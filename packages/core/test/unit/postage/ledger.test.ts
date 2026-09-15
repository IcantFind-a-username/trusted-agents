import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/common/index.js";
import {
	FilePostageLedger,
	MAX_ISSUED_CREDITS_PER_PEER,
	postagePeerKey,
} from "../../../src/postage/ledger.js";

const BOB_KEY = postagePeerKey({ chain: "eip155:8453", agentId: 7 });
const CAROL_KEY = postagePeerKey({ chain: "eip155:8453", agentId: 8 });

describe("postagePeerKey", () => {
	it("matches the attention ledger's chain#agentId format", () => {
		expect(BOB_KEY).toBe("eip155:8453#7");
	});
});

describe("FilePostageLedger", () => {
	let dataDir: string;
	let ledger: FilePostageLedger;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "postage-ledger-"));
		ledger = new FilePostageLedger(dataDir);
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	const topup = (overrides: Partial<Parameters<FilePostageLedger["recordIssued"]>[0]> = {}) =>
		ledger.recordIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			amount: "0.01",
			txHash: "0xabc",
			...overrides,
		});

	it("persists issued credits under <dataDir>/apps/postage/state.json", async () => {
		await topup();
		const raw = JSON.parse(
			await readFile(join(dataDir, "apps", "postage", "state.json"), "utf-8"),
		) as { version: number; issued: Record<string, { amount: string; spent: string }> };
		expect(raw.version).toBe(1);
		expect(raw.issued["credit-1"]).toMatchObject({ amount: "0.01", spent: "0" });
	});

	it("recordIssued is idempotent for the same topup and rejects conflicting ones", async () => {
		const first = await topup({ certificate: "0xsig" as `0x${string}` });
		expect(first.created).toBe(true);
		const replay = await topup();
		expect(replay.created).toBe(false);
		expect(replay.credit.certificate).toBe("0xsig");
		await expect(topup({ txHash: "0xother" })).rejects.toThrow(ValidationError);
		await expect(topup({ amount: "0.02" })).rejects.toThrow(ValidationError);
	});

	it("recordIssued backfills a certificate onto a credit recorded without one", async () => {
		await topup();
		const retried = await topup({ certificate: "0xlate" as `0x${string}` });
		expect(retried.created).toBe(false);
		expect(retried.credit.certificate).toBe("0xlate");
	});

	it("debitIssued spends, tracks seq, and reports remaining", async () => {
		await topup();
		const debit = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
		});
		expect(debit).toEqual({ ok: true, remaining: "0.009" });
		const state = await ledger.read();
		expect(state.issued["credit-1"]).toMatchObject({ spent: "0.001", lastSeq: 1 });
	});

	it("debitIssued rejects unknown credits and other peers' credits identically", async () => {
		await topup();
		const unknown = await ledger.debitIssued({
			creditId: "nope",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
		});
		const wrongPeer = await ledger.debitIssued({
			creditId: "credit-1",
			peer: CAROL_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
		});
		expect(unknown).toMatchObject({ ok: false, rejection: { reason: "unknown_credit" } });
		expect(wrongPeer).toMatchObject({ ok: false, rejection: { reason: "unknown_credit" } });
	});

	it("debitIssued rejects replayed or rewound seqs without spending", async () => {
		await topup();
		await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 3,
			cost: "0.001",
			required: "0.001",
		});
		const replay = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 3,
			cost: "0.001",
			required: "0.001",
		});
		expect(replay).toMatchObject({ ok: false, rejection: { reason: "seq_replayed" } });
		const state = await ledger.read();
		expect(state.issued["credit-1"]?.spent).toBe("0.001");
	});

	it("debitIssued rejects stamps below the required price and malformed costs", async () => {
		await topup();
		const below = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.0001",
			required: "0.001",
		});
		expect(below).toMatchObject({
			ok: false,
			rejection: { reason: "below_price", required: "0.001" },
		});
		const malformed = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "1e-3",
			required: "0.001",
		});
		expect(malformed).toMatchObject({ ok: false, rejection: { reason: "below_price" } });
	});

	it("debitIssued rejects when the credit cannot cover the cost", async () => {
		await ledger.recordIssued({
			creditId: "small",
			peer: BOB_KEY,
			amount: "0.001",
			txHash: "0xabc",
		});
		await ledger.debitIssued({
			creditId: "small",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
		});
		const exhausted = await ledger.debitIssued({
			creditId: "small",
			peer: BOB_KEY,
			seq: 2,
			cost: "0.001",
			required: "0.001",
		});
		expect(exhausted).toMatchObject({
			ok: false,
			rejection: { reason: "insufficient_credit", remaining: "0", required: "0.001" },
		});
	});

	it("stampHeld consumes seq and spend from the oldest covering credit", async () => {
		await ledger.recordHeld({
			creditId: "held-new",
			peer: BOB_KEY,
			amount: "0.01",
			txHash: "0x2",
			at: "2026-08-02T00:00:00.000Z",
		});
		await ledger.recordHeld({
			creditId: "held-old",
			peer: BOB_KEY,
			amount: "0.002",
			txHash: "0x1",
			at: "2026-08-01T00:00:00.000Z",
		});
		const first = await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" });
		expect(first).toEqual({
			ok: true,
			stamp: { creditId: "held-old", seq: 1, cost: "0.001" },
			remaining: "0.001",
		});
		const second = await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" });
		expect(second).toMatchObject({ ok: true, stamp: { creditId: "held-old", seq: 2 } });
		// held-old is dry; the next stamp rolls over to the newer credit.
		const third = await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" });
		expect(third).toMatchObject({ ok: true, stamp: { creditId: "held-new", seq: 1 } });
	});

	it("stampHeld distinguishes no credit from exhausted credit", async () => {
		expect(await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" })).toEqual({
			ok: false,
			reason: "no_credit",
		});
		await ledger.recordHeld({
			creditId: "held",
			peer: BOB_KEY,
			amount: "0.001",
			txHash: "0x1",
		});
		await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" });
		expect(await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" })).toEqual({
			ok: false,
			reason: "insufficient_credit",
		});
	});

	it("recordHeld preserves local spend tracking on topup retries", async () => {
		await ledger.recordHeld({ creditId: "held", peer: BOB_KEY, amount: "0.01", txHash: "0x1" });
		await ledger.stampHeld({ peer: BOB_KEY, cost: "0.001" });
		const updated = await ledger.recordHeld({
			creditId: "held",
			peer: BOB_KEY,
			amount: "0.01",
			txHash: "0x1",
			certificate: "0xsig" as `0x${string}`,
			certificateVerified: true,
		});
		expect(updated).toMatchObject({
			spent: "0.001",
			nextSeq: 2,
			certificate: "0xsig",
			certificateVerified: true,
		});
	});

	it("concurrent debits never double-spend the same balance", async () => {
		await ledger.recordIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			amount: "0.003",
			txHash: "0xabc",
		});
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((seq) =>
				ledger.debitIssued({
					creditId: "credit-1",
					peer: BOB_KEY,
					seq,
					cost: "0.001",
					required: "0.001",
				}),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(3);
		const state = await ledger.read();
		expect(state.issued["credit-1"]?.spent).toBe("0.003");
	});

	it("one on-chain payment opens exactly one credit — txHash reuse is rejected", async () => {
		await topup();
		await expect(
			ledger.recordIssued({ creditId: "credit-2", peer: BOB_KEY, amount: "0.01", txHash: "0xabc" }),
		).rejects.toThrow("already backs another credit");
		// Also across peers: a payment cannot be re-claimed by anyone.
		await expect(
			ledger.recordIssued({
				creditId: "credit-3",
				peer: CAROL_KEY,
				amount: "0.01",
				txHash: "0xabc",
			}),
		).rejects.toThrow("already backs another credit");
	});

	it("caps live issued credits per peer", async () => {
		for (let i = 0; i < MAX_ISSUED_CREDITS_PER_PEER; i++) {
			await ledger.recordIssued({
				creditId: `cap-${i}`,
				peer: BOB_KEY,
				amount: "0.000001",
				txHash: `0xcap-${i}`,
			});
		}
		await expect(
			ledger.recordIssued({
				creditId: "cap-over",
				peer: BOB_KEY,
				amount: "0.000001",
				txHash: "0xcap-over",
			}),
		).rejects.toThrow("credit limit reached");
		// Retrying an existing credit still succeeds at the cap.
		const retry = await ledger.recordIssued({
			creditId: "cap-0",
			peer: BOB_KEY,
			amount: "0.000001",
			txHash: "0xcap-0",
		});
		expect(retry.created).toBe(false);
		// Other peers are unaffected.
		await expect(
			ledger.recordIssued({
				creditId: "carol-1",
				peer: CAROL_KEY,
				amount: "0.01",
				txHash: "0xcarol",
			}),
		).resolves.toMatchObject({ created: true });
	});

	it("lets the exact last-debited delivery replay for free via stampKey", async () => {
		await topup();
		const first = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
			stampKey: "inbox:message/send:m1",
		});
		expect(first).toEqual({ ok: true, remaining: "0.009" });
		// Same message redelivered (crash before its journal entry completed):
		// passes without spending again.
		const redelivery = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
			stampKey: "inbox:message/send:m1",
		});
		expect(redelivery).toEqual({ ok: true, remaining: "0.009" });
		// A different message reusing the seq is still a replay.
		const attack = await ledger.debitIssued({
			creditId: "credit-1",
			peer: BOB_KEY,
			seq: 1,
			cost: "0.001",
			required: "0.001",
			stampKey: "inbox:message/send:m2",
		});
		expect(attack).toMatchObject({ ok: false, rejection: { reason: "seq_replayed" } });
		const state = await ledger.read();
		expect(state.issued["credit-1"]?.spent).toBe("0.001");
	});

	it("removeHeld drops a held credit and tolerates unknown ids", async () => {
		await ledger.recordHeld({ creditId: "held-1", peer: BOB_KEY, amount: "0.01", txHash: "0x1" });
		await ledger.removeHeld("held-1");
		await ledger.removeHeld("never-existed");
		const state = await ledger.read();
		expect(state.held["held-1"]).toBeUndefined();
	});
});
