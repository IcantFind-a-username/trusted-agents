/**
 * Typed event union representing the discrete things `TapMessagingService.emitEvent`
 * can produce. Consumers (tapd, host plugins) translate the raw `Record<string, unknown>`
 * payload from `emitEvent` into one of these typed shapes.
 *
 * The runtime itself still emits `Record<string, unknown>` to preserve backward
 * compatibility with existing consumers; this file is the canonical schema.
 */

export interface TapEventEnvelope {
	id: string;
	occurredAt: string;
	identityAgentId: number;
}

export interface TapPeerRef {
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerChain: string;
}

/**
 * Postage actually charged for an inbound message by attention
 * enforcement. Only present when a stamp was debited: grant holders ride
 * free (no field), and with enforcement off nothing is charged. A
 * "priority" tier means the stamp covered the receiver's advertised
 * priority price — hosts treat that as an escalation that may wake the
 * agent and widen the rendered excerpt.
 */
export interface PaidPostageRef {
	tier: "standard" | "priority";
	cost: string;
}

export interface MessageReceivedEvent extends TapEventEnvelope {
	type: "message.received";
	conversationId: string;
	peer: TapPeerRef;
	messageId: string;
	text: string;
	scope: string;
	postage?: PaidPostageRef;
}

export interface MessageSentEvent extends TapEventEnvelope {
	type: "message.sent";
	conversationId: string;
	peer: TapPeerRef;
	messageId: string;
	text: string;
	scope: string;
}

export type TapActionKind = "transfer" | "scheduling" | "grant";

export interface ActionRequestedEvent extends TapEventEnvelope {
	type: "action.requested";
	conversationId: string;
	peer: TapPeerRef;
	requestId: string;
	kind: TapActionKind;
	payload: Record<string, unknown>;
	direction: "inbound" | "outbound";
}

export interface ActionCompletedEvent extends TapEventEnvelope {
	type: "action.completed";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	result: Record<string, unknown>;
	txHash?: string;
	completedAt: string;
}

export interface ActionFailedEvent extends TapEventEnvelope {
	type: "action.failed";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	error: string;
}

export interface ActionPendingEvent extends TapEventEnvelope {
	type: "action.pending";
	conversationId: string;
	requestId: string;
	kind: TapActionKind;
	payload: Record<string, unknown>;
	awaitingDecision: true;
}

export interface PendingResolvedEvent extends TapEventEnvelope {
	type: "pending.resolved";
	requestId: string;
	decision: "approved" | "denied";
	decidedBy: "operator" | "auto-grant";
}

export interface ConnectionRequestedEvent extends TapEventEnvelope {
	type: "connection.requested";
	requestId: string;
	peerAgentId: number;
	peerChain: string;
	direction: "inbound" | "outbound";
}

export interface ConnectionEstablishedEvent extends TapEventEnvelope {
	type: "connection.established";
	connectionId: string;
	peer: TapPeerRef;
}

export interface ConnectionFailedEvent extends TapEventEnvelope {
	type: "connection.failed";
	requestId: string;
	error: string;
}

export interface ContactUpdatedEvent extends TapEventEnvelope {
	type: "contact.updated";
	connectionId: string;
	status: string;
	fields: Record<string, unknown>;
}

export interface DaemonStatusEvent extends TapEventEnvelope {
	type: "daemon.status";
	transportConnected: boolean;
	lastSyncAt?: string;
}

export type TapEvent =
	| MessageReceivedEvent
	| MessageSentEvent
	| ActionRequestedEvent
	| ActionCompletedEvent
	| ActionFailedEvent
	| ActionPendingEvent
	| PendingResolvedEvent
	| ConnectionRequestedEvent
	| ConnectionEstablishedEvent
	| ConnectionFailedEvent
	| ContactUpdatedEvent
	| DaemonStatusEvent;

export type TapEventType = TapEvent["type"];
