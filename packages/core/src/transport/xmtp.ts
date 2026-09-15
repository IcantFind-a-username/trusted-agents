import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, getInboxIdForIdentifier } from "@xmtp/node-sdk";
import type { DecodedMessage, Dm, Signer } from "@xmtp/node-sdk";
import { hexToBytes } from "viem";
import {
	AttentionPaymentRequiredError,
	TransportError,
	TransportRpcError,
	isEthereumAddress,
	nowISO,
	toErrorMessage,
} from "../common/index.js";
import type { IAgentResolver } from "../identity/resolver.js";
import {
	CONNECTION_REQUEST,
	CONNECTION_RESULT,
	PERMISSIONS_UPDATE,
	extractConnectionIdFromParams,
	isResultMethod,
} from "../protocol/index.js";
import type { AgentIdentifier } from "../protocol/types.js";
import type { ITrustStore } from "../trust/trust-store.js";
import type { Contact } from "../trust/types.js";
import type {
	ProtocolMessage,
	TransportAck,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
	TransportReconcileOptions,
	TransportReconcileResult,
} from "./interface.js";
import type { TransportSendOptions } from "./types.js";
import { createXmtpSigner } from "./xmtp-signer.js";
import { FileXmtpSyncStateStore, type XmtpConversationCheckpoint } from "./xmtp-sync-state.js";
import type { XmtpTransportConfig } from "./xmtp-types.js";

/** IdentifierKind.Ethereum from @xmtp/node-bindings (const enum, value inlined to avoid verbatimModuleSyntax issues) */
const IDENTIFIER_KIND_ETHEREUM = 0 as const;
const MESSAGE_SORT_BY_SENT_AT = 0 as const;
const SORT_DIRECTION_ASCENDING = 0 as const;

const RECONNECT_DELAY_MS = 5_000;
const CLIENT_CREATE_TIMEOUT_MS = 30_000;
const INBOUND_REQUEST_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const MAX_TRACKED_INBOUND_REQUESTS = 4_096;
const MAX_RECONCILE_ERROR_SAMPLES = 5;

function collectErrorSamples(samples: string[], messages: string[], conversationId: string): void {
	for (const message of messages) {
		if (samples.length >= MAX_RECONCILE_ERROR_SAMPLES) {
			return;
		}
		samples.push(`[${conversationId}] ${message}`);
	}
}

interface PendingRequest {
	resolve: (receipt: TransportReceipt) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	senderInboxId: string;
}

interface IncomingTransportMessage {
	senderInboxId: string;
	content: unknown;
	conversationId?: string;
	messageId?: string;
	sentAtNs?: bigint;
}

export class XmtpTransport implements TransportProvider {
	private client: Client | null = null;
	private handlers: TransportHandlers = {};
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly processedIncomingRequests = new Map<string, number>();
	private running = false;
	private streamCloser?: { return?: () => Promise<unknown> };
	private listenerPromise?: Promise<void>;
	private streamOpenAbort?: () => void;
	private reconnectCanceler?: {
		timer: ReturnType<typeof setTimeout>;
		resolve: () => void;
	};
	private readonly inboxIdToAddress = new Map<string, `0x${string}`>();
	private readonly agentResolver?: IAgentResolver;
	private readonly resolveCacheTtlMs: number;
	private readonly syncState: FileXmtpSyncStateStore | null;

	constructor(
		private readonly config: XmtpTransportConfig,
		private readonly trustStore: ITrustStore,
	) {
		this.agentResolver = config.agentResolver;
		this.resolveCacheTtlMs = config.resolveCacheTtlMs ?? 86_400_000;
		this.syncState =
			config.syncStatePath || config.dbPath
				? new FileXmtpSyncStateStore(
						config.syncStatePath ?? join(config.dbPath ?? ".", "sync-state.json"),
					)
				: null;
	}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = { ...handlers };
	}

	async start(): Promise<void> {
		if (this.running && this.client) {
			return;
		}

		const signer = await createXmtpSigner(this.config.signingProvider);
		if (!this.config.dbEncryptionKey) {
			throw new TransportError(
				"xmtpDbEncryptionKey is required. Set it in config.yaml or provide it via the host runtime.",
			);
		}
		const dbEncryptionKey = hexToBytes(this.config.dbEncryptionKey);
		if (this.config.dbPath) {
			await mkdir(this.config.dbPath, { recursive: true, mode: 0o700 });
		}

		const clientOptions = {
			env: "production" as const,
			dbEncryptionKey,
			...(this.config.dbPath
				? { dbPath: (inboxId: string) => `${this.config.dbPath}/${inboxId}.db3` }
				: {}),
		};
		const createClient = async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					Client.create(signer, clientOptions),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(
							() => reject(new TransportError("XMTP Client.create() timed out")),
							CLIENT_CREATE_TIMEOUT_MS,
						);
					}),
				]);
			} finally {
				if (timeout) {
					clearTimeout(timeout);
				}
			}
		};

		try {
			this.client = await createClient();
		} catch (error: unknown) {
			// If the inbox hit the 10-installation limit, Client.create() fails
			// before we get a chance to call revokeAllOtherInstallations().
			// Revoke all installations using static SDK methods and retry once.
			if (isInstallationLimitError(error)) {
				await revokeAllInstallationsStatic(signer);
				this.client = await createClient();
			} else {
				throw error;
			}
		}

		// Revoke stale installations after successfully registering so the NEXT
		// start has room.  This keeps the inbox clean over repeated sessions.
		try {
			await this.client.revokeAllOtherInstallations();
		} catch {
			// Best-effort: if revocation fails, proceed anyway.
		}

		this.running = true;
		await this.populateInboxIdCache();
		this.listenWithReconnect();
	}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		let peerAddress: `0x${string}`;
		let connectionId: string | undefined;

		if (options?.peerAddress) {
			peerAddress = options.peerAddress;
		} else {
			const contact = await this.trustStore.findByAgentId(peerId, this.config.chain);
			if (!contact) {
				throw new TransportError(`No contact found for agent ${peerId}`);
			}
			peerAddress = contact.peerAgentAddress;
			connectionId = contact.connectionId;
		}

		const inboxId = await this.resolveInboxId(peerAddress);
		const dm = await this.client.conversations.createDm(inboxId);
		const requestId = String(message.id);
		const waitForAck = options?.waitForAck ?? true;

		// Fire-and-forget path: publish to the transport and return immediately.
		// The peer may still emit a JSON-RPC receipt later, which `processIncomingReceipt`
		// will silently ignore (no matching pendingRequest entry). Delivery durability
		// is owned by the caller's request journal + retry pipeline, not by the
		// synchronous ack.
		if (!waitForAck) {
			try {
				await dm.sendText(JSON.stringify(message));
			} catch (err) {
				throw err instanceof TransportError
					? err
					: new TransportError(`Failed to send message: ${toErrorMessage(err)}`);
			}
			if (connectionId) {
				this.trustStore.touchContact(connectionId).catch(() => {});
			}
			return {
				received: true,
				requestId,
				status: "published",
				receivedAt: nowISO(),
			};
		}

		const timeout = options?.timeout ?? this.config.defaultResponseTimeoutMs ?? 30_000;

		const receiptPromise = new Promise<TransportReceipt>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new TransportError(`Response timeout for message ${requestId}`));
			}, timeout);

			this.pendingRequests.set(requestId, {
				resolve,
				reject,
				timer,
				senderInboxId: inboxId,
			});
		});

		try {
			await dm.sendText(JSON.stringify(message));
		} catch (err) {
			const pending = this.pendingRequests.get(requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(requestId);
			}
			throw err instanceof TransportError
				? err
				: new TransportError(`Failed to send message: ${toErrorMessage(err)}`);
		}

		const receipt = await receiptPromise;
		if (connectionId) {
			this.trustStore.touchContact(connectionId).catch(() => {});
		}
		return receipt;
	}

	async reconcile(options?: TransportReconcileOptions): Promise<TransportReconcileResult> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		if (!this.syncState) {
			return await this.reconcileAllMessages(options);
		}

		await this.client.conversations.syncAll(
			options?.consentStates as Parameters<Client["conversations"]["syncAll"]>[0],
		);

		const dms = this.client.conversations.listDms();
		const initialized = await this.syncState.isInitialized();
		if (!initialized) {
			await this.syncState.initializeAtHead(await this.buildConversationHeadCheckpoints(dms));
			return {
				synced: true,
				processed: 0,
			};
		}

		let processed = 0;
		const errorSamples: string[] = [];
		let errors = 0;
		for (const dm of dms) {
			try {
				const result = await this.reconcileConversation(dm);
				processed += result.processed;
				if (result.errors.length > 0) {
					errors += result.errors.length;
					collectErrorSamples(errorSamples, result.errors, dm.id);
				}
			} catch (error) {
				// Skip this DM so one persistently-failing DM doesn't block all others.
				// Common causes: transient checkpoint-read errors or XMTP SDK query failures.
				errors += 1;
				collectErrorSamples(errorSamples, [toErrorMessage(error)], dm.id);
			}
		}

		return {
			synced: true,
			processed,
			...(errors > 0 ? { errors, errorSamples } : {}),
		};
	}

	async isReachable(peerId: number): Promise<boolean> {
		if (!this.client) return false;

		const contact = await this.trustStore.findByAgentId(peerId, this.config.chain);
		if (!contact) return false;

		try {
			const normalizedAddress = contact.peerAgentAddress.toLowerCase();
			const result = await this.client.canMessage([
				{
					identifier: normalizedAddress,
					identifierKind: IDENTIFIER_KIND_ETHEREUM,
				},
			]);
			return result.get(normalizedAddress) === true;
		} catch {
			return false;
		}
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		this.running = false;
		const stream = this.streamCloser;
		this.streamCloser = undefined;

		if (this.reconnectCanceler) {
			clearTimeout(this.reconnectCanceler.timer);
			this.reconnectCanceler.resolve();
			this.reconnectCanceler = undefined;
		}

		if (this.streamOpenAbort) {
			this.streamOpenAbort();
			this.streamOpenAbort = undefined;
		}

		try {
			await stream?.return?.();
		} catch {
			// Ignore stream close errors
		}

		const listener = this.listenerPromise;
		this.listenerPromise = undefined;
		if (listener) {
			try {
				await listener;
			} catch {
				// Listener errors are already swallowed inside the reconnect loop
			}
		}

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new TransportError("Transport stopped"));
		}
		this.pendingRequests.clear();
		this.processedIncomingRequests.clear();
		this.client = null;
	}

	private async populateInboxIdCache(): Promise<void> {
		if (!this.client) return;
		const contacts = await this.trustStore.getContacts();
		for (const contact of contacts) {
			try {
				await this.resolveInboxId(contact.peerAgentAddress);
			} catch {
				// Skip contacts not registered on XMTP
			}
		}
	}

	private listenWithReconnect(): void {
		this.listenerPromise = (async () => {
			while (this.running) {
				try {
					await this.listenForMessages();
				} catch {
					// Stream failed — will retry after delay
				}
				if (this.running) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(() => {
							this.reconnectCanceler = undefined;
							resolve();
						}, RECONNECT_DELAY_MS);
						this.reconnectCanceler = { timer, resolve };
					});
				}
			}
		})();
	}

	private toIncomingMessage(message: DecodedMessage): IncomingTransportMessage {
		return {
			senderInboxId: message.senderInboxId,
			content: message.content,
			conversationId: message.conversationId,
			messageId: message.id,
			sentAtNs: message.sentAtNs,
		};
	}

	private async listenForMessages(): Promise<void> {
		if (!this.client) return;

		// The SDK call can stall (network/handshake), so race it against a
		// stop-initiated abort signal. Without this race, `await transport.stop()`
		// would block on `listenerPromise` indefinitely when the stream never
		// opens — exactly the one-shot CLI flow this change is meant to unblock.
		const streamPromise = this.client.conversations.streamAllDmMessages({
			disableSync: true,
		});
		const aborted: Promise<null> = new Promise((resolve) => {
			this.streamOpenAbort = () => resolve(null);
		});
		const stream = await Promise.race([streamPromise, aborted]);
		this.streamOpenAbort = undefined;

		if (stream === null) {
			// Stop was signaled before the stream opened. Close any stream that
			// lands later so we don't leak an open handle.
			streamPromise.then((s) => s.return?.()).catch(() => {});
			return;
		}

		this.streamCloser = stream;
		if (!this.running) {
			if (this.streamCloser === stream) {
				this.streamCloser = undefined;
			}
			await stream.return?.();
			return;
		}

		try {
			for await (const message of stream) {
				if (!this.running) break;
				try {
					await this.processMessage(this.toIncomingMessage(message));
					await this.advanceCheckpoint(message.conversationId, message.sentAtNs, message.id);
				} catch {
					// Leave the checkpoint unchanged so transient failures can be retried.
				}
			}
		} finally {
			if (this.streamCloser === stream) {
				this.streamCloser = undefined;
			}
		}
	}

	private async reconcileAllMessages(
		options?: TransportReconcileOptions,
	): Promise<TransportReconcileResult> {
		if (!this.client) {
			throw new TransportError("XMTP client not started");
		}

		await this.client.conversations.syncAll(
			options?.consentStates as Parameters<Client["conversations"]["syncAll"]>[0],
		);

		let processed = 0;
		for (const dm of this.client.conversations.listDms()) {
			const messages = await dm.messages();
			messages.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
			for (const message of messages) {
				const didProcess = await this.processMessage(this.toIncomingMessage(message));
				if (didProcess) {
					processed += 1;
				}
			}
		}

		return {
			synced: true,
			processed,
		};
	}

	private async buildConversationHeadCheckpoints(
		dms: Dm[],
	): Promise<Record<string, XmtpConversationCheckpoint>> {
		const checkpoints: Record<string, XmtpConversationCheckpoint> = {};
		for (const dm of dms) {
			const lastMessage = await dm.lastMessage();
			if (!lastMessage) {
				continue;
			}
			checkpoints[dm.id] = {
				lastSentAtNs: lastMessage.sentAtNs.toString(),
				lastMessageIds: [lastMessage.id],
			};
		}
		return checkpoints;
	}

	private async reconcileConversation(dm: Dm): Promise<{ processed: number; errors: string[] }> {
		if (!this.syncState) {
			return { processed: 0, errors: [] };
		}

		const checkpoint = await this.syncState.getCheckpoint(dm.id);
		const messages = await dm.messages(buildMessageQuery(checkpoint));

		let processed = 0;
		const errors: string[] = [];
		for (const message of messages) {
			if (isMessageAlreadyCheckpointed(checkpoint, message)) {
				continue;
			}
			try {
				const didProcess = await this.processMessage(this.toIncomingMessage(message));
				if (didProcess) {
					processed += 1;
				}
			} catch (error) {
				// Record the error but keep draining the DM. The listener stream is
				// the authoritative real-time channel; reconcile is catch-up. If we
				// bailed here without advancing the checkpoint (as earlier attempts
				// at this code did), a single poison message would block every
				// subsequent message in the same DM on every future reconcile pass.
				errors.push(toErrorMessage(error));
			}
			// Always advance the checkpoint — successes, `didProcess === false`,
			// and thrown errors alike — so reconcile makes forward progress across
			// restarts even when a message is not replay-safe. Transient failures
			// that need a retry should flow through the listener or the journal
			// retry pipeline, not the reconcile replay loop.
			await this.advanceCheckpoint(dm.id, message.sentAtNs, message.id);
		}

		return { processed, errors };
	}

	private async processMessage(message: IncomingTransportMessage): Promise<boolean> {
		if (message.senderInboxId === this.client?.inboxId) {
			return false;
		}

		const content = typeof message.content === "string" ? message.content : null;
		if (!content) {
			return false;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return false;
		}

		if (typeof parsed !== "object" || parsed === null) {
			return false;
		}

		const payload = parsed as Record<string, unknown>;
		if (payload.jsonrpc !== "2.0") {
			return false;
		}

		if ("result" in payload || "error" in payload) {
			return this.processIncomingReceipt(message.senderInboxId, payload);
		}

		if (!("method" in payload)) {
			return false;
		}

		const request = payload as unknown as ProtocolMessage;
		if (this.isDuplicateIncomingRequest(message.senderInboxId, request)) {
			return false;
		}

		// Mark as processed BEFORE the async handler to prevent the TOCTOU race
		// where both the listener stream and reconcile process the same message concurrently.
		this.markIncomingRequestProcessed(message.senderInboxId, request);
		let handled: boolean;
		try {
			handled = await this.handleIncomingProtocolMessage(message, request);
		} catch (err) {
			// Remove the mark on error so the message can be retried
			this.processedIncomingRequests.delete(
				buildIncomingRequestKey(message.senderInboxId, request),
			);
			throw err;
		}
		if (!handled) {
			// Remove the mark so genuine retries can be processed
			this.processedIncomingRequests.delete(
				buildIncomingRequestKey(message.senderInboxId, request),
			);
		}
		return handled;
	}

	private processIncomingReceipt(senderInboxId: string, payload: Record<string, unknown>): boolean {
		const requestId = String(payload.id);
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return false;
		}
		if (pending.senderInboxId !== senderInboxId) {
			return false;
		}

		clearTimeout(pending.timer);
		this.pendingRequests.delete(requestId);

		if ("error" in payload && payload.error && typeof payload.error === "object") {
			const rpcError = payload.error as { code?: unknown; message?: unknown; data?: unknown };
			const errorMessage =
				typeof rpcError.message === "string"
					? rpcError.message
					: `Peer returned an error for message ${requestId}`;
			if (typeof rpcError.code === "number") {
				pending.reject(new TransportRpcError(errorMessage, rpcError.code, rpcError.data));
			} else {
				pending.reject(new TransportError(errorMessage));
			}
			return true;
		}

		const result = payload.result;
		if (typeof result !== "object" || result === null) {
			pending.reject(new TransportError(`Invalid receipt payload for message ${requestId}`));
			return true;
		}

		const receipt = result as Record<string, unknown>;
		if (
			receipt.received !== true ||
			typeof receipt.status !== "string" ||
			(receipt.status !== "received" &&
				receipt.status !== "duplicate" &&
				receipt.status !== "queued")
		) {
			pending.reject(new TransportError(`Invalid receipt payload for message ${requestId}`));
			return true;
		}

		pending.resolve({
			received: true,
			requestId:
				typeof receipt.requestId === "string" && receipt.requestId.length > 0
					? receipt.requestId
					: requestId,
			status: receipt.status,
			receivedAt:
				typeof receipt.receivedAt === "string" && receipt.receivedAt.length > 0
					? receipt.receivedAt
					: nowISO(),
		});
		return true;
	}

	private async handleIncomingProtocolMessage(
		rawMessage: IncomingTransportMessage,
		message: ProtocolMessage,
	): Promise<boolean> {
		if (!this.client) {
			return false;
		}

		const senderAddresses = await this.resolveInboxAddresses(rawMessage.senderInboxId);
		const resultMethod = isResultMethod(message.method);
		const resolvedSenderContact = await this.findSenderContactFromMessage(senderAddresses, message);

		let senderId: number;
		if (resolvedSenderContact) {
			if (!this.isContactAllowedForMethod(resolvedSenderContact, message.method)) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					-32003,
					"Sender connection is not active for this method",
				);
				return false;
			}
			senderId = resolvedSenderContact.peerAgentId;
		} else if (this.isBootstrapMethod(message.method)) {
			try {
				senderId = await this.verifyBootstrapSender(
					rawMessage.senderInboxId,
					senderAddresses,
					message,
				);
			} catch (error) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					-32001,
					error instanceof Error ? error.message : "Bootstrap sender verification failed",
				);
				return false;
			}
		} else {
			const senderContact = await this.findContactByAddresses(senderAddresses);
			if (senderContact && this.isContactAllowedForMethod(senderContact, message.method)) {
				senderId = senderContact.peerAgentId;
			} else if (senderContact) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					-32003,
					"Sender connection is not active for this method",
				);
				return false;
			} else {
				await this.sendJsonRpcError(rawMessage.senderInboxId, message.id, -32001, "Unknown sender");
				return false;
			}
		}

		const handler = resultMethod ? this.handlers.onResult : this.handlers.onRequest;
		if (!handler) {
			await this.sendJsonRpcError(
				rawMessage.senderInboxId,
				message.id,
				-32601,
				`No transport handler registered for ${resultMethod ? "results" : "requests"}`,
			);
			return false;
		}

		let ack: TransportAck;
		try {
			ack = await handler({
				from: senderId,
				senderInboxId: rawMessage.senderInboxId,
				message,
			});
		} catch (error) {
			// Typed service rejections keep their code and machine-readable
			// data on the wire; anything else collapses to the generic -32603.
			if (error instanceof AttentionPaymentRequiredError) {
				await this.sendJsonRpcError(
					rawMessage.senderInboxId,
					message.id,
					error.rpcCode,
					error.message,
					{ attention: error.quote, ...(error.postage ? { postage: error.postage } : {}) },
				);
				return false;
			}
			await this.sendJsonRpcError(
				rawMessage.senderInboxId,
				message.id,
				-32603,
				error instanceof Error ? error.message : "Internal error",
			);
			return false;
		}

		await this.sendJsonRpcReceipt(rawMessage.senderInboxId, message.id, String(message.id), ack);
		return true;
	}

	private isContactAllowedForMethod(contact: Contact, _method: string): boolean {
		return contact.status === "active";
	}

	private isBootstrapMethod(method: string): boolean {
		return method === CONNECTION_REQUEST || method === CONNECTION_RESULT;
	}

	private async verifyBootstrapSender(
		senderInboxId: string,
		senderAddresses: `0x${string}`[],
		message: ProtocolMessage,
	): Promise<number> {
		const claimedSender = this.extractAgentIdentifier(message.params, "from");
		const claimedAgentId = claimedSender?.agentId;
		const claimedChain = claimedSender?.chain;

		if (
			typeof claimedAgentId !== "number" ||
			claimedAgentId < 0 ||
			typeof claimedChain !== "string" ||
			claimedChain.length === 0
		) {
			throw new TransportError("Invalid bootstrap sender identity");
		}

		if (!this.agentResolver) {
			throw new TransportError("Bootstrap sender verification unavailable");
		}

		const resolved = await this.agentResolver
			.resolveWithCache(claimedAgentId, claimedChain, this.resolveCacheTtlMs)
			.catch(() => null);
		if (!resolved) {
			throw new TransportError("Failed to resolve bootstrap sender identity");
		}

		const expectedSenderAddress = resolved.agentAddress.toLowerCase();
		const verified = senderAddresses.some(
			(address) => address.toLowerCase() === expectedSenderAddress,
		);
		if (!verified) {
			throw new TransportError("Sender identity verification failed");
		}

		this.inboxIdToAddress.set(senderInboxId, expectedSenderAddress as `0x${string}`);
		return claimedAgentId;
	}

	private extractAgentIdentifier(params: unknown, key: string): AgentIdentifier | null {
		if (typeof params !== "object" || params === null) {
			return null;
		}

		const nested = (params as Record<string, unknown>)[key];
		if (typeof nested !== "object" || nested === null) {
			return null;
		}

		const agentId = (nested as { agentId?: unknown }).agentId;
		const chain = (nested as { chain?: unknown }).chain;
		if (
			typeof agentId !== "number" ||
			agentId < 0 ||
			typeof chain !== "string" ||
			chain.length === 0
		) {
			return null;
		}

		return { agentId, chain };
	}

	private async resolveInboxAddresses(senderInboxId: string): Promise<`0x${string}`[]> {
		const cached = this.inboxIdToAddress.get(senderInboxId);
		if (cached) {
			return [cached];
		}
		if (!this.client) return [];

		try {
			const states = await this.client.preferences.fetchInboxStates([senderInboxId]);
			const identifiers = states[0]?.identifiers ?? [];

			const addresses = identifiers
				.filter((identifier) => identifier.identifierKind === IDENTIFIER_KIND_ETHEREUM)
				.map((identifier) => identifier.identifier)
				.filter((identifier): identifier is `0x${string}` => isEthereumAddress(identifier))
				.map((identifier) => identifier.toLowerCase() as `0x${string}`);

			const unique = [...new Set(addresses)];
			if (unique.length > 0) {
				this.inboxIdToAddress.set(senderInboxId, unique[0]!);
			}

			return unique;
		} catch {
			return [];
		}
	}

	private async findContactByAddresses(addresses: `0x${string}`[]): Promise<Contact | null> {
		for (const address of addresses) {
			const contact = await this.trustStore.findByAgentAddress(address);
			if (contact) {
				return contact;
			}
		}
		return null;
	}

	private async findSenderContactFromMessage(
		senderAddresses: `0x${string}`[],
		message: ProtocolMessage,
	): Promise<Contact | null> {
		if (this.isBootstrapMethod(message.method)) {
			return null;
		}

		const metadataContact = await this.findContactByConnectionId(senderAddresses, message);
		if (metadataContact) {
			return metadataContact;
		}

		if (message.method !== PERMISSIONS_UPDATE) {
			return null;
		}

		const grantor = this.extractAgentIdentifier(message.params, "grantor");
		if (!grantor) {
			return null;
		}

		const contact = await this.trustStore.findByAgentId(grantor.agentId, grantor.chain);
		if (!contact || !this.senderMatchesContact(senderAddresses, contact)) {
			return null;
		}

		return contact;
	}

	private async findContactByConnectionId(
		senderAddresses: `0x${string}`[],
		message: ProtocolMessage,
	): Promise<Contact | null> {
		const connectionId = extractConnectionIdFromParams(message.params);
		if (!connectionId) {
			return null;
		}

		const contact = await this.trustStore.getContact(connectionId);
		if (!contact || !this.senderMatchesContact(senderAddresses, contact)) {
			return null;
		}

		return contact;
	}

	private senderMatchesContact(senderAddresses: `0x${string}`[], contact: Contact): boolean {
		const expectedAddress = contact.peerAgentAddress.toLowerCase();
		return senderAddresses.some((address) => address.toLowerCase() === expectedAddress);
	}

	private async sendJsonRpc(senderInboxId: string, payload: object): Promise<void> {
		const dm = await this.findDmForSender(senderInboxId);
		if (!dm) {
			return;
		}
		await dm.sendText(JSON.stringify(payload));
	}

	private async sendJsonRpcReceipt(
		senderInboxId: string,
		id: ProtocolMessage["id"],
		requestId: string,
		ack: TransportAck,
	): Promise<void> {
		await this.sendJsonRpc(senderInboxId, {
			jsonrpc: "2.0",
			id,
			result: {
				received: true,
				requestId,
				status: ack.status,
				receivedAt: nowISO(),
			},
		});
	}

	private async sendJsonRpcError(
		senderInboxId: string,
		id: ProtocolMessage["id"],
		code: number,
		message: string,
		data?: unknown,
	): Promise<void> {
		await this.sendJsonRpc(senderInboxId, {
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data !== undefined ? { data } : {}) },
		});
	}

	private async resolveInboxId(address: `0x${string}`): Promise<string> {
		for (const [cachedInboxId, cachedAddr] of this.inboxIdToAddress) {
			if (cachedAddr.toLowerCase() === address.toLowerCase()) {
				return cachedInboxId;
			}
		}

		const inboxId = await this.client!.fetchInboxIdByIdentifier({
			identifier: address.toLowerCase(),
			identifierKind: IDENTIFIER_KIND_ETHEREUM,
		});
		if (!inboxId) {
			throw new TransportError(`Peer ${address} not registered on XMTP`);
		}

		this.inboxIdToAddress.set(inboxId, address.toLowerCase() as `0x${string}`);
		return inboxId;
	}

	private async findDmForSender(
		senderInboxId: string,
	): Promise<{ sendText: (text: string) => Promise<unknown> } | null> {
		if (!this.client) {
			return null;
		}

		try {
			return await this.client.conversations.createDm(senderInboxId);
		} catch {
			return null;
		}
	}

	private isDuplicateIncomingRequest(senderInboxId: string, request: ProtocolMessage): boolean {
		const now = Date.now();
		this.pruneProcessedIncomingRequests(now);
		return this.processedIncomingRequests.has(buildIncomingRequestKey(senderInboxId, request));
	}

	private markIncomingRequestProcessed(senderInboxId: string, request: ProtocolMessage): void {
		const now = Date.now();
		this.pruneProcessedIncomingRequests(now);
		this.processedIncomingRequests.set(buildIncomingRequestKey(senderInboxId, request), now);
	}

	private pruneProcessedIncomingRequests(now: number): void {
		for (const [key, timestamp] of this.processedIncomingRequests) {
			if (now - timestamp > INBOUND_REQUEST_DEDUPE_TTL_MS) {
				this.processedIncomingRequests.delete(key);
			}
		}

		if (this.processedIncomingRequests.size <= MAX_TRACKED_INBOUND_REQUESTS) {
			return;
		}

		const oldestEntries = [...this.processedIncomingRequests.entries()].sort(
			(left, right) => left[1] - right[1],
		);
		for (const [key] of oldestEntries.slice(
			0,
			this.processedIncomingRequests.size - MAX_TRACKED_INBOUND_REQUESTS,
		)) {
			this.processedIncomingRequests.delete(key);
		}
	}

	private async advanceCheckpoint(
		conversationId: string | undefined,
		sentAtNs: bigint | undefined,
		messageId: string | undefined,
	): Promise<void> {
		if (!this.syncState || !conversationId || sentAtNs === undefined || !messageId) {
			return;
		}
		await this.syncState.advance(conversationId, {
			sentAtNs,
			messageId,
		});
	}
}

function buildIncomingRequestKey(senderInboxId: string, request: ProtocolMessage): string {
	return `${senderInboxId}:${request.method}:${String(request.id)}`;
}

function buildMessageQuery(checkpoint: XmtpConversationCheckpoint | null): {
	sentAfterNs?: bigint;
	sortBy: number;
	direction: number;
} {
	if (!checkpoint) {
		return {
			sortBy: MESSAGE_SORT_BY_SENT_AT,
			direction: SORT_DIRECTION_ASCENDING,
		};
	}

	const floor = BigInt(checkpoint.lastSentAtNs);
	return {
		sentAfterNs: floor > 0n ? floor - 1n : floor,
		sortBy: MESSAGE_SORT_BY_SENT_AT,
		direction: SORT_DIRECTION_ASCENDING,
	};
}

function isMessageAlreadyCheckpointed(
	checkpoint: XmtpConversationCheckpoint | null,
	message: DecodedMessage,
): boolean {
	if (!checkpoint) {
		return false;
	}

	const checkpointNs = BigInt(checkpoint.lastSentAtNs);
	if (message.sentAtNs < checkpointNs) {
		return true;
	}
	if (message.sentAtNs > checkpointNs) {
		return false;
	}
	return checkpoint.lastMessageIds.includes(message.id);
}

/**
 * Detect the XMTP "10/10 installations" error that occurs when
 * Client.create() tries to register a new installation but the inbox
 * has already reached its maximum.
 */
function isInstallationLimitError(error: unknown): boolean {
	return /registered \d+\/\d+ installations/i.test(toErrorMessage(error));
}

/**
 * Revoke ALL installations for a signer's inbox using static SDK methods.
 * This does not require a Client instance, so it works even when
 * Client.create() fails due to the installation limit.
 */
async function revokeAllInstallationsStatic(signer: Signer): Promise<void> {
	const identifier = await signer.getIdentifier();
	const inboxId = await getInboxIdForIdentifier(identifier, "production");
	if (!inboxId) {
		return;
	}

	const states = await Client.fetchInboxStates([inboxId], "production");
	const installations = states[0]?.installations;
	if (!installations || installations.length === 0) {
		return;
	}

	const installationBytes = installations.map((i) => i.bytes);
	await Client.revokeInstallations(signer, inboxId, installationBytes, "production");
}
