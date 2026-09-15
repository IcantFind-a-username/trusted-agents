import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileAttentionLedger,
	UNATTRIBUTED_PEER_KEY,
	attentionPeerKey,
} from "../../../src/attention/ledger.js";

const BOB = { chain: "eip155:8453", agentId: 7 };
const CAROL = { chain: "eip155:8453", agentId: 8 };

describe("attentionPeerKey", () => {
	it("serializes a peer as chain#agentId and null as the unattributed key", () => {
		expect(attentionPeerKey(BOB)).toBe("eip155:8453#7");
		expect(attentionPeerKey(null)).toBe(UNATTRIBUTED_PEER_KEY);
	});
});

describe("FileAttentionLedger", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "attention-ledger-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("starts empty when no file exists", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		expect(await ledger.read()).toEqual({ version: 1, days: {} });
		expect(await ledger.summarize()).toEqual([]);
	});

	it("accumulates deltas per peer and day, with totals", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		await ledger.record(
			[
				{ peer: BOB, notificationsRendered: 1, tokensInjected: 10 },
				{ peer: null, tokensInjected: 5 },
			],
			{ at: "2026-08-27T10:00:00.000Z", identity: { chain: "eip155:8453", agentId: 42 } },
		);
		await ledger.record([{ peer: BOB, escalations: 1, tokensInjected: 4 }], {
			at: "2026-08-27T12:00:00.000Z",
		});

		const data = await ledger.read();
		expect(data.identity).toEqual({ chain: "eip155:8453", agentId: 42 });
		const day = data.days["2026-08-27"];
		expect(day?.peers["eip155:8453#7"]).toEqual({
			notificationsRendered: 1,
			tokensInjected: 14,
			escalations: 1,
			overflowSuppressed: 0,
		});
		expect(day?.peers[UNATTRIBUTED_PEER_KEY]?.tokensInjected).toBe(5);
		expect(day?.totals.tokensInjected).toBe(19);
	});

	it("buckets by UTC date and prunes days past retention on write", async () => {
		const ledger = new FileAttentionLedger(dataDir, { retentionDays: 7 });
		await ledger.record([{ peer: BOB, tokensInjected: 1 }], { at: "2026-08-01T00:00:00.000Z" });
		await ledger.record([{ peer: BOB, tokensInjected: 1 }], { at: "2026-08-26T23:59:00.000Z" });
		await ledger.record([{ peer: BOB, tokensInjected: 1 }], { at: "2026-08-27T10:00:00.000Z" });

		const data = await ledger.read();
		expect(Object.keys(data.days).sort()).toEqual(["2026-08-26", "2026-08-27"]);
	});

	it("summarizes across days sorted by tokens injected", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		await ledger.record(
			[
				{ peer: BOB, tokensInjected: 3, notificationsRendered: 1 },
				{ peer: CAROL, tokensInjected: 20, notificationsRendered: 2 },
			],
			{ at: "2026-08-26T10:00:00.000Z" },
		);
		await ledger.record([{ peer: BOB, tokensInjected: 4, overflowSuppressed: 6 }], {
			at: "2026-08-27T10:00:00.000Z",
		});

		const rows = await ledger.summarize();
		expect(rows.map((r) => r.peerKey)).toEqual(["eip155:8453#8", "eip155:8453#7"]);
		expect(rows[1]).toEqual({
			peerKey: "eip155:8453#7",
			peer: BOB,
			notificationsRendered: 1,
			tokensInjected: 7,
			escalations: 0,
			overflowSuppressed: 6,
		});
	});

	it("persists atomically: a fresh instance reads what another wrote", async () => {
		await new FileAttentionLedger(dataDir).record([{ peer: BOB, tokensInjected: 9 }], {
			at: "2026-08-27T10:00:00.000Z",
		});
		const rows = await new FileAttentionLedger(dataDir).summarize();
		expect(rows[0]?.tokensInjected).toBe(9);

		const raw = await readFile(join(dataDir, "attention-ledger.json"), "utf-8");
		expect(JSON.parse(raw).version).toBe(1);
	});

	it("serializes concurrent records through the mutex without losing writes", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		await Promise.all(
			Array.from({ length: 10 }, () =>
				ledger.record([{ peer: BOB, tokensInjected: 1 }], { at: "2026-08-27T10:00:00.000Z" }),
			),
		);
		const rows = await ledger.summarize();
		expect(rows[0]?.tokensInjected).toBe(10);
	});

	it("ignores empty delta batches and rejects invalid timestamps", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		await ledger.record([], { at: "not-a-date" });
		expect(await ledger.read()).toEqual({ version: 1, days: {} });

		await expect(
			ledger.record([{ peer: BOB, tokensInjected: 1 }], { at: "not-a-date" }),
		).rejects.toThrow(/invalid timestamp/);
	});

	it("renderedInWindow sums one peer's rendered lines over the trailing days only", async () => {
		const ledger = new FileAttentionLedger(dataDir);
		// Inside the 7-day window ending 2026-08-28: the 22nd..28th.
		await ledger.record([{ peer: BOB, notificationsRendered: 2 }], {
			at: "2026-08-22T09:00:00.000Z",
		});
		await ledger.record([{ peer: BOB, notificationsRendered: 3 }], {
			at: "2026-08-28T01:00:00.000Z",
		});
		// Outside the window (the 21st), and another peer inside it.
		await ledger.record([{ peer: BOB, notificationsRendered: 10 }], {
			at: "2026-08-21T23:59:00.000Z",
		});
		await ledger.record([{ peer: CAROL, notificationsRendered: 7 }], {
			at: "2026-08-27T12:00:00.000Z",
		});

		const now = new Date("2026-08-28T02:00:00.000Z");
		expect(await ledger.renderedInWindow(BOB, 7, now)).toBe(5);
		expect(await ledger.renderedInWindow(CAROL, 7, now)).toBe(7);
		expect(await ledger.renderedInWindow({ chain: "eip155:8453", agentId: 99 }, 7, now)).toBe(0);
		// A 1-day window sees only today's bucket.
		expect(await ledger.renderedInWindow(BOB, 1, now)).toBe(3);
		await expect(ledger.renderedInWindow(BOB, 0, now)).rejects.toThrow(/positive integer/);
	});
});
