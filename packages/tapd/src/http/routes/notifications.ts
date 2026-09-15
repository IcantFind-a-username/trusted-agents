import {
	type AttentionDelta,
	type AttentionPeerRef,
	type FileAttentionLedger,
	type ITrustStore,
	attentionPeerKey,
} from "trusted-agents-core";
import { notificationEventCount, planNotificationRender } from "../../notification-format.js";
import type { NotificationQueue, TapNotification } from "../../notification-queue.js";
import { applyNotificationQuota } from "../../notification-quota.js";
import type { RouteHandler } from "../router.js";

export interface NotificationsRouteOptions {
	/**
	 * When set, every drain records attention accounting before returning;
	 * `read` also feeds the weekly quota check when `trustStore` is set.
	 */
	ledger?: Pick<FileAttentionLedger, "record" | "renderedInWindow">;
	/** The daemon's own identity, stamped on the ledger file. */
	identity?: () => AttentionPeerRef;
	/**
	 * When set together with `ledger`, drained batches pass through the
	 * weekly notification quota fold (grant constraints looked up here)
	 * before accounting and before the batch goes over the wire — so every
	 * host, including the Hermes Python mirror, sees the folded batch.
	 */
	trustStore?: Pick<ITrustStore, "findByAgentId">;
	/**
	 * A ledger write failure must never fail the drain — a 500 here starves
	 * host plugins of notifications. The error is handed here instead.
	 */
	onLedgerError?: (error: unknown) => void;
}

export function createNotificationsRoute(
	queue: NotificationQueue,
	options: NotificationsRouteOptions = {},
): RouteHandler<unknown, { notifications: TapNotification[] }> {
	return async () => {
		let notifications = queue.drain();
		if (options.trustStore && options.ledger && notifications.length > 0) {
			notifications = await applyNotificationQuota(notifications, {
				trustStore: options.trustStore,
				ledger: options.ledger,
				onError: options.onLedgerError,
			});
		}
		if (options.ledger && notifications.length > 0) {
			try {
				await options.ledger.record(buildAttentionDeltas(notifications), {
					identity: options.identity?.(),
				});
			} catch (error) {
				options.onLedgerError?.(error);
			}
		}
		return { notifications };
	};
}

/**
 * Derives per-peer attention costs for one drained batch from the canonical
 * render plan: each rendered line bills its peer `ceil(chars/4)` tokens plus
 * one rendered notification; block overhead (header/footer) bills the
 * unattributed bucket; omitted entries bill their peer the suppressed event
 * count. Escalations are counted per drained notification whether rendered
 * or not. Peers resolve from `data.peerChain` + `data.peerAgentId`; action
 * lifecycle events carry no peer on the wire and land unattributed.
 */
export function buildAttentionDeltas(notifications: TapNotification[]): AttentionDelta[] {
	const deltas = new Map<string, AttentionDelta>();
	const bump = (
		peer: AttentionPeerRef | null,
		field: "notificationsRendered" | "tokensInjected" | "escalations" | "overflowSuppressed",
		amount: number,
	): void => {
		if (amount === 0) return;
		const key = attentionPeerKey(peer);
		let delta = deltas.get(key);
		if (!delta) {
			delta = { peer };
			deltas.set(key, delta);
		}
		delta[field] = (delta[field] ?? 0) + amount;
	};

	for (const notification of notifications) {
		if (notification.type === "escalation") {
			bump(peerOf(notification), "escalations", 1);
		}
	}

	const plan = planNotificationRender(notifications);
	if (plan) {
		for (const { notification, line } of plan.rendered) {
			const peer = peerOf(notification);
			// A quota-fold summary must not count as a rendered line for its
			// peer: renderedInWindow feeds the next quota decision, and
			// billing the fold itself would re-top the trailing window on
			// every drain — the documented "until the window rolls" recovery
			// would never happen. Its token cost is still real and billed.
			if (notification.data?.quotaFolded !== true) {
				bump(peer, "notificationsRendered", 1);
			}
			bump(peer, "tokensInjected", estimateTokens(line));
		}
		let overheadChars = plan.header.length;
		if (plan.footer !== null) {
			overheadChars += plan.footer.length + 1;
		}
		bump(null, "tokensInjected", Math.ceil(overheadChars / 4));
		for (const notification of plan.omitted) {
			bump(peerOf(notification), "overflowSuppressed", notificationEventCount(notification));
		}
	}

	return [...deltas.values()];
}

function estimateTokens(text: string): number {
	// +1 for the newline joining the line into the injected block.
	return Math.ceil((text.length + 1) / 4);
}

function peerOf(notification: TapNotification): AttentionPeerRef | null {
	const data = notification.data;
	if (!data) return null;
	const chain = data.peerChain;
	const agentId = data.peerAgentId;
	if (typeof chain === "string" && chain.length > 0 && typeof agentId === "number") {
		return { chain, agentId };
	}
	return null;
}
