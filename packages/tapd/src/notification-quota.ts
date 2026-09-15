import { randomUUID } from "node:crypto";
import type { FileAttentionLedger, ITrustStore, PermissionGrant } from "trusted-agents-core";
import { MESSAGE_SEND, findActiveGrantsByScope } from "trusted-agents-core";
import { notificationEventCount } from "./notification-format.js";
import type { TapNotification } from "./notification-queue.js";

/**
 * Constraint key on a `message/send` grant: how many rendered notification
 * lines the grant holder's free messages may claim per trailing 7 UTC
 * days. Grants without it are unmetered (today's behavior).
 */
export const NOTIFICATIONS_PER_WEEK_CONSTRAINT = "notificationsPerWeek";
export const QUOTA_WINDOW_DAYS = 7;

export interface NotificationQuotaDeps {
	trustStore: Pick<ITrustStore, "findByAgentId">;
	ledger: Pick<FileAttentionLedger, "renderedInWindow">;
	now?: () => Date;
	onError?: (error: unknown) => void;
}

/**
 * Enforce per-grant weekly notification quotas on a drained batch, before
 * accounting and before any host renders it: an over-quota grant holder's
 * plain info notifications collapse into ONE summary line (nothing is
 * dropped — the peer's chatter just stops costing per-line attention until
 * the window rolls). Escalations are never folded: paid priority stamps
 * and pending approvals outrank the free-tier quota by design — postage
 * buys quota and wake-ups, the grant alone only buys standard delivery.
 *
 * Applied inside the daemon's drain (not in the renderer) so every host —
 * OpenClaw, Hermes's Python mirror, and the attention accounting — sees
 * the same folded batch. Enforcement is per-drain and fails open: if the
 * trust store or ledger cannot answer, the batch passes through unfolded —
 * a quota must never lose messages.
 */
export async function applyNotificationQuota(
	notifications: TapNotification[],
	deps: NotificationQuotaDeps,
): Promise<TapNotification[]> {
	const byPeer = new Map<string, { chain: string; agentId: number; indexes: number[] }>();
	for (const [index, notification] of notifications.entries()) {
		if (notification.type !== "info") continue;
		const chain = notification.data?.peerChain;
		const agentId = notification.data?.peerAgentId;
		if (typeof chain !== "string" || typeof agentId !== "number") continue;
		const key = `${chain}#${agentId}`;
		let entry = byPeer.get(key);
		if (!entry) {
			entry = { chain, agentId, indexes: [] };
			byPeer.set(key, entry);
		}
		entry.indexes.push(index);
	}
	if (byPeer.size === 0) {
		return notifications;
	}

	const folded = new Map<number, TapNotification | null>();
	for (const { chain, agentId, indexes } of byPeer.values()) {
		try {
			const contact = await deps.trustStore.findByAgentId(agentId, chain);
			if (!contact) continue;
			const quota = weeklyNotificationQuota(
				findActiveGrantsByScope(contact.permissions.grantedByMe, MESSAGE_SEND),
			);
			if (quota === undefined) continue;
			const used = await deps.ledger.renderedInWindow(
				{ chain, agentId },
				QUOTA_WINDOW_DAYS,
				deps.now?.(),
			);
			if (used < quota) continue;

			const foldable = indexes.map((index) => notifications[index] as TapNotification);
			const events = foldable.reduce(
				(sum, notification) => sum + notificationEventCount(notification),
				0,
			);
			const peerName = firstPeerName(foldable) ?? `agent #${agentId}`;
			const summary: TapNotification = {
				id: `note-${randomUUID()}`,
				type: "summary",
				oneLiner: `${events} ${events === 1 ? "notification" : "notifications"} from ${peerName} folded — weekly notification quota reached (${quota}/week)`,
				createdAt: foldable[foldable.length - 1]?.createdAt ?? new Date().toISOString(),
				count: events,
				data: {
					peerChain: chain,
					peerAgentId: agentId,
					peerName,
					quotaFolded: true,
					quota,
				},
			};
			// The summary takes the first folded slot; the rest vanish.
			folded.set(indexes[0] as number, summary);
			for (const index of indexes.slice(1)) {
				folded.set(index, null);
			}
		} catch (error) {
			deps.onError?.(error);
		}
	}
	if (folded.size === 0) {
		return notifications;
	}
	const result: TapNotification[] = [];
	for (const [index, notification] of notifications.entries()) {
		if (!folded.has(index)) {
			result.push(notification);
			continue;
		}
		const replacement = folded.get(index);
		if (replacement) {
			result.push(replacement);
		}
	}
	return result;
}

/**
 * The effective weekly quota across a peer's active message/send grants:
 * the most permissive one wins (they were all issued by this agent).
 * Undefined = unmetered. A quota of 0 means "no free notification lines".
 */
function weeklyNotificationQuota(grants: PermissionGrant[]): number | undefined {
	let quota: number | undefined;
	for (const grant of grants) {
		const value = grant.constraints?.[NOTIFICATIONS_PER_WEEK_CONSTRAINT];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) continue;
		if (quota === undefined || value > quota) {
			quota = value;
		}
	}
	return quota;
}

function firstPeerName(notifications: TapNotification[]): string | undefined {
	for (const notification of notifications) {
		const name = notification.data?.peerName;
		if (typeof name === "string" && name.trim().length > 0) {
			return name.trim();
		}
	}
	return undefined;
}
