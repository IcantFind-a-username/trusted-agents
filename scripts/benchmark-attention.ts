// Before/after demo for the Phase 1 notification pipeline changes.
//
// Scenario: three peers flood the daemon with 50 chat messages, then a
// transfer request lands and needs approval. The legacy pipeline renders
// 20 interleaved chatter lines and buries the escalation in an opaque
// "N more omitted" footer; the coalescing pipeline renders the escalation
// first plus one counted line per peer.
//
// Run from the repo root: bun scripts/demo-notification-flood.ts

import type { TapEvent } from "../packages/core/src/runtime/event-types.ts";
import { classifyEventToNotification } from "../packages/tapd/src/notification-classifier.ts";
import { formatNotificationLines } from "../packages/tapd/src/notification-format.ts";
import {
	NotificationQueue,
	type TapNotification,
} from "../packages/tapd/src/notification-queue.ts";

const PEERS = [
	{ connectionId: "conn-alice", peerAgentId: 11, peerName: "Alice", peerChain: "eip155:8453" },
	{ connectionId: "conn-bob", peerAgentId: 22, peerName: "Bob", peerChain: "eip155:8453" },
	{ connectionId: "conn-carol", peerAgentId: 33, peerName: "Carol", peerChain: "eip155:8453" },
];

const MESSAGE_FLOOD_SIZES = [10, 50, 100, 500, 1000];

function buildEvents(messageFloodSize: number): TapEvent[] {
	const events: TapEvent[] = [];
	for (let i = 0; i < messageFloodSize; i += 1) {
		const peer = PEERS[i % PEERS.length];
		if (!peer) continue;
		events.push({
			id: `evt-msg-${i}`,
			occurredAt: `2026-08-27T10:00:${String(i).padStart(2, "0")}.000Z`,
			identityAgentId: 1,
			type: "message.received",
			conversationId: `conv-${peer.connectionId}`,
			peer,
			messageId: `m-${i}`,
			text: `Status update #${i} from ${peer.peerName}: still syncing the shipment sheet`,
			scope: "general-chat",
		});
	}
	// The escalation arrives AFTER the flood — the worst case for the legacy
	// FIFO cap, which drops it into the omitted tail.
	events.push({
		id: "evt-pending",
		occurredAt: "2026-08-27T10:01:00.000Z",
		identityAgentId: 1,
		type: "action.pending",
		conversationId: "conv-conn-dave",
		requestId: "req-transfer-1",
		kind: "transfer",
		payload: { asset: "USDC", amount: "25.00" },
		awaitingDecision: true,
	});
	return events;
}

const LEGACY_LABELS: Record<TapNotification["type"], string> = {
	info: "INFO",
	escalation: "ESCALATION",
	"auto-reply": "AUTO-REPLY",
	summary: "SUMMARY",
};

/**
 * Verbatim copy of the pre-Phase-1 renderer loop, kept demo-local so the
 * production code carries no legacy render mode. The queue's
 * `coalesce: false` option is the only legacy switch that ships.
 */
function legacyFormatNotificationLines(notifications: TapNotification[]): string | null {
	if (notifications.length === 0) return null;
	const lines: string[] = ["[TAP Notifications]"];
	let rendered = 0;
	for (const notification of notifications.slice(0, 20)) {
		const label = LEGACY_LABELS[notification.type] ?? "INFO";
		const oneLiner = (notification.oneLiner ?? "").trim();
		if (!oneLiner) continue;
		lines.push(`- ${label}: ${oneLiner}`);
		rendered += 1;
	}
	if (rendered === 0) return null;
	const remaining = notifications.length - 20;
	if (remaining > 0) {
		lines.push(`- SUMMARY: ${remaining} more TAP notifications omitted.`);
	}
	return lines.join("\n");
}

function estimateTokens(block: string): number {
	return Math.ceil(block.length / 4);
}

function hasVisibleEscalation(block: string): boolean {
	return block.includes("- ESCALATION:");
}

function main(): void {
	const results: Array<{
	messageFloodSize: number;
	legacyTokens: number;
	coalescedTokens: number;
	reductionPercent: number;
	legacyEscalationVisible: boolean;
	coalescedEscalationVisible: boolean;
}> = [];
	for (const messageFloodSize of MESSAGE_FLOOD_SIZES) {
    const events = buildEvents(messageFloodSize);
	const legacyQueue = new NotificationQueue({ coalesce: false });
	const coalescedQueue = new NotificationQueue();
	for (const event of events) {
		const notification = classifyEventToNotification(event);
		if (!notification) continue;
		legacyQueue.enqueue(notification);
		coalescedQueue.enqueue(notification);
	}

	const legacyBlock = legacyFormatNotificationLines(legacyQueue.drain()) ?? "(empty)";
	const coalescedBlock = formatNotificationLines(coalescedQueue.drain()) ?? "(empty)";

	console.log(`Scenario: ${messageFloodSize} messages from ${PEERS.length} peers,`);
	console.log("then 1 transfer request awaiting approval.\n");

	console.log("── BEFORE (per-event FIFO, hard 20-line cap) ──");
	console.log(legacyBlock);
	const legacyEscalationVisible = hasVisibleEscalation(legacyBlock);

	console.log(`\n≈ ${estimateTokens(legacyBlock)} tokens injected per prompt;`);
	console.log(
		legacyEscalationVisible
			? "the ESCALATION is visible."
			: "the ESCALATION is buried inside the omitted tail.",
	);

	console.log("── AFTER (coalesced queue + escalation-first rendering) ──");
	console.log(coalescedBlock);
const coalescedEscalationVisible = hasVisibleEscalation(coalescedBlock);
const legacyTokens = estimateTokens(legacyBlock);
const coalescedTokens = estimateTokens(coalescedBlock);
const reductionPercent =
    ((legacyTokens - coalescedTokens) / legacyTokens) * 100;
results.push({
    messageFloodSize,
    legacyTokens,
    coalescedTokens,
    reductionPercent,
    legacyEscalationVisible,
    coalescedEscalationVisible,
});



	console.log(`\n≈ ${estimateTokens(coalescedBlock)} tokens injected per prompt;`);
	console.log(
		coalescedEscalationVisible
			? "the ESCALATION is visible."
			: "the ESCALATION is not visible.",
	);
	}
		console.log("\n=== BENCHMARK SUMMARY ===");
	console.table(
		results.map((result) => ({
			Messages: result.messageFloodSize,
			LegacyTokens: result.legacyTokens,
			NewTokens: result.coalescedTokens,
			Reduction: `${result.reductionPercent.toFixed(1)}%`,
			LegacyEscalation: result.legacyEscalationVisible ? "Visible" : "Hidden",
			NewEscalation: result.coalescedEscalationVisible ? "Visible" : "Hidden",
		})),
	);
}

main();