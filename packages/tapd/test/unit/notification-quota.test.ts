import type { Contact } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import type { TapNotification } from "../../src/notification-queue.js";
import { applyNotificationQuota } from "../../src/notification-quota.js";

const CHAIN = "eip155:8453";
const BOB_ID = 7;

function makeContact(
	grants: Array<{ grantId: string; scope: string; constraints?: Record<string, unknown> }>,
): Contact {
	return {
		connectionId: "conn-bob",
		peerAgentId: BOB_ID,
		peerChain: CHAIN,
		peerOwnerAddress: "0x2222222222222222222222222222222222222222",
		peerDisplayName: "Bob",
		peerAgentAddress: "0x2222222222222222222222222222222222222222",
		permissions: {
			grantedByMe: {
				version: "tap-grants/v1",
				updatedAt: "2026-08-28T00:00:00.000Z",
				grants: grants.map((grant) => ({
					...grant,
					status: "active" as const,
					updatedAt: "2026-08-28T00:00:00.000Z",
				})),
			},
			grantedByPeer: { version: "tap-grants/v1", updatedAt: "", grants: [] },
		},
		establishedAt: "2026-08-28T00:00:00.000Z",
		lastContactAt: "2026-08-28T00:00:00.000Z",
		status: "active",
	};
}

function infoNote(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		id: `n-${Math.random().toString(36).slice(2)}`,
		type: "info",
		oneLiner: "New message from Bob: hi",
		createdAt: "2026-08-28T01:00:00.000Z",
		data: { peerChain: CHAIN, peerAgentId: BOB_ID, peerName: "Bob", connectionId: "conn-bob" },
		coalesceKey: "msg:conn-bob",
		coalesceStrategy: "count",
		...overrides,
	};
}

function makeDeps(overrides: {
	contact?: Contact | null;
	rendered?: number;
	findError?: Error;
	ledgerError?: Error;
}) {
	return {
		trustStore: {
			findByAgentId: overrides.findError
				? vi.fn(async () => {
						throw overrides.findError;
					})
				: vi.fn(async () => overrides.contact ?? null),
		},
		ledger: {
			renderedInWindow: overrides.ledgerError
				? vi.fn(async () => {
						throw overrides.ledgerError;
					})
				: vi.fn(async () => overrides.rendered ?? 0),
		},
		onError: vi.fn(),
	};
}

const QUOTA_GRANT = [
	{
		grantId: "g-msg",
		scope: "message/send",
		constraints: { notificationsPerWeek: 2 },
	},
];

describe("applyNotificationQuota", () => {
	it("folds an over-quota grant holder's info notifications into one summary line", async () => {
		const deps = makeDeps({ contact: makeContact(QUOTA_GRANT), rendered: 2 });
		const input = [
			infoNote({ oneLiner: "New message from Bob: one", count: 3 }),
			infoNote({ oneLiner: "New message from Bob: two" }),
		];
		const result = await applyNotificationQuota(input, deps);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			type: "summary",
			count: 4,
			data: { peerChain: CHAIN, peerAgentId: BOB_ID, quotaFolded: true, quota: 2 },
		});
		expect(result[0]?.oneLiner).toBe(
			"4 notifications from Bob folded — weekly notification quota reached (2/week)",
		);
		expect(deps.ledger.renderedInWindow).toHaveBeenCalledWith(
			{ chain: CHAIN, agentId: BOB_ID },
			7,
			undefined,
		);
	});

	it("passes everything through while the peer is under quota", async () => {
		const deps = makeDeps({ contact: makeContact(QUOTA_GRANT), rendered: 1 });
		const input = [infoNote(), infoNote()];
		expect(await applyNotificationQuota(input, deps)).toEqual(input);
	});

	it("never folds peers without a grant or without the constraint", async () => {
		const noGrant = makeDeps({ contact: makeContact([]), rendered: 100 });
		expect(await applyNotificationQuota([infoNote()], noGrant)).toHaveLength(1);

		const noConstraint = makeDeps({
			contact: makeContact([{ grantId: "g", scope: "message/send" }]),
			rendered: 100,
		});
		const input = [infoNote()];
		expect(await applyNotificationQuota(input, noConstraint)).toEqual(input);
	});

	it("never folds escalations — paid wake-ups outrank the free-tier quota", async () => {
		const deps = makeDeps({ contact: makeContact(QUOTA_GRANT), rendered: 10 });
		const escalation = infoNote({
			type: "escalation",
			oneLiner: "Priority message from Bob: pay attention",
			coalesceKey: undefined,
			coalesceStrategy: undefined,
		});
		const result = await applyNotificationQuota([infoNote(), escalation, infoNote()], deps);
		expect(result).toHaveLength(2);
		expect(result[0]?.type).toBe("summary");
		expect(result[1]).toBe(escalation);
	});

	it("leaves notifications without a peer identity untouched", async () => {
		const deps = makeDeps({ contact: makeContact(QUOTA_GRANT), rendered: 10 });
		const anonymous = infoNote({ data: {} });
		const result = await applyNotificationQuota([anonymous], deps);
		expect(result).toEqual([anonymous]);
		expect(deps.trustStore.findByAgentId).not.toHaveBeenCalled();
	});

	it("honors a quota of zero (no free notification lines at all)", async () => {
		const deps = makeDeps({
			contact: makeContact([
				{ grantId: "g", scope: "message/send", constraints: { notificationsPerWeek: 0 } },
			]),
			rendered: 0,
		});
		const result = await applyNotificationQuota([infoNote()], deps);
		expect(result[0]?.type).toBe("summary");
	});

	it("takes the most permissive quota across multiple active grants", async () => {
		const deps = makeDeps({
			contact: makeContact([
				{ grantId: "g1", scope: "message/send", constraints: { notificationsPerWeek: 1 } },
				{ grantId: "g2", scope: "message/send", constraints: { notificationsPerWeek: 10 } },
			]),
			rendered: 5,
		});
		const input = [infoNote()];
		expect(await applyNotificationQuota(input, deps)).toEqual(input);
	});

	it("ignores malformed constraint values", async () => {
		const deps = makeDeps({
			contact: makeContact([
				{ grantId: "g", scope: "message/send", constraints: { notificationsPerWeek: "two" } },
			]),
			rendered: 100,
		});
		const input = [infoNote()];
		expect(await applyNotificationQuota(input, deps)).toEqual(input);
	});

	it("fails open when the trust store or ledger cannot answer", async () => {
		const storeDown = makeDeps({ findError: new Error("store offline"), rendered: 100 });
		const input = [infoNote()];
		expect(await applyNotificationQuota(input, storeDown)).toEqual(input);
		expect(storeDown.onError).toHaveBeenCalled();

		const ledgerDown = makeDeps({
			contact: makeContact(QUOTA_GRANT),
			ledgerError: new Error("disk gone"),
		});
		expect(await applyNotificationQuota(input, ledgerDown)).toEqual(input);
		expect(ledgerDown.onError).toHaveBeenCalled();
	});
});
