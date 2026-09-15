export type TapNotificationType = "info" | "escalation" | "auto-reply" | "summary";

export interface TapNotification {
	id: string;
	type: TapNotificationType;
	oneLiner: string;
	createdAt: string;
	data?: Record<string, unknown>;
	/**
	 * Buffered entries carrying the same key are merged in place instead of
	 * stacking one line per event: the entry keeps its first-arrival buffer
	 * slot and `id`, while `type`/`oneLiner`/`createdAt`/`data` reflect the
	 * newest event. Because content is newest-wins, `createdAt` across a
	 * drained array is not monotonic; `count` covers the merged span.
	 */
	coalesceKey?: string;
	/**
	 * How same-key merges accumulate. `"count"` (the default) increments
	 * `count` — N events of the same thing, e.g. messages from one peer.
	 * `"replace"` swaps the content without ever setting `count` — a state
	 * transition (pending → completed), not a repeat of the same thing.
	 */
	coalesceStrategy?: "count" | "replace";
	/**
	 * Number of underlying events this entry represents. Absent means 1.
	 * Only the `"count"` strategy accumulates it.
	 */
	count?: number;
}

export interface NotificationQueueOptions {
	/**
	 * Maximum number of buffered notifications. When the queue is full,
	 * `enqueue` drops the oldest entry so new events always land — this
	 * queue is a heads-up for consumers, not durable storage. If
	 * `/api/notifications/drain` isn't being called (consumer offline, host
	 * misconfigured), an unbounded buffer would grow indefinitely and could
	 * destabilize the daemon over time; the cap bounds that at a predictable
	 * number of most-recent notifications instead.
	 */
	maxSize?: number;
	/**
	 * Merge entries that share a `coalesceKey` (default true). `false`
	 * preserves the legacy append-only FIFO behavior — used by tests and the
	 * flood demo as the before/after control.
	 */
	coalesce?: boolean;
}

const DEFAULT_MAX_SIZE = 1000;

export class NotificationQueue {
	private buffer: TapNotification[] = [];
	/**
	 * coalesceKey → buffered entry. Must stay in sync with `buffer`: cleared
	 * on drain (the buffer is swapped out) and pruned on max-size eviction —
	 * a stale mapping would merge later events into an object that is no
	 * longer buffered, silently losing them.
	 */
	private index = new Map<string, TapNotification>();
	private readonly maxSize: number;
	private readonly coalesce: boolean;

	constructor(options: NotificationQueueOptions = {}) {
		const size = options.maxSize ?? DEFAULT_MAX_SIZE;
		if (!Number.isInteger(size) || size <= 0) {
			throw new Error("NotificationQueue maxSize must be a positive integer");
		}
		this.maxSize = size;
		this.coalesce = options.coalesce ?? true;
	}

	enqueue(notification: TapNotification): void {
		const key = this.coalesce ? notification.coalesceKey : undefined;
		if (key) {
			const existing = this.index.get(key);
			if (existing) {
				existing.type = notification.type;
				existing.oneLiner = notification.oneLiner;
				existing.createdAt = notification.createdAt;
				existing.data = notification.data;
				existing.coalesceStrategy = notification.coalesceStrategy;
				if ((notification.coalesceStrategy ?? "count") === "count") {
					existing.count = (existing.count ?? 1) + (notification.count ?? 1);
				}
				// Merged in place — the buffer did not grow, so no eviction check.
				return;
			}
			// Buffer a copy so in-place merges never mutate the caller's object.
			const entry = { ...notification };
			this.buffer.push(entry);
			this.index.set(key, entry);
		} else {
			this.buffer.push(notification);
		}
		if (this.buffer.length > this.maxSize) {
			const dropped = this.buffer.shift();
			if (dropped?.coalesceKey && this.index.get(dropped.coalesceKey) === dropped) {
				this.index.delete(dropped.coalesceKey);
			}
		}
	}

	drain(): TapNotification[] {
		const drained = this.buffer;
		this.buffer = [];
		this.index.clear();
		return drained;
	}

	size(): number {
		return this.buffer.length;
	}
}
