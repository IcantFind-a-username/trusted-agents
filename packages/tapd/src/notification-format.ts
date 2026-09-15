import type { TapNotification, TapNotificationType } from "./notification-queue.js";

const LABELS: Record<TapNotificationType, string> = {
	info: "INFO",
	escalation: "ESCALATION",
	"auto-reply": "AUTO-REPLY",
	summary: "SUMMARY",
};

export const MAX_RENDERED_NOTIFICATIONS = 20;
const HEADER = "[TAP Notifications]";

export interface RenderedNotificationLine {
	notification: TapNotification;
	line: string;
}

export interface NotificationRenderPlan {
	header: string;
	rendered: RenderedNotificationLine[];
	omitted: TapNotification[];
	footer: string | null;
}

/**
 * Canonical render plan for a drained batch: which notifications make the
 * `[TAP Notifications]` block and as what line, and which fall past the cap.
 * This is the single source of truth for rendering — the OpenClaw host
 * renders exactly this, the Hermes Python plugin mirrors it (plus identity
 * prefixes), and the daemon's attention accounting derives token costs from
 * it.
 *
 * Processing order: drop empty one-liners (they never burn a rendered slot),
 * stable-partition escalations first (arrival order preserved within each
 * class — the cap can then never silently drop an approval request behind
 * peer chatter), cap at MAX_RENDERED_NOTIFICATIONS, and summarize the
 * omitted tail grouped by peer/type with event counts. Entries coalesced
 * upstream (`count` >= 2) render an ` (xN)` suffix; `count` absent means 1 —
 * notifications from an older tapd render unchanged.
 */
export function planNotificationRender(
	notifications: TapNotification[],
): NotificationRenderPlan | null {
	const renderable = notifications.filter((n) => (n.oneLiner ?? "").trim().length > 0);
	if (renderable.length === 0) return null;

	const ordered = [
		...renderable.filter((n) => n.type === "escalation"),
		...renderable.filter((n) => n.type !== "escalation"),
	];

	const rendered = ordered.slice(0, MAX_RENDERED_NOTIFICATIONS).map((notification) => ({
		notification,
		line: `- ${LABELS[notification.type] ?? "INFO"}: ${notification.oneLiner.trim()}${countSuffix(notification)}`,
	}));
	const omitted = ordered.slice(MAX_RENDERED_NOTIFICATIONS);
	const footer = omitted.length > 0 ? `- SUMMARY: omitted: ${summarizeOmitted(omitted)}.` : null;

	return { header: HEADER, rendered, omitted, footer };
}

/** Renders the plan as the final block; null when nothing would surface. */
export function formatNotificationLines(notifications: TapNotification[]): string | null {
	const plan = planNotificationRender(notifications);
	if (plan === null) return null;
	const lines = [plan.header, ...plan.rendered.map((r) => r.line)];
	if (plan.footer !== null) {
		lines.push(plan.footer);
	}
	return lines.join("\n");
}

/** Number of underlying events a (possibly coalesced) notification covers. */
export function notificationEventCount(notification: TapNotification): number {
	return typeof notification.count === "number" && notification.count >= 1 ? notification.count : 1;
}

function countSuffix(notification: TapNotification): string {
	const count = notification.count;
	return typeof count === "number" && count >= 2 ? ` (x${count})` : "";
}

function peerLabel(notification: TapNotification): string | null {
	const data = notification.data;
	if (!data) return null;
	const peerName = data.peerName;
	if (typeof peerName === "string" && peerName.trim().length > 0) return peerName.trim();
	const peerAgentId = data.peerAgentId;
	if (typeof peerAgentId === "number" || typeof peerAgentId === "string") {
		return `agent #${peerAgentId}`;
	}
	return null;
}

function typeBucketLabel(type: TapNotification["type"], events: number): string {
	switch (type) {
		case "escalation":
			return events === 1 ? "escalation" : "escalations";
		case "auto-reply":
			return events === 1 ? "auto-reply" : "auto-replies";
		case "summary":
			return events === 1 ? "summary" : "summaries";
		default:
			return "info";
	}
}

function summarizeOmitted(omitted: TapNotification[]): string {
	const peerBuckets = new Map<string, number>();
	const typeBuckets = new Map<TapNotification["type"], number>();
	for (const notification of omitted) {
		const events = notificationEventCount(notification);
		const label = notification.type === "info" ? peerLabel(notification) : null;
		if (label) {
			peerBuckets.set(label, (peerBuckets.get(label) ?? 0) + events);
		} else {
			typeBuckets.set(notification.type, (typeBuckets.get(notification.type) ?? 0) + events);
		}
	}
	const parts: string[] = [];
	for (const [label, events] of peerBuckets) {
		parts.push(`${events} ${events === 1 ? "message" : "messages"} from ${label}`);
	}
	for (const [type, events] of typeBuckets) {
		parts.push(`${events} ${typeBucketLabel(type, events)}`);
	}
	return parts.join(", ");
}
