import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	AsyncMutex,
	type PostageRejection,
	ValidationError,
	resolveDataDir,
} from "../common/index.js";
import type { PostageStamp } from "../protocol/types.js";
import { isValidPostageAmount, microsToPostageAmount, postageAmountToMicros } from "./amounts.js";

/**
 * Peer key for postage accounting: `"<chain>#<agentId>"`, the same format
 * the attention ledger uses so the two ledgers can be joined per peer.
 */
export function postagePeerKey(peer: { chain: string; agentId: number }): string {
	return `${peer.chain}#${peer.agentId}`;
}

/** A credit a peer bought with us — we accept its stamps until it runs dry. */
export interface IssuedPostageCredit {
	creditId: string;
	/** Peer key of the payer whose stamps draw on this credit. */
	peer: string;
	amount: string;
	spent: string;
	/** Highest stamp seq already debited; stamps must be strictly greater. */
	lastSeq: number;
	/**
	 * Delivery key of the message that debited lastSeq. Lets a redelivery of
	 * that same message (crash between the debit and the journal completing)
	 * pass idempotently instead of bouncing as a replay.
	 */
	lastStampKey?: string;
	txHash: string;
	issuedAt: string;
	/** Our signed credit certificate, as returned to the payer. */
	certificate?: `0x${string}`;
}

/** A credit we bought at a peer — our stamps draw on it when we send. */
export interface HeldPostageCredit {
	creditId: string;
	/** Peer key of the receiver this credit buys attention from. */
	peer: string;
	amount: string;
	spent: string;
	/** Seq the next stamp will carry; incremented (and persisted) per stamp. */
	nextSeq: number;
	txHash: string;
	issuedAt: string;
	certificate?: `0x${string}`;
	certificateVerified: boolean;
}

export interface PostageStateFile {
	version: 1;
	issued: Record<string, IssuedPostageCredit>;
	held: Record<string, HeldPostageCredit>;
}

export interface RecordIssuedInput {
	creditId: string;
	peer: string;
	amount: string;
	txHash: string;
	certificate?: `0x${string}`;
	at?: string;
}

export interface RecordHeldInput {
	creditId: string;
	peer: string;
	amount: string;
	txHash: string;
	certificate?: `0x${string}`;
	certificateVerified?: boolean;
	at?: string;
}

export interface DebitIssuedInput {
	creditId: string;
	peer: string;
	seq: number;
	cost: string;
	/** The receiver's advertised standard price the stamp must cover. */
	required: string;
	/** Delivery key of the carrying message, for redelivery idempotency. */
	stampKey?: string;
}

/**
 * Cap on live credits a single peer can hold on the issued ledger. Topups
 * are cheap to request and each one costs this agent durable state and a
 * signing operation, so a peer must consolidate (or spend) before opening
 * more.
 */
export const MAX_ISSUED_CREDITS_PER_PEER = 16;

export type PostageDebitResult =
	| { ok: true; remaining: string }
	| { ok: false; rejection: PostageRejection };

export type PostageStampResult =
	| { ok: true; stamp: PostageStamp; remaining: string }
	| { ok: false; reason: "no_credit" | "insufficient_credit" };

function emptyState(): PostageStateFile {
	return { version: 1, issued: {}, held: {} };
}

function remainingMicros(credit: { amount: string; spent: string }): bigint {
	return postageAmountToMicros(credit.amount) - postageAmountToMicros(credit.spent);
}

/**
 * File-backed store of prepaid postage credits at
 * `<dataDir>/apps/postage/state.json`, both sides at once: credits peers
 * bought with this agent (`issued` — debited by attention enforcement) and
 * credits this agent bought at peers (`held` — debited when stamping
 * outbound messages).
 *
 * Written only by the transport-owning process (single writer), like the
 * attention ledger: the AsyncMutex is process-local. The postage app's
 * handlers mutate this ledger through the service-injected extension — the
 * same instance enforcement uses — never through `ctx.storage`, precisely
 * so one mutex serializes topups against debits.
 */
export class FilePostageLedger {
	private readonly statePath: string;
	private readonly writeMutex = new AsyncMutex();

	constructor(dataDir: string) {
		this.statePath = join(resolveDataDir(dataDir), "apps", "postage", "state.json");
	}

	/**
	 * Record a credit a peer just bought with us. Idempotent on `creditId`:
	 * replaying the same topup (same txHash) returns the stored credit so a
	 * retried `postage/topup` gets the original certificate back; the same
	 * creditId with a different txHash or amount is rejected.
	 */
	async recordIssued(
		input: RecordIssuedInput,
	): Promise<{ credit: IssuedPostageCredit; created: boolean }> {
		this.assertCreditInput(input);
		return await this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			const existing = state.issued[input.creditId];
			if (existing) {
				if (existing.txHash !== input.txHash || existing.amount !== input.amount) {
					throw new ValidationError(
						`postage credit ${input.creditId} already exists with a different topup`,
					);
				}
				if (!existing.certificate && input.certificate) {
					existing.certificate = input.certificate;
					await this.save(state);
				}
				return { credit: existing, created: false };
			}
			// One on-chain payment opens exactly one credit: without this,
			// a single real txHash could be re-claimed under fresh creditIds
			// and mint unbounded balance past any payment-verification hook.
			const txHashClaimed = Object.values(state.issued).some(
				(credit) => credit.txHash === input.txHash,
			);
			if (txHashClaimed) {
				throw new ValidationError(
					`postage topup payment ${input.txHash} already backs another credit`,
				);
			}
			const livePeerCredits = Object.values(state.issued).filter(
				(credit) => credit.peer === input.peer,
			);
			if (livePeerCredits.length >= MAX_ISSUED_CREDITS_PER_PEER) {
				throw new ValidationError(
					`postage credit limit reached: ${input.peer} already holds ${livePeerCredits.length} credits`,
				);
			}
			const credit: IssuedPostageCredit = {
				creditId: input.creditId,
				peer: input.peer,
				amount: input.amount,
				spent: "0",
				lastSeq: 0,
				txHash: input.txHash,
				issuedAt: input.at ?? new Date().toISOString(),
				...(input.certificate ? { certificate: input.certificate } : {}),
			};
			state.issued[input.creditId] = credit;
			await this.save(state);
			return { credit, created: true };
		});
	}

	/**
	 * Debit an inbound stamp against an issued credit. The whole
	 * check-and-spend runs under the ledger mutex so two concurrently
	 * delivered stamps cannot double-spend the same balance.
	 */
	async debitIssued(input: DebitIssuedInput): Promise<PostageDebitResult> {
		return await this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			const credit = state.issued[input.creditId];
			// An existing credit owned by a different peer is reported as
			// unknown — stamps must not probe other senders' credits.
			if (!credit || credit.peer !== input.peer) {
				return {
					ok: false,
					rejection: { reason: "unknown_credit", creditId: input.creditId },
				};
			}
			if (!isValidPostageAmount(input.cost)) {
				return {
					ok: false,
					rejection: {
						reason: "below_price",
						creditId: input.creditId,
						required: input.required,
					},
				};
			}
			const costMicros = postageAmountToMicros(input.cost);
			if (costMicros < postageAmountToMicros(input.required)) {
				return {
					ok: false,
					rejection: {
						reason: "below_price",
						creditId: input.creditId,
						required: input.required,
					},
				};
			}
			if (!Number.isInteger(input.seq) || input.seq <= credit.lastSeq) {
				// Redelivery of the exact message that performed the last debit
				// (crash before its journal entry completed) is already paid —
				// let it through without spending again.
				if (
					input.seq === credit.lastSeq &&
					input.stampKey !== undefined &&
					input.stampKey === credit.lastStampKey
				) {
					return { ok: true, remaining: microsToPostageAmount(remainingMicros(credit)) };
				}
				return {
					ok: false,
					rejection: { reason: "seq_replayed", creditId: input.creditId },
				};
			}
			const remaining = remainingMicros(credit);
			if (remaining < costMicros) {
				return {
					ok: false,
					rejection: {
						reason: "insufficient_credit",
						creditId: input.creditId,
						remaining: microsToPostageAmount(remaining),
						required: input.cost,
					},
				};
			}
			credit.spent = microsToPostageAmount(postageAmountToMicros(credit.spent) + costMicros);
			credit.lastSeq = input.seq;
			credit.lastStampKey = input.stampKey;
			await this.save(state);
			return { ok: true, remaining: microsToPostageAmount(remaining - costMicros) };
		});
	}

	/**
	 * Record (or update, after a topup retry) a credit we hold at a peer.
	 * Local spend tracking (`spent`/`nextSeq`) is preserved on update.
	 */
	async recordHeld(input: RecordHeldInput): Promise<HeldPostageCredit> {
		this.assertCreditInput(input);
		return await this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			const existing = state.held[input.creditId];
			if (existing) {
				if (existing.txHash !== input.txHash || existing.amount !== input.amount) {
					throw new ValidationError(
						`held postage credit ${input.creditId} already exists with a different topup`,
					);
				}
				if (input.certificate) {
					existing.certificate = input.certificate;
				}
				if (input.certificateVerified !== undefined) {
					existing.certificateVerified = input.certificateVerified;
				}
				await this.save(state);
				return existing;
			}
			const credit: HeldPostageCredit = {
				creditId: input.creditId,
				peer: input.peer,
				amount: input.amount,
				spent: "0",
				nextSeq: 1,
				txHash: input.txHash,
				issuedAt: input.at ?? new Date().toISOString(),
				...(input.certificate ? { certificate: input.certificate } : {}),
				certificateVerified: input.certificateVerified ?? false,
			};
			state.held[input.creditId] = credit;
			await this.save(state);
			return credit;
		});
	}

	/**
	 * Consume one stamp from a held credit for the given peer: picks the
	 * oldest credit whose remaining balance covers `cost`, then increments
	 * and persists its seq and spend BEFORE the stamp is returned — a crash
	 * after this point wastes one seq value rather than reusing one.
	 */
	async stampHeld(input: { peer: string; cost: string }): Promise<PostageStampResult> {
		if (!isValidPostageAmount(input.cost)) {
			return { ok: false, reason: "no_credit" };
		}
		const costMicros = postageAmountToMicros(input.cost);
		return await this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			const candidates = Object.values(state.held)
				.filter((credit) => credit.peer === input.peer)
				.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
			if (candidates.length === 0) {
				return { ok: false, reason: "no_credit" };
			}
			const credit = candidates.find((candidate) => remainingMicros(candidate) >= costMicros);
			if (!credit) {
				return { ok: false, reason: "insufficient_credit" };
			}
			const stamp: PostageStamp = {
				creditId: credit.creditId,
				seq: credit.nextSeq,
				cost: input.cost,
			};
			credit.nextSeq += 1;
			credit.spent = microsToPostageAmount(postageAmountToMicros(credit.spent) + costMicros);
			await this.save(state);
			return { ok: true, stamp, remaining: microsToPostageAmount(remainingMicros(credit)) };
		});
	}

	/**
	 * Drop a held credit — used when the peer definitively rejected the
	 * topup that created it, so the record must not feed auto-stamping.
	 */
	async removeHeld(creditId: string): Promise<void> {
		await this.writeMutex.runExclusive(async () => {
			const state = await this.load();
			if (state.held[creditId] === undefined) {
				return;
			}
			const { [creditId]: _removed, ...rest } = state.held;
			state.held = rest;
			await this.save(state);
		});
	}

	async read(): Promise<PostageStateFile> {
		return await this.load();
	}

	async issuedFor(peer: string): Promise<IssuedPostageCredit[]> {
		const state = await this.load();
		return Object.values(state.issued)
			.filter((credit) => credit.peer === peer)
			.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
	}

	async heldFor(peer: string): Promise<HeldPostageCredit[]> {
		const state = await this.load();
		return Object.values(state.held)
			.filter((credit) => credit.peer === peer)
			.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
	}

	/** Remaining balance across a peer's credits, decimal currency string. */
	static remainingOf(credit: { amount: string; spent: string }): string {
		return microsToPostageAmount(remainingMicros(credit));
	}

	private assertCreditInput(input: { creditId: string; amount: string; txHash: string }): void {
		if (typeof input.creditId !== "string" || input.creditId.length === 0) {
			throw new ValidationError("postage creditId must be a non-empty string");
		}
		if (!isValidPostageAmount(input.amount) || postageAmountToMicros(input.amount) <= 0n) {
			throw new ValidationError(
				`postage amount must be a positive decimal string (≤6 decimals), got ${JSON.stringify(input.amount)}`,
			);
		}
		if (typeof input.txHash !== "string" || input.txHash.length === 0) {
			throw new ValidationError("postage txHash must be a non-empty string");
		}
	}

	private async load(): Promise<PostageStateFile> {
		try {
			const raw = await readFile(this.statePath, "utf-8");
			return JSON.parse(raw) as PostageStateFile;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return emptyState();
			}
			throw err;
		}
	}

	private async save(data: PostageStateFile): Promise<void> {
		await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const tmpPath = `${this.statePath}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.statePath);
	}
}
