import { describe, expect, it } from "vitest";
import {
	drainAndFormatNotifications,
	formatNotificationLines,
} from "../src/notifications-drain.js";
import type { OpenClawTapdClient, TapNotification } from "../src/tapd-client.js";

function clientWith(notifications: TapNotification[]): OpenClawTapdClient {
	return {
		drainNotifications: async () => ({ notifications }),
	} as unknown as OpenClawTapdClient;
}

function note(
	id: string,
	type: TapNotification["type"],
	oneLiner: string,
	extra: Partial<TapNotification> = {},
): TapNotification {
	return { id, type, oneLiner, createdAt: "2026-01-01T00:00:00Z", ...extra };
}

describe("drainAndFormatNotifications", () => {
	it("returns null when the queue is empty", async () => {
		const result = await drainAndFormatNotifications(clientWith([]));
		expect(result).toBeNull();
	});

	it("renders a single info notification with its label", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([note("1", "info", "alice said hi")]),
		);
		expect(result).toEqual({
			prependContext: ["[TAP Notifications]", "- INFO: alice said hi"].join("\n"),
		});
	});

	it("renders mixed notification types with the right labels", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([
				note("1", "escalation", "transfer needs approval"),
				note("2", "auto-reply", "auto reply sent"),
				note("3", "summary", "10 messages summarized"),
				note("4", "info", "fyi"),
			]),
		);
		expect(result?.prependContext).toBe(
			[
				"[TAP Notifications]",
				"- ESCALATION: transfer needs approval",
				"- AUTO-REPLY: auto reply sent",
				"- SUMMARY: 10 messages summarized",
				"- INFO: fyi",
			].join("\n"),
		);
	});

	it("skips entries with empty one-liners", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([note("1", "info", "  "), note("2", "info", "kept"), note("3", "info", "")]),
		);
		expect(result?.prependContext).toBe(["[TAP Notifications]", "- INFO: kept"].join("\n"));
	});

	it("returns null when every entry has an empty one-liner", async () => {
		const result = await drainAndFormatNotifications(
			clientWith([note("1", "info", ""), note("2", "info", "  ")]),
		);
		expect(result).toBeNull();
	});
});

describe("formatNotificationLines", () => {
	it("returns null for an empty array", () => {
		expect(formatNotificationLines([])).toBeNull();
	});

	it("moves escalations first while preserving arrival order within each class", () => {
		const block = formatNotificationLines([
			note("a", "info", "info a"),
			note("b", "escalation", "esc b"),
			note("c", "info", "info c"),
			note("d", "escalation", "esc d"),
		]);
		expect(block).toBe(
			[
				"[TAP Notifications]",
				"- ESCALATION: esc b",
				"- ESCALATION: esc d",
				"- INFO: info a",
				"- INFO: info c",
			].join("\n"),
		);
	});

	it("appends an (xN) suffix only when count >= 2", () => {
		const block = formatNotificationLines([
			note("a", "info", "New message from Bob: hi", { count: 3 }),
			note("b", "info", "counted once", { count: 1 }),
			note("c", "info", "no count field"),
		]);
		expect(block).toBe(
			[
				"[TAP Notifications]",
				"- INFO: New message from Bob: hi (x3)",
				"- INFO: counted once",
				"- INFO: no count field",
			].join("\n"),
		);
	});

	it("renders the count suffix on escalations too", () => {
		const block = formatNotificationLines([
			note("a", "escalation", "connection request failed", { count: 2 }),
		]);
		expect(block).toBe(
			["[TAP Notifications]", "- ESCALATION: connection request failed (x2)"].join("\n"),
		);
	});

	it("keeps an escalation visible past a 20-message chatter flood", () => {
		const flood: TapNotification[] = [];
		for (let i = 0; i < 25; i += 1) {
			flood.push(note(String(i), "info", `msg ${i}`));
		}
		flood.push(note("esc", "escalation", "transfer needs approval"));

		const lines = formatNotificationLines(flood)?.split("\n") ?? [];
		expect(lines[1]).toBe("- ESCALATION: transfer needs approval");
		// 1 header + 20 body + 1 summary footer = 22
		expect(lines).toHaveLength(22);
		expect(lines[lines.length - 1]).toBe("- SUMMARY: omitted: 6 info.");
	});

	it("keeps rendering escalations beyond the cap and groups the omitted tail", () => {
		const notifications: TapNotification[] = [];
		for (let i = 0; i < 25; i += 1) {
			notifications.push(note(`e-${i}`, "escalation", `esc ${i}`));
		}
		for (let i = 0; i < 5; i += 1) {
			notifications.push(note(`i-${i}`, "info", `info ${i}`));
		}

		const lines = formatNotificationLines(notifications)?.split("\n") ?? [];
		expect(lines).toHaveLength(22);
		for (let i = 1; i <= 20; i += 1) {
			expect(lines[i]).toContain("- ESCALATION:");
		}
		expect(lines[21]).toBe("- SUMMARY: omitted: 5 escalations, 5 info.");
	});

	it("groups omitted info messages by peer, summing coalesced counts", () => {
		const notifications: TapNotification[] = [];
		for (let i = 0; i < 20; i += 1) {
			notifications.push(note(`keep-${i}`, "info", `kept ${i}`));
		}
		notifications.push(
			note("bob", "info", "New message from Bob: hi", {
				count: 12,
				data: { peerName: "Bob", peerAgentId: 7 },
			}),
			note("carol", "info", "New message from Carol: yo", {
				count: 3,
				data: { peerName: "Carol", peerAgentId: 8 },
			}),
			note("anon", "info", "New message from peer: hm", { data: { peerAgentId: 9 } }),
			note("bare", "info", "Connection established with Dave"),
			note("late-esc", "escalation", "transfer needs approval"),
		);

		const lines = formatNotificationLines(notifications)?.split("\n") ?? [];
		// The escalation enters the rendered window, pushing one more info line out.
		expect(lines[1]).toBe("- ESCALATION: transfer needs approval");
		expect(lines[lines.length - 1]).toBe(
			"- SUMMARY: omitted: 12 messages from Bob, 3 messages from Carol, 1 message from agent #9, 2 info.",
		);
		expect(lines.join("\n")).not.toContain("undefined");
	});

	it("does not let blank one-liners burn rendered slots", () => {
		const notifications: TapNotification[] = [note("blank", "info", "   ")];
		for (let i = 0; i < 20; i += 1) {
			notifications.push(note(`n-${i}`, "info", `msg ${i}`));
		}
		const lines = formatNotificationLines(notifications)?.split("\n") ?? [];
		// The blank entry is dropped before the cap: all 20 real lines render,
		// no summary footer.
		expect(lines).toHaveLength(21);
		expect(lines[1]).toBe("- INFO: msg 0");
	});
});
