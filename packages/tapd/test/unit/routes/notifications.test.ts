import type { AttentionDelta } from "trusted-agents-core";
import { describe, expect, it } from "vitest";
import {
	buildAttentionDeltas,
	createNotificationsRoute,
} from "../../../src/http/routes/notifications.js";
import { NotificationQueue, type TapNotification } from "../../../src/notification-queue.js";

function note(overrides: Partial<TapNotification> = {}): TapNotification {
	return { id: "n", type: "info", oneLiner: "hello", createdAt: "x", ...overrides };
}

describe("notifications route", () => {
	it("returns drained notifications", async () => {
		const q = new NotificationQueue();
		q.enqueue(note({ id: "a" }));
		q.enqueue(note({ id: "b", type: "escalation", oneLiner: "uh oh", createdAt: "y" }));
		const handler = createNotificationsRoute(q);

		const result = (await handler({}, undefined)) as { notifications: { id: string }[] };
		// Response order is drain (arrival) order; escalation-first is a render
		// concern applied host-side.
		expect(result.notifications.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.size()).toBe(0);
	});

	it("returns empty list when no notifications", async () => {
		const q = new NotificationQueue();
		const handler = createNotificationsRoute(q);
		const result = (await handler({}, undefined)) as { notifications: unknown[] };
		expect(result.notifications).toEqual([]);
	});

	it("records attention deltas on drain with the daemon identity", async () => {
		const q = new NotificationQueue();
		q.enqueue(
			note({
				id: "a",
				oneLiner: "New message from Bob: hi",
				count: 3,
				data: { peerAgentId: 7, peerChain: "eip155:8453", peerName: "Bob" },
			}),
		);
		const recorded: Array<{ deltas: AttentionDelta[]; identity?: unknown }> = [];
		const handler = createNotificationsRoute(q, {
			ledger: {
				record: async (deltas, options) => {
					recorded.push({ deltas, identity: options?.identity });
				},
			},
			identity: () => ({ chain: "eip155:8453", agentId: 42 }),
		});

		await handler({}, undefined);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.identity).toEqual({ chain: "eip155:8453", agentId: 42 });
		const peerDelta = recorded[0]?.deltas.find(
			(d) => d.peer?.agentId === 7 && d.peer?.chain === "eip155:8453",
		);
		expect(peerDelta?.notificationsRendered).toBe(1);
		expect(peerDelta?.tokensInjected).toBeGreaterThan(0);
	});

	it("does not record when the drain is empty", async () => {
		const q = new NotificationQueue();
		let calls = 0;
		const handler = createNotificationsRoute(q, {
			ledger: {
				record: async () => {
					calls += 1;
				},
			},
		});
		await handler({}, undefined);
		expect(calls).toBe(0);
	});

	it("folds over-quota grant holders before accounting and before the wire", async () => {
		const q = new NotificationQueue();
		q.enqueue(
			note({
				id: "a",
				oneLiner: "New message from Bob: chatter one",
				data: { peerAgentId: 7, peerChain: "eip155:8453", peerName: "Bob" },
			}),
		);
		q.enqueue(
			note({
				id: "b",
				oneLiner: "New message from Bob: chatter two",
				data: { peerAgentId: 7, peerChain: "eip155:8453", peerName: "Bob" },
			}),
		);
		const recorded: Array<{ deltas: AttentionDelta[] }> = [];
		const handler = createNotificationsRoute(q, {
			ledger: {
				record: async (deltas) => {
					recorded.push({ deltas });
				},
				renderedInWindow: async () => 5,
			},
			trustStore: {
				findByAgentId: async () => ({
					connectionId: "conn-bob",
					peerAgentId: 7,
					peerChain: "eip155:8453",
					peerOwnerAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
					peerDisplayName: "Bob",
					peerAgentAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
					permissions: {
						grantedByMe: {
							version: "tap-grants/v1",
							updatedAt: "",
							grants: [
								{
									grantId: "g",
									scope: "message/send",
									constraints: { notificationsPerWeek: 5 },
									status: "active" as const,
									updatedAt: "",
								},
							],
						},
						grantedByPeer: { version: "tap-grants/v1", updatedAt: "", grants: [] },
					},
					establishedAt: "",
					lastContactAt: "",
					status: "active" as const,
				}),
			},
		});

		const result = (await handler({}, undefined)) as {
			notifications: Array<{ type: string; oneLiner: string; count?: number }>;
		};
		// The wire batch is the folded batch — every host (incl. the Hermes
		// Python mirror) sees one summary line instead of the chatter.
		expect(result.notifications).toHaveLength(1);
		expect(result.notifications[0]).toMatchObject({ type: "summary", count: 2 });
		expect(result.notifications[0]?.oneLiner).toContain("folded — weekly notification quota");
		// Accounting was computed on the folded batch: the summary's token
		// cost bills the peer, but it is NOT a rendered line for quota
		// purposes — billing the fold itself would re-top the trailing
		// window on every drain and the quota would never recover.
		const peerDelta = recorded[0]?.deltas.find((d) => d.peer?.agentId === 7);
		expect(peerDelta?.notificationsRendered).toBeUndefined();
		expect(peerDelta?.tokensInjected).toBeGreaterThan(0);
	});

	it("still returns the drained batch when the ledger write fails", async () => {
		const q = new NotificationQueue();
		q.enqueue(note({ id: "a" }));
		const failures: unknown[] = [];
		const handler = createNotificationsRoute(q, {
			ledger: {
				record: async () => {
					throw new Error("disk full");
				},
			},
			onLedgerError: (error) => failures.push(error),
		});

		const result = (await handler({}, undefined)) as { notifications: { id: string }[] };
		expect(result.notifications.map((n) => n.id)).toEqual(["a"]);
		expect(failures).toHaveLength(1);
	});
});

describe("buildAttentionDeltas", () => {
	it("attributes rendered lines and tokens per peer, overhead unattributed", () => {
		const deltas = buildAttentionDeltas([
			note({
				id: "bob",
				oneLiner: "New message from Bob: hi",
				count: 2,
				data: { peerAgentId: 7, peerChain: "eip155:8453", peerName: "Bob" },
			}),
			note({ id: "bare", oneLiner: "Connection established" }),
		]);

		const bob = deltas.find((d) => d.peer?.agentId === 7);
		expect(bob?.notificationsRendered).toBe(1);
		// "- INFO: New message from Bob: hi (x2)" + newline = 38 chars → 10 tokens
		expect(bob?.tokensInjected).toBe(10);
		const unattributed = deltas.find((d) => d.peer === null);
		// The bare line bills unattributed, plus the header overhead.
		expect(unattributed?.notificationsRendered).toBe(1);
		expect(unattributed?.tokensInjected).toBeGreaterThan(0);
	});

	it("counts escalations whether rendered or suppressed", () => {
		const flood: TapNotification[] = [];
		for (let i = 0; i < 25; i += 1) {
			flood.push(note({ id: `e-${i}`, type: "escalation", oneLiner: `esc ${i}` }));
		}
		const deltas = buildAttentionDeltas(flood);
		const unattributed = deltas.find((d) => d.peer === null);
		expect(unattributed?.escalations).toBe(25);
		expect(unattributed?.notificationsRendered).toBe(20);
		expect(unattributed?.overflowSuppressed).toBe(5);
	});

	it("bills suppressed coalesced entries their full event count", () => {
		const flood: TapNotification[] = [];
		for (let i = 0; i < 20; i += 1) {
			flood.push(note({ id: `keep-${i}`, oneLiner: `kept ${i}` }));
		}
		flood.push(
			note({
				id: "bob",
				oneLiner: "New message from Bob: hi",
				count: 12,
				data: { peerAgentId: 7, peerChain: "eip155:8453", peerName: "Bob" },
			}),
		);
		const deltas = buildAttentionDeltas(flood);
		const bob = deltas.find((d) => d.peer?.agentId === 7);
		expect(bob?.overflowSuppressed).toBe(12);
		expect(bob?.notificationsRendered).toBeUndefined();
	});

	it("returns only escalation counts when nothing renders", () => {
		const deltas = buildAttentionDeltas([
			note({ id: "blank", type: "escalation", oneLiner: "   " }),
		]);
		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.escalations).toBe(1);
		expect(deltas[0]?.tokensInjected).toBeUndefined();
	});
});
