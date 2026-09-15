import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseEther, parseUnits } from "viem";
import { buildActionContext } from "../app/context.js";
import type { TapActionContext, TapActionResult } from "../app/types.js";
import { defineTapApp } from "../app/types.js";
import {
	AsyncMutex,
	AttentionPaymentRequiredError,
	type AttentionQuote,
	PermissionError,
	type PostageRejection,
	TransportError,
	TrustedAgentError,
	ValidationError,
	caip2ToChainId,
	fsErrorCode,
	generateConnectionId,
	generateNonce,
	nowISO,
	toErrorMessage,
} from "../common/index.js";
import type { TrustedAgentsConfig } from "../config/types.js";
import {
	buildConnectionRequest,
	buildConnectionResult,
	buildConnectionRevoke,
	buildPermissionsUpdate,
	deriveConnectionResultId,
	handleConnectionRequest,
	isSelfInvite,
	parseConnectionRevoke,
	parseInviteUrl,
	verifyInvite,
} from "../connection/index.js";
import type { ResolvedAgent } from "../identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../permissions/index.js";
import type { PermissionGrantSet } from "../permissions/types.js";
import { isValidPostageAmount, postageAmountToMicros } from "../postage/amounts.js";
import { signPostageCredit, verifyPostageCredit } from "../postage/certificate.js";
import {
	POSTAGE_APP_ID,
	type PostageAppExtension,
	handlePostageBalance,
	handlePostageTopup,
} from "../postage/handlers.js";
import { FilePostageLedger, postagePeerKey } from "../postage/ledger.js";
import {
	POSTAGE_TOPUP_ACTION,
	type PostageTopupRequest,
	buildPostageTopupPayload,
	extractPostageStamp,
	parsePostageTopupResponse,
} from "../postage/payload.js";
import { extractConnectionIdFromParams } from "../protocol/messages.js";
import {
	ACTION_REQUEST,
	ACTION_RESULT,
	CONNECTION_REQUEST,
	CONNECTION_RESULT,
	CONNECTION_REVOKE,
	MESSAGE_SEND,
	PERMISSIONS_UPDATE,
} from "../protocol/methods.js";
import type {
	AgentIdentifier,
	ConnectionRequestParams,
	ConnectionResultParams,
	ConnectionRevokeParams,
	MessageSendParams,
	PermissionsUpdateParams,
	PostageStamp,
	TextPart,
} from "../protocol/types.js";
import {
	buildSchedulingAcceptText,
	buildSchedulingProposalText,
	buildSchedulingRejectText,
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../scheduling/actions.js";
import {
	findApplicableSchedulingGrants,
	findSchedulableSchedulingSlots,
} from "../scheduling/grants.js";
import {
	type ConfirmedMeeting,
	type ProposedMeeting,
	type SchedulingApprovalContext,
	type SchedulingHandler,
	mapSchedulingDecisionToResult,
} from "../scheduling/handler.js";
import type { SchedulingProposal } from "../scheduling/types.js";
import type { SigningProvider } from "../signing/provider.js";
import type { ProtocolMessage } from "../transport/interface.js";
import type {
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../transport/interface.js";
import type { ITrustStore } from "../trust/trust-store.js";
import { peerLabel } from "../trust/types.js";
import type { Contact } from "../trust/types.js";
import {
	type PermissionGrantRequestAction,
	type TransferActionRequest,
	type TransferActionResponse,
	buildPermissionGrantRequestText,
	buildTransferRequestText,
	buildTransferResponseText,
	extractMessageData,
	parsePermissionGrantRequest,
	parseTransferActionRequest,
	parseTransferActionResponse,
} from "./actions.js";
import { getUsdcAsset } from "./assets.js";
import type { TapCommandJob, TapCommandJobResultPayload } from "./command-job.js";
import type { TapRuntimeContext } from "./default-context.js";
import type {
	PaidPostageRef,
	TapActionKind,
	TapEvent,
	TapEventEnvelope,
	TapPeerRef,
} from "./event-types.js";
import {
	findActiveGrantsByScope,
	normalizeGrantInput,
	replaceGrantedByMe,
	replaceGrantedByPeer,
	summarizeGrant,
	summarizeGrantSet,
} from "./grants.js";
import {
	DEFAULT_MESSAGE_SCOPE,
	appendConversationLog,
	buildOutgoingActionRequest,
	buildOutgoingActionResult,
	buildOutgoingMessageRequest,
	findContactForPeer,
	findUniqueContactForAgentId,
	resolveConversationId,
} from "./message-conversations.js";
import {
	type PermissionLedgerEntry,
	appendPermissionLedgerEntry,
	getPermissionLedgerPath,
} from "./permission-ledger.js";
import type { RequestJournalEntry, RequestJournalLastError } from "./request-journal.js";
import {
	type TransportOwnerInfo,
	TransportOwnerLock,
	TransportOwnershipError,
} from "./transport-owner-lock.js";

type TapEventBody = TapEvent extends infer E
	? E extends TapEvent
		? Omit<E, keyof TapEventEnvelope>
		: never
	: never;

function actionKindFromType(actionType: string): TapActionKind {
	if (actionType.startsWith("scheduling/")) return "scheduling";
	if (actionType.startsWith("transfer/")) return "transfer";
	return "grant";
}

const ACTION_RESULT_WAIT_TIMEOUT_MS = 15_000;
/**
 * Pending outbound result entries older than this are garbage-collected by the
 * retry pipeline. Prevents accumulation when a peer is permanently unreachable
 * (or when the local side has lost track of outbound deliveries across many
 * restarts).
 */
const PENDING_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OUTBOX_POLL_INTERVAL_MS = 1_000;
const QUEUED_JOURNAL_STALE_CLAIM_MS = 5 * 60 * 1000;

export interface TapTransferApprovalContext {
	requestId: string;
	contact: Contact;
	request: TransferActionRequest;
	activeTransferGrants: ReturnType<typeof findActiveGrantsByScope>;
	ledgerPath: string;
}

export interface TapPendingTransferDetails {
	type: "transfer";
	peerName: string;
	peerChain: string;
	asset: TransferActionRequest["asset"];
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
	activeGrantSummary: string[];
	ledgerPath: string;
}

export interface TapPendingSchedulingDetails {
	type: "scheduling";
	peerName: string;
	peerChain: string;
	schedulingId: string;
	title: string;
	duration: number;
	slots: Array<{ start: string; end: string }>;
	originTimezone: string;
	note?: string;
	activeGrantSummary: string[];
	ledgerPath: string;
}

export type TapPendingRequestDetails = TapPendingTransferDetails | TapPendingSchedulingDetails;

export interface TapPendingRequest {
	requestId: string;
	method: string;
	peerAgentId: number;
	/** CAIP-2 chain; empty when unknown — consumers must fail closed on routing. */
	peerChain: string;
	direction: string;
	kind: string;
	status: string;
	correlationId?: string;
	details?: TapPendingRequestDetails;
}

interface PendingActionResultDelivery extends Record<string, unknown> {
	type: "action-result-delivery";
	actionId: string;
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerAddress: `0x${string}`;
	request: ProtocolMessage;
}

interface PendingPermissionsUpdateDelivery extends Record<string, unknown> {
	type: "permissions-update-delivery";
	connectionId: string;
	peerAgentId: number;
	peerName: string;
	peerAddress: `0x${string}`;
	grantSet: PermissionGrantSet;
	request: ProtocolMessage;
}

// ──────────────────────────────────────────────────────────────
// Connect waiter infrastructure (spec §3.2)
// ──────────────────────────────────────────────────────────────

interface ConnectWaiter {
	requestId: string;
	peerAgentId: number;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class ConnectWaiterTimeoutError extends Error {
	constructor(public readonly requestId: string) {
		super(`connect waiter timed out for requestId=${requestId}`);
		this.name = "ConnectWaiterTimeoutError";
	}
}

class ConnectWaiterRejectedError extends Error {
	constructor(
		public readonly requestId: string,
		reason?: string,
	) {
		super(reason ?? "Connection rejected by peer");
		this.name = "ConnectWaiterRejectedError";
	}
}

// ──────────────────────────────────────────────────────────────

interface PendingConnectionResultDelivery extends Record<string, unknown> {
	type: "connection-result-delivery";
	peerAgentId: number;
	/**
	 * CAIP-2 chain id of the target peer. Used so implicit handshake
	 * completion and the short-circuit cache can scope matches per-chain —
	 * two peers on different chains can share the same numeric agentId.
	 *
	 * Optional for backward compatibility with journal entries written by
	 * versions before this field was introduced. Legacy entries are still
	 * delivered via the direct retry pipeline (which only needs peerAgentId
	 * + peerAddress); they just can't participate in the chain-scoped
	 * implicit-completion short-circuit.
	 */
	peerChain?: string;
	peerName: string;
	peerAddress: `0x${string}`;
	request: ProtocolMessage;
	/**
	 * The contact to write to the trust store after a successful send.
	 * Present only for accepted (non-rejected) connection results — rejection
	 * results do not write a contact. Stored so the retry pipeline can
	 * complete the contact write on reconciliation without re-running the
	 * full handler.
	 *
	 * Optional for backward compatibility with entries written before this
	 * field was introduced. Legacy entries are retried for delivery only;
	 * the contact write is skipped if the field is absent.
	 */
	plannedContact?: Contact;
}

const DELIVERY_FAILURE_METADATA_KEY = "__deliveryFailure";

interface DeliveryFailureMetadata {
	type: "delivery-failure";
	attempts: number;
	lastAttemptAt: string;
	lastError: string;
}

interface PendingConnectionRequest extends Record<string, unknown> {
	type: "connection-request";
	message: ProtocolMessage;
}

interface RecordedTransferResponseMetadata extends Record<string, unknown> {
	type: "transfer-response";
	response: TransferActionResponse;
}

type SchedulingRequestState = "accepted" | "cancelled" | "rejected";

/** Shape of entries in the legacy pending-connects.json file (pre-connection-flow-simplification). */
interface LegacyPendingConnect {
	requestId: string;
	peerAgentId: number;
	peerChain: string;
	peerOwnerAddress: `0x${string}`;
	peerDisplayName: string;
	peerAgentAddress: `0x${string}`;
	createdAt: string;
}

interface SchedulingTrackingMetadata extends Record<string, unknown> {
	localEventId?: string;
	schedulingState?: SchedulingRequestState;
}

export interface TapServiceHooks {
	approveTransfer?: (context: TapTransferApprovalContext) => Promise<boolean | null>;
	approveScheduling?: (context: SchedulingApprovalContext) => Promise<boolean | null>;
	confirmMeeting?: (meeting: ProposedMeeting) => Promise<boolean>;
	onMeetingConfirmed?: (meeting: ConfirmedMeeting) => Promise<void>;
	executeTransfer?: (
		config: TrustedAgentsConfig,
		request: TransferActionRequest,
	) => Promise<{ txHash: `0x${string}` }>;
	/**
	 * Verify an inbound `postage/topup`'s claimed on-chain payment before a
	 * credit is opened. Absent = accept the claimed txHash (the topup is
	 * still bound to it in the credit record and certificate); hosts that
	 * can query the chain plug real verification in here.
	 */
	verifyPostageTopup?: (
		config: TrustedAgentsConfig,
		request: PostageTopupRequest,
		peerKey: string,
	) => Promise<boolean>;
	appendLedgerEntry?: (dataDir: string, entry: PermissionLedgerEntry) => Promise<string>;
	log?: (level: "info" | "warn" | "error", message: string) => void;
	emitEvent?: (payload: Record<string, unknown>) => void;
	onTypedEvent?: (event: TapEvent) => void;
	/**
	 * Called after a connection has been established via an inbound
	 * `connection/request` — the contact has been written as active and the
	 * `connection/result` has been delivered. The hook is non-blocking and
	 * informational; it should NOT modify state or throw.
	 */
	onConnectionEstablished?: (info: {
		peerAgentId: number;
		peerName: string;
		peerChain: string;
	}) => void | Promise<void>;
}

export interface TapServiceOptions {
	ownerLabel?: string;
	outboxPollIntervalMs?: number;
	hooks?: TapServiceHooks;
	schedulingHandler?: SchedulingHandler;
}

export interface TapServiceStatus {
	running: boolean;
	lock: TransportOwnerInfo | null;
	lastSyncAt?: string;
	pendingRequests: TapPendingRequest[];
}

export interface TapPendingDelivery {
	requestId: string;
	method: string;
	peerAgentId: number;
	correlationId?: string;
	ageMs: number;
	attempts?: number;
	lastAttemptAt?: string;
	lastError?: string;
}

export interface TapSyncReport {
	synced: true;
	processed: number;
	pendingRequests: TapServiceStatus["pendingRequests"];
	pendingDeliveries: TapPendingDelivery[];
}

export interface TapConnectResult {
	connectionId?: string;
	peerName: string;
	peerAgentId: number;
	status: "active" | "pending";
	receipt?: TransportReceipt;
}

export interface TapSendMessageOptions {
	/** Reply-loop guard threaded into the wire metadata. */
	autoGenerated?: boolean;
	/**
	 * Pay the peer's advertised priority price instead of standard so the
	 * message escalates (and may wake the peer's agent) on arrival. Applies
	 * even when a message/send grant is held — the grant buys standard
	 * delivery, the priority stamp buys the wake-up. Ignored when the peer
	 * publishes no priority price.
	 */
	priority?: boolean;
}

export interface TapSendMessageResult {
	receipt: TransportReceipt;
	peerName: string;
	peerAgentId: number;
	scope: string;
}

export interface TapPublishGrantSetResult {
	receipt: TransportReceipt;
	peerName: string;
	peerAgentId: number;
	grantCount: number;
}

export interface TapRequestGrantSetResult {
	receipt: TransportReceipt;
	actionId: string;
	peerName: string;
	peerAgentId: number;
	grantCount: number;
}

export interface TapRequestFundsInput {
	peer: string;
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	note?: string;
}

export interface TapRequestFundsResult {
	receipt: TransportReceipt;
	actionId: string;
	peerName: string;
	peerAgentId: number;
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
	asyncResult?: TransferActionResponse;
}

export interface TapPostageTopupInput {
	/** Decimal USDC amount to prepay, ≤6 decimals. */
	amount: string;
	/** How long to wait for the peer's credit certificate. */
	waitMs?: number;
}

export interface TapPostageTopupResult {
	/**
	 * accepted: the peer opened the credit (certificate may still be absent
	 * if its signer was unavailable). pending: paid, but the request send
	 * failed or no answer arrived within waitMs — the credit is recorded
	 * locally and the retry path is idempotent on the receiver. rejected:
	 * the peer refused; the on-chain payment already happened, so txHash is
	 * the recovery handle.
	 */
	status: "accepted" | "pending" | "rejected";
	/** Absent when the request send itself failed after payment. */
	receipt?: TransportReceipt;
	creditId: string;
	amount: string;
	txHash: `0x${string}`;
	peerName: string;
	peerAgentId: number;
	certificate?: `0x${string}`;
	certificateVerified: boolean;
	error?: string;
}

export interface TapRequestMeetingInput {
	peer: string;
	proposal: SchedulingProposal;
}

export interface TapRequestMeetingResult {
	receipt: TransportReceipt;
	schedulingId: string;
	peerName: string;
	peerAgentId: number;
	title: string;
	duration: number;
	slotCount: number;
}

export interface TapCancelMeetingResult {
	requestId: string;
	peerAgentId: number;
	schedulingId: string;
	report: TapSyncReport;
}

export class TapMessagingService {
	private readonly context: TapRuntimeContext;
	private readonly hooks: TapServiceHooks;
	private readonly ownerLabel: string;
	private readonly signingProvider: SigningProvider;
	private readonly ownerLock: TransportOwnerLock;
	private localAgentAddress: `0x${string}` | undefined;
	private readonly executionMutex = new AsyncMutex();
	private readonly outboxPollIntervalMs: number;
	private readonly pendingTasks = new Set<Promise<void>>();
	private readonly inFlightKeys = new Set<string>();
	/**
	 * Peers that currently have (or recently had) a pending outbound
	 * connection/result entry in the journal. Lets the implicit-completion
	 * path avoid a full journal scan on every inbound DM. See
	 * {@link markPendingConnectionResultsCompletedFor}.
	 *
	 * Keyed by {@link peerConnectionResultCacheKey} = `"chain:agentId"` so
	 * two peers that happen to share a numeric agentId across chains do not
	 * collide. Cache is authoritative as a "yes, scan the journal" hint —
	 * false positives only cost an extra scan, false negatives could orphan
	 * a pending entry from the implicit-completion path. We therefore prefer
	 * stale-positive over stale-negative: the cache is updated only when we
	 * have full certainty that no pending entries remain for the peer.
	 */
	private readonly peersWithPendingConnectionResult = new Set<string>();
	private connectionResultCachePriming: Promise<void> | null = null;
	private connectionResultCachePrimed = false;
	private readonly decisionOverrides = {
		transfers: new Map<string, boolean>(),
		scheduling: new Map<string, { approve: boolean; reason?: string }>(),
	};
	private readonly waiters = new Map<string, (value: TransferActionResponse) => void>();
	/**
	 * In-memory waiters keyed by requestId. Populated by connect() when
	 * waitMs > 0 and cleared by resolveConnectWaiter / rejectConnectWaiter /
	 * rejectAllConnectWaiters (on service stop). See spec §3.2.
	 */
	private readonly inFlightConnectWaiters = new Map<string, ConnectWaiter>();
	private readonly schedulingHandler: SchedulingHandler | undefined;
	/**
	 * Prepaid postage credits for this data dir. One instance per service:
	 * attention enforcement debits and the postage app's topups go through
	 * the same AsyncMutex, so a topup can never race a debit.
	 */
	private readonly postageLedger: FilePostageLedger;
	private readonly handlers: TransportHandlers;
	private running = false;
	private lastSyncAt: string | undefined;
	private outboxPoller: ReturnType<typeof setInterval> | null = null;
	private outboxPollInFlight: Promise<void> | null = null;
	private transportSessionReentryDepth = 0;
	private legacyStateMigrationsComplete = false;
	private manifestLoaded = false;

	constructor(context: TapRuntimeContext, options: TapServiceOptions = {}) {
		this.context = context;
		this.signingProvider = context.signingProvider;
		this.hooks = options.hooks ?? {};
		this.ownerLabel = options.ownerLabel ?? `tap:${process.pid}`;
		this.ownerLock = new TransportOwnerLock(context.config.dataDir, this.ownerLabel);
		this.outboxPollIntervalMs = options.outboxPollIntervalMs ?? OUTBOX_POLL_INTERVAL_MS;
		this.schedulingHandler = options.schedulingHandler;
		this.postageLedger = new FilePostageLedger(context.config.dataDir);
		this.handlers = {
			onRequest: async (envelope) => await this.onRequest(envelope),
			onResult: async (envelope) => await this.onResult(envelope),
		};
		this.registerBuiltinApps();
	}

	/** Load the installed app manifest once so the registry can lazy-load custom apps. */
	private async ensureManifestLoaded(): Promise<void> {
		if (this.manifestLoaded) return;
		await this.context.appRegistry.loadManifest();
		this.manifestLoaded = true;
	}

	private registerBuiltinApps(): void {
		// Register transfer/request as an inline app that delegates to the
		// existing processTransferRequest method.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "tap-transfer",
				name: "TAP Transfer",
				version: "0.0.0",
				grantScopes: ["transfer/request"],
				actions: {
					"transfer/request": {
						handler: async (_ctx) => {
							// The actual processing is still done by the existing
							// processTransferRequest method via the dispatch in onRequest.
							// This registration exists so that resolveHandler succeeds and
							// the dispatch does not emit UNSUPPORTED_ACTION.
							// The real handler is never called directly — the dispatch
							// delegates to the legacy codepath.
							return { success: true };
						},
					},
				},
			}),
		);

		// Register scheduling action types as an inline app that delegates to
		// SchedulingHandler for calendar availability and operator approval.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "scheduling",
				name: "Scheduling",
				version: "1.0.0",
				grantScopes: ["scheduling/request"],
				actions: {
					"scheduling/propose": {
						handler: async (ctx) => {
							return this.handleSchedulingAction(ctx);
						},
					},
					"scheduling/counter": {
						handler: async (ctx) => {
							return this.handleSchedulingAction(ctx);
						},
					},
				},
			}),
		);

		// Register the postage app inline. Unlike tap-transfer/scheduling, its
		// action types are NOT special-cased in onRequest: dispatch flows
		// through the generic dispatchToApp path, which injects the postage
		// extension (ledger + signing adapters) the handlers run on. The
		// packaged form (`@trustedagents/app-postage`) wraps the exact same
		// handler functions for manifest-installed hosts.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: POSTAGE_APP_ID,
				name: "Postage",
				version: "1.0.0",
				grantScopes: [],
				actions: {
					"postage/topup": { handler: handlePostageTopup },
					"postage/balance": { handler: handlePostageBalance },
				},
			}),
		);

		// Register permission grant request as an inline app.
		this.context.appRegistry.registerApp(
			defineTapApp({
				id: "tap-permissions",
				name: "TAP Permissions",
				version: "0.0.0",
				grantScopes: [],
				actions: {
					"permissions/request-grants": {
						handler: async (_ctx) => {
							return { success: true };
						},
					},
				},
			}),
		);
	}

	private async getLocalAgentAddress(): Promise<`0x${string}`> {
		if (!this.localAgentAddress) {
			this.localAgentAddress = await this.signingProvider.getAddress();
		}
		return this.localAgentAddress;
	}

	get transport(): TransportProvider {
		return this.context.transport;
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		await this.ensureManifestLoaded();

		// Acquire the transport owner lock BEFORE running legacy state migrations.
		// Two concurrent processes for the same data-dir must not both migrate —
		// `migrateOutbox()` in particular generates a fresh requestId per migrated
		// file, so without serialization the same legacy outbox job could be
		// inserted twice into the journal and executed twice. Holding the owner
		// lock across the migration makes it mutually exclusive by construction.
		await this.ownerLock.acquire();
		try {
			await this.ensureLegacyStateMigrated();
			this.context.transport.setHandlers(this.handlers);
			await this.context.transport.start?.();
			this.running = true;
			await this.executionMutex.runExclusive(async () => await this.runMaintenanceCycle(true));
			this.installOutboxPoller();
		} catch (error) {
			this.clearOutboxPoller();
			this.running = false;
			await this.ownerLock
				.release()
				.catch((releaseError: unknown) =>
					this.log(
						"warn",
						`Failed to release transport owner lock after start() error: ${toErrorMessage(releaseError)}`,
					),
				);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			this.clearOutboxPoller();
			this.rejectAllConnectWaiters(new Error("TapMessagingService stopped"));
			await this.outboxPollInFlight?.catch((error: unknown) =>
				this.log(
					"warn",
					`Queued TAP command polling failed during stop(): ${toErrorMessage(error)}`,
				),
			);
			await this.drain();
			await this.context.transport.stop?.();
		} finally {
			this.running = false;
			await this.ownerLock
				.release()
				.catch((releaseError: unknown) =>
					this.log(
						"warn",
						`Failed to release transport owner lock during stop(): ${toErrorMessage(releaseError)}`,
					),
				);
		}
	}

	// ──────────────────────────────────────────────────────────────
	// Connect waiter helpers (spec §3.2)
	// ──────────────────────────────────────────────────────────────

	private registerConnectWaiter(
		requestId: string,
		peerAgentId: number,
		timeoutMs: number,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.inFlightConnectWaiters.delete(requestId);
				reject(new ConnectWaiterTimeoutError(requestId));
			}, timeoutMs);
			this.inFlightConnectWaiters.set(requestId, {
				requestId,
				peerAgentId,
				resolve: () => resolve(),
				reject,
				timer,
			});
		});
	}

	private resolveConnectWaiter(requestId: string): void {
		const waiter = this.inFlightConnectWaiters.get(requestId);
		if (!waiter) return;
		clearTimeout(waiter.timer);
		this.inFlightConnectWaiters.delete(requestId);
		waiter.resolve();
	}

	private rejectConnectWaiter(requestId: string, reason: Error): void {
		const waiter = this.inFlightConnectWaiters.get(requestId);
		if (!waiter) return;
		clearTimeout(waiter.timer);
		this.inFlightConnectWaiters.delete(requestId);
		waiter.reject(reason);
	}

	private rejectAllConnectWaiters(reason: Error): void {
		for (const waiter of this.inFlightConnectWaiters.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(reason);
		}
		this.inFlightConnectWaiters.clear();
	}

	// ──────────────────────────────────────────────────────────────

	async syncOnce(): Promise<TapSyncReport> {
		const processed = await this.executionMutex.runExclusive(() =>
			this.withTransportSession(() => this.runMaintenanceCycle(true)),
		);
		return await this.buildSyncReport(processed);
	}

	async processOutboxOnce(): Promise<number> {
		return await this.executionMutex.runExclusive(() =>
			this.withTransportSession(() => this.processOutboxInternal()),
		);
	}

	async getStatus(): Promise<TapServiceStatus> {
		const pendingRequests = await this.listPendingRequests();
		return {
			running: this.running,
			lock: await this.ownerLock.inspect(),
			lastSyncAt: this.lastSyncAt,
			pendingRequests,
		};
	}

	async listPendingRequests(): Promise<TapServiceStatus["pendingRequests"]> {
		const [pending, contacts] = await Promise.all([
			this.context.requestJournal.listPending(),
			this.context.trustStore.getContacts(),
		]);
		return pending
			.filter((entry) => entry.kind === "request" && !isOutboundDeliveryEntry(entry))
			.map((entry) => toPendingRequestView(entry, contacts));
	}

	private async findCancellableSchedulingRequest(
		schedulingId: string,
	): Promise<RequestJournalEntry | null> {
		const entries = (await this.context.requestJournal.list())
			.filter((entry) => entry.kind === "request" && entry.method === ACTION_REQUEST)
			.reverse();

		const matchesSchedulingId = (entry: RequestJournalEntry): boolean =>
			parseStoredSchedulingRequest(entry.metadata)?.schedulingId === schedulingId;

		const pendingOutbound = entries.find(
			(entry) =>
				entry.direction === "outbound" &&
				entry.status !== "completed" &&
				matchesSchedulingId(entry),
		);
		if (pendingOutbound) {
			return pendingOutbound;
		}

		return (
			entries.find((entry) => {
				if (!matchesSchedulingId(entry)) {
					return false;
				}
				return parseSchedulingTrackingMetadata(entry.metadata).schedulingState === "accepted";
			}) ?? null
		);
	}

	private async closePendingOutboundSchedulingRequestForCounter(
		peerAgentId: number,
		schedulingId: string,
	): Promise<void> {
		const pendingOutbound = await this.context.requestJournal.listPending("outbound");
		const supersededRequest = pendingOutbound.find(
			(entry) =>
				entry.kind === "request" &&
				entry.method === ACTION_REQUEST &&
				entry.peerAgentId === peerAgentId &&
				parseStoredSchedulingRequest(entry.metadata)?.schedulingId === schedulingId,
		);
		if (!supersededRequest) {
			return;
		}
		await this.context.requestJournal.updateStatus(supersededRequest.requestId, "completed");
	}

	private async updateSchedulingTracking(
		requestId: string,
		updates: SchedulingTrackingMetadata,
	): Promise<void> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry) {
			return;
		}
		await this.context.requestJournal.updateMetadata(
			requestId,
			mergeMetadata(entry.metadata, updates),
		);
	}

	private async cancelLocalSchedulingEvent(
		requestId: string,
		localEventId: string | undefined,
		contextLabel: string,
	): Promise<boolean> {
		if (!localEventId || !this.schedulingHandler) {
			return false;
		}
		try {
			await this.schedulingHandler.handleCancel(localEventId);
			return true;
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to cancel local calendar event for scheduling request ${requestId} during ${contextLabel}: ${toErrorMessage(error)}`,
			);
			return false;
		}
	}

	async resolvePending(
		requestId: string,
		approve: boolean,
		reason?: string,
		options?: { decidedBy?: "operator" | "auto-grant" },
	): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.direction !== "inbound" || entry.kind !== "request") {
			throw new ValidationError(`Pending inbound request not found: ${requestId}`);
		}

		if (entry.method !== ACTION_REQUEST) {
			throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
		}

		const isScheduling = entry.method === ACTION_REQUEST && entry.metadata?.type === "scheduling";
		if (isScheduling) {
			this.decisionOverrides.scheduling.set(requestId, { approve, reason });
		} else {
			this.decisionOverrides.transfers.set(requestId, approve);
		}
		try {
			const report = await this.executionMutex.runExclusive(
				async () =>
					await this.withTransportSession(async () => {
						await this.drain();
						const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
						if (
							!latestEntry ||
							latestEntry.direction !== "inbound" ||
							latestEntry.kind !== "request"
						) {
							throw new ValidationError(`Pending inbound request not found: ${requestId}`);
						}
						if (latestEntry.status === "completed") {
							return await this.buildSyncReport(0);
						}

						if (latestEntry.method === ACTION_REQUEST) {
							const latestIsScheduling = latestEntry.metadata?.type === "scheduling";
							if (latestIsScheduling) {
								await this.resolvePendingSchedulingRequest(latestEntry);
							} else {
								await this.resolvePendingTransferRequest(latestEntry);
							}
						} else {
							throw new ValidationError(`Request ${requestId} cannot be resolved manually`);
						}

						await this.drain();
						return await this.buildSyncReport(1);
					}),
			);

			this.emit({
				type: "pending.resolved",
				requestId,
				decision: approve ? "approved" : "denied",
				decidedBy: options?.decidedBy ?? "operator",
			});

			return report;
		} finally {
			if (isScheduling) {
				this.decisionOverrides.scheduling.delete(requestId);
			} else {
				this.decisionOverrides.transfers.delete(requestId);
			}
		}
	}

	async connect(params: { inviteUrl: string; waitMs?: number }): Promise<TapConnectResult> {
		return await this.executionMutex.runExclusive(async () => await this.connectInternal(params));
	}

	async cancelMeeting(schedulingId: string, reason?: string): Promise<TapCancelMeetingResult> {
		const entry = await this.findCancellableSchedulingRequest(schedulingId);
		if (!entry) {
			throw new ValidationError(
				`No pending or accepted meeting found with schedulingId: ${schedulingId}`,
			);
		}

		const report = await this.cancelPendingSchedulingRequest(entry.requestId, reason);
		return {
			requestId: entry.requestId,
			peerAgentId: entry.peerAgentId,
			schedulingId,
			report,
		};
	}

	async cancelPendingSchedulingRequest(requestId: string, reason?: string): Promise<TapSyncReport> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		if (!entry || entry.kind !== "request") {
			throw new ValidationError(`Scheduling request not found: ${requestId}`);
		}
		if (entry.method !== ACTION_REQUEST) {
			throw new ValidationError(`Request ${requestId} cannot be cancelled manually`);
		}

		const tracking = parseSchedulingTrackingMetadata(entry.metadata);
		if (entry.direction !== "outbound" && tracking.schedulingState !== "accepted") {
			throw new ValidationError(`Scheduling request ${requestId} is not cancellable`);
		}

		if (!parseStoredSchedulingRequest(entry.metadata)) {
			throw new ValidationError(
				`Scheduling request ${requestId} is missing the original request payload`,
			);
		}

		return await this.executionMutex.runExclusive(
			async () =>
				await this.withTransportSession(async () => {
					await this.drain();
					const latestEntry = await this.context.requestJournal.getByRequestId(requestId);
					if (!latestEntry || latestEntry.kind !== "request") {
						throw new ValidationError(`Scheduling request not found: ${requestId}`);
					}
					const latestTracking = parseSchedulingTrackingMetadata(latestEntry.metadata);
					const acceptedMeeting = latestTracking.schedulingState === "accepted";
					if (latestEntry.direction !== "outbound" && !acceptedMeeting) {
						throw new ValidationError(`Scheduling request ${requestId} is not cancellable`);
					}
					if (latestEntry.status === "completed" && !acceptedMeeting) {
						throw new ValidationError(`Scheduling request ${requestId} is not pending or accepted`);
					}

					const latestProposal = parseStoredSchedulingRequest(latestEntry.metadata);
					if (!latestProposal) {
						throw new ValidationError(
							`Scheduling request ${requestId} is missing the original request payload`,
						);
					}

					const contact = await this.findActiveContactForPendingEntry(latestEntry);
					if (!contact) {
						throw new ValidationError(
							`No active contact found for pending scheduling request ${requestId}`,
						);
					}

					const cancellation = {
						type: "scheduling/cancel" as const,
						schedulingId: latestProposal.schedulingId,
						...(reason ? { reason } : {}),
					};
					const outgoing = buildOutgoingActionResult(
						contact,
						latestEntry.requestId,
						buildSchedulingRejectText(cancellation),
						cancellation,
						"scheduling/request",
						"rejected",
					);

					await this.persistSchedulingActionResult(
						contact,
						latestEntry.requestId,
						latestProposal.schedulingId,
						outgoing,
						"cancel",
					);
					const clearedLocalEvent = await this.cancelLocalSchedulingEvent(
						latestEntry.requestId,
						latestTracking.localEventId,
						`local cancellation for ${latestProposal.schedulingId}`,
					);

					await this.updateSchedulingTracking(latestEntry.requestId, {
						schedulingState: "cancelled",
						...(clearedLocalEvent ? { localEventId: undefined } : {}),
					});

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						peer: peerLabel(contact),
						direction: "local",
						event: "scheduling-cancel",
						scope: "scheduling/request",
						action_id: latestProposal.schedulingId,
						decision: "cancelled",
						rationale: reason ?? "Cancelled by operator",
					});

					await this.drain();
					return await this.buildSyncReport(1);
				}),
		);
	}

	private async connectInternal(params: {
		inviteUrl: string;
		waitMs?: number;
	}): Promise<TapConnectResult> {
		const waitMs = params.waitMs ?? 30_000;
		const { config, resolver } = this.context;
		const chainId = caip2ToChainId(config.chain);
		if (chainId === null) {
			throw new ValidationError(`Invalid local chain format: ${config.chain}`);
		}

		const invite = parseInviteUrl(params.inviteUrl);
		if (isSelfInvite(invite, { agentId: config.agentId, chain: config.chain })) {
			throw new ValidationError(
				"Cannot connect to your own invite. Switch to a different TAP identity or --data-dir before accepting it.",
			);
		}
		const peerAgent = await resolver.resolve(invite.agentId, invite.chain);
		const verification = await verifyInvite(invite, {
			expectedSignerAddress: peerAgent.agentAddress,
		});
		if (!verification.valid) {
			throw new ValidationError(verification.error ?? "Invite verification failed");
		}

		return await this.withTransportSession(async () => {
			const { trustStore, transport } = this.context;

			const existing = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);

			const from: AgentIdentifier = { agentId: config.agentId, chain: config.chain };
			const requestedAt = nowISO();
			const requestParams: ConnectionRequestParams = {
				from,
				invite,
				timestamp: requestedAt,
			};

			// §3.2 wire-level idempotency: reuse the requestId from an existing
			// non-terminal outbound connection/request journal entry if one exists for
			// this (peer, chain) pair. Scope matters because two on-chain identities
			// can legitimately share the same numeric agentId across chains; without
			// the chain check, a connect to chain B would inherit chain A's requestId
			// and let chain A's result satisfy chain B's waiter.
			//
			// `listPending` returns both `queued` and `pending` entries (see
			// request-journal.ts), so a prior connect() that couldn't acquire the
			// transport lock and wrote a queued intent is still found here.
			const nonTerminalOutbound = await this.context.requestJournal.listPending("outbound");
			const existingOutboundEntry = nonTerminalOutbound.find(
				(entry) =>
					entry.method === CONNECTION_REQUEST &&
					entry.peerAgentId === peerAgent.agentId &&
					entry.kind === "request" &&
					(entry.metadata as { peerChain?: string } | undefined)?.peerChain === peerAgent.chain,
			);
			const requestId = existingOutboundEntry?.requestId ?? generateNonce();

			const rpcRequest = buildConnectionRequest(requestParams, requestId);

			// Upsert a "connecting" contact as the durable "I asked" record before
			// any wire traffic. Per spec §1.1, the connecting contact is sticky —
			// it persists across restarts and survives send failures. Only written
			// if the contact is not already active (we do not downgrade an active
			// peer to connecting while a re-handshake is in flight — see spec §3.1.1).
			if (existing?.status !== "active") {
				const expiresAt = new Date(invite.expires * 1000).toISOString();
				const connectingContact: Contact = {
					connectionId: existing?.connectionId ?? generateConnectionId(),
					peerAgentId: peerAgent.agentId,
					peerChain: peerAgent.chain,
					peerOwnerAddress: peerAgent.ownerAddress,
					peerDisplayName: peerAgent.registrationFile.name,
					peerAgentAddress: peerAgent.agentAddress,
					permissions: existing?.permissions ?? createEmptyPermissionState(requestedAt),
					establishedAt: existing?.establishedAt ?? requestedAt,
					lastContactAt: requestedAt,
					status: "connecting",
					expiresAt,
				};
				if (existing) {
					await trustStore.updateContact(existing.connectionId, connectingContact);
				} else {
					await trustStore.addContact(connectingContact);
				}
			}

			// Persist the outbound journal entry BEFORE sending so that a
			// transport-level failure (including XMTP's app-receipt timeout when
			// the peer is offline) leaves a retryable record in the journal. If
			// we only wrote the entry after a successful send, an offline peer
			// would turn into a hard connect failure with no reconciliation
			// path. `peerChain` is stored in metadata so the idempotency lookup
			// above and the security gate in handleConnectionResult can both
			// require a chain match.
			if (!existingOutboundEntry) {
				await this.context.requestJournal.putOutbound({
					requestId,
					requestKey: `outbound:${CONNECTION_REQUEST}:${requestId}`,
					direction: "outbound",
					kind: "request",
					method: CONNECTION_REQUEST,
					peerAgentId: peerAgent.agentId,
					status: "pending",
					metadata: { peerChain: peerAgent.chain },
				});
			}

			this.emitConnectionRequested(requestId, peerAgent.agentId, peerAgent.chain, "outbound");

			// Register a waiter before sending so that a result arriving during or
			// immediately after send() can resolve it. waitMs === 0 means fire-and-forget.
			//
			// Attach a no-op .catch() immediately to suppress Node.js unhandled-
			// rejection warnings in cases where the result arrives synchronously
			// inside send() (e.g. ImmediateRejectTransport in tests). The real
			// rejection handler is in the try/catch below when we await the promise.
			const waiterPromise =
				waitMs > 0 ? this.registerConnectWaiter(requestId, peerAgent.agentId, waitMs) : null;
			waiterPromise?.catch(() => {
				/* handled in await below */
			});

			let receipt: TransportReceipt | undefined;
			let sendTimedOut = false;
			try {
				receipt = await transport.send(peerAgent.agentId, rpcRequest, {
					peerAddress: peerAgent.xmtpEndpoint ?? peerAgent.agentAddress,
				});
			} catch (error: unknown) {
				// Receipt timeout (e.g. peer offline): treat as "pending" rather
				// than fatal. The outbound journal entry was written above, so
				// reconciliation on the next sync can finish the handshake.
				// Clean up the local waiter — no matching result will arrive in
				// this process, and we want the caller to return a pending
				// status instead of waiting for the full waitMs.
				if (isTransportReceiptTimeout(error)) {
					sendTimedOut = true;
					await this.recordSendFailure(requestId, error);
					if (waiterPromise) {
						const waiter = this.inFlightConnectWaiters.get(requestId);
						if (waiter) {
							clearTimeout(waiter.timer);
							this.inFlightConnectWaiters.delete(requestId);
						}
					}
				} else {
					// Non-timeout transport failure: also clean up the waiter
					// and propagate. The journal entry remains pending so a
					// future sync can retry.
					if (waiterPromise) {
						const waiter = this.inFlightConnectWaiters.get(requestId);
						if (waiter) {
							clearTimeout(waiter.timer);
							this.inFlightConnectWaiters.delete(requestId);
						}
					}
					await this.recordSendFailure(requestId, error);
					throw error;
				}
			}

			// Fire-and-forget OR send receipt timed out (peer offline): return
			// the current state without waiting for a result. In the timeout
			// case the journal entry is still pending and a future sync will
			// complete the handshake.
			if (waitMs === 0 || !waiterPromise || sendTimedOut) {
				const currentContact = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
				const status = currentContact?.status === "active" ? "active" : "pending";
				return {
					connectionId: currentContact?.connectionId,
					peerName: currentContact?.peerDisplayName ?? peerAgent.registrationFile.name,
					peerAgentId: peerAgent.agentId,
					status,
					receipt,
				};
			}

			// Await the waiter: resolves when connection/result arrives, times out
			// after waitMs, or rejects immediately on explicit peer rejection.
			try {
				await waiterPromise;
				// Waiter resolved — the peer accepted and handleConnectionResult already
				// flipped the contact to active. Re-read for the latest state.
				const latestContact = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
				return {
					connectionId: latestContact?.connectionId,
					peerName: latestContact?.peerDisplayName ?? peerAgent.registrationFile.name,
					peerAgentId: peerAgent.agentId,
					status: "active",
					receipt,
				};
			} catch (error: unknown) {
				if (error instanceof ConnectWaiterTimeoutError) {
					// Timeout: return pending. The connecting contact is still in place
					// and the journal entry will be retried on the next sync.
					const latestContact = await trustStore.findByAgentId(peerAgent.agentId, peerAgent.chain);
					return {
						connectionId: latestContact?.connectionId,
						peerName: latestContact?.peerDisplayName ?? peerAgent.registrationFile.name,
						peerAgentId: peerAgent.agentId,
						status: "pending",
						receipt,
					};
				}
				if (error instanceof ConnectWaiterRejectedError) {
					// Peer explicitly rejected: surface as ValidationError so the caller
					// gets a clear message.
					throw new ValidationError(error.message);
				}
				// Unexpected error (e.g. service stopped) — propagate.
				throw error;
			}
		});
	}

	/**
	 * Send a `connection/revoke` to the peer. Persists the message as a pending
	 * outbound journal entry so reconciliation can retry on transport failures.
	 * The caller is responsible for deleting the local contact AFTER this method
	 * returns (success or failure — the local delete always happens per spec §3.4).
	 */
	async revokeConnection(contact: Contact, reason?: string): Promise<void> {
		return await this.withTransportSession(async () => {
			const revokeParams: ConnectionRevokeParams = {
				from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				reason,
				timestamp: nowISO(),
			};
			const rpcRequest = buildConnectionRevoke(revokeParams);
			const requestId = String(rpcRequest.id);

			// Store the peerAddress and reason in metadata so the reconciliation
			// loop can rebuild and re-send the wire message on retry. The CLI
			// deletes the local contact after revokeConnection returns regardless
			// of delivery outcome, so reconciliation is our only chance to reach
			// the peer if the first send fails.
			await this.context.requestJournal.putOutbound({
				requestId,
				requestKey: `outbound:${CONNECTION_REVOKE}:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: CONNECTION_REVOKE,
				peerAgentId: contact.peerAgentId,
				status: "pending",
				metadata: {
					revokeDelivery: {
						peerAgentId: contact.peerAgentId,
						peerChain: contact.peerChain,
						peerAddress: contact.peerAgentAddress,
						peerDisplayName: contact.peerDisplayName,
						reason,
					},
				},
			});

			try {
				await this.context.transport.send(contact.peerAgentId, rpcRequest, {
					peerAddress: contact.peerAgentAddress,
				});
				await this.context.requestJournal.updateStatus(requestId, "completed");
			} catch (error: unknown) {
				// Best-effort: leave the journal entry pending so the retry loop can
				// deliver it on a future transport-owning run. Do not rethrow — the
				// CLI flow should still delete the local contact.
				await this.recordSendFailure(requestId, error);
				this.log(
					"warn",
					`Failed to send connection/revoke to ${peerLabel(contact)} — will retry on next reconciliation: ${toErrorMessage(error)}`,
				);
			}
		});
	}

	async sendMessage(
		peer: string,
		text: string,
		scope = DEFAULT_MESSAGE_SCOPE,
		options?: TapSendMessageOptions,
	): Promise<TapSendMessageResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.sendMessageInternal(peer, text, scope, options),
		);
	}

	private async sendMessageInternal(
		peer: string,
		text: string,
		scope = DEFAULT_MESSAGE_SCOPE,
		options?: TapSendMessageOptions,
	): Promise<TapSendMessageResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			const timestamp = nowISO();
			// Fire-and-forget by default: a one-shot peer that isn't running
			// `tap message listen` during the publish window would otherwise
			// turn a successful XMTP publication into a local timeout. When the
			// peer advertises attention pricing, though, it may reject with a
			// -32050 quote — wait for the receipt so that rejection reaches the
			// caller instead of being silently dropped.
			// Priority sends re-resolve the peer's price list fresh (bypassing
			// the ~24h cache): stamping a stale priority price would debit the
			// credit yet buy no wake-up once the peer has raised its price.
			const pricing = await this.resolvePeerAttentionPricing(
				contact,
				options?.priority === true ? 0 : undefined,
			);
			const waitForAck = pricing !== null;
			const postage = pricing
				? await this.stampOutboundMessage(contact, pricing, options)
				: undefined;
			const request = buildOutgoingMessageRequest(contact, text, scope, {
				...options,
				...(postage ? { postage } : {}),
			});
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
				waitForAck,
			});

			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);

			this.emit({
				type: "message.sent",
				conversationId: resolveConversationId(contact),
				peer: this.peerRefFromContact(contact),
				messageId: String(request.id),
				text,
				scope,
			});

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				scope,
			};
		});
	}

	async sendActionRequest(
		peer: { agentId: number } | { connectionId: string },
		actionType: string,
		payload: Record<string, unknown>,
		text?: string,
	): Promise<TapSendMessageResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.sendActionRequestInternal(peer, actionType, payload, text),
		);
	}

	private async sendActionRequestInternal(
		peer: { agentId: number } | { connectionId: string },
		actionType: string,
		payload: Record<string, unknown>,
		text?: string,
	): Promise<TapSendMessageResult> {
		return await this.withTransportSession(async () => {
			let contact: Contact;
			if ("connectionId" in peer) {
				const c = await this.context.trustStore.getContact(peer.connectionId);
				if (!c || c.status !== "active") {
					throw new ValidationError(`No active contact found for connection ${peer.connectionId}`);
				}
				contact = c;
			} else {
				const contacts = await this.context.trustStore.getContacts();
				const c = findUniqueContactForAgentId(contacts, peer.agentId);
				if (!c || c.status !== "active") {
					throw new ValidationError(`No active contact found for agent ${peer.agentId}`);
				}
				contact = c;
			}

			const data = { ...payload, type: actionType };
			const scope = actionType;
			const request = buildOutgoingActionRequest(
				contact,
				text ?? `Action request: ${actionType}`,
				data,
				scope,
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				{ actionType, peerChain: contact.peerChain },
			);

			this.emitActionRequested(
				contact,
				requestId,
				actionKindFromType(actionType),
				data as Record<string, unknown>,
				"outbound",
			);

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				scope,
			};
		});
	}

	async publishGrantSet(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapPublishGrantSetResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.publishGrantSetInternal(peer, grantSet, note),
		);
	}

	private async publishGrantSetInternal(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapPublishGrantSetResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireContact(peer);
			await this.completeSupersededPermissionsUpdates(contact.connectionId);

			const request = buildPermissionsUpdate({
				grantSet,
				grantor: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				grantee: { agentId: contact.peerAgentId, chain: contact.peerChain },
				note,
				timestamp: nowISO(),
			});
			const delivery = buildPendingPermissionsUpdateDelivery(contact, grantSet, request);
			await this.context.requestJournal.putOutbound({
				requestId: String(request.id),
				requestKey: `outbound:${request.method}:${String(request.id)}`,
				direction: "outbound",
				kind: "request",
				method: request.method,
				peerAgentId: contact.peerAgentId,
				status: "pending",
				metadata: serializePendingPermissionsUpdateDelivery(delivery),
			});

			let receipt: TransportReceipt;
			try {
				receipt = await this.deliverPendingPermissionsUpdate(delivery);
			} catch (error: unknown) {
				await this.recordDeliveryFailure(
					String(request.id),
					serializePendingPermissionsUpdateDelivery(delivery),
					error,
				);
				throw error;
			}

			await this.appendLedger({
				peer: peerLabel(contact),
				direction: "granted-by-me",
				event: "grant-published",
				note,
			});

			return {
				receipt,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				grantCount: grantSet.grants.length,
			};
		});
	}

	async requestGrantSet(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapRequestGrantSetResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.requestGrantSetInternal(peer, grantSet, note),
		);
	}

	private async requestGrantSetInternal(
		peer: string,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapRequestGrantSetResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			const action: PermissionGrantRequestAction = {
				type: "permissions/request-grants",
				actionId: generateNonce(),
				grants: grantSet.grants,
				note,
			};
			const request = buildOutgoingActionRequest(
				contact,
				buildPermissionGrantRequestText(action),
				action,
				"permissions/request-grants",
			);

			const timestamp = nowISO();
			const receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
			await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);

			await this.appendLedger({
				peer: peerLabel(contact),
				direction: "local",
				event: "grant-request-sent",
				action_id: action.actionId,
				note,
			});

			return {
				receipt,
				actionId: action.actionId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				grantCount: grantSet.grants.length,
			};
		});
	}

	async requestFunds(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.requestFundsInternal(input),
		);
	}

	private async requestFundsInternal(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(input.peer);
			const peerTransferGrants = findActiveGrantsByScope(
				contact.permissions.grantedByPeer,
				"transfer/request",
			);
			if (peerTransferGrants.length === 0) {
				this.log(
					"warn",
					`No matching transfer/request grant found in grantedByPeer for ${contact.peerDisplayName}. The peer may reject this request.`,
				);
			}
			const requestPayload = {
				type: "transfer/request" as const,
				actionId: generateNonce(),
				asset: input.asset,
				amount: input.amount,
				chain: input.chain,
				toAddress: input.toAddress,
				note: input.note,
			};
			const request = buildOutgoingActionRequest(
				contact,
				buildTransferRequestText(requestPayload),
				requestPayload,
				"transfer/request",
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			await this.appendLedger({
				timestamp,
				peer: peerLabel(contact),
				direction: "local",
				event: "transfer-request-sent",
				scope: "transfer/request",
				asset: input.asset,
				amount: input.amount,
				action_id: requestPayload.actionId,
				note: input.note,
			});

			const waiter = this.registerActionResultWaiter(
				requestId,
				requestPayload.actionId,
				ACTION_RESULT_WAIT_TIMEOUT_MS,
			);

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				{ peerChain: contact.peerChain },
				() => waiter.cancel(),
			);

			this.emitActionRequested(
				contact,
				requestId,
				"transfer",
				requestPayload as Record<string, unknown>,
				"outbound",
			);

			const asyncResult = await waiter.promise;
			if (!asyncResult) {
				await this.runReconcile();
			}
			await this.drain();
			const settledResult =
				asyncResult ?? (await this.readRecordedTransferResponse(requestId)) ?? undefined;

			if (settledResult?.status === "rejected") {
				throw new PermissionError(settledResult.error ?? "Action rejected by agent");
			}
			if (settledResult?.status === "failed") {
				throw new Error(settledResult.error ?? "Transfer request failed");
			}

			return {
				receipt,
				actionId: requestPayload.actionId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				asset: input.asset,
				amount: input.amount,
				chain: input.chain,
				toAddress: input.toAddress,
				asyncResult: settledResult,
			};
		});
	}

	/**
	 * Buy prepaid postage credit at a peer: pay USDC on-chain to the peer's
	 * agent address through the host's transfer executor, send a
	 * `postage/topup` action request referencing the payment, wait for the
	 * signed credit certificate, verify it against the peer's known agent
	 * address, and record the held credit locally. Auto-stamping on
	 * `sendMessage` draws on that credit from then on.
	 */
	async topUpPostage(peer: string, input: TapPostageTopupInput): Promise<TapPostageTopupResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.topUpPostageInternal(peer, input),
		);
	}

	private async topUpPostageInternal(
		peer: string,
		input: TapPostageTopupInput,
	): Promise<TapPostageTopupResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(peer);
			if (!isValidPostageAmount(input.amount) || postageAmountToMicros(input.amount) <= 0n) {
				throw new ValidationError(
					`postage topup amount must be a positive decimal string (≤6 decimals), got ${JSON.stringify(input.amount)}`,
				);
			}
			if (!this.hooks.executeTransfer) {
				throw new ValidationError("No transfer executor configured for this TAP host");
			}

			// Pay first: the credit certificate binds to this txHash, and the
			// receiver's topup handler is idempotent per creditId, so retries
			// after a timeout never double-pay.
			const { txHash } = await this.hooks.executeTransfer(this.context.config, {
				type: "transfer/request",
				actionId: generateNonce(),
				asset: "usdc",
				amount: input.amount,
				chain: contact.peerChain,
				toAddress: contact.peerAgentAddress,
				note: `postage topup from agent #${this.context.config.agentId}`,
			});

			const payload = buildPostageTopupPayload({
				amount: input.amount,
				chain: contact.peerChain,
				txHash,
			});
			const actionId = payload.actionId as string;
			const creditId = payload.creditId as string;
			const peerKey = postagePeerKey({ chain: contact.peerChain, agentId: contact.peerAgentId });

			// The payment is irreversible from here on, so persist its trace
			// BEFORE any transport action: whatever fails later, the ledger
			// holds the creditId/txHash pair needed to recover or reconcile.
			// A definitive peer rejection removes the record again below.
			await this.postageLedger.recordHeld({
				creditId,
				peer: peerKey,
				amount: input.amount,
				txHash,
			});

			const request = buildOutgoingActionRequest(
				contact,
				`Postage topup: ${input.amount} USDC (credit ${creditId})`,
				payload,
				POSTAGE_TOPUP_ACTION,
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			// matchActionId: false — a delivered failure result must settle the
			// waiter even when its data part carries no actionId (a pre-postage
			// peer's UNSUPPORTED_ACTION reply, a handler crash), otherwise a
			// definitive rejection is misread as a timeout.
			const waiter = this.registerActionResultWaiter(
				requestId,
				actionId,
				input.waitMs ?? ACTION_RESULT_WAIT_TIMEOUT_MS,
				{ matchActionId: false },
			);

			const base = {
				creditId,
				amount: input.amount,
				txHash,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
			};

			let receipt: TransportReceipt;
			try {
				receipt = await this.sendAndJournalOutboundRequest(
					contact,
					request,
					requestId,
					timestamp,
					{ actionType: POSTAGE_TOPUP_ACTION, peerChain: contact.peerChain },
					() => waiter.cancel(),
				);
			} catch (error) {
				// The payment already happened — never throw it away with the
				// transport error. The held credit stays recorded as the
				// recovery handle and the result carries the failure.
				this.log(
					"warn",
					`postage topup ${creditId}: request send failed after payment (${toErrorMessage(error)})`,
				);
				return {
					...base,
					status: "pending",
					certificateVerified: false,
					error: `topup request could not be sent (payment ${txHash} completed): ${toErrorMessage(error)}`,
				};
			}

			this.emitActionRequested(
				contact,
				requestId,
				actionKindFromType(POSTAGE_TOPUP_ACTION),
				payload,
				"outbound",
			);

			const asyncResult = await waiter.promise;

			if (!asyncResult) {
				// No answer inside the wait window. The held credit recorded
				// above stands: the journal retries the pending request and the
				// receiver's handler is idempotent per creditId.
				return { ...base, receipt, status: "pending", certificateVerified: false };
			}

			const response = parsePostageTopupResponse(asyncResult as unknown as Record<string, unknown>);
			if (!response || response.error || response.status !== "accepted") {
				// A delivered non-acceptance: drop the provisional held credit
				// so auto-stamping can never draw on a credit the peer refused.
				await this.postageLedger.removeHeld(creditId);
				const deliveredError = response
					? response.error?.message
					: (asyncResult as unknown as { error?: { message?: string } }).error?.message;
				return {
					...base,
					receipt,
					status: "rejected",
					certificateVerified: false,
					error: deliveredError ?? `topup ${response?.status ?? "failed"}`,
				};
			}

			let certificateVerified = false;
			if (response.certificate) {
				const verification = await verifyPostageCredit(
					{
						creditId,
						issuerChain: contact.peerChain,
						issuerAgentId: contact.peerAgentId,
						holderAgentId: this.context.config.agentId,
						amount: input.amount,
						txHash,
					},
					response.certificate,
					contact.peerAgentAddress,
				);
				certificateVerified = verification.valid;
				if (!verification.valid) {
					this.log(
						"warn",
						`postage credit ${creditId}: certificate verification failed (${verification.error ?? "unknown"})`,
					);
				}
			}

			await this.postageLedger.recordHeld({
				creditId,
				peer: peerKey,
				amount: input.amount,
				txHash,
				...(response.certificate ? { certificate: response.certificate } : {}),
				certificateVerified,
			});

			return {
				...base,
				receipt,
				status: "accepted",
				...(response.certificate ? { certificate: response.certificate } : {}),
				certificateVerified,
			};
		});
	}

	/**
	 * The narrow capability surface the postage handlers run on: the
	 * service-owned ledger plus signing/verification adapters. Handlers
	 * never see the SigningProvider or the hook table.
	 */
	private buildPostageAppExtension(): PostageAppExtension {
		return {
			recordIssued: (input) => this.postageLedger.recordIssued(input),
			issuedFor: (peerKey) => this.postageLedger.issuedFor(peerKey),
			signCredit: async (facts) => {
				try {
					return await signPostageCredit(this.signingProvider, facts);
				} catch (error) {
					this.log(
						"warn",
						`postage credit ${facts.creditId}: certificate signing failed (${toErrorMessage(error)})`,
					);
					return null;
				}
			},
			verifyTopup: async (request, peerKey) =>
				this.hooks.verifyPostageTopup
					? await this.hooks.verifyPostageTopup(this.context.config, request, peerKey)
					: true,
		};
	}

	async requestMeeting(input: TapRequestMeetingInput): Promise<TapRequestMeetingResult> {
		return await this.executionMutex.runExclusive(
			async () => await this.requestMeetingInternal(input),
		);
	}

	private async requestMeetingInternal(
		input: TapRequestMeetingInput,
	): Promise<TapRequestMeetingResult> {
		return await this.withTransportSession(async () => {
			const contact = await this.requireActiveContact(input.peer);
			const { proposal } = input;
			const peerSchedulingGrants = findActiveGrantsByScope(
				contact.permissions.grantedByPeer,
				"scheduling/request",
			);
			if (peerSchedulingGrants.length === 0) {
				this.log(
					"warn",
					`No matching scheduling/request grant found in grantedByPeer for ${contact.peerDisplayName}. The peer may reject this request.`,
				);
			}

			const request = buildOutgoingActionRequest(
				contact,
				buildSchedulingProposalText(proposal),
				proposal as unknown as Record<string, unknown>,
				"scheduling/request",
			);
			const requestId = String(request.id);
			const timestamp = nowISO();

			await this.appendLedger({
				timestamp,
				peer: peerLabel(contact),
				direction: "local",
				event: "scheduling-request-sent",
				scope: "scheduling/request",
				action_id: proposal.schedulingId,
				note: proposal.note ?? `Meeting: ${proposal.title}`,
			});

			const receipt = await this.sendAndJournalOutboundRequest(
				contact,
				request,
				requestId,
				timestamp,
				serializePendingSchedulingRequestDetails(
					contact,
					proposal,
					this.context.config.dataDir,
					"outbound",
				),
			);

			this.emitActionRequested(
				contact,
				requestId,
				"scheduling",
				proposal as unknown as Record<string, unknown>,
				"outbound",
			);

			return {
				receipt,
				schedulingId: proposal.schedulingId,
				peerName: contact.peerDisplayName,
				peerAgentId: contact.peerAgentId,
				title: proposal.title,
				duration: proposal.duration,
				slotCount: proposal.slots.length,
			};
		});
	}

	private async runMaintenanceCycle(reconcile: boolean): Promise<number> {
		if (!reconcile) {
			return await this.processOutboxInternal();
		}
		const reconciled = await this.runReconcile();
		const outboxProcessed = await this.processOutboxInternal();
		return reconciled + outboxProcessed;
	}

	private async processOutboxInternal(): Promise<number> {
		let processed = await this.retryPendingConnectionRequests();
		processed += await this.retryPendingConnectionResults();
		processed += await this.retryPendingPermissionsUpdates();
		processed += await this.retryPendingActionResults();
		processed += await this.drainQueuedJournalCommands();
		return processed;
	}

	/**
	 * Drain `queued` outbound journal entries that represent command intents
	 * written by another process (or by connect() when transport was busy).
	 *
	 * Claim protocol: transition queued → pending with claim metadata, execute,
	 * then write commandResult and transition to completed (even on failure).
	 *
	 * Stale claim recovery: pending entries with claim.claimedAt older than
	 * QUEUED_JOURNAL_STALE_CLAIM_MS are reset to queued so they can be retried.
	 */
	private async drainQueuedJournalCommands(): Promise<number> {
		const journal = this.context.requestJournal;

		// Recover stale claims from a previous crashed run before looking for
		// new work. This prevents a crashed entry from blocking the queue.
		const allPending = await journal.listPending("outbound");
		for (const entry of allPending) {
			if (!entry.method.startsWith("command/")) continue;
			const claim = entry.metadata?.claim as { claimedAt?: string } | undefined;
			if (!claim?.claimedAt) continue;
			const claimedAt = Date.parse(claim.claimedAt);
			if (Number.isFinite(claimedAt) && Date.now() - claimedAt >= QUEUED_JOURNAL_STALE_CLAIM_MS) {
				const { claim: _dropped, ...rest } = (entry.metadata ?? {}) as Record<string, unknown>;
				await journal.updateStatus(entry.requestId, "queued");
				await journal.updateMetadata(entry.requestId, rest);
			}
		}

		const queued = await journal.listQueued("outbound");
		let processed = 0;
		for (const entry of queued) {
			if (!entry.method.startsWith("command/")) continue;

			// Claim the entry: queued → pending with claim metadata.
			//
			// Ordering matters for crash safety. updateMetadata must run BEFORE
			// updateStatus. If we crash between the two writes with the old
			// "status first, metadata second" order, the entry ends up `pending`
			// with no `claim.claimedAt`, and neither the stale-claim recovery
			// loop (which keys on claim metadata) nor the queued-drain loop
			// (which scans `queued` only) would pick it up — a silent orphan.
			// With metadata first, a crash between writes leaves the entry
			// `queued` with stale claim metadata; the next queued-drain pass
			// finds it, overwrites the claim, and re-executes. The transient
			// stale claim metadata is harmless because the drain loop always
			// rewrites it on re-claim.
			const claimMeta: Record<string, unknown> = {
				...(entry.metadata ?? {}),
				claim: {
					owner: this.ownerLabel,
					claimedAt: nowISO(),
					pid: process.pid,
				},
			};
			await journal.updateMetadata(entry.requestId, claimMeta);
			await journal.updateStatus(entry.requestId, "pending");

			const commandType = entry.metadata?.commandType as TapCommandJob["type"] | undefined;
			const commandPayload = entry.metadata?.commandPayload as TapCommandJob["payload"] | undefined;

			if (!commandType || commandPayload === undefined) {
				this.log(
					"warn",
					`Queued journal entry ${entry.requestId} missing commandType or commandPayload — skipping`,
				);
				continue;
			}

			try {
				const result = await this.executeJournalCommand(commandType, commandPayload);
				await journal.updateMetadata(entry.requestId, {
					...claimMeta,
					commandResult: {
						jobId: entry.requestId,
						type: commandType,
						finishedAt: nowISO(),
						status: "completed",
						result,
					},
				});
				await journal.updateStatus(entry.requestId, "completed");
			} catch (error: unknown) {
				const message = toErrorMessage(error);
				this.log(
					"error",
					`Failed queued TAP command ${entry.requestId} (${commandType}): ${message}`,
				);
				await journal.updateMetadata(entry.requestId, {
					...claimMeta,
					commandResult: {
						jobId: entry.requestId,
						type: commandType,
						finishedAt: nowISO(),
						status: "failed",
						error: message,
						errorCode: error instanceof TrustedAgentError ? error.code : "UNKNOWN",
					},
				});
				await journal.updateStatus(entry.requestId, "completed");
			}
			processed += 1;
		}
		return processed;
	}

	private async executeJournalCommand(
		commandType: TapCommandJob["type"],
		commandPayload: TapCommandJob["payload"],
	): Promise<TapCommandJobResultPayload> {
		switch (commandType) {
			case "connect":
				// Journal commands are fire-and-forget: the caller polls the journal
				// entry for the result. Pass waitMs: 0 so connectInternal returns
				// immediately after send.
				return await this.connectInternal({
					...(commandPayload as { inviteUrl: string }),
					waitMs: 0,
				});
			case "send-message": {
				const p = commandPayload as {
					peer: string;
					text: string;
					scope: string;
					autoGenerated?: boolean;
				};
				return await this.sendMessageInternal(
					p.peer,
					p.text,
					p.scope,
					p.autoGenerated ? { autoGenerated: true } : undefined,
				);
			}
			case "publish-grant-set": {
				const p = commandPayload as {
					peer: string;
					grantSet: import("../permissions/types.js").PermissionGrantSet;
					note?: string;
				};
				return await this.publishGrantSetInternal(p.peer, p.grantSet, p.note);
			}
			case "request-grant-set": {
				const p = commandPayload as {
					peer: string;
					grantSet: import("../permissions/types.js").PermissionGrantSet;
					note?: string;
				};
				return await this.requestGrantSetInternal(p.peer, p.grantSet, p.note);
			}
			case "request-funds": {
				const p = commandPayload as { input: import("./service.js").TapRequestFundsInput };
				return await this.requestFundsInternal(p.input);
			}
			case "request-meeting": {
				const p = commandPayload as { input: import("./service.js").TapRequestMeetingInput };
				return await this.requestMeetingInternal(p.input);
			}
			default:
				throw new Error(`Unknown command type: ${String(commandType)}`);
		}
	}

	private installOutboxPoller(): void {
		if (this.outboxPollIntervalMs <= 0 || this.outboxPoller) {
			return;
		}
		this.outboxPoller = setInterval(() => {
			void this.tickOutboxPoller();
		}, this.outboxPollIntervalMs);
	}

	private clearOutboxPoller(): void {
		if (!this.outboxPoller) {
			return;
		}
		clearInterval(this.outboxPoller);
		this.outboxPoller = null;
	}

	private async tickOutboxPoller(): Promise<void> {
		if (!this.running || this.outboxPollInFlight) {
			return;
		}

		const poll = (async () => {
			await this.executionMutex.runExclusive(async () => await this.processOutboxInternal());
		})();
		this.outboxPollInFlight = poll;
		try {
			await poll;
		} catch (error: unknown) {
			this.log("warn", `Queued TAP command polling failed: ${toErrorMessage(error)}`);
		} finally {
			if (this.outboxPollInFlight === poll) {
				this.outboxPollInFlight = null;
			}
		}
	}

	private async withTransportSession<T>(task: () => Promise<T>): Promise<T> {
		if (this.running || this.transportSessionReentryDepth > 0) {
			return await task();
		}

		await this.ensureManifestLoaded();
		await this.ownerLock.acquire();
		this.transportSessionReentryDepth += 1;
		try {
			await this.ensureLegacyStateMigrated();
			this.context.transport.setHandlers(this.handlers);
			await this.context.transport.start?.();
			try {
				return await task();
			} finally {
				await this.drain();
				await this.context.transport.stop?.();
			}
		} finally {
			this.transportSessionReentryDepth -= 1;
			await this.ownerLock
				.release()
				.catch((releaseError: unknown) =>
					this.log(
						"warn",
						`Failed to release transport owner lock after transport session: ${toErrorMessage(releaseError)}`,
					),
				);
		}
	}

	private async runReconcile(): Promise<number> {
		const reconciled = (await this.context.transport.reconcile?.()) ?? {
			synced: true,
			processed: 0,
		};
		if (reconciled.errors && reconciled.errors > 0) {
			const samples = reconciled.errorSamples?.join("; ") ?? "";
			this.log(
				"warn",
				`Reconcile completed with ${reconciled.errors} error(s); processed ${reconciled.processed} message(s)${samples ? `. Samples: ${samples}` : ""}`,
			);
		}
		await this.drain();
		this.lastSyncAt = nowISO();
		return reconciled.processed;
	}

	private async buildSyncReport(processed: number): Promise<TapSyncReport> {
		// Single journal scan partitioned into the two views the report needs.
		// Avoids reading request-journal.json twice per sync.
		const [allPending, contacts] = await Promise.all([
			this.context.requestJournal.listPending(),
			this.context.trustStore.getContacts(),
		]);
		const pendingRequests = allPending
			.filter((entry) => entry.kind === "request" && !isOutboundDeliveryEntry(entry))
			.map((entry) => toPendingRequestView(entry, contacts));
		const pendingDeliveries = allPending
			.filter((entry) => entry.direction === "outbound" && isDeliveryEntry(entry))
			.map((entry) => toPendingDeliveryView(entry, Date.now()));
		return {
			synced: true,
			processed,
			pendingRequests,
			pendingDeliveries,
		};
	}

	private emitEvent(payload: Record<string, unknown>): void {
		try {
			this.hooks.emitEvent?.({
				timestamp: nowISO(),
				...payload,
			});
		} catch (error: unknown) {
			this.log("warn", `emitEvent hook threw: ${toErrorMessage(error)}`);
		}
	}

	private emit(body: TapEventBody): void {
		const event = {
			id: `evt-${randomUUID()}`,
			occurredAt: nowISO(),
			identityAgentId: this.context.config.agentId,
			...body,
		} as TapEvent;
		try {
			this.hooks.onTypedEvent?.(event);
		} catch (error: unknown) {
			this.log("warn", `onTypedEvent hook threw: ${toErrorMessage(error)}`);
		}
	}

	private peerRefFromContact(contact: Contact): TapPeerRef {
		return {
			connectionId: contact.connectionId,
			peerAgentId: contact.peerAgentId,
			peerName: contact.peerDisplayName,
			peerChain: contact.peerChain,
		};
	}

	private emitActionRequested(
		contact: Contact,
		requestId: string,
		kind: TapActionKind,
		payload: Record<string, unknown>,
		direction: "inbound" | "outbound",
	): void {
		this.emit({
			type: "action.requested",
			conversationId: resolveConversationId(contact),
			peer: this.peerRefFromContact(contact),
			requestId,
			kind,
			payload,
			direction,
		});
	}

	private emitActionPending(
		contact: Contact,
		requestId: string,
		kind: TapActionKind,
		payload: Record<string, unknown>,
	): void {
		this.emit({
			type: "action.pending",
			conversationId: resolveConversationId(contact),
			requestId,
			kind,
			payload,
			awaitingDecision: true,
		});
	}

	private emitConnectionEstablished(connectionId: string, peer: TapPeerRef): void {
		this.emit({ type: "connection.established", connectionId, peer });
	}

	private emitConnectionRequested(
		requestId: string,
		peerAgentId: number,
		peerChain: string,
		direction: "inbound" | "outbound",
	): void {
		this.emit({ type: "connection.requested", requestId, peerAgentId, peerChain, direction });
	}

	private emitActionCompleted(
		conversationId: string,
		requestId: string,
		kind: TapActionKind,
		result: Record<string, unknown>,
		extras?: Record<string, unknown>,
	): void {
		this.emit({
			type: "action.completed",
			conversationId,
			requestId,
			kind,
			result,
			...extras,
			completedAt: nowISO(),
		});
	}

	private emitActionFailed(
		conversationId: string,
		requestId: string,
		kind: TapActionKind,
		error: string,
	): void {
		this.emit({ type: "action.failed", conversationId, requestId, kind, error });
	}

	private emitIncomingAndReturn<S extends string>(
		envelope: { from: number; message: ProtocolMessage },
		status: S,
		extra?: Record<string, unknown>,
	): { status: S } {
		this.emitEvent({
			direction: "incoming",
			from: envelope.from,
			method: envelope.message.method,
			id: envelope.message.id,
			receipt_status: status,
			...extra,
		});
		return { status };
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.hooks.log?.(level, message);
	}

	private async runLegacyStateMigrations(): Promise<void> {
		await this.migratePendingConnects();
		await this.migrateOutbox();
		await this.context.requestJournal.migrateLegacyAcked?.();
	}

	private async ensureLegacyStateMigrated(): Promise<void> {
		if (this.legacyStateMigrationsComplete) {
			return;
		}
		await this.runLegacyStateMigrations();
		this.legacyStateMigrationsComplete = true;
	}

	private async migratePendingConnects(): Promise<void> {
		const path = join(this.context.config.dataDir, "pending-connects.json");
		let raw: string;
		try {
			raw = await readFile(path, "utf-8");
		} catch (error: unknown) {
			if (fsErrorCode(error) === "ENOENT") return; // Nothing to migrate
			throw error;
		}

		let parsed: { pendingConnects?: LegacyPendingConnect[] };
		try {
			parsed = JSON.parse(raw) as { pendingConnects?: LegacyPendingConnect[] };
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to parse legacy pending-connects.json: ${toErrorMessage(error)}. Skipping migration.`,
			);
			return;
		}

		const records = parsed.pendingConnects ?? [];
		let migrated = 0;
		for (const legacy of records) {
			// Idempotent: if a contact already exists for this peer (from a previous
			// migration run or new flow), skip this legacy record.
			const existing = await this.context.trustStore.findByAgentId(
				legacy.peerAgentId,
				legacy.peerChain,
			);
			if (existing) continue;

			await this.context.trustStore.addContact({
				connectionId: generateConnectionId(),
				peerAgentId: legacy.peerAgentId,
				peerChain: legacy.peerChain,
				peerOwnerAddress: legacy.peerOwnerAddress,
				peerDisplayName: legacy.peerDisplayName,
				peerAgentAddress: legacy.peerAgentAddress,
				permissions: createEmptyPermissionState(legacy.createdAt),
				establishedAt: legacy.createdAt,
				lastContactAt: legacy.createdAt,
				status: "connecting",
				// Note: legacy records did not carry expiresAt; leave it undefined.
				// These old connecting rows will never expire on their own but can be
				// cleaned up manually via `tap contacts remove`.
			});
			migrated += 1;
		}

		await rm(path);

		if (migrated > 0) {
			this.log(
				"info",
				`Migrated ${migrated} pending-connects.json record(s) to connecting contacts`,
			);
		}
	}

	/**
	 * Migrate legacy `outbox/` directory-based queue entries into the request
	 * journal as `queued` outbound entries. Called on service start.
	 *
	 * Reads files from `outbox/queued/` and `outbox/processing/` (both become
	 * `queued` journal entries — processing entries failed to complete last time).
	 * Files in `outbox/results/` are discarded.
	 * Deletes the migrated files and removes the outbox directory if empty.
	 * Idempotent: no-op if the outbox directory does not exist.
	 */
	private async migrateOutbox(): Promise<void> {
		const dataDir = this.context.config.dataDir;
		const outboxDir = join(dataDir, "outbox");
		const queuedDir = join(outboxDir, "queued");
		const processingDir = join(outboxDir, "processing");
		const resultsDir = join(outboxDir, "results");

		// Idempotent: nothing to do if the legacy outbox directory doesn't exist.
		let queuedFiles: string[] = [];
		let processingFiles: string[] = [];
		try {
			queuedFiles = (await readdir(queuedDir)).filter((f) => f.endsWith(".json")).sort();
		} catch (error: unknown) {
			if (fsErrorCode(error) !== "ENOENT") throw error;
		}
		try {
			processingFiles = (await readdir(processingDir)).filter((f) => f.endsWith(".json")).sort();
		} catch (error: unknown) {
			if (fsErrorCode(error) !== "ENOENT") throw error;
		}
		// Delete results without preserving — they were short-lived blobs.
		try {
			const resultFiles = (await readdir(resultsDir)).filter((f) => f.endsWith(".json"));
			await Promise.all(resultFiles.map((f) => rm(join(resultsDir, f), { force: true })));
			await rm(resultsDir, { force: true, recursive: true });
		} catch (error: unknown) {
			if (fsErrorCode(error) !== "ENOENT") throw error;
		}

		if (queuedFiles.length === 0 && processingFiles.length === 0) {
			// Nothing in queued or processing; clean up empty dirs if they exist.
			await rm(outboxDir, { force: true, recursive: true });
			return;
		}

		const journal = this.context.requestJournal;
		let migrated = 0;

		const migrateFile = async (filePath: string): Promise<void> => {
			let raw: string;
			try {
				raw = await readFile(filePath, "utf-8");
			} catch (error: unknown) {
				if (fsErrorCode(error) === "ENOENT") return; // Already deleted
				throw error;
			}
			let job: Record<string, unknown>;
			try {
				job = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				this.log("warn", `Failed to parse legacy outbox file ${filePath} — skipping`);
				await rm(filePath, { force: true });
				return;
			}
			const commandType = job.type as string | undefined;
			const commandPayload = job.payload;
			const requestedBy = job.requestedBy as string | undefined;
			if (!commandType || commandPayload === undefined) {
				this.log("warn", `Legacy outbox file ${filePath} missing type/payload — discarding`);
				await rm(filePath, { force: true });
				return;
			}
			const requestId = generateNonce();
			await journal.putOutbound({
				requestId,
				requestKey: `outbound:command:${requestId}`,
				direction: "outbound",
				kind: "request",
				method: `command/${commandType}`,
				peerAgentId: 0,
				status: "queued",
				metadata: {
					commandType,
					commandPayload,
					...(requestedBy !== undefined ? { commandRequestedBy: requestedBy } : {}),
				},
			});
			await rm(filePath, { force: true });
			migrated += 1;
		};

		for (const name of queuedFiles) {
			await migrateFile(join(queuedDir, name));
		}
		for (const name of processingFiles) {
			await migrateFile(join(processingDir, name));
		}

		// Remove the outbox directory tree now that files are migrated.
		await rm(outboxDir, { force: true, recursive: true });

		if (migrated > 0) {
			this.log("info", `Migrated ${migrated} legacy outbox job(s) to queued journal entries`);
		}
	}

	private appendLedger(entry: PermissionLedgerEntry): Promise<string> {
		if (this.hooks.appendLedgerEntry) {
			return this.hooks.appendLedgerEntry(this.context.config.dataDir, entry);
		}
		return appendPermissionLedgerEntry(this.context.config.dataDir, entry);
	}

	private async sendAndJournalOutboundRequest(
		contact: Contact,
		request: ProtocolMessage,
		requestId: string,
		timestamp: string,
		metadata?: Record<string, unknown>,
		onSendError?: () => void,
	): Promise<TransportReceipt> {
		await this.context.requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:${request.method}:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: request.method,
			peerAgentId: contact.peerAgentId,
			status: "pending",
			...(metadata ? { metadata } : {}),
		});

		let receipt: TransportReceipt;
		try {
			receipt = await this.context.transport.send(contact.peerAgentId, request, {
				peerAddress: contact.peerAgentAddress,
			});
		} catch (error: unknown) {
			onSendError?.();
			if (!isTransportReceiptTimeout(error)) {
				await this.context.requestJournal.delete(requestId);
			}
			throw error;
		}

		await this.appendConversationLogSafe(contact, request, "outgoing", timestamp);

		return receipt;
	}

	private async appendConversationLogSafe(
		contact: Contact,
		request: ProtocolMessage,
		direction: "incoming" | "outgoing",
		timestamp?: string,
	): Promise<void> {
		try {
			await appendConversationLog(
				this.context.conversationLogger,
				contact,
				request,
				direction,
				timestamp,
			);
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to record conversation log for ${peerLabel(contact)}: ${toErrorMessage(error)}`,
			);
		}
		try {
			await this.context.trustStore.touchContact(contact.connectionId);
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to update contact activity for ${contact.connectionId}: ${toErrorMessage(error)}`,
			);
		}
	}

	private enqueue(key: string, task: () => Promise<void>): void {
		if (this.inFlightKeys.has(key)) {
			return;
		}

		this.inFlightKeys.add(key);
		const promise = task()
			.catch((error: unknown) => {
				this.log("error", toErrorMessage(error));
			})
			.finally(() => {
				this.inFlightKeys.delete(key);
				this.pendingTasks.delete(promise);
			});
		this.pendingTasks.add(promise);
	}

	private async drain(): Promise<void> {
		await Promise.allSettled([...this.pendingTasks]);
	}

	private registerActionResultWaiter(
		requestId: string,
		actionId: string,
		timeoutMs: number,
		options?: {
			/**
			 * When false, any result correlated to this requestId settles the
			 * waiter even if its data part carries no matching actionId. Used
			 * by flows that must distinguish a delivered failure result (e.g.
			 * an UNSUPPORTED_ACTION reply from a pre-postage peer, which has
			 * no actionId at all) from a genuine timeout. Defaults to true —
			 * the transfer flow's original strict matching.
			 */
			matchActionId?: boolean;
		},
	): {
		promise: Promise<TransferActionResponse | null>;
		cancel: () => void;
	} {
		let settle: (value: TransferActionResponse | null) => void = () => {};
		const promise = new Promise<TransferActionResponse | null>((resolve) => {
			settle = resolve;
		});
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			finish(null);
		}, timeoutMs);

		const finish = (value: TransferActionResponse | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = null;
			}
			if (this.waiters.get(requestId) === onResult) {
				this.waiters.delete(requestId);
			}
			settle(value);
		};

		const onResult = (value: TransferActionResponse) => {
			if ((options?.matchActionId ?? true) && value.actionId !== actionId) {
				return;
			}
			finish(value);
		};

		this.waiters.set(requestId, onResult);
		return {
			promise,
			cancel: () => finish(null),
		};
	}

	private async readRecordedTransferResponse(
		requestId: string,
	): Promise<TransferActionResponse | null> {
		const entry = await this.context.requestJournal.getByRequestId(requestId);
		return parseRecordedTransferResponse(entry?.metadata);
	}

	/**
	 * The quote a rejected sender receives in `error.data` of a -32050:
	 * this agent's advertised price list (mirrors the registration file's
	 * `trustedAgentProtocol.attention` block). An empty pricing map is
	 * legal — enforcement without published prices means "granted peers
	 * only".
	 */
	private buildAttentionQuote(): AttentionQuote {
		return {
			version: "1.0",
			currency: "USDC",
			chain: this.context.config.chain,
			pricing: this.context.config.attention?.pricing ?? {},
		};
	}

	/**
	 * Try to pay for an un-granted inbound message with its postage stamp.
	 * Returns null when the stamp covered the price (the debit is already
	 * persisted), otherwise the rejection to put on the wire. Charging
	 * happens against the `standard` tier: without a published standard
	 * price, enforcement stays "granted peers only" (Phase 3 semantics).
	 */
	private async chargePostageStamp(
		envelope: { from: number; message: ProtocolMessage },
		contact: Contact,
		requestKey: string,
	): Promise<
		{ charged: PaidPostageRef } | { rejection: { message: string; postage: PostageRejection } }
	> {
		const stamp = extractPostageStamp(envelope.message.params);
		if (!stamp) {
			return {
				rejection: {
					message: `attention payment required: no active ${MESSAGE_SEND} grant and no postage stamp from agent #${envelope.from}`,
					postage: { reason: "missing_stamp" },
				},
			};
		}
		const required = this.context.config.attention?.pricing?.standard;
		if (required === undefined) {
			return {
				rejection: {
					message:
						"attention payment required: no standard attention price published — granted peers only",
					postage: { reason: "unpriced", creditId: stamp.creditId },
				},
			};
		}
		const debit = await this.postageLedger.debitIssued({
			creditId: stamp.creditId,
			peer: postagePeerKey({ chain: contact.peerChain, agentId: contact.peerAgentId }),
			seq: stamp.seq,
			cost: stamp.cost,
			required,
			// Keyed to this delivery so a crash-window redelivery of the same
			// message passes idempotently instead of bouncing as a replay.
			stampKey: requestKey,
		});
		if (debit.ok) {
			const tier = this.paidStampTier(stamp.cost);
			// A stamp that overpays standard yet undercuts the current
			// priority price (typically a sender pricing from a stale
			// registration after a price raise) is honored at standard —
			// surface it so the operator can see the mismatch.
			const priorityPrice = this.context.config.attention?.pricing?.priority;
			if (
				tier === "standard" &&
				priorityPrice !== undefined &&
				postageAmountToMicros(stamp.cost) > postageAmountToMicros(required)
			) {
				this.log(
					"warn",
					`postage stamp from agent #${envelope.from} paid ${stamp.cost} (above standard ${required}, below priority ${priorityPrice}) — treated as standard`,
				);
			}
			return { charged: { tier, cost: stamp.cost } };
		}
		return {
			rejection: {
				message: this.describePostageRejection(debit.rejection),
				postage: debit.rejection,
			},
		};
	}

	/**
	 * The tier a successfully debited stamp bought: "priority" when the
	 * stamp covered this agent's advertised priority price (the wake-up
	 * tier), otherwise "standard". Without a published priority price
	 * nothing can buy priority treatment.
	 */
	private paidStampTier(cost: string): PaidPostageRef["tier"] {
		const priorityPrice = this.context.config.attention?.pricing?.priority;
		if (priorityPrice === undefined) {
			return "standard";
		}
		return postageAmountToMicros(cost) >= postageAmountToMicros(priorityPrice)
			? "priority"
			: "standard";
	}

	/**
	 * Grant holders ride free at standard treatment, but a stamp worth the
	 * priority tier still buys a wake-up — the grant exempts the message,
	 * not the escalation. Any failure here degrades silently to plain
	 * grant delivery: a grant holder is never rejected over a bad stamp.
	 */
	private async chargeOptionalPriorityStamp(
		envelope: { message: ProtocolMessage },
		contact: Contact,
		requestKey: string,
	): Promise<PaidPostageRef | undefined> {
		const stamp = extractPostageStamp(envelope.message.params);
		if (!stamp) {
			return undefined;
		}
		const priorityPrice = this.context.config.attention?.pricing?.priority;
		if (priorityPrice === undefined || !isValidPostageAmount(stamp.cost)) {
			return undefined;
		}
		if (postageAmountToMicros(stamp.cost) < postageAmountToMicros(priorityPrice)) {
			return undefined;
		}
		const debit = await this.postageLedger.debitIssued({
			creditId: stamp.creditId,
			peer: postagePeerKey({ chain: contact.peerChain, agentId: contact.peerAgentId }),
			seq: stamp.seq,
			cost: stamp.cost,
			required: priorityPrice,
			stampKey: requestKey,
		});
		if (!debit.ok) {
			this.log(
				"warn",
				`priority stamp from grant holder ${contact.peerDisplayName} not charged (${debit.rejection.reason}) — delivering at grant treatment`,
			);
			return undefined;
		}
		return { tier: "priority", cost: stamp.cost };
	}

	private describePostageRejection(rejection: PostageRejection): string {
		switch (rejection.reason) {
			case "unknown_credit":
				return `attention payment required: unknown postage credit ${rejection.creditId}`;
			case "seq_replayed":
				return `attention payment required: postage stamp seq already spent on credit ${rejection.creditId}`;
			case "below_price":
				return `attention payment required: postage stamp does not cover the standard price ${rejection.required}`;
			case "insufficient_credit":
				return `attention payment required: postage credit ${rejection.creditId} exhausted (remaining ${rejection.remaining}, needed ${rejection.required}) — top up to continue`;
			default:
				return "attention payment required";
		}
	}

	/**
	 * The peer's advertised attention price list from its (cached)
	 * registration file, or null when absent/empty. Resolution failures
	 * never block a send — the fire-and-forget default is the fallback.
	 */
	private async resolvePeerAttentionPricing(
		contact: Contact,
		maxAgeMs?: number,
	): Promise<Record<string, string> | null> {
		try {
			const resolved = await this.context.resolver.resolveWithCache(
				contact.peerAgentId,
				contact.peerChain,
				maxAgeMs ?? this.context.config.resolveCacheTtlMs,
			);
			const pricing = resolved.attention?.pricing;
			return pricing !== undefined && Object.keys(pricing).length > 0 ? pricing : null;
		} catch {
			return null;
		}
	}

	/**
	 * Auto-stamp an outbound message to a priced peer: holders of a
	 * `message/send` grant ride free, otherwise spend one stamp at the
	 * peer's standard price from a held credit. A priority send pays the
	 * peer's priority price instead — even when a grant is held, because a
	 * grant only buys standard delivery, never the wake-up. Returns
	 * undefined when no stamp applies (grant held, no published price, or
	 * no usable credit) — the message still goes out and an enforcing
	 * receiver answers with a -32050 quote the caller sees thanks to
	 * waitForAck.
	 */
	private async stampOutboundMessage(
		contact: Contact,
		pricing: Record<string, string>,
		options?: TapSendMessageOptions,
	): Promise<PostageStamp | undefined> {
		const holdsGrant =
			findActiveGrantsByScope(contact.permissions.grantedByPeer, MESSAGE_SEND).length > 0;
		// An un-granted priority send additionally needs the peer to publish a
		// standard price: a standard-less receiver admits un-granted mail
		// never (its enforcement rejects "unpriced" before reading the
		// stamp), so stamping would burn the credit on a doomed message.
		// Grant holders are exempt — their delivery rides the grant and the
		// receiver's priority charge path needs only the priority price.
		const wantsPriority =
			options?.priority === true &&
			pricing.priority !== undefined &&
			(holdsGrant || pricing.standard !== undefined);
		if (!wantsPriority && holdsGrant) {
			return undefined;
		}
		const required = wantsPriority ? pricing.priority : pricing.standard;
		if (required === undefined) {
			return undefined;
		}
		const stamped = await this.postageLedger.stampHeld({
			peer: postagePeerKey({ chain: contact.peerChain, agentId: contact.peerAgentId }),
			cost: required,
		});
		if (!stamped.ok) {
			return undefined;
		}
		return stamped.stamp;
	}

	private async onRequest(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" | "queued" }> {
		const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
		if (envelope.message.method === CONNECTION_REQUEST) {
			const claimed = await this.context.requestJournal.claimInbound({
				requestId: String(envelope.message.id),
				requestKey,
				direction: "inbound",
				kind: "request",
				method: envelope.message.method,
				peerAgentId: envelope.from,
				metadata: serializePendingConnectionRequest(envelope.message),
			});

			if (claimed.duplicate && claimed.entry.status === "completed") {
				return this.emitIncomingAndReturn(envelope, "duplicate");
			}

			if (!claimed.duplicate) {
				this.emitConnectionRequested(
					String(envelope.message.id),
					envelope.from,
					(envelope.message.params as { from?: { chain?: string } } | undefined)?.from?.chain ?? "",
					"inbound",
				);
			}

			this.enqueue(requestKey, async () => {
				const result = await this.processConnectionRequest(envelope.message);
				if (result === "processed") {
					await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
				}
			});
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued");
		}

		const claimed = await this.context.requestJournal.claimInbound({
			requestId: String(envelope.message.id),
			requestKey,
			direction: "inbound",
			kind: "request",
			method: envelope.message.method,
			peerAgentId: envelope.from,
		});

		if (claimed.duplicate && claimed.entry.status === "completed") {
			return this.emitIncomingAndReturn(envelope, "duplicate");
		}

		// connection/revoke must dispatch BEFORE the generic findContactForMessage
		// lookup because that helper falls back to `findUniqueContactForAgentId`,
		// which throws when multiple contacts share the same numeric agent id
		// across different chains. `processConnectionRevoke` parses `from.chain`
		// from the revoke payload and does its own chain-scoped `findByAgentId`,
		// so valid revokes for a specific chain still land correctly when another
		// contact on a different chain happens to share the numeric agent id.
		// A revoke is also teardown, so we don't need the implicit-handshake-
		// completion side effect that runs in the generic non-revoke path.
		//
		// The authenticated sender's agentId (envelope.from) is passed in so
		// processConnectionRevoke can reject spoofed params.from — the transport
		// layer guarantees envelope.from reflects the real sender, but the
		// payload's params.from is attacker-controlled.
		if (envelope.message.method === CONNECTION_REVOKE) {
			await this.processConnectionRevoke(envelope.message, envelope.from);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received");
		}

		const contact = await findContactForMessage(this.context, envelope.from, envelope.message);
		if (!contact) {
			throw new ValidationError(`No contact found for agent ${envelope.from}`);
		}

		// Implicit handshake completion: the peer could only be sending us a
		// non-bootstrap request if they already have an active contact for us,
		// which means they received our connection/result. Any pending outbound
		// connection/result entries for this peer are now load-bearing no more.
		if (contact.status === "active") {
			await this.markPendingConnectionResultsCompletedFor(contact.peerAgentId, contact.peerChain);
		}

		if (envelope.message.method === PERMISSIONS_UPDATE) {
			await this.handlePermissionsUpdate(contact, envelope.message);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
			});
		}

		// Attention enforcement (message/send only): with `attention.enforce`
		// on, a message from a sender holding no active "message/send" grant
		// from us must pay with a prepaid postage stamp; a grant is a free
		// stamp. Unpaid messages are rejected with a machine-readable quote
		// BEFORE they reach the conversation log or the notification
		// pipeline — a rejected message must cost this agent's LLM nothing.
		// Rejections mark the journal entry completed before the throw so
		// full-history syncs replay the duplicate short-circuit instead of
		// re-running enforcement per replay. Accepted stamps complete the
		// journal further down (after the conversation log); a crash in
		// between redelivers the message with its journal entry pending, and
		// the ledger's stampKey idempotency lets that exact redelivery pass
		// without double-debiting.
		let paidPostage: PaidPostageRef | undefined;
		if (envelope.message.method === MESSAGE_SEND && this.context.config.attention?.enforce) {
			const grants = findActiveGrantsByScope(contact.permissions.grantedByMe, MESSAGE_SEND);
			if (grants.length === 0) {
				const outcome = await this.chargePostageStamp(envelope, contact, requestKey);
				if ("rejection" in outcome) {
					await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
					throw new AttentionPaymentRequiredError(
						outcome.rejection.message,
						this.buildAttentionQuote(),
						outcome.rejection.postage,
					);
				}
				paidPostage = outcome.charged;
			} else {
				// Grant holders deliver free, but a priority-tier stamp still
				// buys the wake-up escalation.
				paidPostage = await this.chargeOptionalPriorityStamp(envelope, contact, requestKey);
			}
		}

		await this.appendConversationLogSafe(contact, envelope.message, "incoming");

		if (envelope.message.method === MESSAGE_SEND) {
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");

			// Extract message text and autoGenerated flag for emitEvent
			let messageText = "";
			let autoGenerated = false;
			try {
				const params = envelope.message.params as MessageSendParams | undefined;
				if (params?.message?.parts) {
					messageText = params.message.parts
						.filter((p): p is TextPart => p.kind === "text")
						.map((p) => p.text)
						.join("\n");
				}
				autoGenerated = params?.message?.metadata?.trustedAgent?.autoGenerated === true;
			} catch {
				// Defensive: don't fail message processing if extraction fails
			}

			// A duplicate delivery normally stays silent, with one exception:
			// when postage was charged for it (paidPostage set), this is the
			// crash-window redelivery of a message whose first delivery died
			// before this emit — the stampKey idempotency already made the
			// charge free, and skipping the emit here would keep the money
			// while dropping everything it bought (the notification line and,
			// for priority stamps, the wake-up).
			if (!claimed.duplicate || paidPostage !== undefined) {
				const params = envelope.message.params as MessageSendParams | undefined;
				const scope =
					(params?.message?.metadata?.trustedAgent as { scope?: string } | undefined)?.scope ??
					DEFAULT_MESSAGE_SCOPE;
				this.emit({
					type: "message.received",
					conversationId: resolveConversationId(contact),
					peer: this.peerRefFromContact(contact),
					messageId: String(envelope.message.id),
					text: messageText,
					scope,
					...(paidPostage ? { postage: paidPostage } : {}),
				});
			}

			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
				messageText,
				autoGenerated,
			});
		}

		if (envelope.message.method !== ACTION_REQUEST) {
			throw new ValidationError(`Unsupported request method: ${envelope.message.method}`);
		}

		// Extract the action type from the data payload
		const actionData = extractMessageData(envelope.message);
		const actionType = typeof actionData?.type === "string" ? actionData.type : undefined;

		// Route through the app registry to determine if a handler exists
		const resolved = actionType
			? await this.context.appRegistry.resolveHandler(actionType)
			: undefined;

		if (!resolved) {
			// No handler registered — send an error result back
			await this.sendUnsupportedActionResult(
				contact,
				String(envelope.message.id),
				actionType ?? "unknown",
				requestKey,
			);
			await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
			return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
				fromName: contact.peerDisplayName,
				error: "UNSUPPORTED_ACTION",
				actionType: actionType ?? "unknown",
			});
		}

		// Delegate to built-in handlers that use the existing codepaths.
		// The inline app registrations (tap-transfer, tap-permissions) exist to
		// claim action types in the registry. Their actual processing is still
		// done by the existing methods below. The scheduling app delegates to
		// SchedulingHandler via dispatchToApp.
		if (resolved.app.id === "tap-permissions") {
			const permissionRequest = parsePermissionGrantRequest(envelope.message);
			if (permissionRequest) {
				await this.handlePermissionGrantRequest(contact, permissionRequest);
				await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "received", {
					fromName: contact.peerDisplayName,
				});
			}
			// Malformed permissions payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "permissions/request-grants",
				requestKey,
				claimed.duplicate,
			);
		}

		if (resolved.app.id === "scheduling") {
			const schedulingRequest = parseSchedulingActionRequest(envelope.message);
			if (schedulingRequest) {
				await this.context.requestJournal.updateMetadata(
					String(envelope.message.id),
					serializePendingSchedulingRequestDetails(
						contact,
						schedulingRequest,
						this.context.config.dataDir,
						"inbound",
					),
				);
				if (schedulingRequest.type === "scheduling/counter") {
					await this.closePendingOutboundSchedulingRequestForCounter(
						contact.peerAgentId,
						schedulingRequest.schedulingId,
					);
				}

				if (!claimed.duplicate) {
					this.emitActionRequested(
						contact,
						String(envelope.message.id),
						"scheduling",
						schedulingRequest as unknown as Record<string, unknown>,
						"inbound",
					);
				}

				this.enqueue(requestKey, async () => {
					await this.processSchedulingRequest(
						contact,
						String(envelope.message.id),
						schedulingRequest,
					);
				});

				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
					fromName: contact.peerDisplayName,
					scope: "scheduling/request",
				});
			}
			// Malformed scheduling payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "scheduling/propose",
				requestKey,
				claimed.duplicate,
			);
		}

		if (resolved.app.id === "tap-transfer") {
			const transferRequest = parseTransferActionRequest(envelope.message);
			if (transferRequest) {
				await this.context.requestJournal.updateMetadata(
					String(envelope.message.id),
					serializePendingTransferRequestDetails(
						contact,
						transferRequest,
						this.context.config.dataDir,
					),
				);

				if (!claimed.duplicate) {
					this.emitActionRequested(
						contact,
						String(envelope.message.id),
						"transfer",
						transferRequest as Record<string, unknown>,
						"inbound",
					);
				}

				this.enqueue(requestKey, async () => {
					await this.processTransferRequest(contact, String(envelope.message.id), transferRequest);
				});
				return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
					fromName: contact.peerDisplayName,
				});
			}
			// Malformed transfer payload — reject instead of falling through
			return this.rejectMalformedPayload(
				contact,
				String(envelope.message.id),
				actionType ?? "transfer/request",
				requestKey,
				claimed.duplicate,
			);
		}

		// For dynamically loaded (non-builtin) apps, use the full app dispatch path
		this.enqueue(requestKey, async () => {
			await this.dispatchToApp(
				contact,
				String(envelope.message.id),
				resolved,
				actionData ?? {},
				requestKey,
			);
		});
		return this.emitIncomingAndReturn(envelope, claimed.duplicate ? "duplicate" : "queued", {
			fromName: contact.peerDisplayName,
			scope: actionType,
		});
	}

	private async onResult(envelope: {
		from: number;
		senderInboxId: string;
		message: ProtocolMessage;
	}): Promise<{ status: "received" | "duplicate" }> {
		if (envelope.message.method === CONNECTION_RESULT) {
			const status = await this.handleConnectionResult(envelope.message);
			return this.emitIncomingAndReturn(envelope, status);
		}

		const requestKey = buildRequestKey(envelope.senderInboxId, envelope.message);
		const claimed = await this.context.requestJournal.claimInbound({
			requestId: String(envelope.message.id),
			requestKey,
			direction: "inbound",
			kind: "result",
			method: envelope.message.method,
			peerAgentId: envelope.from,
		});

		if (claimed.duplicate && claimed.entry.status === "completed") {
			return this.emitIncomingAndReturn(envelope, "duplicate");
		}

		let peerName: string | undefined;
		if (envelope.message.method === ACTION_RESULT) {
			// Implicit handshake completion runs inside `handleActionResult`
			// once the contact (and therefore peerChain) is resolved.
			peerName = await this.handleActionResult(envelope.from, envelope.message);
		} else {
			throw new ValidationError(`Unsupported result method: ${envelope.message.method}`);
		}

		await this.context.requestJournal.updateStatus(String(envelope.message.id), "completed");
		return this.emitIncomingAndReturn(
			envelope,
			claimed.duplicate ? "duplicate" : "received",
			peerName ? { fromName: peerName } : undefined,
		);
	}

	private async processConnectionRequest(message: ProtocolMessage): Promise<"processed"> {
		const params = parseConnectionRequest(message);

		// Cheap local check first — avoids resolving a peer for misrouted requests
		const inviteRejectionReason = await this.validateInboundInvite(params.invite);
		if (inviteRejectionReason) {
			const peer = await this.context.resolver.resolveWithCache(
				params.from.agentId,
				params.from.chain,
			);
			await this.sendConnectionResult(peer, {
				requestId: String(message.id),
				from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
				status: "rejected",
				reason: inviteRejectionReason,
				timestamp: nowISO(),
			});
			this.log(
				"warn",
				`Rejected connection request from ${peer.registrationFile.name} (#${peer.agentId}): ${inviteRejectionReason}`,
			);
			return "processed";
		}

		// 1. Plan — pure, no trust store writes.
		const plan = await handleConnectionRequest({
			message,
			resolver: this.context.resolver,
			trustStore: this.context.trustStore,
			ownAgent: { agentId: this.context.config.agentId, chain: this.context.config.chain },
		});

		// 2. Persist outbound journal entry + send wire (plan is stored in metadata
		//    so the retry pipeline can write the contact if this send fails).
		await this.sendConnectionResult(plan.peer, plan.result, {
			plannedContact: plan.plannedContact,
			existingContact: plan.existingContact,
		});

		// 3. Verify the send succeeded — the journal entry must be completed.
		//    If it is still pending the send failed and the contact must not be
		//    written yet; the retry pipeline will resend and write the contact.
		const deliveryRequestId = deriveConnectionResultId({
			chain: plan.peer.chain,
			peerAgentId: plan.peer.agentId,
			correlationId: plan.result.requestId,
		});
		const delivery = await this.context.requestJournal.getByRequestId(deliveryRequestId);
		if (delivery?.status !== "completed") {
			this.log(
				"warn",
				`Connection result send failed for ${plan.peer.registrationFile.name} (#${plan.peer.agentId}); contact will remain unwritten until reconciliation`,
			);
			return "processed";
		}

		// 4. Send succeeded — write the contact to the trust store.
		await applyConnectionResultContact(this.context.trustStore, plan);

		this.log(
			"info",
			`Accepted connection request from ${plan.peer.registrationFile.name} (#${plan.peer.agentId})`,
		);

		this.emitConnectionEstablished(plan.plannedContact.connectionId, {
			connectionId: plan.plannedContact.connectionId,
			peerAgentId: plan.peer.agentId,
			peerName: plan.peer.registrationFile.name,
			peerChain: plan.peer.chain,
		});

		// 5. Notify the host (non-blocking, informational).
		try {
			await this.hooks.onConnectionEstablished?.({
				peerAgentId: plan.peer.agentId,
				peerName: plan.peer.registrationFile.name,
				peerChain: plan.peer.chain,
			});
		} catch (error: unknown) {
			this.log("warn", `onConnectionEstablished hook threw: ${toErrorMessage(error)}`);
		}

		return "processed";
	}

	private async processConnectionRevoke(
		message: ProtocolMessage,
		authenticatedSenderAgentId: number,
	): Promise<"processed"> {
		const params = parseConnectionRevoke(message);

		// Security: validate the payload's from.agentId matches the authenticated
		// transport sender. The transport layer resolves envelope.from from the
		// sender's XMTP inbox, so it cannot be spoofed by an attacker. Without
		// this cross-check, any currently active peer could forge a revoke
		// naming another contact and have us delete the wrong record.
		if (params.from.agentId !== authenticatedSenderAgentId) {
			this.log(
				"warn",
				`Rejecting connection/revoke: payload from.agentId=${params.from.agentId} does not match authenticated sender agentId=${authenticatedSenderAgentId}`,
			);
			return "processed";
		}

		const existing = await this.context.trustStore.findByAgentId(
			params.from.agentId,
			params.from.chain,
		);
		if (!existing) {
			this.log(
				"info",
				`Received connection/revoke from unknown peer agent #${params.from.agentId} on ${params.from.chain}; ignoring.`,
			);
			return "processed";
		}

		// Additional defense: verify the found contact's peerAgentAddress is
		// the same 0x address we would resolve for the authenticated sender.
		// Because envelope.from is authoritative for (numeric) agentId, the
		// primary spoofing case (cross-peer) is already blocked above. The
		// remaining narrow window is a cross-chain collision where two real
		// agents share the same numeric agentId on different chains and one
		// is an active contact of ours — verifying peerAgentAddress via the
		// trust store doesn't close that, but by construction the revoker is
		// one of our own active contacts, so the worst case is we accept a
		// cross-chain revoke from a legitimate peer who happens to share the
		// numeric id. This is documented in spec §3.4 as the narrow residual
		// threat model pending a per-chain envelope enrichment.
		await this.context.trustStore.removeContact(existing.connectionId);
		const reasonSuffix = params.reason ? `: ${params.reason}` : "";
		this.log(
			"info",
			`Peer ${peerLabel(existing)} revoked the connection${reasonSuffix}; contact removed.`,
		);
		return "processed";
	}

	private async validateInboundInvite(
		invite: ConnectionRequestParams["invite"],
	): Promise<string | null> {
		if (
			invite.agentId !== this.context.config.agentId ||
			invite.chain !== this.context.config.chain
		) {
			return "Invite does not target the local agent";
		}

		const verification = await verifyInvite(invite, {
			expectedSignerAddress: await this.getLocalAgentAddress(),
		});
		if (!verification.valid) {
			return verification.error ?? "Invite verification failed";
		}

		return null;
	}

	private async handlePermissionsUpdate(contact: Contact, message: ProtocolMessage): Promise<void> {
		const update = parsePermissionsUpdate(message);
		const peer = resolvePermissionsUpdatePeer(this.context.config, update);
		if (peer.agentId !== contact.peerAgentId || peer.chain !== contact.peerChain) {
			throw new ValidationError("Grant update does not match the sending contact");
		}
		await this.context.trustStore.updateContact(contact.connectionId, {
			permissions: replaceGrantedByPeer(contact.permissions, update.grantSet),
		});
		await this.appendLedger({
			peer: peerLabel(contact),
			direction: "granted-by-peer",
			event: "grant-received",
			note: update.note,
		});
		await this.context.trustStore.touchContact(contact.connectionId);

		this.log("info", `Grant update from ${peerLabel(contact)}`);
		for (const line of summarizeGrantSet(update.grantSet)) {
			this.log("info", `  - ${line}`);
		}
		if (update.note) {
			this.log("info", `Note: ${update.note}`);
		}
	}

	private async handlePermissionGrantRequest(
		contact: Contact,
		request: PermissionGrantRequestAction,
	): Promise<void> {
		this.log("info", `Grant request from ${peerLabel(contact)}`);
		for (const line of summarizeGrantSet(createGrantSet(request.grants))) {
			this.log("info", `  - ${line}`);
		}
		if (request.note) {
			this.log("info", `Note: ${request.note}`);
		}

		await this.appendLedger({
			peer: peerLabel(contact),
			direction: "local",
			event: "grant-request-received",
			action_id: request.actionId,
			note: request.note,
		});
	}

	private async resolvePendingRequestWithContact<T>(
		entry: RequestJournalEntry,
		parse: (metadata: Record<string, unknown> | undefined) => T | null,
		label: string,
		process: (contact: Contact, requestId: string, request: T) => Promise<void>,
	): Promise<void> {
		const request = parse(entry.metadata);
		if (!request) {
			throw new ValidationError(
				`Pending ${label} ${entry.requestId} is missing the original request payload`,
			);
		}

		const contact = await this.findActiveContactForPendingEntry(entry);
		if (!contact) {
			throw new ValidationError(`No active contact found for pending ${label} ${entry.requestId}`);
		}

		await process(contact, entry.requestId, request);
	}

	private async findActiveContactForPendingEntry(
		entry: RequestJournalEntry,
	): Promise<Contact | null> {
		const metadata = entry.metadata as Record<string, unknown> | undefined;
		const peerChain = typeof metadata?.peerChain === "string" ? metadata.peerChain : undefined;
		if (peerChain) {
			const contact = await this.context.trustStore.findByAgentId(entry.peerAgentId, peerChain);
			return contact?.status === "active" ? contact : null;
		}

		return (
			findUniqueContactForAgentId(await this.context.trustStore.getContacts(), entry.peerAgentId) ??
			null
		);
	}

	private async resolvePendingTransferRequest(entry: RequestJournalEntry): Promise<void> {
		await this.resolvePendingRequestWithContact(
			entry,
			parseStoredTransferRequest,
			"action request",
			(contact, requestId, request) => this.processTransferRequest(contact, requestId, request),
		);
	}

	private async resolvePendingSchedulingRequest(entry: RequestJournalEntry): Promise<void> {
		await this.resolvePendingRequestWithContact(
			entry,
			parseStoredSchedulingRequest,
			"scheduling request",
			(contact, requestId, proposal) => this.processSchedulingRequest(contact, requestId, proposal),
		);
	}

	private async processTransferRequest(
		contact: Contact,
		requestId: string,
		request: TransferActionRequest,
	): Promise<void> {
		const approved = await this.decideTransfer(requestId, contact, request);
		if (approved === null) {
			this.log(
				"info",
				`Queued action request ${request.actionId} from ${contact.peerDisplayName}; resolve it later with TAP sync or the host approval flow`,
			);
			this.emitActionPending(contact, requestId, "transfer", request as Record<string, unknown>);
			return;
		}

		const baseResponse = {
			type: "transfer/response" as const,
			actionId: request.actionId,
			asset: request.asset,
			amount: request.amount,
			chain: request.chain,
			toAddress: request.toAddress,
		};
		const baseLedger = {
			peer: peerLabel(contact),
			direction: "granted-by-me" as const,
			scope: "transfer/request",
			asset: request.asset,
			amount: request.amount,
			action_id: request.actionId,
		};

		let response: TransferActionResponse;
		if (!approved) {
			response = { ...baseResponse, status: "rejected", error: "Action rejected by agent" };
			await this.appendLedger({
				...baseLedger,
				event: "transfer-rejected",
				decision: "rejected",
				rationale: "Rejected at runtime by agent decision",
			});
		} else if (!this.hooks.executeTransfer) {
			response = {
				...baseResponse,
				status: "failed",
				error: "No transfer executor configured for this TAP host",
			};
		} else {
			try {
				const transfer = await this.hooks.executeTransfer(this.context.config, request);
				response = { ...baseResponse, status: "completed", txHash: transfer.txHash };
				await this.appendLedger({
					...baseLedger,
					event: "transfer-completed",
					tx_hash: transfer.txHash,
					decision: "approved",
					rationale: "Approved at runtime by agent decision",
				});
			} catch (error: unknown) {
				response = {
					...baseResponse,
					status: "failed",
					error: toErrorMessage(error),
				};
				await this.appendLedger({
					...baseLedger,
					event: "transfer-failed",
					decision: "approved",
					rationale: response.error,
				});
			}
		}

		const delivery = buildPendingActionResultDelivery(contact, requestId, response);
		await this.context.requestJournal.updateStatus(requestId, "completed");
		// The on-chain transfer is irreversible at this point, so complete the inbound
		// request before attempting any retry bookkeeping to avoid duplicate execution.
		try {
			await this.context.requestJournal.putOutbound({
				requestId: String(delivery.request.id),
				requestKey: `outbound:${delivery.request.method}:${String(delivery.request.id)}`,
				direction: "outbound",
				kind: "result",
				method: delivery.request.method,
				peerAgentId: contact.peerAgentId,
				correlationId: requestId,
				status: "pending",
				metadata: serializePendingActionResultDelivery(delivery),
			});
		} catch (error: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for action result ${response.actionId}: ${toErrorMessage(error)}`,
			);
			try {
				await this.context.transport.send(contact.peerAgentId, delivery.request, {
					peerAddress: contact.peerAgentAddress,
					waitForAck: false,
				});
				await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
			} catch (deliveryError: unknown) {
				this.logActionResultDeliveryFailure(contact, response.actionId, deliveryError);
			}
			return;
		}
		try {
			await this.deliverPendingActionResult(delivery);
		} catch (error: unknown) {
			this.logActionResultDeliveryFailure(contact, response.actionId, error);
		}
	}

	private async handleSchedulingAction(ctx: TapActionContext): Promise<TapActionResult> {
		const contact = ctx.extensions.contact as Contact | undefined;
		const schedulingHandler = ctx.extensions.schedulingHandler as SchedulingHandler | undefined;

		// Parse the proposal from the action context payload
		const proposal = this.parseSchedulingProposalFromPayload(ctx.payload);
		if (!proposal) {
			return {
				success: false,
				error: {
					code: "INVALID_PAYLOAD",
					message: "Missing or invalid scheduling fields: title, durationMinutes, proposedSlots",
				},
			};
		}

		// If no SchedulingHandler is available, fall back to grant-only evaluation
		if (!schedulingHandler || !contact) {
			return this.handleSchedulingFallback(ctx, proposal);
		}

		// Generate a synthetic requestId from the payload schedulingId
		const requestId = proposal.schedulingId;

		const decision = await schedulingHandler.evaluateProposal(requestId, contact, proposal);

		return mapSchedulingDecisionToResult(proposal.schedulingId, decision);
	}

	private parseSchedulingProposalFromPayload(
		payload: Record<string, unknown>,
	): SchedulingProposal | null {
		const type = payload.type;
		if (type !== "scheduling/propose" && type !== "scheduling/counter") {
			// Also accept "scheduling/request" as the wire format uses it
			if (type !== "scheduling/request") {
				return null;
			}
		}

		if (typeof payload.title !== "string" || payload.title.length === 0) {
			return null;
		}

		const durationMinutes =
			typeof payload.durationMinutes === "number"
				? payload.durationMinutes
				: typeof payload.duration === "number"
					? payload.duration
					: undefined;
		if (durationMinutes === undefined || durationMinutes <= 0) {
			return null;
		}

		const rawSlots = Array.isArray(payload.proposedSlots)
			? payload.proposedSlots
			: Array.isArray(payload.slots)
				? payload.slots
				: undefined;
		if (!rawSlots || rawSlots.length === 0) {
			return null;
		}

		const slots: Array<{ start: string; end: string }> = [];
		for (const slot of rawSlots) {
			if (
				typeof slot !== "object" ||
				slot === null ||
				typeof (slot as Record<string, unknown>).start !== "string" ||
				typeof (slot as Record<string, unknown>).end !== "string"
			) {
				return null;
			}
			slots.push({ start: (slot as { start: string }).start, end: (slot as { end: string }).end });
		}

		const schedulingId =
			typeof payload.schedulingId === "string" && payload.schedulingId.length > 0
				? payload.schedulingId
				: `sch_${Date.now()}`;

		const timezone =
			typeof payload.timezone === "string" && payload.timezone.length > 0
				? payload.timezone
				: typeof payload.originTimezone === "string" && payload.originTimezone.length > 0
					? payload.originTimezone
					: "UTC";

		return {
			type: (type === "scheduling/request" ? "scheduling/propose" : type) as
				| "scheduling/propose"
				| "scheduling/counter",
			schedulingId,
			title: payload.title,
			duration: durationMinutes,
			slots,
			originTimezone: timezone,
			...(typeof payload.note === "string" && payload.note.length > 0
				? { note: payload.note }
				: {}),
		};
	}

	private handleSchedulingFallback(
		ctx: TapActionContext,
		proposal: SchedulingProposal,
	): TapActionResult {
		// Grant-only evaluation: check if grants cover this request, accept first slot
		const matchingGrants = findApplicableSchedulingGrants(
			{ version: "tap-grants/v1", updatedAt: "", grants: ctx.peer.grantsToPeer },
			proposal,
		);

		if (matchingGrants.length === 0) {
			return {
				success: false,
				data: {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "No active scheduling grant covers this request",
				},
				error: {
					code: "NO_MATCHING_GRANT",
					message: "No active scheduling grant covers this request",
				},
			};
		}

		const schedulableSlots = findSchedulableSchedulingSlots(matchingGrants, proposal);

		if (schedulableSlots.length === 0) {
			return {
				success: false,
				data: {
					type: "scheduling/reject",
					schedulingId: proposal.schedulingId,
					reason: "No proposed time slots match grant constraints",
				},
				error: {
					code: "NO_MATCHING_SLOTS",
					message: "No proposed time slots match scheduling grant constraints",
				},
			};
		}

		const acceptedSlot = schedulableSlots[0] as { start: string; end: string };

		return {
			success: true,
			data: {
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot,
				note: `Confirmed: ${proposal.title}`,
			},
		};
	}

	private async processSchedulingRequest(
		contact: Contact,
		requestId: string,
		proposal: SchedulingProposal,
	): Promise<void> {
		if (!this.schedulingHandler) {
			await this.deliverSchedulingReject(
				contact,
				requestId,
				proposal,
				"Scheduling is not supported by this TAP host",
			);
			return;
		}

		const override = this.decisionOverrides.scheduling.get(requestId);
		const evaluatedDecision = await this.schedulingHandler.evaluateProposal(
			requestId,
			contact,
			proposal,
		);
		const decision =
			override?.approve === false
				? ({
						action: "reject",
						reason: override.reason ?? "Scheduling request declined by operator",
					} as const)
				: override?.approve === true && evaluatedDecision.action !== "confirm"
					? ({
							action: "confirm",
							slot: proposal.slots[0],
							proposal,
						} as const)
					: evaluatedDecision;

		const baseLedger = {
			peer: peerLabel(contact),
			scope: "scheduling/request",
			action_id: proposal.schedulingId,
		};

		switch (decision.action) {
			case "confirm": {
				const selectedSlot = decision.slot ?? proposal.slots[0];
				if (!selectedSlot) {
					throw new ValidationError(
						`Scheduling request ${proposal.schedulingId} has no proposed slots`,
					);
				}
				const confirmed =
					override?.approve === true
						? true
						: this.hooks.confirmMeeting
							? await this.hooks.confirmMeeting({
									schedulingId: proposal.schedulingId,
									title: proposal.title,
									slot: selectedSlot,
									peerName: contact.peerDisplayName,
									peerAgentId: contact.peerAgentId,
									originTimezone: proposal.originTimezone,
								})
							: false;

				if (confirmed) {
					const eventResult = await this.schedulingHandler.handleAccept(
						{
							type: "scheduling/accept",
							schedulingId: proposal.schedulingId,
							acceptedSlot: selectedSlot,
						},
						contact.peerDisplayName,
						proposal.title,
						getLocalTimezone(),
					);
					await this.updateSchedulingTracking(requestId, {
						schedulingState: "accepted",
						...(eventResult.eventId ? { localEventId: eventResult.eventId } : {}),
					});

					const acceptData: Record<string, unknown> = {
						type: "scheduling/accept",
						schedulingId: proposal.schedulingId,
						acceptedSlot: selectedSlot,
						...(eventResult.eventId ? { eventId: eventResult.eventId } : {}),
					};
					const acceptText = buildSchedulingAcceptText({
						type: "scheduling/accept",
						schedulingId: proposal.schedulingId,
						acceptedSlot: selectedSlot,
					});
					const outgoing = buildOutgoingActionResult(
						contact,
						requestId,
						acceptText,
						acceptData,
						"scheduling/request",
						"completed",
					);

					await this.persistSchedulingActionResult(
						contact,
						requestId,
						proposal.schedulingId,
						outgoing,
						"accept",
					);

					await this.context.requestJournal.updateStatus(requestId, "completed");
					await this.appendLedger({
						...baseLedger,
						direction: "granted-by-me",
						event: "scheduling-accepted",
						decision: "accepted",
					});

					if (this.hooks.onMeetingConfirmed) {
						await this.hooks.onMeetingConfirmed({
							schedulingId: proposal.schedulingId,
							title: proposal.title,
							slot: selectedSlot,
							peerName: contact.peerDisplayName,
							peerAgentId: contact.peerAgentId,
							originTimezone: proposal.originTimezone,
							eventId: eventResult.eventId,
						});
					}
					break;
				}

				await this.deliverSchedulingReject(
					contact,
					requestId,
					proposal,
					"Scheduling request declined by operator",
				);
				break;
			}
			case "counter": {
				const counterData: Record<string, unknown> = {
					type: "scheduling/counter",
					schedulingId: proposal.schedulingId,
					title: proposal.title,
					duration: proposal.duration,
					slots: decision.slots,
					originTimezone: proposal.originTimezone,
				};
				const counterText = buildSchedulingProposalText({
					type: "scheduling/counter",
					schedulingId: proposal.schedulingId,
					title: proposal.title,
					duration: proposal.duration,
					slots: decision.slots,
					originTimezone: proposal.originTimezone,
				});
				const outgoing = buildOutgoingActionRequest(
					contact,
					counterText,
					counterData,
					"scheduling/request",
				);

				const delivered = await this.sendSchedulingCounterRequest(
					contact,
					requestId,
					outgoing,
					proposal.schedulingId,
				);
				if (!delivered) {
					break;
				}

				await this.context.requestJournal.updateStatus(requestId, "completed");
				await this.appendLedger({
					...baseLedger,
					direction: "local",
					event: "scheduling-counter",
					decision: "counter",
				});
				break;
			}
			case "reject": {
				await this.deliverSchedulingReject(contact, requestId, proposal, decision.reason);
				break;
			}
			case "defer": {
				this.log(
					"info",
					`Scheduling request ${proposal.schedulingId} deferred for manual decision`,
				);
				this.emitActionPending(
					contact,
					requestId,
					"scheduling",
					proposal as unknown as Record<string, unknown>,
				);
				break;
			}
		}
	}

	private async deliverSchedulingReject(
		contact: Contact,
		requestId: string,
		proposal: SchedulingProposal,
		reason: string,
	): Promise<void> {
		await this.updateSchedulingTracking(requestId, {
			schedulingState: "rejected",
		});
		const rejectData: Record<string, unknown> = {
			type: "scheduling/reject",
			schedulingId: proposal.schedulingId,
			reason,
		};
		const rejectText = buildSchedulingRejectText({
			type: "scheduling/reject",
			schedulingId: proposal.schedulingId,
			reason,
		});
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			rejectText,
			rejectData,
			"scheduling/request",
			"rejected",
		);

		await this.persistSchedulingActionResult(
			contact,
			requestId,
			proposal.schedulingId,
			outgoing,
			"reject",
		);

		await this.context.requestJournal.updateStatus(requestId, "completed");
		await this.appendLedger({
			peer: peerLabel(contact),
			direction: "granted-by-me",
			event: "scheduling-rejected",
			scope: "scheduling/request",
			action_id: proposal.schedulingId,
			decision: "rejected",
			rationale: reason,
		});
	}

	private async persistSchedulingActionResult(
		contact: Contact,
		requestId: string,
		schedulingId: string,
		outgoing: ProtocolMessage,
		actionType: string,
	): Promise<void> {
		const delivery = buildPendingActionResultDeliveryFromRequest(contact, schedulingId, outgoing);
		await this.context.requestJournal.putOutbound({
			requestId: String(delivery.request.id),
			requestKey: `outbound:${delivery.request.method}:${String(delivery.request.id)}`,
			direction: "outbound",
			kind: "result",
			method: delivery.request.method,
			peerAgentId: contact.peerAgentId,
			correlationId: requestId,
			status: "pending",
			metadata: serializePendingActionResultDelivery(delivery),
		});

		try {
			await this.deliverPendingActionResult(delivery);
		} catch (error: unknown) {
			this.logResultDeliveryFailure(`Scheduling ${actionType}`, peerLabel(contact), error);
			await this.recordSendFailure(String(delivery.request.id), error);
		}
	}

	private async sendSchedulingCounterRequest(
		contact: Contact,
		requestId: string,
		outgoing: ProtocolMessage,
		schedulingId: string,
	): Promise<boolean> {
		try {
			await this.context.transport.send(contact.peerAgentId, outgoing, {
				peerAddress: contact.peerAgentAddress,
				waitForAck: false,
			});
			await this.appendConversationLogSafe(contact, outgoing, "outgoing");
			return true;
		} catch (error: unknown) {
			await this.recordSendFailure(requestId, error);
			this.log(
				"warn",
				`Failed to deliver scheduling counter for ${schedulingId}: ${toErrorMessage(error)}`,
			);
			return false;
		}
	}

	private async handleConnectionResult(
		message: ProtocolMessage,
	): Promise<"received" | "duplicate"> {
		const result = parseConnectionResult(message);
		const existingContact = await this.context.trustStore.findByAgentId(
			result.from.agentId,
			result.from.chain,
		);

		// §5.3 idempotency table: apply the correct action based on local contact state.

		if (result.status === "rejected") {
			// Rejection path: delete any connecting contact so the user knows to
			// obtain a fresh invite. Active contacts are left unchanged.
			if (existingContact?.status === "connecting") {
				await this.context.trustStore.removeContact(existingContact.connectionId);
				this.log("info", `Connection rejected by ${peerLabel(existingContact)}`);
				// Best-effort journal correlation: mark matching outbound entry completed.
				const journalEntry = await this.context.requestJournal.getByRequestId(result.requestId);
				if (journalEntry) {
					await this.context.requestJournal.updateStatus(result.requestId, "completed");
				}
				this.emit({
					type: "connection.failed",
					requestId: result.requestId,
					error:
						result.reason ??
						`Connection rejected by ${existingContact.peerDisplayName} (#${existingContact.peerAgentId})`,
				});
				// Notify any in-flight connect() waiter so it surfaces the rejection
				// immediately rather than waiting for the full waitMs timeout.
				this.rejectConnectWaiter(
					result.requestId,
					new ConnectWaiterRejectedError(
						result.requestId,
						`Connection rejected by ${existingContact.peerDisplayName} (#${existingContact.peerAgentId})`,
					),
				);
				return "received";
			}
			// No connecting contact: stale or unsolicited rejection — ignore.
			this.log(
				"info",
				`Ignoring stale rejected connection result from agent #${result.from.agentId} on ${result.from.chain}`,
			);
			return "duplicate";
		}

		// result.status === "accepted" — apply the idempotency table.

		if (existingContact?.status === "active") {
			// Already active: no-op on the contact. Touch lastContactAt and mark
			// any matching journal entry completed. Retry-safe.
			await this.context.trustStore.touchContact(existingContact.connectionId);
			this.log(
				"info",
				`Duplicate connection result from ${peerLabel(existingContact)} — already active`,
			);
			const journalEntry = await this.context.requestJournal.getByRequestId(result.requestId);
			if (journalEntry) {
				await this.context.requestJournal.updateStatus(result.requestId, "completed");
			}
			// Resolve any in-flight connect() waiter — the peer is already active.
			this.resolveConnectWaiter(result.requestId);
			return "duplicate";
		}

		if (existingContact?.status === "revoked") {
			// Revoked: log and ignore. Bob explicitly revoked; a stale result should
			// not resurrect the contact. Mark matching journal entry completed.
			this.log(
				"info",
				`Ignoring connection result from revoked peer ${peerLabel(existingContact)}`,
			);
			const journalEntry = await this.context.requestJournal.getByRequestId(result.requestId);
			if (journalEntry) {
				await this.context.requestJournal.updateStatus(result.requestId, "completed");
			}
			return "duplicate";
		}

		// connecting / idle / stale → flip to active.
		// missing → gated recovery (see below) or rejected as unsolicited.
		//
		// SECURITY GATE (spec §5.3, corrected): before creating a contact from an
		// incoming result, require local proof that WE initiated this handshake.
		// Transport-layer sender verification proves the sender's IDENTITY, not
		// our CONSENT to be connected to them — without this gate any agent who
		// knows another agent's XMTP inbox could self-establish trust by sending
		// an unsolicited accepted result. Proof of initiation = a matching
		// outbound connection/request journal entry whose requestId correlates
		// to result.requestId and whose peerAgentId matches the sender. This
		// preserves the partial-wipe recovery scenario (contact deleted, journal
		// entry survived) while closing the self-establishment hole.
		if (!existingContact) {
			const outboundEntry = await this.context.requestJournal.getByRequestId(result.requestId);
			// Chain-scoped proof: two on-chain identities can legitimately share the
			// same numeric agentId across chains, so the gate must also match
			// metadata.peerChain against result.from.chain. Legacy entries written
			// before peerChain was persisted have no chain in metadata and are
			// intentionally NOT accepted — the security guarantee is that EVERY
			// contact creation requires fresh chain-scoped proof of initiation.
			const outboundChain = (outboundEntry?.metadata as { peerChain?: string } | undefined)
				?.peerChain;
			const hasValidOutboundProof =
				outboundEntry !== null &&
				outboundEntry.direction === "outbound" &&
				outboundEntry.method === CONNECTION_REQUEST &&
				outboundEntry.peerAgentId === result.from.agentId &&
				outboundChain === result.from.chain;
			if (!hasValidOutboundProof) {
				this.log(
					"warn",
					`Ignoring unsolicited connection/result from agent #${result.from.agentId} on ${result.from.chain}: no matching outbound request in journal`,
				);
				return "duplicate";
			}
			// If the outbound request already completed, the result is a replay or
			// the user explicitly deleted the contact after a successful handshake.
			// Do NOT recreate the contact — that would silently undo a deletion.
			if (outboundEntry.status === "completed") {
				this.log(
					"info",
					`Ignoring stale connection/result for already-completed request ${result.requestId}; not recreating missing contact`,
				);
				return "duplicate";
			}
			// Partial-wipe recovery: journal says we asked, contact is gone.
			// Resolve the peer on-chain to populate load-bearing fields
			// (peerAgentAddress is required for transport routing).
			let resolved: ResolvedAgent;
			try {
				resolved = await this.context.resolver.resolveWithCache(
					result.from.agentId,
					result.from.chain,
				);
			} catch (error: unknown) {
				this.log(
					"warn",
					`handleConnectionResult: resolver failed for agent #${result.from.agentId} on ${result.from.chain} — skipping contact creation: ${toErrorMessage(error)}`,
				);
				return "duplicate";
			}
			const now = result.timestamp ?? nowISO();
			const freshContact: Contact = {
				connectionId: generateConnectionId(),
				peerAgentId: resolved.agentId,
				peerChain: resolved.chain,
				peerOwnerAddress: resolved.ownerAddress,
				peerDisplayName: resolved.registrationFile.name,
				peerAgentAddress: resolved.agentAddress,
				permissions: createEmptyPermissionState(now),
				establishedAt: now,
				lastContactAt: now,
				status: "active",
			};
			await this.context.trustStore.addContact(freshContact);
			await this.context.requestJournal.updateStatus(result.requestId, "completed");
			this.log("info", `Connection accepted by ${peerLabel(freshContact)} (partial-wipe recovery)`);
			this.emitConnectionEstablished(
				freshContact.connectionId,
				this.peerRefFromContact(freshContact),
			);
			// Notify any in-flight connect() waiter.
			this.resolveConnectWaiter(result.requestId);
			return "received";
		}

		const establishedAt = result.timestamp ?? nowISO();
		const nextContact: Contact = {
			connectionId: existingContact.connectionId,
			peerAgentId: result.from.agentId,
			peerChain: result.from.chain,
			peerOwnerAddress: existingContact.peerOwnerAddress,
			peerDisplayName: existingContact.peerDisplayName,
			peerAgentAddress: existingContact.peerAgentAddress,
			permissions: existingContact.permissions ?? createEmptyPermissionState(establishedAt),
			establishedAt: existingContact.establishedAt ?? establishedAt,
			lastContactAt: establishedAt,
			status: "active",
			// Clear expiresAt when transitioning to active — no longer needed.
			expiresAt: undefined,
		};

		// existingContact is always defined here — the !existingContact path
		// was handled above with an early return.
		await this.context.trustStore.updateContact(existingContact.connectionId, nextContact);

		// Best-effort journal correlation: mark matching outbound entry completed.
		const journalEntry = await this.context.requestJournal.getByRequestId(result.requestId);
		if (journalEntry) {
			await this.context.requestJournal.updateStatus(result.requestId, "completed");
		}

		this.log("info", `Connection accepted by ${peerLabel(nextContact)}`);
		// `existingContact.status` is narrowed to non-active here — the active
		// branch returned "duplicate" above. This is a real state transition
		// (connecting/idle/stale → active).
		this.emitConnectionEstablished(nextContact.connectionId, this.peerRefFromContact(nextContact));
		// Notify any in-flight connect() waiter.
		this.resolveConnectWaiter(result.requestId);
		return "received";
	}

	private async handleActionResult(
		from: number,
		message: ProtocolMessage,
	): Promise<string | undefined> {
		const contact = await findContactForMessage(this.context, from, message);
		if (contact) {
			// Implicit handshake completion (see `onRequest` for rationale).
			// Scoped by (peerAgentId, peerChain) so cross-chain peers sharing
			// a numeric tokenId don't complete each other's pending entries.
			await this.markPendingConnectionResultsCompletedFor(contact.peerAgentId, contact.peerChain);
			await this.appendConversationLogSafe(contact, message, "incoming");
		}

		const response = parseTransferActionResponse(message);
		if (response) {
			if (contact) {
				await this.appendLedger({
					peer: peerLabel(contact),
					direction: "local",
					event: `transfer-${response.status}`,
					scope: "transfer/request",
					asset: response.asset,
					amount: response.amount,
					action_id: response.actionId,
					tx_hash: response.txHash,
					decision: response.status,
					rationale: response.error,
				});
			}
			if (response.requestId) {
				await this.context.requestJournal.updateMetadata(
					response.requestId,
					serializeRecordedTransferResponse(response),
				);
				await this.context.requestJournal.updateStatus(response.requestId, "completed");
				this.waiters.get(response.requestId)?.(response);
			}
			if (contact) {
				this.log("info", `Received transfer ${response.status} result from ${peerLabel(contact)}`);
			}
			const transferConversationId = contact ? resolveConversationId(contact) : "";
			const transferRequestId = response.requestId ?? response.actionId;
			if (response.status === "completed") {
				this.emitActionCompleted(
					transferConversationId,
					transferRequestId,
					"transfer",
					response as Record<string, unknown>,
					response.txHash ? { txHash: response.txHash } : undefined,
				);
			} else if (response.status === "rejected" || response.status === "failed") {
				this.emitActionFailed(
					transferConversationId,
					transferRequestId,
					"transfer",
					response.error ?? `transfer ${response.status}`,
				);
			}
			return contact?.peerDisplayName;
		}

		const schedulingResponse = parseSchedulingActionResponse(message);
		if (schedulingResponse) {
			const requestId = (message.params as { requestId?: string } | undefined)?.requestId;
			const originalRequest = requestId
				? await this.context.requestJournal.getByRequestId(requestId)
				: null;
			const originalProposal = parseStoredSchedulingRequest(originalRequest?.metadata);
			const tracking = parseSchedulingTrackingMetadata(originalRequest?.metadata);

			if (schedulingResponse.type === "scheduling/accept") {
				let localEventId: string | undefined;
				if (this.schedulingHandler) {
					const eventResult = await this.schedulingHandler.handleAccept(
						schedulingResponse,
						contact?.peerDisplayName ?? "Unknown",
						originalProposal?.title ?? "Meeting",
						originalProposal?.originTimezone ?? "UTC",
					);
					localEventId = eventResult.eventId;
				}
				if (requestId) {
					await this.updateSchedulingTracking(requestId, {
						schedulingState: "accepted",
						...(localEventId ? { localEventId } : {}),
					});
				}
			} else if (schedulingResponse.type === "scheduling/cancel" && requestId) {
				const clearedLocalEvent = await this.cancelLocalSchedulingEvent(
					requestId,
					tracking.localEventId,
					`remote cancellation for ${schedulingResponse.schedulingId}`,
				);
				await this.updateSchedulingTracking(requestId, {
					schedulingState: "cancelled",
					...(clearedLocalEvent ? { localEventId: undefined } : {}),
				});
			} else if (schedulingResponse.type === "scheduling/reject" && requestId) {
				await this.updateSchedulingTracking(requestId, {
					schedulingState: "rejected",
				});
			}

			if (requestId) {
				await this.context.requestJournal.updateStatus(requestId, "completed");
			}

			const eventType = schedulingResponse.type.split("/")[1] ?? schedulingResponse.type;
			if (contact) {
				await this.appendLedger({
					peer: peerLabel(contact),
					direction: "local",
					event: `scheduling-${eventType}`,
					scope: "scheduling/request",
					action_id: schedulingResponse.schedulingId,
					decision: eventType,
				});
				this.log("info", `Received scheduling ${eventType} result from ${peerLabel(contact)}`);
			}
			const schedConversationId = contact ? resolveConversationId(contact) : "";
			const schedRequestId = requestId ?? schedulingResponse.schedulingId;
			if (schedulingResponse.type === "scheduling/accept") {
				this.emitActionCompleted(
					schedConversationId,
					schedRequestId,
					"scheduling",
					schedulingResponse as unknown as Record<string, unknown>,
				);
			} else if (
				schedulingResponse.type === "scheduling/reject" ||
				schedulingResponse.type === "scheduling/cancel"
			) {
				this.emitActionFailed(
					schedConversationId,
					schedRequestId,
					"scheduling",
					(schedulingResponse as { reason?: string }).reason ?? `scheduling ${eventType}`,
				);
			}
			return contact?.peerDisplayName;
		}

		// Generic app action result fallback — handles any result type that
		// is not a transfer or scheduling response (e.g. bet/propose, custom app actions).
		const resultData = extractMessageData(message);
		const requestId = (message.params as { requestId?: string } | undefined)?.requestId;
		if (resultData) {
			const actionType = (resultData.type as string | undefined) ?? "unknown";

			this.emitEvent({
				event: "action_result_received",
				method: ACTION_RESULT,
				actionType,
				peerAgentId: from,
				...(contact
					? {
							peerName: contact.peerDisplayName,
							connectionId: contact.connectionId,
						}
					: {}),
				data: resultData,
				...(requestId ? { requestId } : {}),
			});

			if (requestId) {
				await this.context.requestJournal.updateStatus(requestId, "completed");
				this.waiters.get(requestId)?.(resultData as TransferActionResponse);
			}

			this.log(
				"info",
				`Received ${actionType} action result from ${contact?.peerDisplayName ?? `agent #${from}`}`,
			);
		} else if (requestId) {
			// No extractable data, but still correlate with journal
			await this.context.requestJournal.updateStatus(requestId, "completed");
		}

		return contact?.peerDisplayName;
	}

	private async sendConnectionResult(
		peer: ResolvedAgent,
		result: ConnectionResultParams,
		plan?: { plannedContact: Contact; existingContact: Contact | null },
	): Promise<void> {
		const delivery = buildPendingConnectionResultDelivery(peer, result, plan);
		const deliveryRequestId = String(delivery.request.id);
		let persisted = false;
		try {
			await this.context.requestJournal.putOutbound({
				requestId: deliveryRequestId,
				requestKey: `outbound:${delivery.request.method}:${deliveryRequestId}`,
				direction: "outbound",
				kind: "result",
				method: delivery.request.method,
				peerAgentId: peer.agentId,
				correlationId: result.requestId,
				status: "pending",
				metadata: delivery as Record<string, unknown>,
			});
			persisted = true;
			this.peersWithPendingConnectionResult.add(
				peerConnectionResultCacheKey(peer.chain, peer.agentId),
			);
		} catch (error: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for connection result ${result.requestId}: ${toErrorMessage(error)}`,
			);
		}

		try {
			if (persisted) {
				await this.sendAndCompleteJournalEntry(delivery);
			} else {
				await this.context.transport.send(delivery.peerAgentId, delivery.request, {
					peerAddress: delivery.peerAddress,
					waitForAck: false,
				});
			}
		} catch (error: unknown) {
			this.logResultDeliveryFailure(
				"Connection result",
				`${peer.registrationFile.name} (#${peer.agentId})`,
				error,
			);
		}
	}

	private async decideTransfer(
		requestId: string,
		contact: Contact,
		request: TransferActionRequest,
	): Promise<boolean | null> {
		const transferGrants = findApplicableTransferGrants(contact.permissions.grantedByMe, request);
		const override = this.decisionOverrides.transfers.get(requestId);
		if (override === false) {
			return false;
		}
		if (override === true) {
			return true;
		}

		if (transferGrants.length === 0) {
			if (this.hooks.approveTransfer) {
				return (
					(await this.hooks.approveTransfer({
						requestId,
						contact,
						request,
						activeTransferGrants: transferGrants,
						ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
					})) ?? null
				);
			}
			this.log(
				"warn",
				`Rejecting action request ${request.actionId} from ${peerLabel(contact)} because no matching active transfer grant exists`,
			);
			return false;
		}

		if (!this.hooks.approveTransfer) {
			return true; // Covered by grant — no hook needed to confirm
		}
		return (
			(await this.hooks.approveTransfer({
				requestId,
				contact,
				request,
				activeTransferGrants: transferGrants,
				ledgerPath: getPermissionLedgerPath(this.context.config.dataDir),
			})) ?? null
		);
	}

	private async retryPendingDeliveries<
		T extends { peerAgentId: number; peerName: string },
	>(options: {
		kind: "request" | "result";
		method: string;
		parse: (metadata: Record<string, unknown> | undefined) => T | null;
		deliver: (delivery: T) => Promise<void>;
		errorLabel: (delivery: T) => string;
		recordFailure: (
			requestId: string,
			metadata: Record<string, unknown> | undefined,
			error: unknown,
		) => Promise<void>;
	}): Promise<number> {
		const pending = await this.context.requestJournal.listPending("outbound");
		let processed = 0;
		const now = Date.now();
		for (const entry of pending) {
			if (entry.kind !== options.kind || entry.method !== options.method) {
				continue;
			}

			// Stale cleanup — prevent indefinite accumulation for peers that
			// have been offline so long that the delivery is no longer
			// meaningful. The entry is marked terminal rather than deleted so
			// the journal still carries a record of the attempt. We do NOT
			// touch `peersWithPendingConnectionResult` here: a single-entry
			// GC cannot safely prove no other pending entries remain for the
			// same peer, and cache cleanup is owned by
			// `markPendingConnectionResultsCompletedFor`.
			const createdMs = Date.parse(entry.createdAt);
			if (Number.isFinite(createdMs) && now - createdMs > PENDING_RESULT_MAX_AGE_MS) {
				this.log(
					"warn",
					`Abandoning pending ${options.method} delivery ${entry.requestId} for agent #${entry.peerAgentId}: older than ${Math.round(PENDING_RESULT_MAX_AGE_MS / 3_600_000)}h`,
				);
				await this.markJournalEntryCompleted(entry.requestId).catch(() => {});
				continue;
			}

			const delivery = options.parse(entry.metadata);
			if (!delivery) {
				continue;
			}
			try {
				await options.deliver(delivery);
				processed += 1;
			} catch (error: unknown) {
				this.logResultDeliveryFailure(
					options.errorLabel(delivery),
					`${delivery.peerName} (#${delivery.peerAgentId})`,
					error,
				);
				await options.recordFailure(entry.requestId, entry.metadata, error);
			}
		}
		return processed;
	}

	/**
	 * Merge `lastError` / `lastAttemptAt` / `attempts` into the journal entry's
	 * metadata so `listPendingDeliveries` — and by extension the sync report —
	 * can surface a real reason for stuck deliveries. Failures are best-effort:
	 * if the metadata update itself fails we don't want to lose the original
	 * delivery payload, so we catch and continue.
	 */
	private async recordDeliveryFailure(
		requestId: string,
		metadata: Record<string, unknown> | undefined,
		error: unknown,
	): Promise<void> {
		try {
			const previousFailure = parseDeliveryFailureMetadata(metadata);
			const nextFailure: DeliveryFailureMetadata = {
				type: "delivery-failure",
				attempts: (previousFailure?.attempts ?? 0) + 1,
				lastAttemptAt: nowISO(),
				lastError: toErrorMessage(error),
			};
			await this.context.requestJournal.updateMetadata(requestId, {
				...(metadata ?? {}),
				[DELIVERY_FAILURE_METADATA_KEY]: nextFailure,
			});
		} catch (updateError: unknown) {
			this.log(
				"warn",
				`Failed to record delivery failure for ${requestId}: ${toErrorMessage(updateError)}`,
			);
		}
	}

	/**
	 * Record a transient send/processing failure on a pending journal entry so
	 * operators can inspect stuck work via `tap journal show`. Keeps attempt count
	 * and cumulative metadata. Safe to call on any entry id — it is a no-op if
	 * the entry does not exist.
	 */
	private async recordSendFailure(requestId: string, error: unknown): Promise<void> {
		const existing = await this.context.requestJournal.getByRequestId(requestId);
		if (!existing) return;
		const prior = existing.metadata?.lastError as RequestJournalLastError | undefined;
		const attempts = (prior?.attempts ?? 0) + 1;
		const message = toErrorMessage(error);
		await this.context.requestJournal.updateMetadata(requestId, {
			...(existing.metadata ?? {}),
			lastError: { message, at: nowISO(), attempts },
		});
	}

	private async completeSupersededPermissionsUpdates(connectionId: string): Promise<void> {
		const pending = await this.context.requestJournal.listPending("outbound");
		for (const entry of pending) {
			if (entry.method !== PERMISSIONS_UPDATE || entry.kind !== "request") {
				continue;
			}
			const delivery = parsePendingPermissionsUpdateDelivery(entry.metadata);
			if (delivery?.connectionId !== connectionId) {
				continue;
			}
			await this.markJournalEntryCompleted(entry.requestId);
		}
	}

	private async deliverPendingPermissionsUpdate(
		delivery: PendingPermissionsUpdateDelivery,
	): Promise<TransportReceipt> {
		const receipt = await this.context.transport.send(delivery.peerAgentId, delivery.request, {
			peerAddress: delivery.peerAddress,
			waitForAck: false,
		});
		const contact = await this.context.trustStore.getContact(delivery.connectionId);
		if (contact) {
			await this.context.trustStore.updateContact(delivery.connectionId, {
				permissions: replaceGrantedByMe(contact.permissions, delivery.grantSet),
			});
		}
		await this.markJournalEntryCompleted(String(delivery.request.id));
		return receipt;
	}

	private retryPendingPermissionsUpdates(): Promise<number> {
		return this.retryPendingDeliveries<PendingPermissionsUpdateDelivery>({
			kind: "request",
			method: PERMISSIONS_UPDATE,
			parse: parsePendingPermissionsUpdateDelivery,
			deliver: (d) => this.deliverPendingPermissionsUpdate(d).then(() => undefined),
			errorLabel: () => "Permissions update",
			recordFailure: (requestId, metadata, error) =>
				this.recordDeliveryFailure(requestId, metadata, error),
		});
	}

	private retryPendingActionResults(): Promise<number> {
		return this.retryPendingDeliveries<PendingActionResultDelivery>({
			kind: "result",
			method: ACTION_RESULT,
			parse: parsePendingActionResultDelivery,
			deliver: (d) => this.deliverPendingActionResult(d),
			errorLabel: (d) => `Action result ${d.actionId}`,
			recordFailure: (requestId, metadata, error) =>
				this.recordDeliveryFailure(requestId, metadata, error),
		});
	}

	private async retryPendingConnectionRequests(): Promise<number> {
		const pending = await this.context.requestJournal.listPending("inbound");
		let processed = 0;
		for (const entry of pending) {
			if (entry.kind !== "request" || entry.method !== CONNECTION_REQUEST) {
				continue;
			}
			const pendingRequest = parsePendingConnectionRequest(entry.metadata);
			if (!pendingRequest || this.inFlightKeys.has(entry.requestKey)) {
				continue;
			}
			try {
				const result = await this.processConnectionRequest(pendingRequest.message);
				if (result === "processed") {
					await this.context.requestJournal.updateStatus(entry.requestId, "completed");
					processed += 1;
				}
			} catch (error: unknown) {
				this.log(
					"warn",
					`Failed to retry connection request ${entry.requestId}: ${toErrorMessage(error)}`,
				);
			}
		}
		return processed;
	}

	private async retryPendingConnectionResults(): Promise<number> {
		const pending = await this.context.requestJournal.listPending("outbound");
		let processed = 0;
		const now = Date.now();
		for (const entry of pending) {
			// Revoke entries are retried by their own branch below — a pending
			// connection/revoke means our first send failed and the peer has
			// not yet heard that we disconnected.
			if (entry.method === CONNECTION_REVOKE) {
				processed += await this.retryPendingConnectionRevoke(entry, now);
				continue;
			}
			if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
				continue;
			}

			// Stale cleanup — prevent indefinite accumulation for peers that
			// have been offline so long that the delivery is no longer
			// meaningful.
			const createdMs = Date.parse(entry.createdAt);
			if (Number.isFinite(createdMs) && now - createdMs > PENDING_RESULT_MAX_AGE_MS) {
				this.log(
					"warn",
					`Abandoning pending ${CONNECTION_RESULT} delivery ${entry.requestId} for agent #${entry.peerAgentId}: older than ${Math.round(PENDING_RESULT_MAX_AGE_MS / 3_600_000)}h`,
				);
				await this.markJournalEntryCompleted(entry.requestId).catch(() => {});
				continue;
			}

			const delivery = parsePendingConnectionResultDelivery(entry.metadata);
			if (!delivery) {
				continue;
			}

			try {
				// Send the wire message and mark the journal entry completed.
				await this.sendAndCompleteJournalEntry(delivery);

				// Send succeeded — write the contact if the planned contact was
				// stored in the metadata. Legacy entries (written before the plan
				// was added) skip the contact write; the contact will eventually
				// be written by the implicit handshake completion or a future
				// connection/request from the peer.
				if (delivery.plannedContact && delivery.peerChain) {
					// Re-read the current trust store state at retry time (more
					// accurate than the state stored at plan time, and ensures
					// the write is idempotent across retries).
					const currentContact = await this.context.trustStore.findByAgentId(
						delivery.peerAgentId,
						delivery.peerChain,
					);
					await applyConnectionResultContact(this.context.trustStore, {
						plannedContact: delivery.plannedContact,
						existingContact: currentContact,
					});
					this.log(
						"info",
						`Reconciled connection result contact for ${delivery.peerName} (#${delivery.peerAgentId})`,
					);
				}

				processed += 1;
			} catch (error: unknown) {
				this.logResultDeliveryFailure(
					"Connection result",
					`${delivery.peerName} (#${delivery.peerAgentId})`,
					error,
				);
				await this.recordDeliveryFailure(entry.requestId, entry.metadata, error);
				await this.recordSendFailure(entry.requestId, error);
			}
		}
		return processed;
	}

	/**
	 * Retry a pending outbound `connection/revoke` entry. The CLI deletes the
	 * local contact as soon as `revokeConnection()` returns, so if the first
	 * send failed the peer will stay connected to us forever unless we deliver
	 * the revoke here. Revoke delivery is idempotent on the receiving side
	 * (removes contact if present, no-ops otherwise), so re-sending is safe.
	 */
	private async retryPendingConnectionRevoke(
		entry: RequestJournalEntry,
		nowMs: number,
	): Promise<number> {
		const createdMs = Date.parse(entry.createdAt);
		if (Number.isFinite(createdMs) && nowMs - createdMs > PENDING_RESULT_MAX_AGE_MS) {
			this.log(
				"warn",
				`Abandoning pending ${CONNECTION_REVOKE} delivery ${entry.requestId} for agent #${entry.peerAgentId}: older than ${Math.round(PENDING_RESULT_MAX_AGE_MS / 3_600_000)}h`,
			);
			await this.markJournalEntryCompleted(entry.requestId).catch(() => {});
			return 0;
		}

		const delivery = parsePendingConnectionRevokeDelivery(entry.metadata);
		if (!delivery) {
			this.log(
				"warn",
				`Pending ${CONNECTION_REVOKE} entry ${entry.requestId} has no revokeDelivery metadata; cannot retry`,
			);
			return 0;
		}

		const revokeParams: ConnectionRevokeParams = {
			from: { agentId: this.context.config.agentId, chain: this.context.config.chain },
			reason: delivery.reason,
			timestamp: nowISO(),
		};
		const rpcRequest = buildConnectionRevoke(revokeParams);

		try {
			await this.context.transport.send(delivery.peerAgentId, rpcRequest, {
				peerAddress: delivery.peerAddress,
			});
			await this.context.requestJournal.updateStatus(entry.requestId, "completed");
			this.log(
				"info",
				`Reconciled connection/revoke delivery for ${delivery.peerDisplayName} (#${delivery.peerAgentId})`,
			);
			return 1;
		} catch (error: unknown) {
			this.log(
				"warn",
				`Retry of connection/revoke to ${delivery.peerDisplayName} (#${delivery.peerAgentId}) failed: ${toErrorMessage(error)}`,
			);
			await this.recordSendFailure(entry.requestId, error);
			return 0;
		}
	}

	/**
	 * Implicit handshake completion. Any inbound protocol message from a peer
	 * with whom we already have an active contact is proof that the peer has
	 * received and accepted our previous connection/result — otherwise the
	 * transport would have rejected the message as "Unknown sender" instead
	 * of routing it here. When that happens, any pending outbound
	 * connection/result entries for that peer become load-bearing no more,
	 * and we complete them so the retry pipeline stops hammering and the
	 * sync report stops reporting stuck handshake work.
	 *
	 * Matching is scoped by (chain, agentId) because two active contacts can
	 * legitimately share the same numeric agentId across chains. Each pending
	 * entry's metadata carries the target `peerChain`; entries whose chain
	 * does not match the inbound peer are left untouched.
	 */
	private async markPendingConnectionResultsCompletedFor(
		peerAgentId: number,
		peerChain: string,
	): Promise<void> {
		// Hot-path short-circuit: only pay for the journal scan if we know
		// this (chain, peer) has a pending connection/result entry. The
		// cache is populated lazily on first miss (see
		// `primeConnectionResultCache`), updated by `sendConnectionResult`
		// when a new entry is persisted, and kept in sync on successful
		// completion below.
		await this.primeConnectionResultCache();
		const cacheKey = peerConnectionResultCacheKey(peerChain, peerAgentId);
		if (!this.peersWithPendingConnectionResult.has(cacheKey)) {
			return;
		}

		let pending: RequestJournalEntry[];
		try {
			pending = await this.context.requestJournal.listPending("outbound");
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to scan pending outbound deliveries for implicit completion: ${toErrorMessage(error)}`,
			);
			return;
		}

		let remainingForPeer = false;
		for (const entry of pending) {
			if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
				continue;
			}
			if (entry.peerAgentId !== peerAgentId) {
				continue;
			}
			// Chain scoping: parse the metadata to read `peerChain`.
			const delivery = parsePendingConnectionResultDelivery(entry.metadata);
			if (!delivery || delivery.peerChain === undefined) {
				// Unparsable, or a legacy entry without peerChain — we
				// can't tell which (chain, agentId) cache key this belongs
				// to. Treat as possibly-ours and keep the current cache
				// entry around so a future scan can retry. The direct
				// retry pipeline still handles delivery.
				remainingForPeer = true;
				continue;
			}
			if (delivery.peerChain !== peerChain) {
				// Belongs to a different (chain, agentId) cache key. Leave it
				// untouched — it does NOT affect whether we can delete our
				// own cache entry.
				continue;
			}
			try {
				await this.markJournalEntryCompleted(entry.requestId);
				this.log(
					"info",
					`Implicitly completed pending connection result ${entry.requestId} for agent #${peerAgentId} on ${peerChain} — peer is already sending active traffic`,
				);
			} catch (error: unknown) {
				remainingForPeer = true;
				this.log(
					"warn",
					`Failed to implicitly complete pending connection result ${entry.requestId}: ${toErrorMessage(error)}`,
				);
			}
		}
		if (!remainingForPeer) {
			this.peersWithPendingConnectionResult.delete(cacheKey);
		}
	}

	/**
	 * Populate {@link peersWithPendingConnectionResult} from the journal on
	 * first access so a freshly-constructed service sees pre-existing entries
	 * left over from the previous process run. Concurrent callers share the
	 * same priming promise so no caller sees an in-flight empty cache (which
	 * would cause false-negative short-circuits on inbound traffic). Best-
	 * effort: on failure, the cache stays unprimed and a future call retries.
	 */
	private async primeConnectionResultCache(): Promise<void> {
		if (this.connectionResultCachePrimed) {
			return;
		}
		if (!this.connectionResultCachePriming) {
			this.connectionResultCachePriming = (async () => {
				try {
					const pending = await this.context.requestJournal.listPending("outbound");
					for (const entry of pending) {
						if (entry.kind !== "result" || entry.method !== CONNECTION_RESULT) {
							continue;
						}
						// Pull chain from metadata so the cache key matches
						// the (chain, agentId) shape used by the lookup path.
						// Legacy entries without `peerChain` in metadata are
						// skipped — the direct retry pipeline still delivers
						// them, at the cost of missing the implicit-completion
						// short-circuit until they age out.
						const delivery = parsePendingConnectionResultDelivery(entry.metadata);
						if (!delivery || delivery.peerChain === undefined) {
							continue;
						}
						this.peersWithPendingConnectionResult.add(
							peerConnectionResultCacheKey(delivery.peerChain, entry.peerAgentId),
						);
					}
					this.connectionResultCachePrimed = true;
				} catch (error: unknown) {
					this.log(
						"warn",
						`Failed to prime pending connection-result cache: ${toErrorMessage(error)}`,
					);
				} finally {
					this.connectionResultCachePriming = null;
				}
			})();
		}
		await this.connectionResultCachePriming;
	}

	private async sendAndCompleteJournalEntry(delivery: {
		peerAgentId: number;
		request: ProtocolMessage;
		peerAddress: `0x${string}`;
	}): Promise<void> {
		await this.context.transport.send(delivery.peerAgentId, delivery.request, {
			peerAddress: delivery.peerAddress,
			waitForAck: false,
		});
		await this.markJournalEntryCompleted(String(delivery.request.id));
		// Deliberately do NOT touch `peersWithPendingConnectionResult` here.
		// A single-entry completion cannot tell us whether other pending
		// connection/result entries for the same peer still exist, and an
		// unconditional delete would cause `markPendingConnectionResultsCompletedFor`
		// to skip the journal scan on the next inbound and orphan the
		// remaining entries. Cache cleanup is owned by
		// `markPendingConnectionResultsCompletedFor`, which scans before
		// deleting. A stale-positive cache entry only costs an extra scan.
	}

	/**
	 * Terminal state for a journal entry: mark completed and clear any retry
	 * metadata. Errors propagate — callers that want to swallow (implicit
	 * cleanup, stale-entry GC) wrap the call themselves.
	 */
	private async markJournalEntryCompleted(requestId: string): Promise<void> {
		await this.context.requestJournal.updateStatus(requestId, "completed");
		await this.context.requestJournal.updateMetadata(requestId, undefined);
	}

	private async deliverPendingActionResult(delivery: PendingActionResultDelivery): Promise<void> {
		await this.sendAndCompleteJournalEntry(delivery);
		const contact = await this.context.trustStore.getContact(delivery.connectionId);
		if (!contact || contact.peerAgentId !== delivery.peerAgentId) {
			return;
		}
		await this.appendConversationLogSafe(contact, delivery.request, "outgoing");
	}

	private logActionResultDeliveryFailure(contact: Contact, actionId: string, error: unknown): void {
		this.logResultDeliveryFailure(`Action result ${actionId}`, peerLabel(contact), error);
	}

	private logResultDeliveryFailure(subject: string, peerLabel: string, error: unknown): void {
		const errorMessage = toErrorMessage(error);
		if (isTransportReceiptTimeout(error)) {
			this.log(
				"warn",
				`${subject} to ${peerLabel} timed out waiting for a delivery receipt; the peer may still receive it during a later sync (${errorMessage})`,
			);
			return;
		}

		this.log(
			"error",
			`Failed to deliver ${subject.toLowerCase()} to ${peerLabel}: ${errorMessage}`,
		);
	}

	private async sendUnsupportedActionResult(
		contact: Contact,
		requestId: string,
		actionType: string,
		_requestKey: string,
	): Promise<void> {
		const errorData: Record<string, unknown> = {
			error: {
				code: "UNSUPPORTED_ACTION",
				message: `No handler registered for action type "${actionType}"`,
			},
		};
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			`Unsupported action type: ${actionType}`,
			errorData,
			actionType,
			"failed",
		);

		try {
			await this.context.transport.send(contact.peerAgentId, outgoing, {
				peerAddress: contact.peerAgentAddress,
				waitForAck: false,
			});
			await this.appendConversationLogSafe(contact, outgoing, "outgoing");
		} catch (error: unknown) {
			this.log(
				"warn",
				`Failed to deliver UNSUPPORTED_ACTION result for "${actionType}": ${toErrorMessage(error)}`,
			);
		}
	}

	private async rejectMalformedPayload(
		contact: Contact,
		messageId: string,
		fallbackActionType: string,
		requestKey: string,
		isDuplicate: boolean,
	): Promise<{ status: "duplicate" | "received" }> {
		await this.sendUnsupportedActionResult(contact, messageId, fallbackActionType, requestKey);
		await this.context.requestJournal.updateStatus(messageId, "completed");
		return { status: isDuplicate ? "duplicate" : "received" };
	}

	private async dispatchToApp(
		contact: Contact,
		requestId: string,
		resolved: {
			app: import("../app/types.js").TapApp;
			handler: import("../app/types.js").TapActionHandler;
		},
		payload: Record<string, unknown>,
		_requestKey: string,
	): Promise<void> {
		const agentAddress = await this.getLocalAgentAddress();
		const actionType = typeof payload.type === "string" ? payload.type : resolved.app.id;

		// Extract text from the request
		let text: string | undefined;
		// We don't have the raw message here, so text is not extracted from the wire.
		// Apps that need it should read from payload.

		const conversationId = contact.connectionId;
		const ctx = buildActionContext({
			config: this.context.config,
			agentAddress,
			contact,
			payload,
			text,
			app: resolved.app,
			reply: async (replyText: string) => {
				await this.sendMessageInternal(
					String(contact.peerAgentId),
					replyText,
					DEFAULT_MESSAGE_SCOPE,
				);
			},
			sendToPeer: async (peerId: number, sendText: string) => {
				await this.sendMessageInternal(String(peerId), sendText, DEFAULT_MESSAGE_SCOPE);
			},
			requestPayment: async (_params) => {
				// Delegate to requestFunds if available
				throw new ValidationError("Payment request not supported in app dispatch context");
			},
			executeTransfer: async (params) => {
				if (!this.hooks.executeTransfer) {
					throw new ValidationError("No transfer executor configured");
				}
				const result = await this.hooks.executeTransfer(this.context.config, {
					type: "transfer/request",
					actionId: generateNonce(),
					asset: params.asset as "native" | "usdc",
					amount: params.amount,
					chain: params.chain,
					toAddress: params.toAddress,
					note: params.note,
				});
				return result;
			},
			emitEvent: (event) => {
				this.emitEvent({
					type: event.type,
					summary: event.summary,
					appId: resolved.app.id,
					...event.data,
				});
			},
			conversationLogger: this.context.conversationLogger,
			conversationId,
			extensions: {
				schedulingHandler: this.schedulingHandler,
				contact,
				postage: this.buildPostageAppExtension(),
			},
		});

		let result: TapActionResult;
		try {
			result = await resolved.handler.handler(ctx);
		} catch (error: unknown) {
			result = {
				success: false,
				error: {
					code: "HANDLER_ERROR",
					message: toErrorMessage(error),
				},
			};
		}

		// DEFERRED means the request should stay pending for later resolution.
		// Do not send a result or complete the journal entry.
		if (result.error?.code === "DEFERRED") {
			this.log(
				"info",
				`Action ${actionType} deferred for approval; request ${requestId} stays pending`,
			);
			return;
		}

		const resultData: Record<string, unknown> = {
			type: actionType,
			...(result.data ?? {}),
			...(result.error ? { error: result.error } : {}),
		};
		const resultStatus = result.success ? "completed" : "failed";
		const resultText = result.success
			? `Action ${actionType} completed`
			: `Action ${actionType} failed: ${result.error?.message ?? "unknown error"}`;
		const outgoing = buildOutgoingActionResult(
			contact,
			requestId,
			resultText,
			resultData,
			actionType,
			resultStatus,
		);

		// Mark the inbound request completed before delivery — the handler has
		// already executed and its side effects are committed.
		await this.context.requestJournal.updateStatus(requestId, "completed");

		// Persist an outbound journal entry so reconciliation can retry delivery
		// if the transport send fails (follows the same pattern as transfer results).
		const actionId = typeof resultData.actionId === "string" ? resultData.actionId : requestId;
		const delivery = buildPendingActionResultDeliveryFromRequest(contact, actionId, outgoing);
		try {
			await this.context.requestJournal.putOutbound({
				requestId: String(outgoing.id),
				requestKey: `outbound:${outgoing.method}:${String(outgoing.id)}`,
				direction: "outbound",
				kind: "result",
				method: outgoing.method,
				peerAgentId: contact.peerAgentId,
				correlationId: requestId,
				status: "pending",
				metadata: serializePendingActionResultDelivery(delivery),
			});
		} catch (journalError: unknown) {
			this.log(
				"error",
				`Failed to persist retry metadata for app result "${actionType}": ${toErrorMessage(journalError)}`,
			);
			// Best-effort delivery without retry
			try {
				await this.context.transport.send(contact.peerAgentId, outgoing, {
					peerAddress: contact.peerAgentAddress,
					waitForAck: false,
				});
				await this.appendConversationLogSafe(contact, outgoing, "outgoing");
			} catch (deliveryError: unknown) {
				this.log(
					"warn",
					`Failed to deliver app result for "${actionType}": ${toErrorMessage(deliveryError)}`,
				);
			}
			return;
		}
		try {
			await this.deliverPendingActionResult(delivery);
		} catch (error: unknown) {
			this.logActionResultDeliveryFailure(contact, actionId, error);
		}
	}

	private async requireContact(peer: string): Promise<Contact> {
		const contacts = await this.context.trustStore.getContacts();
		const contact = findContactForPeer(contacts, peer);
		if (!contact) {
			throw new ValidationError(`Peer not found in contacts: ${peer}`);
		}
		return contact;
	}

	private async requireActiveContact(peer: string): Promise<Contact> {
		const contact = await this.requireContact(peer);
		if (contact.status !== "active") {
			throw new ValidationError(`Contact is not active: ${contact.peerDisplayName}`);
		}
		return contact;
	}
}

function buildRequestKey(senderInboxId: string, message: ProtocolMessage): string {
	return `${senderInboxId}:${message.method}:${String(message.id)}`;
}

function parseConnectionRequest(message: ProtocolMessage): ConnectionRequestParams {
	const params = message.params as ConnectionRequestParams | undefined;
	if (
		typeof params?.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		typeof params.invite !== "object" ||
		params.invite === null ||
		typeof params.invite.agentId !== "number" ||
		typeof params.invite.chain !== "string" ||
		typeof params.invite.expires !== "number" ||
		typeof params.invite.signature !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection request payload");
	}
	return params;
}

function parseConnectionResult(message: ProtocolMessage): ConnectionResultParams {
	const params = message.params as ConnectionResultParams | undefined;
	if (
		typeof params?.requestId !== "string" ||
		typeof params.from?.agentId !== "number" ||
		typeof params.from.chain !== "string" ||
		(params.status !== "accepted" && params.status !== "rejected") ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid connection result payload");
	}
	return params;
}

function parsePermissionsUpdate(
	message: ProtocolMessage,
): PermissionsUpdateParams & { note?: string } {
	if (typeof message.params !== "object" || message.params === null) {
		throw new ValidationError("Invalid grant publication payload");
	}

	const params = message.params as {
		grantSet?: PermissionsUpdateParams["grantSet"];
		grantor?: PermissionsUpdateParams["grantor"];
		grantee?: PermissionsUpdateParams["grantee"];
		note?: unknown;
		timestamp?: unknown;
	};

	if (
		typeof params.grantSet !== "object" ||
		params.grantSet === null ||
		typeof params.grantor?.agentId !== "number" ||
		typeof params.grantor.chain !== "string" ||
		typeof params.grantee?.agentId !== "number" ||
		typeof params.grantee.chain !== "string" ||
		typeof params.timestamp !== "string"
	) {
		throw new ValidationError("Invalid grant publication payload");
	}

	return {
		grantSet: normalizeGrantInput(params.grantSet),
		grantor: params.grantor,
		grantee: params.grantee,
		note: typeof params.note === "string" && params.note.length > 0 ? params.note : undefined,
		timestamp: params.timestamp,
	};
}

function buildPendingTransferDetails(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
): TapPendingTransferDetails {
	return {
		type: "transfer",
		peerName: contact.peerDisplayName,
		peerChain: contact.peerChain,
		asset: request.asset,
		amount: request.amount,
		chain: request.chain,
		toAddress: request.toAddress,
		note: request.note,
		activeGrantSummary: findActiveGrantsByScope(
			contact.permissions.grantedByMe,
			"transfer/request",
		).map((grant) => summarizeGrant(grant)),
		ledgerPath: getPermissionLedgerPath(dataDir),
	};
}

function parsePendingRequestDetails(
	metadata: Record<string, unknown> | undefined,
): TapPendingRequestDetails | undefined {
	if (!metadata) {
		return undefined;
	}

	if (metadata.type === "transfer") {
		const toAddress = asString(metadata.toAddress);
		if (!toAddress || !toAddress.startsWith("0x")) {
			return undefined;
		}
		return {
			type: "transfer",
			peerName: asString(metadata.peerName) ?? "Unknown peer",
			peerChain: asString(metadata.peerChain) ?? "unknown",
			asset: metadata.asset === "usdc" ? "usdc" : "native",
			amount: asString(metadata.amount) ?? "0",
			chain: asString(metadata.chain) ?? "unknown",
			toAddress: toAddress as `0x${string}`,
			note: asString(metadata.note),
			activeGrantSummary: asStringArray(metadata.activeGrantSummary),
			ledgerPath: asString(metadata.ledgerPath) ?? "",
		};
	}

	if (metadata.type === "scheduling") {
		return {
			type: "scheduling",
			peerName: asString(metadata.peerName) ?? "Unknown peer",
			peerChain: asString(metadata.peerChain) ?? "unknown",
			schedulingId: asString(metadata.schedulingId) ?? "",
			title: asString(metadata.title) ?? "",
			duration: typeof metadata.duration === "number" ? metadata.duration : 0,
			slots: Array.isArray(metadata.slots)
				? (metadata.slots as Array<{ start: string; end: string }>)
				: [],
			originTimezone: asString(metadata.originTimezone) ?? "UTC",
			note: asString(metadata.note),
			activeGrantSummary: asStringArray(metadata.activeGrantSummary),
			ledgerPath: asString(metadata.ledgerPath) ?? "",
		};
	}

	return undefined;
}

function parseSchedulingTrackingMetadata(
	metadata: Record<string, unknown> | undefined,
): SchedulingTrackingMetadata {
	if (!metadata) {
		return {};
	}

	const ss = metadata.schedulingState;
	const schedulingState: SchedulingRequestState | undefined =
		ss === "accepted" || ss === "cancelled" || ss === "rejected" ? ss : undefined;
	return {
		...(typeof metadata.localEventId === "string" && metadata.localEventId.length > 0
			? { localEventId: metadata.localEventId }
			: {}),
		...(schedulingState ? { schedulingState } : {}),
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function mergeMetadata(
	existing: Record<string, unknown> | undefined,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) {
			delete next[key];
			continue;
		}
		next[key] = value;
	}
	return next;
}

function serializePendingTransferRequestDetails(
	contact: Contact,
	request: TransferActionRequest,
	dataDir: string,
): Record<string, unknown> {
	return {
		...(buildPendingTransferDetails(contact, request, dataDir) as unknown as Record<
			string,
			unknown
		>),
		request: {
			type: "transfer-request",
			payload: request,
		},
	};
}

function serializePendingSchedulingRequestDetails(
	contact: Contact,
	request: SchedulingProposal,
	dataDir: string,
	direction: "inbound" | "outbound",
): Record<string, unknown> {
	const grants =
		direction === "inbound"
			? findApplicableSchedulingGrants(contact.permissions.grantedByMe, request)
			: findActiveGrantsByScope(contact.permissions.grantedByPeer, "scheduling/request");
	const details: TapPendingSchedulingDetails = {
		type: "scheduling",
		peerName: contact.peerDisplayName,
		peerChain: contact.peerChain,
		schedulingId: request.schedulingId,
		title: request.title,
		duration: request.duration,
		slots: request.slots,
		originTimezone: request.originTimezone,
		note: request.note,
		activeGrantSummary: grants.map((g) => summarizeGrant(g)),
		ledgerPath: getPermissionLedgerPath(dataDir),
	};
	return {
		...(details as unknown as Record<string, unknown>),
		request: {
			type: "scheduling-request",
			payload: request,
		},
	};
}

function parseStoredSchedulingRequest(
	metadata: Record<string, unknown> | undefined,
): SchedulingProposal | null {
	const payload = parseStoredRequestField(metadata, "scheduling-request", "payload");
	if (payload === null) {
		return null;
	}

	return parseSchedulingActionRequest({
		jsonrpc: "2.0",
		id: "pending-scheduling-request",
		method: ACTION_REQUEST,
		params: {
			message: {
				parts: [{ kind: "data", data: payload }],
			},
		},
	});
}

function getLocalTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function buildPendingActionResultDeliveryFromRequest(
	contact: Contact,
	actionId: string,
	request: ProtocolMessage,
): PendingActionResultDelivery {
	return {
		type: "action-result-delivery",
		actionId,
		connectionId: contact.connectionId,
		peerAgentId: contact.peerAgentId,
		peerName: contact.peerDisplayName,
		peerAddress: contact.peerAgentAddress,
		request,
	};
}

function buildPendingActionResultDelivery(
	contact: Contact,
	requestId: string,
	response: TransferActionResponse,
): PendingActionResultDelivery {
	const request = buildOutgoingActionResult(
		contact,
		requestId,
		buildTransferResponseText(response),
		response,
		"transfer/request",
		response.status,
	);
	return buildPendingActionResultDeliveryFromRequest(contact, response.actionId, request);
}

function serializePendingActionResultDelivery(
	delivery: PendingActionResultDelivery,
): Record<string, unknown> {
	return delivery as Record<string, unknown>;
}

function buildPendingPermissionsUpdateDelivery(
	contact: Contact,
	grantSet: PermissionGrantSet,
	request: ProtocolMessage,
): PendingPermissionsUpdateDelivery {
	return {
		type: "permissions-update-delivery",
		connectionId: contact.connectionId,
		peerAgentId: contact.peerAgentId,
		peerName: contact.peerDisplayName,
		peerAddress: contact.peerAgentAddress,
		grantSet,
		request,
	};
}

function serializePendingPermissionsUpdateDelivery(
	delivery: PendingPermissionsUpdateDelivery,
): Record<string, unknown> {
	return delivery as Record<string, unknown>;
}

function serializePendingConnectionRequest(message: ProtocolMessage): Record<string, unknown> {
	return {
		type: "connection-request",
		message,
	};
}

function buildPendingConnectionResultDelivery(
	peer: ResolvedAgent,
	result: ConnectionResultParams,
	plan?: { plannedContact: Contact; existingContact: Contact | null },
): PendingConnectionResultDelivery {
	// Deterministic id keyed by (chain, peer agentId, correlation) so repeated
	// calls upsert a single journal entry instead of accumulating one per retry
	// (bounds pending set). Peer identity is part of the key because JSON-RPC
	// ids are only unique within a single client's request space — two peers
	// can use the same correlationId without scoping.
	const request = buildConnectionResult(
		result,
		deriveConnectionResultId({
			chain: peer.chain,
			peerAgentId: peer.agentId,
			correlationId: result.requestId,
		}),
	);
	const base: PendingConnectionResultDelivery = {
		type: "connection-result-delivery",
		peerAgentId: peer.agentId,
		peerChain: peer.chain,
		peerName: peer.registrationFile.name,
		peerAddress: peer.xmtpEndpoint ?? peer.agentAddress,
		request,
	};
	if (plan) {
		base.plannedContact = plan.plannedContact;
	}
	return base;
}

/**
 * Cache key for the pending-connection-result short-circuit set. Peers are
 * uniquely identified by (chain, agentId), not agentId alone — two peers on
 * different chains can legitimately share the same numeric tokenId.
 */
function peerConnectionResultCacheKey(chain: string, agentId: number): string {
	return `${chain}:${agentId}`;
}

function isPlausiblePlannedContact(value: unknown): value is Contact {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Partial<Contact>;
	return (
		typeof c.connectionId === "string" &&
		typeof c.peerAgentId === "number" &&
		typeof c.peerChain === "string" &&
		typeof c.peerOwnerAddress === "string" &&
		typeof c.peerDisplayName === "string" &&
		typeof c.peerAgentAddress === "string" &&
		typeof c.establishedAt === "string" &&
		typeof c.lastContactAt === "string" &&
		typeof c.status === "string"
	);
}

function parsePendingConnectionResultDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingConnectionResultDelivery | null {
	if (!metadata || metadata.type !== "connection-result-delivery") {
		return null;
	}

	const peerAddress = asString(metadata.peerAddress);
	if (
		typeof metadata.peerAgentId !== "number" ||
		typeof metadata.peerName !== "string" ||
		!peerAddress?.startsWith("0x") ||
		!isProtocolMessage(metadata.request)
	) {
		return null;
	}

	// peerChain is optional for backward compatibility with entries written
	// before the field was introduced. Missing/empty chain means the entry
	// cannot participate in chain-scoped implicit completion, but the direct
	// retry pipeline still delivers it.
	const peerChain =
		typeof metadata.peerChain === "string" && metadata.peerChain.length > 0
			? metadata.peerChain
			: undefined;

	// plannedContact is optional — entries written before this field was
	// introduced do not carry the planned contact and therefore cannot write
	// the contact on retry. The retry pipeline will deliver the send but skip
	// the contact write for such legacy entries (the implicit handshake
	// completion or a future connection/request from the peer will eventually
	// write the contact).
	const plannedContact = isPlausiblePlannedContact(metadata.plannedContact)
		? metadata.plannedContact
		: undefined;
	if (metadata.plannedContact !== undefined && !plannedContact) {
		// The field is present but failed validation — warn so the journal
		// entry is still retried for delivery, but the unexpected shape is
		// surfaced for debugging.
		console.warn(
			"[TAP] parsePendingConnectionResultDelivery: plannedContact failed validation, skipping contact write",
		);
	}

	return {
		type: "connection-result-delivery",
		peerAgentId: metadata.peerAgentId,
		...(peerChain ? { peerChain } : {}),
		peerName: metadata.peerName,
		peerAddress: peerAddress as `0x${string}`,
		request: metadata.request,
		...(plannedContact ? { plannedContact } : {}),
	};
}

interface PendingConnectionRevokeDelivery {
	peerAgentId: number;
	peerChain: string;
	peerAddress: `0x${string}`;
	peerDisplayName: string;
	reason?: string;
}

function parsePendingConnectionRevokeDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingConnectionRevokeDelivery | null {
	if (!metadata || typeof metadata !== "object") return null;
	const revokeDelivery = (metadata as Record<string, unknown>).revokeDelivery;
	if (!revokeDelivery || typeof revokeDelivery !== "object") return null;
	const delivery = revokeDelivery as Record<string, unknown>;
	const peerAddress = asString(delivery.peerAddress);
	if (
		typeof delivery.peerAgentId !== "number" ||
		typeof delivery.peerChain !== "string" ||
		delivery.peerChain.length === 0 ||
		typeof delivery.peerDisplayName !== "string" ||
		!peerAddress?.startsWith("0x")
	) {
		return null;
	}
	const reason = typeof delivery.reason === "string" ? delivery.reason : undefined;
	return {
		peerAgentId: delivery.peerAgentId,
		peerChain: delivery.peerChain,
		peerAddress: peerAddress as `0x${string}`,
		peerDisplayName: delivery.peerDisplayName,
		...(reason ? { reason } : {}),
	};
}

function parsePendingConnectionRequest(
	metadata: Record<string, unknown> | undefined,
): PendingConnectionRequest | null {
	if (!metadata || metadata.type !== "connection-request" || !isProtocolMessage(metadata.message)) {
		return null;
	}

	return {
		type: "connection-request",
		message: metadata.message,
	};
}

function parsePendingActionResultDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingActionResultDelivery | null {
	if (!metadata || metadata.type !== "action-result-delivery") {
		return null;
	}

	const peerAddress = asString(metadata.peerAddress);
	if (
		typeof metadata.actionId !== "string" ||
		typeof metadata.connectionId !== "string" ||
		typeof metadata.peerAgentId !== "number" ||
		typeof metadata.peerName !== "string" ||
		!peerAddress?.startsWith("0x") ||
		!isProtocolMessage(metadata.request)
	) {
		return null;
	}

	return {
		type: "action-result-delivery",
		actionId: metadata.actionId,
		connectionId: metadata.connectionId,
		peerAgentId: metadata.peerAgentId,
		peerName: metadata.peerName,
		peerAddress: peerAddress as `0x${string}`,
		request: metadata.request,
	};
}

function parsePendingPermissionsUpdateDelivery(
	metadata: Record<string, unknown> | undefined,
): PendingPermissionsUpdateDelivery | null {
	if (!metadata || metadata.type !== "permissions-update-delivery") {
		return null;
	}

	const peerAddress = asString(metadata.peerAddress);
	const grantSet = metadata.grantSet;
	if (
		typeof metadata.connectionId !== "string" ||
		typeof metadata.peerAgentId !== "number" ||
		typeof metadata.peerName !== "string" ||
		!peerAddress?.startsWith("0x") ||
		!grantSet ||
		typeof grantSet !== "object" ||
		!isProtocolMessage(metadata.request)
	) {
		return null;
	}

	return {
		type: "permissions-update-delivery",
		connectionId: metadata.connectionId,
		peerAgentId: metadata.peerAgentId,
		peerName: metadata.peerName,
		peerAddress: peerAddress as `0x${string}`,
		grantSet: grantSet as PermissionGrantSet,
		request: metadata.request,
	};
}

function parseStoredTransferRequest(
	metadata: Record<string, unknown> | undefined,
): TransferActionRequest | null {
	const payload = parseStoredRequestField(metadata, "transfer-request", "payload");
	if (payload === null) {
		return null;
	}

	return parseTransferActionRequest({
		jsonrpc: "2.0",
		id: "pending-transfer-request",
		method: ACTION_REQUEST,
		params: {
			message: {
				parts: [{ kind: "data", data: payload }],
			},
		},
	});
}

function parseStoredRequestField(
	metadata: Record<string, unknown> | undefined,
	expectedType: string,
	field: string,
): unknown | null {
	if (!metadata) {
		return null;
	}

	const request = metadata.request;
	if (typeof request !== "object" || request === null) {
		return null;
	}
	if ((request as { type?: unknown }).type !== expectedType) {
		return null;
	}

	return (request as Record<string, unknown>)[field] ?? null;
}

function resolvePermissionsUpdatePeer(
	config: Pick<TrustedAgentsConfig, "agentId" | "chain">,
	params: Pick<PermissionsUpdateParams, "grantor" | "grantee">,
) {
	const localAgent = { agentId: config.agentId, chain: config.chain };
	const grantorIsLocal = isSameAgentIdentifier(params.grantor, localAgent);
	const granteeIsLocal = isSameAgentIdentifier(params.grantee, localAgent);

	if (grantorIsLocal === granteeIsLocal) {
		throw new ValidationError("Grant update must involve the local agent exactly once");
	}

	return grantorIsLocal ? params.grantee : params.grantor;
}

function serializeRecordedTransferResponse(
	response: TransferActionResponse,
): RecordedTransferResponseMetadata {
	return {
		type: "transfer-response",
		response,
	};
}

function parseRecordedTransferResponse(
	metadata: Record<string, unknown> | undefined,
): TransferActionResponse | null {
	if (!metadata || metadata.type !== "transfer-response") {
		return null;
	}

	const response = metadata.response;
	if (typeof response !== "object" || response === null) {
		return null;
	}

	const parsed = response as Partial<TransferActionResponse>;
	if (
		parsed.type !== "transfer/response" ||
		typeof parsed.actionId !== "string" ||
		(parsed.asset !== "native" && parsed.asset !== "usdc") ||
		typeof parsed.amount !== "string" ||
		typeof parsed.chain !== "string" ||
		typeof parsed.toAddress !== "string" ||
		(parsed.status !== "completed" && parsed.status !== "rejected" && parsed.status !== "failed")
	) {
		return null;
	}

	return parsed as TransferActionResponse;
}

function isDeliveryEntry(entry: RequestJournalEntry): boolean {
	if (entry.kind === "result") return true;
	return entry.kind === "request" && entry.method === PERMISSIONS_UPDATE;
}

function isOutboundDeliveryEntry(entry: RequestJournalEntry): boolean {
	return entry.direction === "outbound" && isDeliveryEntry(entry);
}

function toPendingRequestView(
	entry: RequestJournalEntry,
	contacts: readonly Contact[],
): TapPendingRequest {
	const metadataChain = (entry.metadata as { peerChain?: string } | undefined)?.peerChain;

	let peerChain = metadataChain ?? "";
	if (!peerChain) {
		const candidates = contacts.filter((c) => c.peerAgentId === entry.peerAgentId);
		if (candidates.length === 1) {
			peerChain = candidates[0]?.peerChain ?? "";
		}
	}

	return {
		requestId: entry.requestId,
		method: entry.method,
		peerAgentId: entry.peerAgentId,
		peerChain,
		direction: entry.direction,
		kind: entry.kind,
		status: entry.status,
		correlationId: entry.correlationId,
		details: parsePendingRequestDetails(entry.metadata),
	};
}

function toPendingDeliveryView(entry: RequestJournalEntry, now: number): TapPendingDelivery {
	const createdMs = Date.parse(entry.createdAt);
	const ageMs = Number.isFinite(createdMs) ? now - createdMs : 0;
	const failure = parseDeliveryFailureMetadata(entry.metadata);
	return {
		requestId: entry.requestId,
		method: entry.method,
		peerAgentId: entry.peerAgentId,
		...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
		ageMs,
		...(failure?.attempts !== undefined ? { attempts: failure.attempts } : {}),
		...(failure?.lastAttemptAt ? { lastAttemptAt: failure.lastAttemptAt } : {}),
		...(failure?.lastError ? { lastError: failure.lastError } : {}),
	};
}

function parseDeliveryFailureMetadata(
	metadata: Record<string, unknown> | undefined,
): DeliveryFailureMetadata | null {
	if (!metadata) {
		return null;
	}
	const raw = metadata[DELIVERY_FAILURE_METADATA_KEY];
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const candidate = raw as Partial<DeliveryFailureMetadata>;
	if (
		candidate.type !== "delivery-failure" ||
		typeof candidate.attempts !== "number" ||
		typeof candidate.lastAttemptAt !== "string" ||
		typeof candidate.lastError !== "string"
	) {
		return null;
	}
	return candidate as DeliveryFailureMetadata;
}

function isProtocolMessage(value: unknown): value is ProtocolMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
		typeof (value as { method?: unknown }).method === "string" &&
		"id" in (value as Record<string, unknown>)
	);
}

function isSameAgentIdentifier(
	left: Pick<AgentIdentifier, "agentId" | "chain">,
	right: Pick<AgentIdentifier, "agentId" | "chain">,
): boolean {
	return left.agentId === right.agentId && left.chain === right.chain;
}

export function findApplicableTransferGrants(
	grantSet: PermissionGrantSet,
	request: TransferActionRequest,
) {
	return findActiveGrantsByScope(grantSet, "transfer/request").filter((grant) =>
		matchesTransferGrantRequest(grant, request),
	);
}

export function matchesTransferGrantRequest(
	grant: PermissionGrantSet["grants"][number],
	request: TransferActionRequest,
): boolean {
	const constraints = grant.constraints;
	if (!constraints) {
		return true;
	}

	if (typeof constraints.asset === "string" && constraints.asset !== request.asset) {
		return false;
	}

	if (typeof constraints.chain === "string" && constraints.chain !== request.chain) {
		return false;
	}

	if (
		typeof constraints.toAddress === "string" &&
		constraints.toAddress.toLowerCase() !== request.toAddress.toLowerCase()
	) {
		return false;
	}

	if (typeof constraints.maxAmount === "string") {
		try {
			const maxAmount =
				request.asset === "native"
					? parseEther(constraints.maxAmount)
					: parseUnits(constraints.maxAmount, getUsdcAsset(request.chain)?.decimals ?? 6);
			const requestedAmount =
				request.asset === "native"
					? parseEther(request.amount)
					: parseUnits(request.amount, getUsdcAsset(request.chain)?.decimals ?? 6);
			if (requestedAmount > maxAmount) {
				return false;
			}
		} catch {
			return false;
		}
	}

	return true;
}

function isTransportReceiptTimeout(error: unknown): error is TransportError {
	return (
		error instanceof TransportError && error.message.startsWith("Response timeout for message ")
	);
}

async function findContactForMessage(
	context: Pick<TapRuntimeContext, "config" | "trustStore">,
	from: number,
	message: ProtocolMessage,
): Promise<Contact | null> {
	const metadataConnectionId = extractConnectionIdFromParams(message.params);
	if (metadataConnectionId) {
		const contact = await context.trustStore.getContact(metadataConnectionId);
		if (contact?.peerAgentId === from) {
			return contact;
		}
	}

	const contacts = await context.trustStore.getContacts();

	if (message.method === CONNECTION_RESULT) {
		const params = parseConnectionResult(message);
		return (
			contacts.find(
				(c) =>
					c.peerAgentId === params.from.agentId &&
					c.peerChain === params.from.chain &&
					c.status === "active",
			) ?? null
		);
	}

	if (message.method === PERMISSIONS_UPDATE) {
		const params = parsePermissionsUpdate(message);
		const peer = resolvePermissionsUpdatePeer(context.config, params);
		return (
			contacts.find(
				(c) =>
					c.peerAgentId === peer.agentId && c.peerChain === peer.chain && c.status === "active",
			) ?? null
		);
	}

	return findUniqueContactForAgentId(contacts, from) ?? null;
}

/**
 * Write the planned contact to the trust store after a successful
 * `connection/result` send. This is shared between `processConnectionRequest`
 * (immediate path) and `retryPendingConnectionResults` (reconciliation path).
 *
 * The active case uses `touchContact` rather than `updateContact` because the
 * handler returns the existing contact as `plannedContact` and only the
 * `lastContactAt` timestamp should advance.
 */
async function applyConnectionResultContact(
	trustStore: ITrustStore,
	plan: { plannedContact: Contact; existingContact: Contact | null },
): Promise<void> {
	if (plan.existingContact) {
		if (plan.existingContact.status === "active") {
			await trustStore.touchContact(plan.existingContact.connectionId);
		} else {
			await trustStore.updateContact(plan.existingContact.connectionId, plan.plannedContact);
		}
	} else {
		await trustStore.addContact(plan.plannedContact);
	}
}

export { TransportOwnershipError };
