import { describe, expect, it } from "vitest";
import { NotificationQueue, type TapNotification } from "../../src/notification-queue.js";

function makeNotification(overrides: Partial<TapNotification> = {}): TapNotification {
	return {
		id: "note-1",
		type: "info",
		oneLiner: "Connection established with Bob",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("NotificationQueue", () => {
	it("starts empty", () => {
		const q = new NotificationQueue();
		expect(q.drain()).toEqual([]);
	});

	it("enqueues and drains notifications", () => {
		const q = new NotificationQueue();
		q.enqueue(makeNotification({ id: "a" }));
		q.enqueue(makeNotification({ id: "b" }));

		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["a", "b"]);
		expect(q.drain()).toEqual([]);
	});

	it("returns notifications in FIFO order", () => {
		const q = new NotificationQueue();
		for (let i = 0; i < 5; i += 1) {
			q.enqueue(makeNotification({ id: `n-${i}` }));
		}
		const drained = q.drain();
		expect(drained.map((n) => n.id)).toEqual(["n-0", "n-1", "n-2", "n-3", "n-4"]);
	});

	it("drops the oldest entry when maxSize overflows", () => {
		const q = new NotificationQueue({ maxSize: 3 });
		for (let i = 0; i < 5; i += 1) {
			q.enqueue(makeNotification({ id: `n-${i}` }));
		}
		expect(q.drain().map((n) => n.id)).toEqual(["n-2", "n-3", "n-4"]);
	});

	it("passes notifications without a coalesceKey through untouched", () => {
		const q = new NotificationQueue();
		const a = makeNotification({ id: "a", oneLiner: "same text" });
		const b = makeNotification({ id: "b", oneLiner: "same text" });
		q.enqueue(a);
		q.enqueue(b);

		const drained = q.drain();
		expect(drained).toHaveLength(2);
		expect(drained[0]).toEqual(a);
		expect(drained[0]?.count).toBeUndefined();
	});

	describe("coalescing", () => {
		it("merges same-key entries: earliest slot, first id, newest content, count sum", () => {
			const q = new NotificationQueue();
			q.enqueue(
				makeNotification({
					id: "a",
					oneLiner: "msg 1",
					createdAt: "2026-01-01T00:00:00Z",
					coalesceKey: "msg:conn-1",
					coalesceStrategy: "count",
					data: { peerName: "Bob", seq: 1 },
				}),
			);
			q.enqueue(
				makeNotification({ id: "b", coalesceKey: "msg:conn-2", coalesceStrategy: "count" }),
			);
			q.enqueue(
				makeNotification({
					id: "c",
					oneLiner: "msg 2",
					createdAt: "2026-01-01T00:05:00Z",
					coalesceKey: "msg:conn-1",
					coalesceStrategy: "count",
					data: { peerName: "Bob", seq: 2 },
				}),
			);

			const drained = q.drain();
			expect(drained.map((n) => n.id)).toEqual(["a", "b"]);
			expect(drained[0]?.count).toBe(2);
			expect(drained[0]?.oneLiner).toBe("msg 2");
			expect(drained[0]?.createdAt).toBe("2026-01-01T00:05:00Z");
			expect(drained[0]?.data).toEqual({ peerName: "Bob", seq: 2 });
			expect(drained[1]?.count).toBeUndefined();
		});

		it("accumulates count across many merges", () => {
			const q = new NotificationQueue();
			for (let i = 0; i < 5; i += 1) {
				q.enqueue(
					makeNotification({ id: `n-${i}`, coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
				);
			}
			const drained = q.drain();
			expect(drained).toHaveLength(1);
			expect(drained[0]?.count).toBe(5);
		});

		it("replace strategy swaps content and type without setting count", () => {
			const q = new NotificationQueue();
			q.enqueue(
				makeNotification({
					id: "pending",
					type: "escalation",
					oneLiner: "Pending transfer request awaiting approval (req-1)",
					coalesceKey: "req:req-1",
					coalesceStrategy: "replace",
				}),
			);
			q.enqueue(
				makeNotification({
					id: "completed",
					type: "info",
					oneLiner: "transfer action req-1 completed",
					coalesceKey: "req:req-1",
					coalesceStrategy: "replace",
				}),
			);

			const drained = q.drain();
			expect(drained).toHaveLength(1);
			expect(drained[0]?.id).toBe("pending");
			expect(drained[0]?.type).toBe("info");
			expect(drained[0]?.oneLiner).toBe("transfer action req-1 completed");
			expect(drained[0]?.count).toBeUndefined();
		});

		it("distinct keys never merge", () => {
			const q = new NotificationQueue();
			q.enqueue(
				makeNotification({ id: "a", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);
			q.enqueue(
				makeNotification({ id: "b", coalesceKey: "msg:conn-2", coalesceStrategy: "count" }),
			);
			expect(q.drain()).toHaveLength(2);
		});

		it("drain resets coalescing: a re-enqueued key starts a fresh entry", () => {
			const q = new NotificationQueue();
			q.enqueue(
				makeNotification({ id: "a", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);
			q.enqueue(
				makeNotification({ id: "b", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);
			expect(q.drain()).toHaveLength(1);

			q.enqueue(
				makeNotification({ id: "c", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);
			const drained = q.drain();
			expect(drained).toHaveLength(1);
			expect(drained[0]?.id).toBe("c");
			expect(drained[0]?.count).toBeUndefined();
		});

		it("does not merge into an entry evicted by maxSize", () => {
			const q = new NotificationQueue({ maxSize: 2 });
			q.enqueue(
				makeNotification({ id: "a", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);
			q.enqueue(makeNotification({ id: "b" }));
			q.enqueue(makeNotification({ id: "c" }));
			// "a" was evicted; a same-key enqueue must land as a fresh entry, not
			// merge into the dropped object.
			q.enqueue(
				makeNotification({ id: "d", coalesceKey: "msg:conn-1", coalesceStrategy: "count" }),
			);

			const drained = q.drain();
			expect(drained.map((n) => n.id)).toEqual(["c", "d"]);
			expect(drained[1]?.count).toBeUndefined();
		});

		it("merging does not mutate the caller's notification object", () => {
			const q = new NotificationQueue();
			const first = makeNotification({
				id: "a",
				oneLiner: "msg 1",
				coalesceKey: "msg:conn-1",
				coalesceStrategy: "count",
			});
			q.enqueue(first);
			q.enqueue(
				makeNotification({
					id: "b",
					oneLiner: "msg 2",
					coalesceKey: "msg:conn-1",
					coalesceStrategy: "count",
				}),
			);
			expect(first.oneLiner).toBe("msg 1");
			expect(first.count).toBeUndefined();
		});

		it("coalesce: false preserves the legacy append-only behavior", () => {
			const q = new NotificationQueue({ coalesce: false });
			const a = makeNotification({ id: "a", coalesceKey: "msg:conn-1", coalesceStrategy: "count" });
			const b = makeNotification({ id: "b", coalesceKey: "msg:conn-1", coalesceStrategy: "count" });
			q.enqueue(a);
			q.enqueue(b);

			const drained = q.drain();
			expect(drained).toHaveLength(2);
			expect(drained[0]).toEqual(a);
			expect(drained[1]).toEqual(b);
			expect(drained[0]?.count).toBeUndefined();
		});
	});
});
