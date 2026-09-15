import { describe, expect, it } from "vitest";
import {
	MAX_RENDERED_NOTIFICATIONS,
	formatNotificationLines,
	notificationEventCount,
	planNotificationRender,
} from "../../src/notification-format.js";
import type { TapNotification } from "../../src/notification-queue.js";

function note(overrides: Partial<TapNotification> = {}): TapNotification {
	return { id: "n", type: "info", oneLiner: "hello", createdAt: "x", ...overrides };
}

describe("planNotificationRender", () => {
	it("returns null when nothing renders", () => {
		expect(planNotificationRender([])).toBeNull();
		expect(planNotificationRender([note({ oneLiner: "  " })])).toBeNull();
	});

	it("splits rendered and omitted around the cap with escalations first", () => {
		const notifications: TapNotification[] = [];
		for (let i = 0; i < MAX_RENDERED_NOTIFICATIONS + 3; i += 1) {
			notifications.push(note({ id: `i-${i}`, oneLiner: `msg ${i}` }));
		}
		notifications.push(note({ id: "esc", type: "escalation", oneLiner: "approve me" }));

		const plan = planNotificationRender(notifications);
		expect(plan?.rendered).toHaveLength(MAX_RENDERED_NOTIFICATIONS);
		expect(plan?.rendered[0]?.notification.id).toBe("esc");
		expect(plan?.rendered[0]?.line).toBe("- ESCALATION: approve me");
		expect(plan?.omitted.map((n) => n.id)).toEqual(["i-19", "i-20", "i-21", "i-22"]);
		expect(plan?.footer).toBe("- SUMMARY: omitted: 4 info.");
	});

	it("formatNotificationLines is exactly the joined plan", () => {
		const notifications = [note({ id: "a", oneLiner: "one" }), note({ id: "b", oneLiner: "two" })];
		const plan = planNotificationRender(notifications);
		const joined = [plan?.header, ...(plan?.rendered.map((r) => r.line) ?? [])].join("\n");
		expect(formatNotificationLines(notifications)).toBe(joined);
	});
});

describe("notificationEventCount", () => {
	it("defaults to 1 for absent or invalid counts", () => {
		expect(notificationEventCount(note())).toBe(1);
		expect(notificationEventCount(note({ count: 0 }))).toBe(1);
		expect(notificationEventCount(note({ count: 5 }))).toBe(5);
	});
});
