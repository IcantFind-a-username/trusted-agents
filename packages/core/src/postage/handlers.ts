import type { TapActionContext, TapActionResult } from "../app/types.js";
import { ValidationError } from "../common/index.js";
import { microsToPostageAmount, postageAmountToMicros } from "./amounts.js";
import type { PostageCreditFacts } from "./certificate.js";
import type { IssuedPostageCredit, RecordIssuedInput } from "./ledger.js";
import { FilePostageLedger, postagePeerKey } from "./ledger.js";
import {
	type PostageTopupRequest,
	parsePostageBalanceRequest,
	parsePostageTopupRequest,
} from "./payload.js";

export const POSTAGE_APP_ID = "postage";

/**
 * Capabilities the hosting service injects into `ctx.extensions.postage`
 * for the postage handlers: the service-owned credit ledger (the same
 * instance attention enforcement debits — one mutex serializes both) and
 * narrow signing/verification adapters, so handlers never see the raw
 * SigningProvider or the service hooks.
 */
export interface PostageAppExtension {
	recordIssued(
		input: RecordIssuedInput,
	): Promise<{ credit: IssuedPostageCredit; created: boolean }>;
	issuedFor(peer: string): Promise<IssuedPostageCredit[]>;
	/** Sign a credit certificate; null when the host cannot sign right now. */
	signCredit(facts: PostageCreditFacts): Promise<`0x${string}` | null>;
	/** Verify the claimed on-chain topup payment. Hosts default to accept. */
	verifyTopup(request: PostageTopupRequest, peer: string): Promise<boolean>;
}

function postageExtension(ctx: TapActionContext): PostageAppExtension | undefined {
	const extension = ctx.extensions.postage;
	return extension ? (extension as PostageAppExtension) : undefined;
}

function contactPeerKey(ctx: TapActionContext): string {
	return postagePeerKey({
		chain: ctx.peer.contact.peerChain,
		agentId: ctx.peer.contact.peerAgentId,
	});
}

/**
 * `postage/topup` — accept a prepaid credit purchase. Verifies the claimed
 * payment (via the host seam), records the credit on the issued ledger, and
 * returns a signed credit certificate. Idempotent per creditId: a retried
 * topup gets the originally recorded credit and certificate back.
 */
export async function handlePostageTopup(ctx: TapActionContext): Promise<TapActionResult> {
	const extension = postageExtension(ctx);
	if (!extension) {
		return {
			success: false,
			error: { code: "POSTAGE_UNAVAILABLE", message: "This host does not accept postage topups" },
		};
	}

	const request = parsePostageTopupRequest(ctx.payload);
	if (!request) {
		return {
			success: false,
			error: {
				code: "INVALID_PAYLOAD",
				message:
					'postage/topup requires { actionId, creditId, amount, asset: "usdc", chain, txHash }',
			},
		};
	}

	const peer = contactPeerKey(ctx);
	const verified = await extension.verifyTopup(request, peer);
	if (!verified) {
		return {
			success: false,
			data: { actionId: request.actionId, creditId: request.creditId, status: "rejected" },
			error: {
				code: "TOPUP_UNVERIFIED",
				message: `postage topup payment ${request.txHash} could not be verified`,
			},
		};
	}

	// Record BEFORE signing: the mutex-guarded ledger is the idempotency and
	// abuse gate (per-creditId retry, one credit per txHash, per-peer credit
	// cap), so a replayed or fabricated topup is settled without ever
	// touching the signing provider — no signing amplification.
	let credit: IssuedPostageCredit;
	let created: boolean;
	try {
		({ credit, created } = await extension.recordIssued({
			creditId: request.creditId,
			peer,
			amount: request.amount,
			txHash: request.txHash,
		}));
	} catch (error) {
		if (error instanceof ValidationError) {
			return {
				success: false,
				data: { actionId: request.actionId, creditId: request.creditId, status: "rejected" },
				error: { code: "CREDIT_CONFLICT", message: error.message },
			};
		}
		throw error;
	}

	// Sign only when the recorded credit still lacks a certificate (fresh
	// credit, or an earlier attempt whose signer was down) and backfill it
	// through the idempotent record path. A null signature still leaves the
	// credit open — the receiver honors what it recorded; the payer just
	// holds no portable proof yet and can retry the topup to obtain one.
	if (!credit.certificate) {
		const facts: PostageCreditFacts = {
			creditId: request.creditId,
			issuerChain: ctx.self.chain,
			issuerAgentId: ctx.self.agentId,
			holderAgentId: ctx.peer.contact.peerAgentId,
			amount: request.amount,
			txHash: request.txHash,
		};
		const certificate = await extension.signCredit(facts);
		if (certificate) {
			({ credit } = await extension.recordIssued({
				creditId: request.creditId,
				peer,
				amount: request.amount,
				txHash: request.txHash,
				certificate,
			}));
		}
	}

	if (created) {
		ctx.events.emit({
			type: "postage/topup",
			summary: `Postage topup: ${request.amount} USDC from ${ctx.peer.contact.peerDisplayName} (credit ${request.creditId})`,
			data: { creditId: request.creditId, amount: request.amount, peer },
		});
		await ctx.log.append({
			text: `Accepted postage topup of ${request.amount} USDC (credit ${request.creditId})`,
			direction: "inbound",
		});
	}

	return {
		success: true,
		data: {
			actionId: request.actionId,
			creditId: credit.creditId,
			status: "accepted",
			amount: credit.amount,
			...(credit.certificate ? { certificate: credit.certificate } : {}),
			issuer: { agentId: ctx.self.agentId, chain: ctx.self.chain, address: ctx.self.address },
		},
	};
}

/**
 * `postage/balance` — report the asking peer's credits on this agent's
 * issued ledger. Read-only; peers only ever see their own credits.
 */
export async function handlePostageBalance(ctx: TapActionContext): Promise<TapActionResult> {
	const extension = postageExtension(ctx);
	if (!extension) {
		return {
			success: false,
			error: { code: "POSTAGE_UNAVAILABLE", message: "This host does not track postage credits" },
		};
	}

	const request = parsePostageBalanceRequest(ctx.payload);
	if (!request) {
		return {
			success: false,
			error: { code: "INVALID_PAYLOAD", message: "postage/balance requires { actionId }" },
		};
	}

	const credits = await extension.issuedFor(contactPeerKey(ctx));
	let totalRemainingMicros = 0n;
	const rows = credits.map((credit) => {
		const remaining = FilePostageLedger.remainingOf(credit);
		totalRemainingMicros += postageAmountToMicros(remaining);
		return {
			creditId: credit.creditId,
			amount: credit.amount,
			spent: credit.spent,
			remaining,
			lastSeq: credit.lastSeq,
		};
	});

	return {
		success: true,
		data: {
			actionId: request.actionId,
			status: "completed",
			credits: rows,
			totalRemaining: microsToPostageAmount(totalRemainingMicros),
		},
	};
}
