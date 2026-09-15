import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { TapAppRegistry } from "../../../src/app/registry.js";
import {
	AttentionPaymentRequiredError,
	TransportError,
	ValidationError,
} from "../../../src/common/errors.js";
import type { TrustedAgentsConfig } from "../../../src/config/types.js";
import {
	buildConnectionRequest,
	buildConnectionResult,
	buildPermissionsUpdate,
	deriveConnectionResultId,
} from "../../../src/connection/handshake.js";
import { generateInvite } from "../../../src/connection/invite.js";
import type { IConversationLogger } from "../../../src/conversation/logger.js";
import type { IAgentResolver } from "../../../src/identity/resolver.js";
import type { ResolvedAgent } from "../../../src/identity/types.js";
import { createEmptyPermissionState, createGrantSet } from "../../../src/permissions/types.js";
import { signPostageCredit, verifyPostageCredit } from "../../../src/postage/certificate.js";
import { FilePostageLedger, postagePeerKey } from "../../../src/postage/ledger.js";
import { buildPostageTopupPayload } from "../../../src/postage/payload.js";
import type {
	MessageSendParams,
	PostageStamp,
	TrustedAgentMetadata,
} from "../../../src/protocol/types.js";
import {
	buildOutgoingActionRequest,
	buildOutgoingActionResult,
	buildOutgoingMessageRequest,
	parseTransferActionRequest,
	parseTransferActionResponse,
} from "../../../src/runtime/index.js";
import type { FileRequestJournal } from "../../../src/runtime/request-journal.js";
import { FileRequestJournal as FileRequestJournalImpl } from "../../../src/runtime/request-journal.js";
import { TapMessagingService } from "../../../src/runtime/service.js";
import {
	parseSchedulingActionRequest,
	parseSchedulingActionResponse,
} from "../../../src/scheduling/index.js";
import type {
	ProtocolMessage,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "../../../src/transport/interface.js";
import type { TransportSendOptions } from "../../../src/transport/types.js";
import type { ITrustStore } from "../../../src/trust/trust-store.js";
import type { Contact } from "../../../src/trust/types.js";
import {
	ALICE,
	ALICE_SIGNING_PROVIDER,
	BOB,
	BOB_SIGNING_PROVIDER,
} from "../../fixtures/test-keys.js";
import { useTempDirs } from "../../helpers/temp-dir.js";

const { track: trackTempDir } = useTempDirs();

class FakeTransport implements TransportProvider {
	public startCalls = 0;
	public stopCalls = 0;
	public reconcileCalls = 0;
	public handlers: TransportHandlers = {};

	constructor(
		private readonly options: {
			reconcileProcessed?: number;
			failOnStart?: boolean;
			sendError?: Error;
		} = {},
	) {}

	public readonly sentMessages: Array<{
		peerId: number;
		message: ProtocolMessage;
		options?: TransportSendOptions;
	}> = [];

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async start(): Promise<void> {
		this.startCalls += 1;
		if (this.options.failOnStart) {
			throw new Error("transport start failed");
		}
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
	}

	async isReachable(): Promise<boolean> {
		return true;
	}

	async reconcile() {
		this.reconcileCalls += 1;
		return {
			synced: true as const,
			processed: this.options.reconcileProcessed ?? 0,
		};
	}

	async send(
		peerId: number,
		message: ProtocolMessage,
		options?: TransportSendOptions,
	): Promise<TransportReceipt> {
		this.sentMessages.push({
			peerId,
			message,
			...(options ? { options } : {}),
		});
		if (this.options.sendError) {
			throw this.options.sendError;
		}
		return {
			received: true,
			requestId: String(message.id),
			status: options?.waitForAck === false ? "published" : "received",
			receivedAt: "2026-03-07T00:00:00.000Z",
		};
	}
}

const PEER_AGENT: ResolvedAgent = {
	agentId: 10,
	chain: "eip155:8453",
	ownerAddress: BOB.address,
	agentAddress: BOB.address,
	capabilities: ["chat", "payments"],
	registrationFile: {
		type: "eip-8004-registration-v1",
		name: "Bob",
		description: "Peer agent",
		services: [{ name: "xmtp", endpoint: BOB.address }],
		trustedAgentProtocol: {
			version: "1.0",
			agentAddress: BOB.address,
			capabilities: ["chat", "payments"],
		},
	},
	resolvedAt: "2026-03-07T00:00:00.000Z",
};

function cloneContact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

async function submitConnectionRequest(
	transport: FakeTransport,
	senderInboxId: string,
	agentId = 1,
): Promise<ProtocolMessage> {
	const { invite } = await generateInvite({
		agentId,
		chain: "eip155:8453",
		signingProvider: ALICE_SIGNING_PROVIDER,
		expirySeconds: 3600,
	});

	const request = buildConnectionRequest({
		from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
		invite,
		timestamp: "2026-03-08T00:00:00.000Z",
	});

	await expect(
		transport.handlers.onRequest?.({
			from: PEER_AGENT.agentId,
			senderInboxId,
			message: request,
		}),
	).resolves.toEqual({ status: "queued" });

	return request;
}

function makeActiveContact(connectionId: string): Contact {
	return {
		connectionId,
		peerAgentId: PEER_AGENT.agentId,
		peerChain: PEER_AGENT.chain,
		peerOwnerAddress: PEER_AGENT.ownerAddress,
		peerDisplayName: PEER_AGENT.registrationFile.name,
		peerAgentAddress: PEER_AGENT.agentAddress,
		permissions: createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
		establishedAt: "2026-03-08T00:00:00.000Z",
		lastContactAt: "2026-03-08T00:00:00.000Z",
		status: "active",
	};
}

function createMemoryTrustStore(initialContacts: Contact[] = []): ITrustStore {
	const contacts = new Map(
		initialContacts.map((contact) => [contact.connectionId, cloneContact(contact)]),
	);
	return {
		getContacts: async () => [...contacts.values()].map((contact) => cloneContact(contact)),
		getContact: async (connectionId: string) => cloneContact(contacts.get(connectionId) ?? null),
		findByAgentAddress: async (address: `0x${string}`, chain?: string) =>
			cloneContact(
				[...contacts.values()].find(
					(contact) =>
						contact.peerAgentAddress.toLowerCase() === address.toLowerCase() &&
						(chain === undefined || contact.peerChain === chain),
				) ?? null,
			),
		findByAgentId: async (agentId: number, chain: string) =>
			cloneContact(
				[...contacts.values()].find(
					(contact) => contact.peerAgentId === agentId && contact.peerChain === chain,
				) ?? null,
			),
		addContact: async (contact: Contact) => {
			contacts.set(contact.connectionId, cloneContact(contact));
		},
		updateContact: async (connectionId: string, updates: Partial<Contact>) => {
			const existing = contacts.get(connectionId);
			if (!existing) {
				return;
			}
			contacts.set(connectionId, cloneContact({ ...existing, ...updates }));
		},
		removeContact: async (connectionId: string) => {
			contacts.delete(connectionId);
		},
		touchContact: async (connectionId: string) => {
			const existing = contacts.get(connectionId);
			if (!existing) {
				return;
			}
			contacts.set(connectionId, {
				...cloneContact(existing),
				lastContactAt: "2026-03-08T00:00:00.000Z",
			});
		},
	};
}

function createStaticResolver(agent: ResolvedAgent = PEER_AGENT): IAgentResolver {
	return {
		resolve: async (_agentId: number, _chain: string) => agent,
		resolveWithCache: async (_agentId: number, _chain: string, _maxAgeMs?: number) => agent,
	};
}

function createNoopConversationLogger(): IConversationLogger {
	return {
		logMessage: async (_conversationId, _message, _context) => {},
		getConversation: async (_conversationId) => null,
		listConversations: async (_filter) => [],
		generateTranscript: async (_conversationId) => "",
		markRead: async (_conversationId, _readAt) => {},
	};
}

async function createService(
	options: {
		reconcileProcessed?: number;
		failOnStart?: boolean;
		sendError?: Error;
	} = {},
	dependencies: {
		trustStore?: ITrustStore;
		resolver?: IAgentResolver;
		transport?: FakeTransport;
		hooks?: ConstructorParameters<typeof TapMessagingService>[1]["hooks"];
		serviceOptions?: Omit<
			ConstructorParameters<typeof TapMessagingService>[1],
			"hooks" | "ownerLabel"
		>;
		configOverrides?: Partial<TrustedAgentsConfig>;
	} = {},
): Promise<{
	service: TapMessagingService;
	transport: FakeTransport;
	requestJournal: FileRequestJournal;
	dataDir: string;
}> {
	const dataDir = await mkdtemp(join(tmpdir(), "tap-service-"));
	trackTempDir(dataDir);

	const config: TrustedAgentsConfig = {
		agentId: 1,
		chain: "eip155:8453",
		ows: { wallet: "test", apiKey: "ows_key_test" },
		dataDir,
		chains: {},
		inviteExpirySeconds: 3600,
		resolveCacheTtlMs: 60_000,
		resolveCacheMaxEntries: 128,
		...(dependencies.configOverrides ?? {}),
	};
	const requestJournal = new FileRequestJournalImpl(dataDir);
	const transport = dependencies.transport ?? new FakeTransport(options);
	const appRegistry = new TapAppRegistry(dataDir);
	const service = new TapMessagingService(
		{
			config,
			signingProvider: ALICE_SIGNING_PROVIDER,
			trustStore: dependencies.trustStore ?? createMemoryTrustStore(),
			resolver: dependencies.resolver ?? createStaticResolver(),
			conversationLogger: createNoopConversationLogger(),
			requestJournal,
			transport,
			appRegistry,
		},
		{
			ownerLabel: "tap:test-service",
			hooks: dependencies.hooks,
			...(dependencies.serviceOptions ?? {}),
		},
	);

	return { service, transport, requestJournal, dataDir };
}

describe("TapMessagingService", () => {
	it("uses a scoped transport session for syncOnce", async () => {
		const { service, transport } = await createService({ reconcileProcessed: 3 });

		const report = await service.syncOnce();

		expect(report).toEqual({
			synced: true,
			processed: 3,
			pendingRequests: [],
			pendingDeliveries: [],
		});
		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(1);
		expect(transport.reconcileCalls).toBe(1);

		const status = await service.getStatus();
		expect(status.running).toBe(false);
		expect(status.lock).toBeNull();
		expect(status.lastSyncAt).toBeDefined();
		expect(transport.handlers.onRequest).toBeTypeOf("function");
		expect(transport.handlers.onResult).toBeTypeOf("function");
	});

	it("keeps the transport session open across start and stop", async () => {
		const { service, transport } = await createService({ reconcileProcessed: 1 });

		await service.start();

		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(0);
		expect(transport.reconcileCalls).toBe(1);

		const runningStatus = await service.getStatus();
		expect(runningStatus.running).toBe(true);
		expect(runningStatus.lock).toEqual(
			expect.objectContaining({
				owner: "tap:test-service",
			}),
		);

		await service.syncOnce();
		expect(transport.startCalls).toBe(1);
		expect(transport.stopCalls).toBe(0);
		expect(transport.reconcileCalls).toBe(2);

		await service.stop();

		const stoppedStatus = await service.getStatus();
		expect(stoppedStatus.running).toBe(false);
		expect(stoppedStatus.lock).toBeNull();
		expect(transport.stopCalls).toBe(1);
	});

	it("releases the ownership lock if start fails", async () => {
		const { service } = await createService({ failOnStart: true });

		await expect(service.start()).rejects.toThrow("transport start failed");

		const status = await service.getStatus();
		expect(status.running).toBe(false);
		expect(status.lock).toBeNull();
	});

	it("does not write the contact when the connection/result send fails (ordering fix R2)", async () => {
		// Ordering fix: the contact must NOT be written until the outbound
		// connection/result is confirmed delivered. If the send fails, the contact
		// stays unwritten and the journal entry stays pending so the retry pipeline
		// can resend it and write the contact on success.
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport({
			sendError: new TransportError("Response timeout for message result-1"),
		});
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-manual-resolve");

		await sleep(50);

		// Contact must NOT be written — send failed, so ordering requires we defer.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();

		// The connection/result was attempted (sent) but failed.
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("connection/result");

		// Journal entry is pending — retry pipeline will pick it up.
		expect(
			await requestJournal.getByRequestId(String(transport.sentMessages[0]!.message.id)),
		).toEqual(
			expect.objectContaining({
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				status: "pending",
				correlationId: String(request.id),
			}),
		);

		await service.stop();
	});

	it("writes the contact only after the connection/result send succeeds (retry path)", async () => {
		// Ordering fix: the contact is not written on first attempt (which fails),
		// then is written on the successful retry via retryPendingConnectionResults.
		const trustStore = createMemoryTrustStore();

		class FlakyConnectionResultTransport extends FakeTransport {
			private failConnectionResultOnce = true;

			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({
					peerId,
					message,
				});
				if (message.method === "connection/result" && this.failConnectionResultOnce) {
					this.failConnectionResultOnce = false;
					throw new TransportError("temporary connection result send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakyConnectionResultTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-connection-result-retry");

		await sleep(50);

		const firstConnectionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "connection/result",
		);
		expect(firstConnectionResult).toBeDefined();

		// Contact NOT yet written — first send failed, ordering prevents premature write.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();

		// Journal entry is still pending — retry pipeline will pick it up.
		expect(
			(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id)))?.status,
		).toBe("pending");

		// syncOnce triggers retryPendingConnectionResults: second send succeeds
		// and the contact is written as active.
		await service.syncOnce();

		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(2);
		expect(await requestJournal.getByRequestId(String(firstConnectionResult!.message.id))).toEqual(
			expect.objectContaining({
				status: "completed",
				correlationId: String(request.id),
			}),
		);
		// Contact now written after successful retry.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);

		await service.stop();
	});

	it("retries pending inbound connection requests during maintenance when contact write fails", async () => {
		// Under the new ordering, addContact is called AFTER the send succeeds.
		// If addContact throws, the inbound journal entry stays pending (enqueue
		// swallows the error). The outbound connection/result entry is already
		// completed (the send succeeded). On next syncOnce, the inbound is
		// retried: a second connection/result is sent and addContact succeeds.
		const baseTrustStore = createMemoryTrustStore();
		let failAddContactOnce = true;
		const trustStore: ITrustStore = {
			...baseTrustStore,
			addContact: async (contact) => {
				if (failAddContactOnce) {
					failAddContactOnce = false;
					throw new Error("temporary trust store failure");
				}
				await baseTrustStore.addContact(contact);
			},
		};
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-retry-connection-request");

		await sleep(50);

		// Contact not yet written (addContact threw).
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();

		// Inbound is still pending (enqueue swallowed the addContact error).
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				direction: "inbound",
				kind: "request",
				method: "connection/request",
				status: "pending",
			}),
		);

		// Unlike the old design, the connection/result WAS sent (send happens
		// before addContact in the new ordering).
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(1);

		// syncOnce retries the pending inbound: second connection/result sent,
		// addContact now succeeds.
		const report = await service.syncOnce();

		expect(report.processed).toBeGreaterThanOrEqual(1);
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		// Second connection/result sent during retry.
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "connection/result"),
		).toHaveLength(2);

		await service.stop();
	});

	it("does not report connection result delivery failure when retry persistence fails", async () => {
		// When journal persistence fails, the connection/result is still sent via
		// the fallback path. However, because there is no journal entry to confirm
		// delivery, the contact is NOT written (ordering fix). The error is logged
		// as a persistence warning, not a delivery failure.
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const logs: string[] = [];
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: {
					log: (level, message) => {
						logs.push(`${level}:${message}`);
					},
				},
			},
		);
		const originalPutOutbound = requestJournal.putOutbound.bind(requestJournal);
		vi.spyOn(requestJournal, "putOutbound").mockImplementation(async (entry) => {
			if (entry.kind === "result" && entry.method === "connection/result") {
				throw new Error("disk full");
			}
			return await originalPutOutbound(entry);
		});

		await service.start();
		await submitConnectionRequest(transport, "peer-inbox-connection-result-persist-fail");

		await sleep(50);

		const sentResult = transport.sentMessages.find(
			(entry) => entry.message.method === "connection/result",
		);
		// The connection/result was still sent via the fallback path.
		expect(sentResult).toBeDefined();

		// Contact NOT written — no journal entry means we cannot confirm delivery,
		// so the ordering fix requires we skip the contact write.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();

		// No journal entry exists (persist failed).
		expect(await requestJournal.getByRequestId(String(sentResult!.message.id))).toBeNull();

		// The persistence error is logged, but the send itself is not a delivery failure.
		expect(
			logs.some((entry) =>
				entry.includes("Failed to persist retry metadata for connection result"),
			),
		).toBe(true);
		expect(logs.some((entry) => entry.includes("Failed to deliver connection result"))).toBe(false);

		await service.stop();
	});

	it("rejects inbound connection requests whose invite targets a different agent", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();
		await submitConnectionRequest(transport, "peer-inbox-connection-retry", 2);

		await sleep(50);
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		const rejection = transport.sentMessages[0]?.message;
		expect(rejection?.method).toBe("connection/result");
		expect((rejection?.params as { status?: string; reason?: string } | undefined)?.status).toBe(
			"rejected",
		);
		expect((rejection?.params as { reason?: string } | undefined)?.reason).toContain(
			"Invite does not target the local agent",
		);

		await service.stop();
	});

	it("rejects self-invites before starting transport", async () => {
		const selfAgent: ResolvedAgent = {
			...PEER_AGENT,
			agentId: 1,
			chain: "eip155:8453",
			registrationFile: {
				...PEER_AGENT.registrationFile,
				name: "Alice",
			},
		};
		const { url: selfInviteUrl } = await generateInvite({
			agentId: 1,
			chain: "eip155:8453",
			signingProvider: ALICE_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});
		const { service, transport } = await createService(
			{},
			{
				resolver: createStaticResolver(selfAgent),
			},
		);

		await expect(service.connect({ inviteUrl: selfInviteUrl })).rejects.toThrow(ValidationError);
		await expect(service.connect({ inviteUrl: selfInviteUrl })).rejects.toThrow(
			"Cannot connect to your own invite",
		);
		expect(transport.startCalls).toBe(0);
		expect(transport.sentMessages).toHaveLength(0);
	});

	it("propagates transport send errors to the caller (spec §3.1 send-failure path)", async () => {
		// Per spec §3.1: on send failure, remove the waiter, leave the connecting
		// contact in place, and propagate the error to the caller.
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});
		const transport = new FakeTransport({
			sendError: new TransportError("network error"),
		});
		const trustStore = createMemoryTrustStore();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		// Send failures propagate to the caller.
		await expect(service.connect({ inviteUrl: url })).rejects.toThrow(TransportError);

		// The connecting contact is still in place (sticky per spec §1.1).
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("connecting");
		expect(contact?.peerAgentId).toBe(PEER_AGENT.agentId);
		expect(contact?.expiresAt).toBeDefined();
	});

	it("connectInternal upserts a connecting contact before sending (spec §1.1)", async () => {
		// The connecting contact must be written before any wire traffic so that
		// a process restart or send failure still leaves durable "I asked" state.
		const { url, invite } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		let contactAtSendTime: Contact | null = null;
		class ObservingTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				// Capture trust store state at the moment send is called.
				contactAtSendTime = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
				return await super.send(peerId, message);
			}
		}

		const transport = new ObservingTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService({}, { transport, trustStore });

		// Use waitMs: 0 (fire-and-forget) so the test does not block for 30 seconds
		// waiting for a result that will never arrive from this fake transport.
		await service.connect({ inviteUrl: url, waitMs: 0 });

		// The contact was already in the trust store when send was called.
		expect(contactAtSendTime).not.toBeNull();
		expect(contactAtSendTime?.status).toBe("connecting");
		expect(contactAtSendTime?.peerAgentId).toBe(PEER_AGENT.agentId);

		// expiresAt matches the invite's expires field.
		const expectedExpiresAt = new Date(invite.expires * 1000).toISOString();
		expect(contactAtSendTime?.expiresAt).toBe(expectedExpiresAt);
	});

	it("returns active when the peer accepts during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		class ImmediateAcceptTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-immediate",
						message: buildConnectionResult({
							requestId: String(message.id),
							from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
							status: "accepted",
							timestamp: "2026-03-08T00:00:01.000Z",
						}),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new ImmediateAcceptTransport();
		const trustStore = createMemoryTrustStore();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		const result = await service.connect({ inviteUrl: url });
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);

		expect(result.status).toBe("active");
		expect(result.connectionId).toBe(contact?.connectionId);
		expect(contact?.status).toBe("active");
		// expiresAt is cleared when contact transitions to active.
		expect(contact?.expiresAt).toBeUndefined();
		expect(transport.sentMessages.map((entry) => entry.message.method)).toContain(
			"connection/request",
		);
	});

	it("fails when the peer rejects during the same transport session", async () => {
		const { url } = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});

		class ImmediateRejectTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "connection/request") {
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-rejected",
						message: buildConnectionResult({
							requestId: String(message.id),
							from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
							status: "rejected",
							reason: "no thanks",
							timestamp: "2026-03-08T00:00:01.000Z",
						}),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new ImmediateRejectTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await expect(service.connect({ inviteUrl: url })).rejects.toThrow(
			"Connection rejected by Bob (#10)",
		);
		// The connecting contact is removed when a rejection is received.
		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		// The outbound journal entry is now persisted BEFORE send() (so that a
		// receipt timeout leaves a retryable record). When the rejection arrives
		// synchronously during send(), the rejection handler correlates against
		// the already-written entry and marks it completed.
		const journalEntry = await requestJournal.getByRequestId(
			String(transport.sentMessages[0]!.message.id),
		);
		expect(journalEntry?.status).toBe("completed");
	});

	it("ignores unsolicited connection results that do not match a pending outbound request", async () => {
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const staleRejectedResult = buildConnectionResult({
			requestId: "req-stale-1",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			status: "rejected",
			reason: "stale rejection",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-stale-result",
				message: staleRejectedResult,
			}),
		).resolves.toEqual({ status: "duplicate" });

		expect(await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain)).toBeNull();
		expect(await requestJournal.getByRequestId("req-stale-1")).toBeNull();
	});

	it("processes queued outbound commands during syncOnce", async () => {
		const activeContact = makeActiveContact("conn-message-1");
		const { service, transport, requestJournal } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([activeContact]),
			},
		);
		// Write a queued journal entry directly (as runOrQueueTapCommand would do).
		const requestId = `test-msg-${Date.now()}`;
		await requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:command:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: "command/send-message",
			peerAgentId: 0,
			status: "queued",
			metadata: {
				commandType: "send-message",
				commandPayload: {
					peer: activeContact.peerDisplayName,
					text: "queued hello",
					scope: "general-chat",
				},
				commandRequestedBy: "test",
			},
		});

		const report = await service.syncOnce();

		expect(report.processed).toBe(1);
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("message/send");
		const entry = await requestJournal.getByRequestId(requestId);
		expect(entry?.status).toBe("completed");
		expect((entry?.metadata as Record<string, unknown>)?.commandResult).toEqual(
			expect.objectContaining({ status: "completed" }),
		);
	});

	it("processes queued connect commands during syncOnce", async () => {
		const { service, transport, requestJournal } = await createService();
		const invite = await generateInvite({
			agentId: PEER_AGENT.agentId,
			chain: PEER_AGENT.chain,
			signingProvider: BOB_SIGNING_PROVIDER,
			expirySeconds: 3600,
		});
		const requestId = `test-connect-${Date.now()}`;
		await requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:command:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: "command/connect",
			peerAgentId: 0,
			status: "queued",
			metadata: {
				commandType: "connect",
				commandPayload: { inviteUrl: invite.url },
				commandRequestedBy: "test",
			},
		});

		const report = await service.syncOnce();

		expect(report.processed).toBe(1);
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("connection/request");
		const entry = await requestJournal.getByRequestId(requestId);
		expect(entry?.status).toBe("completed");
		expect((entry?.metadata as Record<string, unknown>)?.commandResult).toEqual(
			expect.objectContaining({
				status: "completed",
				result: expect.objectContaining({ status: "pending" }),
			}),
		);
	});

	it("polls queued outbound commands while the listener is running", async () => {
		const activeContact = makeActiveContact("conn-grants-1");
		const { service, transport, requestJournal } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([activeContact]),
				serviceOptions: {
					outboxPollIntervalMs: 25,
				},
			},
		);

		await service.start();
		const requestId = `test-grants-${Date.now()}`;
		await requestJournal.putOutbound({
			requestId,
			requestKey: `outbound:command:${requestId}`,
			direction: "outbound",
			kind: "request",
			method: "command/publish-grant-set",
			peerAgentId: 0,
			status: "queued",
			metadata: {
				commandType: "publish-grant-set",
				commandPayload: {
					peer: activeContact.peerDisplayName,
					grantSet: {
						version: "tap-grants/v1",
						updatedAt: "2026-03-08T00:00:00.000Z",
						grants: [{ grantId: "queued-chat", scope: "general-chat" }],
					},
					note: "queued publish",
				},
				commandRequestedBy: "test",
			},
		});

		await sleep(150);
		await service.stop();

		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]?.message.method).toBe("permissions/update");
		const entry = await requestJournal.getByRequestId(requestId);
		expect(entry?.status).toBe("completed");
		expect((entry?.metadata as Record<string, unknown>)?.commandResult).toEqual(
			expect.objectContaining({ status: "completed" }),
		);
	});

	it("only updates local grants after permissions/update is durably delivered", async () => {
		const activeContact = makeActiveContact("conn-grants-durable");
		const trustStore = createMemoryTrustStore([activeContact]);
		const grantSet = createGrantSet([{ grantId: "durable-chat", scope: "general-chat" }]);

		class FlakyPermissionsTransport extends FakeTransport {
			private failOnce = true;

			override async send(
				peerId: number,
				message: ProtocolMessage,
				options?: TransportSendOptions,
			): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message, ...(options ? { options } : {}) });
				if (message.method === "permissions/update" && this.failOnce) {
					this.failOnce = false;
					throw new TransportError("temporary permissions update send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: options?.waitForAck === false ? "published" : "received",
					receivedAt: "2026-03-07T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakyPermissionsTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		await expect(
			service.publishGrantSet(activeContact.peerDisplayName, grantSet, "durable publish"),
		).rejects.toThrow("temporary permissions update send failure");

		const afterFailure = await trustStore.getContact(activeContact.connectionId);
		expect(afterFailure?.permissions.grantedByMe.grants).toEqual([]);

		const pendingEntry = (await requestJournal.listPending("outbound")).find(
			(entry) => entry.method === "permissions/update",
		);
		expect(pendingEntry).toBeDefined();

		const report = await service.syncOnce();
		expect(report.pendingDeliveries).toEqual([]);

		const afterRetry = await trustStore.getContact(activeContact.connectionId);
		expect(afterRetry?.permissions.grantedByMe.grants).toEqual(
			expect.arrayContaining([expect.objectContaining({ grantId: "durable-chat" })]),
		);

		await service.stop();
	});

	it("captures an action result that arrives before requestFunds finishes sending", async () => {
		const activeContact = makeActiveContact("conn-request-funds-fast");

		class ImmediateActionResultTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/request") {
					const request = parseTransferActionRequest(message);
					if (!request) {
						throw new Error("expected transfer request payload");
					}
					await this.handlers.onResult?.({
						from: peerId,
						senderInboxId: "peer-inbox-fast-result",
						message: buildOutgoingActionResult(
							activeContact,
							String(message.id),
							"Transfer complete",
							{
								type: "transfer/response",
								requestId: String(message.id),
								actionId: request.actionId,
								asset: request.asset,
								amount: request.amount,
								chain: request.chain,
								toAddress: request.toAddress,
								status: "completed",
								txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							},
							"transfer/request",
							"completed",
						),
					});
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const { service } = await createService(
			{},
			{
				transport: new ImmediateActionResultTransport(),
				trustStore: createMemoryTrustStore([activeContact]),
			},
		);

		const result = await service.requestFunds({
			peer: activeContact.peerDisplayName,
			asset: "native",
			amount: "0.1",
			chain: "eip155:8453",
			toAddress: ALICE.address,
		});

		expect(result.asyncResult).toEqual(
			expect.objectContaining({
				status: "completed",
				actionId: result.actionId,
			}),
		);
	});

	it("retries pending action result delivery during maintenance", async () => {
		const contact = makeActiveContact("conn-transfer-retry");

		class FlakyActionResultTransport extends FakeTransport {
			private failActionResultOnce = true;

			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/result" && this.failActionResultOnce) {
					this.failActionResultOnce = false;
					throw new TransportError("temporary action result send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakyActionResultTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: {
					approveTransfer: async () => true,
					executeTransfer: vi.fn(async () => ({
						txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
					})),
				},
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-retry-1",
				asset: "native",
				amount: "0.2",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-retry",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		const firstActionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "action/result",
		);
		expect(firstActionResult).toBeDefined();
		expect(
			(await requestJournal.getByRequestId(String(firstActionResult!.message.id)))?.status,
		).toBe("pending");

		await service.syncOnce();

		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "action/result"),
		).toHaveLength(2);
		expect(
			(await requestJournal.getByRequestId(String(firstActionResult!.message.id)))?.status,
		).toBe("completed");

		await service.stop();
	});

	it("auto-approves grant-covered transfer when no approveTransfer hook is registered", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-manual-transfer-1"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "manual-transfer-approval",
							scope: "transfer/request",
							constraints: {
								asset: "native",
								chain: "eip155:8453",
								toAddress: ALICE.address,
								maxAmount: "1",
							},
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const,
		}));
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "manual-transfer-1",
				asset: "native",
				amount: "0.1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-manual-transfer",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		// Grant-covered transfer should be auto-approved without needing resolvePending
		expect(await service.listPendingRequests()).toEqual([]);
		expect(executeTransfer).toHaveBeenCalledOnce();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");

		const actionResult = transport.sentMessages.find(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResult).toBeDefined();
		expect(parseTransferActionResponse(actionResult!.message)?.status).toBe("completed");

		await service.stop();
	});

	it("marks executed transfer requests completed even if retry metadata persistence fails", async () => {
		const contact = makeActiveContact("conn-transfer-journal-fail");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
		}));
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer: async () => true, executeTransfer },
			},
		);
		const originalPutOutbound = requestJournal.putOutbound.bind(requestJournal);
		vi.spyOn(requestJournal, "putOutbound").mockImplementation(async (entry) => {
			if (entry.kind === "result" && entry.method === "action/result") {
				throw new Error("disk full");
			}
			return await originalPutOutbound(entry);
		});

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-journal-fail-1",
				asset: "native",
				amount: "0.5",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-journal-fail",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(executeTransfer).toHaveBeenCalledOnce();
		expect((await requestJournal.getByRequestId(String(request.id)))?.status).toBe("completed");
		expect(
			transport.sentMessages.filter((entry) => entry.message.method === "action/result"),
		).toHaveLength(1);
		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-journal-fail",
				message: request,
			}),
		).resolves.toEqual({ status: "duplicate" });
		expect(executeTransfer).toHaveBeenCalledOnce();

		await service.stop();
	});

	it("rejects transfer without matching grants when no approveTransfer hook is registered", async () => {
		const contact = makeActiveContact("conn-transfer-no-hook");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-action-no-hook",
				asset: "native",
				amount: "0.1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-no-hook",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect(executeTransfer).not.toHaveBeenCalled();
		const result = parseTransferActionResponse(transport.sentMessages[0]!.message);
		expect(transport.sentMessages[0]?.message.method).toBe("action/result");
		expect(result?.status).toBe("rejected");
	});

	it("leaves transfer pending when approveTransfer hook returns null and no grants match", async () => {
		const contact = makeActiveContact("conn-transfer-hook-null");
		const approveTransfer = vi.fn(async () => null);
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer, executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-hook-null-1",
				asset: "native",
				amount: "0.1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-hook-null",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(approveTransfer).toHaveBeenCalledOnce();
		expect(executeTransfer).not.toHaveBeenCalled();
		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(request.id),
				method: "action/request",
				peerAgentId: PEER_AGENT.agentId,
			}),
		]);
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(0);

		await service.stop();
	});

	it("allows hook-based transfer approval without matching grants", async () => {
		const contact = makeActiveContact("conn-transfer-2");
		const executeTransfer = vi.fn(async () => ({
			txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
		}));
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { approveTransfer: async () => true, executeTransfer },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Please send funds",
			{
				type: "transfer/request",
				actionId: "transfer-action-2",
				asset: "usdc",
				amount: "1",
				chain: "eip155:8453",
				toAddress: ALICE.address,
			},
			"transfer/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-3",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await service.stop();

		expect(executeTransfer).toHaveBeenCalledOnce();
		expect(transport.sentMessages[0]?.message.method).toBe("action/result");
		expect(parseTransferActionResponse(transport.sentMessages[0]!.message)?.status).toBe(
			"completed",
		);
	});

	it("captures fast transfer results that arrive before the request call finishes", async () => {
		const contact = makeActiveContact("conn-request-funds-fast");

		class FastResultTransport extends FakeTransport {
			override async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message });
				if (message.method === "action/request") {
					const request = parseTransferActionRequest(message);
					if (request) {
						await this.handlers.onResult?.({
							from: peerId,
							senderInboxId: "peer-inbox-fast-result",
							message: buildOutgoingActionResult(
								contact,
								String(message.id),
								"Transfer completed",
								{
									type: "transfer/response",
									actionId: request.actionId,
									asset: request.asset,
									amount: request.amount,
									chain: request.chain,
									toAddress: request.toAddress,
									status: "completed",
									txHash:
										"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
								},
								"transfer/request",
								"completed",
							),
						});
					}
				}

				return {
					received: true,
					requestId: String(message.id),
					status: "received",
					receivedAt: "2026-03-08T00:00:00.000Z",
				};
			}
		}

		const transport = new FastResultTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		const result = await service.requestFunds({
			peer: contact.peerDisplayName,
			asset: "native",
			amount: "0.1",
			chain: "eip155:8453",
			toAddress: ALICE.address,
		});

		expect(result.asyncResult).toEqual(
			expect.objectContaining({
				status: "completed",
				actionId: expect.any(String),
			}),
		);
	});

	it("rejects an unsolicited connection result when no outbound request exists (§5.3 security gate)", async () => {
		// REGRESSION TEST for a critical security issue: before this fix,
		// handleConnectionResult would create a fresh active contact for ANY
		// accepted result that passed XMTP transport sender verification. That
		// meant a remote agent who knew another agent's XMTP inbox ID could
		// self-establish trust by sending an unsolicited `connection/result`,
		// because identity verification proves the sender IS who they claim to
		// be — not that we CONSENTED to connect to them.
		//
		// The fix requires a matching outbound connection/request in the local
		// journal before accepting any "missing contact" result. Without that
		// proof of initiation, the result is rejected as unsolicited.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();

		const unknownAgentId = 999;
		const unknownChain = PEER_AGENT.chain;
		const unknownAgentResolved: ResolvedAgent = {
			agentId: unknownAgentId,
			chain: unknownChain,
			ownerAddress: ALICE.address,
			agentAddress: ALICE.address,
			capabilities: ["chat"],
			registrationFile: {
				type: "eip-8004-registration-v1",
				name: "Unknown Agent",
				description: "Attacker claiming to be a newly discovered peer",
				services: [{ name: "xmtp", endpoint: ALICE.address }],
				trustedAgentProtocol: {
					version: "1.0",
					agentAddress: ALICE.address,
					capabilities: ["chat"],
				},
			},
			resolvedAt: "2026-03-08T00:00:00.000Z",
		};
		const resolver = createStaticResolver(unknownAgentResolved);

		const { service, requestJournal } = await createService(
			{},
			{ transport, trustStore, resolver },
		);
		await service.start();

		// No outbound connection/request exists in the journal — we never asked
		// to connect to this agent.
		expect(await requestJournal.getByRequestId("req-unsolicited")).toBeNull();

		const acceptedResult = buildConnectionResult({
			requestId: "req-unsolicited",
			from: { agentId: unknownAgentId, chain: unknownChain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: unknownAgentId,
				senderInboxId: "peer-inbox-attacker",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "duplicate" });

		// Critical assertion: NO contact was created.
		expect(await trustStore.findByAgentId(unknownAgentId, unknownChain)).toBeNull();
		expect(await trustStore.getContacts()).toHaveLength(0);

		await service.stop();
	});

	it("accepts a connection result for partial-wipe recovery when outbound journal entry exists (§5.3 recovery path)", async () => {
		// Legitimate recovery scenario: the user previously ran `tap connect`
		// (creating an outbound connection/request journal entry) but then
		// lost or deleted their contacts.json. The journal entry is proof of
		// initiation, so when the result arrives the handler should rebuild
		// the contact via on-chain resolution.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();

		const peerAgentId = 999;
		const peerChain = PEER_AGENT.chain;
		const peerResolved: ResolvedAgent = {
			agentId: peerAgentId,
			chain: peerChain,
			ownerAddress: ALICE.address,
			agentAddress: ALICE.address,
			capabilities: ["chat"],
			registrationFile: {
				type: "eip-8004-registration-v1",
				name: "Previously Connected Peer",
				description: "A peer we asked to connect to",
				services: [{ name: "xmtp", endpoint: ALICE.address }],
				trustedAgentProtocol: {
					version: "1.0",
					agentAddress: ALICE.address,
					capabilities: ["chat"],
				},
			},
			resolvedAt: "2026-03-08T00:00:00.000Z",
		};
		const resolver = createStaticResolver(peerResolved);

		const { service, requestJournal } = await createService(
			{},
			{ transport, trustStore, resolver },
		);
		await service.start();

		// Simulate a prior `connect()` call that left a pending outbound entry
		// in the journal. The contact was then (hypothetically) wiped. Must
		// include metadata.peerChain so the security gate's chain check passes.
		await requestJournal.putOutbound({
			requestId: "req-recovered",
			requestKey: "outbound:req-recovered",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId,
			status: "pending",
			metadata: { peerChain },
		});
		expect(await trustStore.findByAgentId(peerAgentId, peerChain)).toBeNull();

		const acceptedResult = buildConnectionResult({
			requestId: "req-recovered",
			from: { agentId: peerAgentId, chain: peerChain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: peerAgentId,
				senderInboxId: "peer-inbox-recovered",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "received" });

		// Contact rebuilt from on-chain resolution, with correct fields.
		const contact = await trustStore.findByAgentId(peerAgentId, peerChain);
		expect(contact?.status).toBe("active");
		expect(contact?.peerAgentAddress).toBe(ALICE.address);
		expect(contact?.peerDisplayName).toBe("Previously Connected Peer");

		// Journal entry marked completed.
		expect((await requestJournal.getByRequestId("req-recovered"))?.status).toBe("completed");

		await service.stop();
	});

	it("ignores a stale connection result when the outbound request is already completed (§5.3 replay protection)", async () => {
		// If the journal entry for the original connection/request is already
		// `completed` and the contact is now missing, the user must have
		// intentionally deleted the contact after a successful handshake. A
		// redelivered stale result should NOT recreate the contact silently —
		// that would undo the user's explicit deletion.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();

		const peerAgentId = 555;
		const peerChain = PEER_AGENT.chain;
		const { service, requestJournal } = await createService(
			{},
			{ transport, trustStore, resolver: createStaticResolver() },
		);
		await service.start();

		await requestJournal.putOutbound({
			requestId: "req-stale",
			requestKey: "outbound:req-stale",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId,
			status: "completed",
		});

		const stale = buildConnectionResult({
			requestId: "req-stale",
			from: { agentId: peerAgentId, chain: peerChain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: peerAgentId,
				senderInboxId: "peer-inbox-stale",
				message: stale,
			}),
		).resolves.toEqual({ status: "duplicate" });

		expect(await trustStore.findByAgentId(peerAgentId, peerChain)).toBeNull();

		await service.stop();
	});

	it("rejects a connection result whose chain does not match the outbound journal entry (§5.3 cross-chain collision)", async () => {
		// Two on-chain identities can legitimately share the same numeric agentId
		// across different chains. The security gate must require the chain in
		// metadata.peerChain to match result.from.chain, otherwise a pending
		// outbound request for chain A could be used as proof of initiation for
		// an unsolicited result claiming to come from the same agentId on chain B.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();

		const sharedAgentId = 42;
		const chainA = "eip155:8453"; // Base
		const chainB = "eip155:167000"; // Taiko — same numeric agentId, different chain

		const { service, requestJournal } = await createService(
			{},
			{ transport, trustStore, resolver: createStaticResolver() },
		);
		await service.start();

		// Seed a pending outbound connection/request for chain A.
		await requestJournal.putOutbound({
			requestId: "req-chain-a",
			requestKey: "outbound:req-chain-a",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: sharedAgentId,
			status: "pending",
			metadata: { peerChain: chainA },
		});

		// Attacker sends a connection/result claiming to come from chain B but
		// echoing the chain A request's id.
		const crossChainResult = buildConnectionResult({
			requestId: "req-chain-a",
			from: { agentId: sharedAgentId, chain: chainB },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: sharedAgentId,
				senderInboxId: "peer-inbox-chain-b-attacker",
				message: crossChainResult,
			}),
		).resolves.toEqual({ status: "duplicate" });

		// No contact created for either chain.
		expect(await trustStore.findByAgentId(sharedAgentId, chainA)).toBeNull();
		expect(await trustStore.findByAgentId(sharedAgentId, chainB)).toBeNull();

		await service.stop();
	});

	it("rejects unsolicited connection result even when sender identity resolves on-chain (§5.3 security gate)", async () => {
		// Extra defense-in-depth: even if the resolver successfully resolves the
		// sender's on-chain identity (as would happen for any real attacker with
		// a real agent ID), the gate must still reject the result because there
		// is no outbound journal proof of initiation. The resolver is only
		// consulted AFTER the journal check passes.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();

		const attackerAgentId = 13337;
		const attackerResolved: ResolvedAgent = {
			agentId: attackerAgentId,
			chain: PEER_AGENT.chain,
			ownerAddress: ALICE.address,
			agentAddress: ALICE.address,
			capabilities: ["chat"],
			registrationFile: {
				type: "eip-8004-registration-v1",
				name: "Real Attacker",
				description: "Legitimate on-chain identity used for spoofing",
				services: [{ name: "xmtp", endpoint: ALICE.address }],
				trustedAgentProtocol: {
					version: "1.0",
					agentAddress: ALICE.address,
					capabilities: ["chat"],
				},
			},
			resolvedAt: "2026-03-08T00:00:00.000Z",
		};

		let resolverCalled = false;
		const spyingResolver: IAgentResolver = {
			resolve: async () => {
				resolverCalled = true;
				return attackerResolved;
			},
			resolveWithCache: async () => {
				resolverCalled = true;
				return attackerResolved;
			},
		};

		const { service } = await createService(
			{},
			{ transport, trustStore, resolver: spyingResolver },
		);
		await service.start();

		await transport.handlers.onResult?.({
			from: attackerAgentId,
			senderInboxId: "attacker-inbox",
			message: buildConnectionResult({
				requestId: "req-attacker-chosen",
				from: { agentId: attackerAgentId, chain: PEER_AGENT.chain },
				status: "accepted",
				timestamp: "2026-03-08T00:00:01.000Z",
			}),
		});

		// Gate blocks the request before the resolver is even called.
		expect(resolverCalled).toBe(false);
		expect(await trustStore.findByAgentId(attackerAgentId, PEER_AGENT.chain)).toBeNull();

		await service.stop();
	});

	it("returns duplicate and skips contact creation when resolver fails during partial-wipe recovery (§5.3 graceful fallback)", async () => {
		// During partial-wipe recovery the outbound journal entry is present
		// (proof of initiation), so the handler proceeds past the security gate
		// and tries to resolve the peer on-chain to rebuild the contact. If the
		// resolver throws (e.g. peer deregistered or network error), the handler
		// must not create a broken zero-address contact — it logs a warning and
		// returns "duplicate" so the caller treats the result as unactionable.
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const failingResolver: IAgentResolver = {
			resolve: async () => {
				throw new Error("on-chain lookup failed");
			},
			resolveWithCache: async () => {
				throw new Error("on-chain lookup failed");
			},
		};

		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				resolver: failingResolver,
			},
		);

		await service.start();

		const unknownAgentId = 888;
		// Seed proof-of-initiation so we reach the resolver-fails path. Must
		// include metadata.peerChain so the security gate's chain check passes.
		await requestJournal.putOutbound({
			requestId: "req-resolver-fail",
			requestKey: "outbound:req-resolver-fail",
			direction: "outbound",
			kind: "request",
			method: "connection/request",
			peerAgentId: unknownAgentId,
			status: "pending",
			metadata: { peerChain: PEER_AGENT.chain },
		});

		const acceptedResult = buildConnectionResult({
			requestId: "req-resolver-fail",
			from: { agentId: unknownAgentId, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: unknownAgentId,
				senderInboxId: "peer-inbox-resolver-fail",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "duplicate" });

		// No contact created — broken zero-address contact was avoided.
		const contact = await trustStore.findByAgentId(unknownAgentId, PEER_AGENT.chain);
		expect(contact).toBeNull();

		await service.stop();
	});

	it("flips an idle contact to active on accepted connection result (§5.3 idle row)", async () => {
		// Spec §5.3: idle status should flip to active, treated identically to connecting.
		const idleContact: Contact = {
			...makeActiveContact("conn-idle-flip"),
			status: "idle",
		};
		const trustStore = createMemoryTrustStore([idleContact]);
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const acceptedResult = buildConnectionResult({
			requestId: "req-idle-flip",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-idle-flip",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "received" });

		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("active");
		// Journal entry (if present) should be completed.
		const journalEntry = await requestJournal.getByRequestId("req-idle-flip");
		if (journalEntry) {
			expect(journalEntry.status).toBe("completed");
		}

		await service.stop();
	});

	it("flips a stale contact to active on accepted connection result (§5.3 stale row)", async () => {
		// Spec §5.3: stale status should flip to active, treated identically to connecting.
		const staleContact: Contact = {
			...makeActiveContact("conn-stale-flip"),
			status: "stale",
		};
		const trustStore = createMemoryTrustStore([staleContact]);
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const acceptedResult = buildConnectionResult({
			requestId: "req-stale-flip",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-stale-flip",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "received" });

		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("active");
		// Journal entry (if present) should be completed.
		const journalEntry = await requestJournal.getByRequestId("req-stale-flip");
		if (journalEntry) {
			expect(journalEntry.status).toBe("completed");
		}

		await service.stop();
	});

	it("ignores accepted connection result when local contact is revoked (§5.3 revoked row)", async () => {
		// Spec §5.3: revoked status — log and ignore. A stale result must not
		// resurrect a contact that was explicitly revoked.
		const revokedContact: Contact = {
			...makeActiveContact("conn-revoked-ignore"),
			status: "revoked",
		};
		const trustStore = createMemoryTrustStore([revokedContact]);
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const acceptedResult = buildConnectionResult({
			requestId: "req-revoked-ignore",
			from: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			status: "accepted",
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onResult?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-revoked-ignore",
				message: acceptedResult,
			}),
		).resolves.toEqual({ status: "duplicate" });

		// Contact must remain revoked — not resurrected.
		const contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(contact?.status).toBe("revoked");

		await service.stop();
	});

	it("rejects permission updates that do not involve the local agent", async () => {
		const contact = makeActiveContact("conn-grants-invalid");
		const trustStore = createMemoryTrustStore([contact]);
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		await service.start();

		const invalidUpdate = buildPermissionsUpdate({
			grantSet: {
				version: "tap-grants/v1",
				updatedAt: "2026-03-08T00:00:00.000Z",
				grants: [
					{
						grantId: "invalid",
						scope: "general-chat",
						updatedAt: "2026-03-08T00:00:00.000Z",
						status: "active",
					},
				],
			},
			grantor: { agentId: PEER_AGENT.agentId, chain: PEER_AGENT.chain },
			grantee: { agentId: 999, chain: PEER_AGENT.chain },
			timestamp: "2026-03-08T00:00:01.000Z",
		});

		await expect(
			transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-invalid-grants",
				message: invalidUpdate,
			}),
		).rejects.toThrow("local agent exactly once");

		const nextContact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
		expect(nextContact?.permissions.grantedByPeer.grants).toEqual([]);
	});

	it("auto-accepts connection request when no approveConnection hook is registered", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
				// No hooks — default behavior
			},
		);

		await service.start();
		const request = await submitConnectionRequest(transport, "peer-inbox-auto-accept-connection");

		let contact: Contact | null = null;
		let journalEntry: Awaited<ReturnType<typeof requestJournal.getByRequestId>> = null;
		for (let attempt = 0; attempt < 20; attempt++) {
			contact = await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain);
			journalEntry = await requestJournal.getByRequestId(String(request.id));
			if (contact?.status === "active" && journalEntry?.status === "completed") {
				break;
			}
			await sleep(10);
		}

		expect(contact).toEqual(
			expect.objectContaining({
				status: "active",
			}),
		);
		expect(journalEntry).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it("resolvePending scheduling approval applies override and bypasses confirm hook", async () => {
		const contact = makeActiveContact("conn-deferred-scheduling");
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => false);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-override-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const proposal = {
			type: "scheduling/propose",
			schedulingId: "sch-override-1",
			title: "Architecture Review",
			duration: 60,
			slots: [{ start: "2026-03-08T16:00:00.000Z", end: "2026-03-08T17:00:00.000Z" }],
			originTimezone: "UTC",
		};
		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			proposal,
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-scheduling-override",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "pending",
			}),
		);

		const report = await service.resolvePending(String(request.id), true);
		expect(report.pendingRequests).toEqual([]);
		expect(confirmMeeting).not.toHaveBeenCalled();
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual(
			expect.objectContaining({
				type: "scheduling/accept",
				schedulingId: "sch-override-1",
			}),
		);

		await service.stop();
	});

	it("rejects scheduling requests when no scheduling handler is configured", async () => {
		const contact = makeActiveContact("conn-scheduling-unsupported");
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();

		const proposal = {
			type: "scheduling/propose",
			schedulingId: "sch-unsupported-1",
			title: "Unsupported Meeting",
			duration: 30,
			slots: [{ start: "2026-03-08T16:00:00.000Z", end: "2026-03-08T16:30:00.000Z" }],
			originTimezone: "UTC",
		};
		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			proposal,
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-scheduling-unsupported",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual(
			expect.objectContaining({
				type: "scheduling/reject",
				schedulingId: "sch-unsupported-1",
				reason: "Scheduling is not supported by this TAP host",
			}),
		);

		await service.stop();
	});

	it("resolves pending scheduling requests using peerChain when agent ids collide", async () => {
		const contact = makeActiveContact("conn-scheduling-mainnet");
		const sameAgentOtherChain: Contact = {
			...makeActiveContact("conn-scheduling-taiko"),
			peerChain: "eip155:167000",
			peerDisplayName: "Bob on Taiko",
		};
		const transport = new FakeTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-mainnet-only" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact, sameAgentOtherChain]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const proposal = {
			type: "scheduling/propose",
			schedulingId: "sch-mainnet-only",
			title: "Mainnet Meeting",
			duration: 30,
			slots: [{ start: "2026-03-08T16:00:00.000Z", end: "2026-03-08T16:30:00.000Z" }],
			originTimezone: "UTC",
		};
		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			proposal,
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-scheduling-mainnet",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		await expect(service.resolvePending(String(request.id), false)).resolves.toEqual(
			expect.objectContaining({
				pendingRequests: [],
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(actionResults[0]?.peerId).toBe(contact.peerAgentId);

		await service.stop();
	});

	it("settles scheduling requests when confirmMeeting returns false", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-confirm-false-scheduling"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => false);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-confirm-false-1",
					title: "Weekly Sync",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "UTC",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-should-not-run" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			{
				type: "scheduling/propose",
				schedulingId: "sch-confirm-false-1",
				title: "Weekly Sync",
				duration: 60,
				slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
				originTimezone: "UTC",
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-confirm-false",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const entry = await requestJournal.getByRequestId(String(request.id));
			if (entry?.status === "completed") {
				break;
			}
			await sleep(10);
		}
		expect(confirmMeeting).toHaveBeenCalledOnce();
		expect(schedulingHandler.handleAccept).not.toHaveBeenCalled();
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual(
			expect.objectContaining({
				type: "scheduling/reject",
				schedulingId: "sch-confirm-false-1",
			}),
		);

		await service.stop();
	});

	it("cancels outbound scheduling requests with a scheduling/cancel response", async () => {
		const contact = makeActiveContact("conn-cancel-outbound-scheduling");
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-cancel-1",
			title: "Cancel Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const requestResult = await service.requestMeeting({
			peer: contact.peerDisplayName,
			proposal,
		});

		const report = await service.cancelPendingSchedulingRequest(
			String(requestResult.receipt.requestId),
			"Need to reschedule",
		);
		expect(report.pendingRequests).toEqual([]);
		expect(await requestJournal.getByRequestId(String(requestResult.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		expect(parseSchedulingActionResponse(actionResults[0]!.message)).toEqual({
			type: "scheduling/cancel",
			schedulingId: "sch-cancel-1",
			reason: "Need to reschedule",
		});

		await service.stop();
	});

	it("retries scheduling cancellation delivery after the initial send fails", async () => {
		const contact = makeActiveContact("conn-cancel-retry");

		class FlakySchedulingCancelTransport extends FakeTransport {
			private failOnce = true;

			override async send(
				peerId: number,
				message: ProtocolMessage,
				options?: TransportSendOptions,
			): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message, ...(options ? { options } : {}) });
				const response = parseSchedulingActionResponse(message);
				if (
					message.method === "action/result" &&
					response?.type === "scheduling/cancel" &&
					this.failOnce
				) {
					this.failOnce = false;
					throw new TransportError("temporary cancel send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: options?.waitForAck === false ? "published" : "received",
					receivedAt: "2026-03-07T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakySchedulingCancelTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-cancel-retry-1",
			title: "Retry Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const requestResult = await service.requestMeeting({
			peer: contact.peerDisplayName,
			proposal,
		});

		const report = await service.cancelPendingSchedulingRequest(
			String(requestResult.receipt.requestId),
			"Need to reschedule",
		);
		expect(report.pendingRequests).toEqual([]);
		expect(report.pendingDeliveries).toEqual([
			expect.objectContaining({
				method: "action/result",
			}),
		]);
		expect(await requestJournal.getByRequestId(String(requestResult.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		const retryReport = await service.syncOnce();
		expect(retryReport.pendingDeliveries).toEqual([]);

		await service.stop();
	});

	it("completes the superseded outbound request when a counter-proposal arrives", async () => {
		const contact = makeActiveContact("conn-counter-cleanup");
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-counter-1",
			title: "Counter Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "pending",
			}),
		);

		const counter = buildOutgoingActionRequest(
			contact,
			"Counter proposal",
			{
				...proposal,
				type: "scheduling/counter" as const,
				slots: [{ start: "2026-03-09T20:00:00.000Z", end: "2026-03-09T20:45:00.000Z" }],
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-counter-cleanup",
				message: counter,
			}),
		).resolves.toEqual({ status: "queued" });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);
		expect(await service.listPendingRequests()).toEqual([
			expect.objectContaining({
				requestId: String(counter.id),
				direction: "inbound",
			}),
		]);

		await service.stop();
	});

	it("keeps inbound scheduling requests pending when a counter-proposal cannot be delivered", async () => {
		const contact = makeActiveContact("conn-counter-failure");

		class FlakySchedulingCounterTransport extends FakeTransport {
			override async send(
				peerId: number,
				message: ProtocolMessage,
				options?: TransportSendOptions,
			): Promise<TransportReceipt> {
				this.sentMessages.push({ peerId, message, ...(options ? { options } : {}) });
				const request = parseSchedulingActionRequest(message);
				if (message.method === "action/request" && request?.type === "scheduling/counter") {
					throw new TransportError("temporary counter send failure");
				}
				return {
					received: true,
					requestId: String(message.id),
					status: options?.waitForAck === false ? "published" : "received",
					receivedAt: "2026-03-07T00:00:00.000Z",
				};
			}
		}

		const transport = new FlakySchedulingCounterTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "counter" as const,
				slots: [{ start: "2026-03-09T20:00:00.000Z", end: "2026-03-09T20:45:00.000Z" }],
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-counter-failure" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-counter-failure-1",
			title: "Counter Failure Candidate",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const request = buildOutgoingActionRequest(
			contact,
			"Counter proposal",
			proposal,
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-counter-failure",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);

		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				status: "pending",
			}),
		);

		await service.stop();
	});

	it("uses the responder's local timezone and stores the local event when accepting", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-responder-timezone"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => true);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-responder-tz-1",
					title: "Local Timezone Review",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "America/New_York",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-responder-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const dateTimeFormatSpy = vi
			.spyOn(Intl, "DateTimeFormat")
			.mockReturnValue({ resolvedOptions: () => ({ timeZone: "America/Los_Angeles" }) } as never);
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		try {
			await service.start();

			const request = buildOutgoingActionRequest(
				contact,
				"Scheduling proposal",
				{
					type: "scheduling/propose",
					schedulingId: "sch-responder-tz-1",
					title: "Local Timezone Review",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "America/New_York",
				},
				"scheduling/request",
			);

			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-responder-timezone",
					message: request,
				}),
			).resolves.toEqual({ status: "queued" });

			await sleep(50);
			expect(schedulingHandler.handleAccept).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "scheduling/accept",
					schedulingId: "sch-responder-tz-1",
				}),
				contact.peerDisplayName,
				"Local Timezone Review",
				"America/Los_Angeles",
			);
			expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
				expect.objectContaining({
					status: "completed",
					metadata: expect.objectContaining({
						localEventId: "evt-responder-1",
						schedulingState: "accepted",
					}),
				}),
			);
		} finally {
			dateTimeFormatSpy.mockRestore();
			await service.stop();
		}
	});

	it("deletes the requester's local calendar event when the peer cancels an accepted meeting", async () => {
		const contact = makeActiveContact("conn-requester-cancel-cleanup");
		const transport = new FakeTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-requester-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-requester-cancel-1",
			title: "Requester Cleanup",
			duration: 45,
			slots: [{ start: "2026-03-08T20:00:00.000Z", end: "2026-03-08T20:45:00.000Z" }],
			originTimezone: "UTC",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		const accept = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Accepted",
			{
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot: proposal.slots[0],
			},
			"scheduling/request",
			"completed",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-requester-accept",
				message: accept,
			}),
		).resolves.toEqual({ status: "received" });

		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					localEventId: "evt-requester-1",
					schedulingState: "accepted",
				}),
			}),
		);

		const cancel = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Cancelled",
			{
				type: "scheduling/cancel",
				schedulingId: proposal.schedulingId,
				reason: "Need to reschedule",
			},
			"scheduling/request",
			"rejected",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-requester-cancel",
				message: cancel,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleCancel).toHaveBeenCalledWith("evt-requester-1");
		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
				metadata: expect.objectContaining({
					schedulingState: "cancelled",
				}),
			}),
		);
		expect(
			(await requestJournal.getByRequestId(String(meeting.receipt.requestId)))?.metadata,
		).not.toHaveProperty("localEventId");

		await service.stop();
	});

	it("deletes the responder's local calendar event when the requester cancels later", async () => {
		const contact: Contact = {
			...makeActiveContact("conn-responder-cancel-cleanup"),
			permissions: {
				...createEmptyPermissionState("2026-03-08T00:00:00.000Z"),
				grantedByMe: createGrantSet(
					[
						{
							grantId: "sched-grant-1",
							scope: "scheduling/request",
						},
					],
					"2026-03-08T00:00:00.000Z",
				),
			},
		};
		const transport = new FakeTransport();
		const confirmMeeting = vi.fn(async () => true);
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({
				action: "confirm" as const,
				slot: { start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" },
				proposal: {
					type: "scheduling/propose",
					schedulingId: "sch-responder-cancel-1",
					title: "Responder Cleanup",
					duration: 60,
					slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
					originTimezone: "UTC",
				},
			})),
			handleAccept: vi.fn(async () => ({ eventId: "evt-responder-cancel-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { confirmMeeting },
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();

		const request = buildOutgoingActionRequest(
			contact,
			"Scheduling proposal",
			{
				type: "scheduling/propose",
				schedulingId: "sch-responder-cancel-1",
				title: "Responder Cleanup",
				duration: 60,
				slots: [{ start: "2026-03-08T18:00:00.000Z", end: "2026-03-08T19:00:00.000Z" }],
				originTimezone: "UTC",
			},
			"scheduling/request",
		);

		await expect(
			transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-responder-cancel",
				message: request,
			}),
		).resolves.toEqual({ status: "queued" });

		await sleep(50);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					localEventId: "evt-responder-cancel-1",
					schedulingState: "accepted",
				}),
			}),
		);

		const cancel = buildOutgoingActionResult(
			contact,
			String(request.id),
			"Cancelled",
			{
				type: "scheduling/cancel",
				schedulingId: "sch-responder-cancel-1",
				reason: "Need to reschedule",
			},
			"scheduling/request",
			"rejected",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-responder-cancel-result",
				message: cancel,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleCancel).toHaveBeenCalledWith("evt-responder-cancel-1");
		expect((await requestJournal.getByRequestId(String(request.id)))?.metadata).not.toHaveProperty(
			"localEventId",
		);
		expect(await requestJournal.getByRequestId(String(request.id))).toEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					schedulingState: "cancelled",
				}),
			}),
		);

		await service.stop();
	});

	it("uses outbound scheduling metadata for accepted meeting title and timezone", async () => {
		const contact = makeActiveContact("conn-scheduling-accept-metadata");
		const transport = new FakeTransport();
		const schedulingHandler = {
			evaluateProposal: vi.fn(async () => ({ action: "defer" as const })),
			handleAccept: vi.fn(async () => ({ eventId: "evt-accept-meta-1" })),
			handleCancel: vi.fn(async () => {}),
		} as unknown as NonNullable<
			ConstructorParameters<typeof TapMessagingService>[1]["schedulingHandler"]
		>;
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				serviceOptions: { schedulingHandler },
			},
		);

		await service.start();
		const proposal = {
			type: "scheduling/propose" as const,
			schedulingId: "sch-meta-1",
			title: "Backend Roadmap",
			duration: 30,
			slots: [{ start: "2026-03-08T12:00:00.000Z", end: "2026-03-08T12:30:00.000Z" }],
			originTimezone: "America/New_York",
		};
		const meeting = await service.requestMeeting({ peer: contact.peerDisplayName, proposal });

		const accept = buildOutgoingActionResult(
			contact,
			String(meeting.receipt.requestId),
			"Accepted",
			{
				type: "scheduling/accept",
				schedulingId: proposal.schedulingId,
				acceptedSlot: proposal.slots[0],
			},
			"scheduling/request",
			"completed",
		);
		await expect(
			transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-accept-meta",
				message: accept,
			}),
		).resolves.toEqual({ status: "received" });

		expect(schedulingHandler.handleAccept).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "scheduling/accept",
				schedulingId: "sch-meta-1",
			}),
			contact.peerDisplayName,
			"Backend Roadmap",
			"America/New_York",
		);
		expect(await requestJournal.getByRequestId(String(meeting.receipt.requestId))).toEqual(
			expect.objectContaining({
				status: "completed",
			}),
		);

		await service.stop();
	});

	it("does not crash when emitEvent hook throws", async () => {
		const trustStore = createMemoryTrustStore();
		const transport = new FakeTransport();
		const emitEvent = vi.fn(() => {
			throw new Error("boom from emitEvent");
		});
		const log = vi.fn();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore,
				hooks: { emitEvent, log },
			},
		);

		await service.start();
		// Should not throw even though emitEvent hook throws
		await submitConnectionRequest(transport, "peer-inbox-emit-crash");

		expect(emitEvent).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"warn",
			expect.stringContaining("emitEvent hook threw: boom from emitEvent"),
		);

		await service.stop();
	});

	it("resolvePending rejects non-connection and non-action requests", async () => {
		const transport = new FakeTransport();
		const trustStore = createMemoryTrustStore();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore,
			},
		);

		// Manually insert a message/send journal entry to simulate a non-resolvable request
		await requestJournal.claimInbound({
			requestId: "msg-send-123",
			requestKey: "test:message/send:msg-send-123",
			direction: "inbound",
			kind: "request",
			method: "message/send",
			peerAgentId: PEER_AGENT.agentId,
		});

		await expect(service.resolvePending("msg-send-123", true)).rejects.toThrow(
			"cannot be resolved manually",
		);
	});

	it("sends UNSUPPORTED_ACTION error for unrecognized action types", async () => {
		const contact = makeActiveContact("conn-unsupported-action");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Build an action/request with an unrecognized type
		const request = buildOutgoingActionRequest(
			contact,
			"Do something exotic",
			{
				type: "exotic/unknown-action",
				actionId: "exotic-1",
				foo: "bar",
			},
			"exotic/unknown-action",
		);

		const result = await transport.handlers.onRequest?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-unsupported",
			message: request,
		});

		expect(result).toEqual({ status: "received" });

		// Should have sent an action/result with UNSUPPORTED_ACTION error
		const actionResults = transport.sentMessages.filter(
			(entry) => entry.message.method === "action/result",
		);
		expect(actionResults).toHaveLength(1);
		const resultParams = actionResults[0].message.params as {
			status?: string;
			message?: { parts?: Array<{ kind: string; data?: Record<string, unknown>; text?: string }> };
		};
		expect(resultParams.status).toBe("failed");

		// Check the data part contains the UNSUPPORTED_ACTION error
		const dataPart = resultParams.message?.parts?.find((p) => p.kind === "data");
		expect(dataPart?.data).toEqual(
			expect.objectContaining({
				error: expect.objectContaining({
					code: "UNSUPPORTED_ACTION",
				}),
			}),
		);

		// Check the emitEvent was called with the error info
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				error: "UNSUPPORTED_ACTION",
				actionType: "exotic/unknown-action",
			}),
		);

		await service.stop();
	});

	it("sendActionRequest persists to request journal", async () => {
		const contact = makeActiveContact("conn-action-journal");
		const { service, transport, requestJournal } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();

		await service.sendActionRequest(
			{ connectionId: contact.connectionId },
			"bet/propose",
			{ odds: 1.5, amount: "100" },
			"Proposing a bet",
		);

		// Verify the request was sent
		expect(transport.sentMessages).toHaveLength(1);
		expect(transport.sentMessages[0]!.message.method).toBe("action/request");

		const requestId = String(transport.sentMessages[0]!.message.id);

		// Verify journal entry was created and pending
		const entry = await requestJournal.getByRequestId(requestId);
		expect(entry).not.toBeNull();
		expect(entry!.direction).toBe("outbound");
		expect(entry!.kind).toBe("request");
		expect(entry!.method).toBe("action/request");
		expect(entry!.peerAgentId).toBe(PEER_AGENT.agentId);
		expect(entry!.status).toBe("pending");
		expect(entry!.metadata).toEqual({
			actionType: "bet/propose",
			peerChain: PEER_AGENT.chain,
		});

		await service.stop();
	});

	it("sendActionRequest cleans up journal on non-timeout send failure", async () => {
		const contact = makeActiveContact("conn-action-journal-fail");
		const { service, requestJournal } = await createService(
			{ sendError: new Error("network failure") },
			{
				trustStore: createMemoryTrustStore([contact]),
			},
		);

		await service.start();

		await expect(
			service.sendActionRequest({ connectionId: contact.connectionId }, "bet/propose", {
				odds: 1.5,
			}),
		).rejects.toThrow("network failure");

		// Journal should be cleaned up after non-timeout failure
		const entries = await requestJournal.list("outbound");
		expect(entries).toHaveLength(0);

		await service.stop();
	});

	it("emits structured event for generic (non-transfer, non-scheduling) action result", async () => {
		const contact = makeActiveContact("conn-generic-result");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service, requestJournal } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Simulate an outbound action request to create a journal entry
		await service.sendActionRequest(
			{ connectionId: contact.connectionId },
			"bet/propose",
			{ odds: 1.5, matchId: "match-42" },
			"Proposing a bet",
		);

		const outboundRequestId = String(transport.sentMessages[0]!.message.id);

		// Build a generic action result (not transfer, not scheduling)
		const resultMessage = buildOutgoingActionResult(
			contact,
			outboundRequestId,
			"Bet accepted",
			{
				type: "bet/accept",
				betId: "bet-123",
				accepted: true,
			},
			"bet/propose",
			"completed",
		);

		// Deliver the result via onResult handler
		const result = await transport.handlers.onResult?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-generic",
			message: resultMessage,
		});

		expect(result).toEqual({ status: "received" });

		// Verify structured event was emitted for the generic result
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "action_result_received",
				method: "action/result",
				actionType: "bet/accept",
				peerAgentId: PEER_AGENT.agentId,
				peerName: PEER_AGENT.registrationFile.name,
				connectionId: contact.connectionId,
				requestId: outboundRequestId,
				data: expect.objectContaining({
					type: "bet/accept",
					betId: "bet-123",
					accepted: true,
				}),
			}),
		);

		// Verify the outbound journal entry was completed
		const entry = await requestJournal.getByRequestId(outboundRequestId);
		expect(entry).not.toBeNull();
		expect(entry!.status).toBe("completed");

		await service.stop();
	});

	it("handles generic action result without a correlated outbound request", async () => {
		const contact = makeActiveContact("conn-generic-no-journal");
		const emitEvent = vi.fn();
		const transport = new FakeTransport();
		const { service } = await createService(
			{},
			{
				transport,
				trustStore: createMemoryTrustStore([contact]),
				hooks: { emitEvent },
			},
		);

		await service.start();

		// Build a generic action result with no corresponding outbound request
		const resultMessage = buildOutgoingActionResult(
			contact,
			"nonexistent-request-id",
			"Unsolicited result",
			{
				type: "custom/notification",
				payload: { status: "ok" },
			},
			"custom/notification",
			"completed",
		);

		const result = await transport.handlers.onResult?.({
			from: contact.peerAgentId,
			senderInboxId: "peer-inbox-unsolicited",
			message: resultMessage,
		});

		expect(result).toEqual({ status: "received" });

		// Should still emit the event even without a journal entry
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "action_result_received",
				actionType: "custom/notification",
				peerAgentId: PEER_AGENT.agentId,
				data: expect.objectContaining({
					type: "custom/notification",
				}),
			}),
		);

		await service.stop();
	});

	describe("messaging fire-and-forget semantics", () => {
		it("sendMessage publishes without waiting for an application-level ack", async () => {
			const activeContact = makeActiveContact("conn-fire-and-forget");
			const loggedMessages: Array<{
				conversationId: string;
				direction: string;
				content: unknown;
			}> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async (conversationId, message) => {
					loggedMessages.push({
						conversationId,
						direction: message.direction,
						content: message.content,
					});
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			};

			// Custom transport that NEVER sends a transport-level ack back —
			// simulates a peer that's not listening (one-shot CLI scenario).
			// Before the fix, sendMessage would rely on the JSON-RPC receipt
			// coming back and throw "Response timeout" if the peer is offline.
			class SilentTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					// Intentionally return "published" — this is what the transport
					// MUST do when waitForAck:false so the caller doesn't block.
					return {
						received: true,
						requestId: String(message.id),
						status: "published",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}

			const transport = new SilentTransport();
			const dataDir = await mkdtemp(join(tmpdir(), "tap-fire-and-forget-"));
			trackTempDir(dataDir);
			const config: TrustedAgentsConfig = {
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "test", apiKey: "ows_key_test" },
				dataDir,
				chains: {},
				inviteExpirySeconds: 3600,
				resolveCacheTtlMs: 60_000,
				resolveCacheMaxEntries: 128,
			};
			const requestJournal = new FileRequestJournalImpl(dataDir);
			const appRegistry = new TapAppRegistry(dataDir);
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal,
					transport,
					appRegistry,
				},
				{
					ownerLabel: "tap:test-fire-and-forget",
				},
			);

			const result = await service.sendMessage(activeContact.peerDisplayName, "Hello Bob");

			// 1. It did not throw. (Before: would throw "Response timeout".)
			expect(result.receipt.status).toBe("published");

			// 2. Transport.send was invoked with waitForAck: false.
			expect(transport.sentMessages).toHaveLength(1);
			expect(transport.sentMessages[0]?.message.method).toBe("message/send");
			expect(transport.sentMessages[0]?.options?.waitForAck).toBe(false);

			// 3. Conversation log was written immediately after publication —
			//    even though no ack ever arrived.
			expect(loggedMessages).toHaveLength(1);
			expect(loggedMessages[0]?.direction).toBe("outgoing");
		});

		it("writes conversation log for outgoing messages on successful publication", async () => {
			const activeContact = makeActiveContact("conn-eager-log");
			const loggedMessages: Array<{ direction: string }> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async (_conversationId, message) => {
					loggedMessages.push({ direction: message.direction });
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			};

			const transport = new FakeTransport();
			const dataDir = await mkdtemp(join(tmpdir(), "tap-eager-log-"));
			trackTempDir(dataDir);
			const config: TrustedAgentsConfig = {
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "test", apiKey: "ows_key_test" },
				dataDir,
				chains: {},
				inviteExpirySeconds: 3600,
				resolveCacheTtlMs: 60_000,
				resolveCacheMaxEntries: 128,
			};
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal: new FileRequestJournalImpl(dataDir),
					transport,
					appRegistry: new TapAppRegistry(dataDir),
				},
				{ ownerLabel: "tap:test-eager-log" },
			);

			await service.sendMessage(activeContact.peerDisplayName, "Eager log test");

			expect(loggedMessages).toEqual([{ direction: "outgoing" }]);
		});

		it("does NOT write conversation log if publication fails", async () => {
			const activeContact = makeActiveContact("conn-publish-fail");
			const loggedMessages: Array<unknown> = [];
			const conversationLogger: IConversationLogger = {
				logMessage: async () => {
					loggedMessages.push(true);
				},
				getConversation: async () => null,
				listConversations: async () => [],
				generateTranscript: async () => "",
				markRead: async () => {},
			};

			class PublishFailTransport extends FakeTransport {
				override async send(): Promise<TransportReceipt> {
					throw new TransportError("Failed to publish DM: network unreachable");
				}
			}

			const dataDir = await mkdtemp(join(tmpdir(), "tap-publish-fail-"));
			trackTempDir(dataDir);
			const config: TrustedAgentsConfig = {
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "test", apiKey: "ows_key_test" },
				dataDir,
				chains: {},
				inviteExpirySeconds: 3600,
				resolveCacheTtlMs: 60_000,
				resolveCacheMaxEntries: 128,
			};
			const service = new TapMessagingService(
				{
					config,
					signingProvider: ALICE_SIGNING_PROVIDER,
					trustStore: createMemoryTrustStore([activeContact]),
					resolver: createStaticResolver(),
					conversationLogger,
					requestJournal: new FileRequestJournalImpl(dataDir),
					transport: new PublishFailTransport(),
					appRegistry: new TapAppRegistry(dataDir),
				},
				{ ownerLabel: "tap:test-publish-fail" },
			);

			await expect(service.sendMessage(activeContact.peerDisplayName, "Will fail")).rejects.toThrow(
				"Failed to publish",
			);
			expect(loggedMessages).toHaveLength(0);
		});
	});

	describe("connection result journal idempotency", () => {
		it("reuses the same outbound journal entry when processConnectionRequest re-runs for the same inbound", async () => {
			// Scenario that reproduces the reported accumulation bug:
			// the process crashes between sendConnectionResult's putOutbound and
			// the updateStatus("completed") of the inbound entry. On restart,
			// the listener re-processes the still-pending inbound, runs
			// sendConnectionResult again, and — before the fix — creates a
			// brand-new outbound entry each time. We simulate the crash by
			// resetting the inbound status to "pending" between submissions.
			const trustStore = createMemoryTrustStore();
			class PublishFailingTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						throw new TransportError("permanent publish failure for test");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new PublishFailingTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			const request = await submitConnectionRequest(transport, "peer-inbox-dedup");
			await sleep(50);

			// Force the inbound back to pending (simulates process crash).
			await requestJournal.updateStatus(String(request.id), "pending");

			// Re-submit the SAME inbound message — mimics the listener replaying
			// the message after restart.
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-dedup",
				message: request,
			});
			await sleep(50);

			// And once more for good measure.
			await requestJournal.updateStatus(String(request.id), "pending");
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-dedup",
				message: request,
			});
			await sleep(50);

			const pendingResults = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingResults).toHaveLength(1);
			expect(pendingResults[0]?.correlationId).toBe(String(request.id));

			await service.stop();
		});
	});

	describe("sync report surfaces pending outbound deliveries", () => {
		it("populates pendingDeliveries with stuck outbound connection/result entries", async () => {
			const trustStore = createMemoryTrustStore();
			class PublishFailingTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result") {
						throw new TransportError("publish failed: unreachable");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new PublishFailingTransport();
			const { service } = await createService({}, { transport, trustStore });

			await service.start();
			const request = await submitConnectionRequest(transport, "peer-inbox-sync-report");
			await sleep(50);

			const report = await service.syncOnce();

			expect(report.pendingDeliveries).toBeDefined();
			expect(report.pendingDeliveries?.length ?? 0).toBeGreaterThan(0);
			const delivery = report.pendingDeliveries?.[0];
			expect(delivery?.method).toBe("connection/result");
			expect(delivery?.peerAgentId).toBe(PEER_AGENT.agentId);
			expect(delivery?.correlationId).toBe(String(request.id));
			expect(delivery?.lastError).toContain("publish failed");

			await service.stop();
		});
	});

	describe("implicit handshake completion on inbound traffic", () => {
		it("marks pending outbound connection/result entries completed when peer sends a valid inbound message", async () => {
			// Implicit handshake completion scenario: we have an active contact for
			// the peer (connection result was already confirmed delivered and
			// contact was written) but the journal entry was left pending due to
			// a transient failure in markJournalEntryCompleted. When the peer sends
			// us a message, we know they received our result and we can safely
			// mark the journal entry completed.
			//
			// State setup: pre-seed the active contact and manually write a pending
			// journal entry to simulate the "send succeeded, journal completion
			// failed" scenario.
			const activeContact = makeActiveContact("conn-implicit-complete-001");
			const trustStore = createMemoryTrustStore([activeContact]);
			const transport = new FakeTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();

			// Manually insert a pending connection/result journal entry simulating
			// a stale entry that was never marked completed (e.g. due to a crash
			// between transport.send() and markJournalEntryCompleted()).
			const staleRequestId = deriveConnectionResultId({
				chain: PEER_AGENT.chain,
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "stale-inbound-req-1",
			});
			const staleResultMessage = buildConnectionResult(
				{
					requestId: "stale-inbound-req-1",
					from: { agentId: 1, chain: "eip155:8453" },
					status: "accepted",
					timestamp: "2026-03-08T00:00:00.000Z",
				},
				staleRequestId,
			);
			await requestJournal.putOutbound({
				requestId: staleRequestId,
				requestKey: `outbound:connection/result:${staleRequestId}`,
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "stale-inbound-req-1",
				status: "pending",
				metadata: {
					type: "connection-result-delivery",
					peerAgentId: PEER_AGENT.agentId,
					peerChain: PEER_AGENT.chain,
					peerName: PEER_AGENT.registrationFile.name,
					peerAddress: PEER_AGENT.agentAddress,
					request: staleResultMessage,
				},
			});

			const pendingBefore = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingBefore).toHaveLength(1);

			// Verify the active contact is present.
			expect((await trustStore.findByAgentId(PEER_AGENT.agentId, PEER_AGENT.chain))?.status).toBe(
				"active",
			);

			// Peer sends us a message — this proves they received our connection/result.
			// The implicit completion should mark the stale journal entry completed.
			const inbound: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-hello-1",
				params: {
					message: {
						parts: [{ kind: "text", text: "Thanks for connecting!" } as const],
					},
				},
			};

			await expect(
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-implicit-completion",
					message: inbound,
				}),
			).resolves.toEqual(expect.objectContaining({ status: "received" }));
			await sleep(50);

			const pendingAfter = (await requestJournal.listPending("outbound")).filter(
				(entry) => entry.method === "connection/result",
			);
			expect(pendingAfter).toHaveLength(0);

			await service.stop();
		});

		it("clears the connection-result cache after the retry pipeline delivers, so subsequent inbounds don't re-scan the journal", async () => {
			// Regression for a cache-leak perf bug: if the retry pipeline
			// delivered the connection/result rather than the direct path,
			// the peer would linger in `peersWithPendingConnectionResult`
			// until the next inbound triggered a full journal scan to clear
			// it. This test proves the cache is cleared at the moment of
			// successful retry delivery instead.
			const trustStore = createMemoryTrustStore();
			let failConnectionResultOnce = true;
			class FlakyThenSucceedTransport extends FakeTransport {
				override async send(
					peerId: number,
					message: ProtocolMessage,
					options?: TransportSendOptions,
				): Promise<TransportReceipt> {
					this.sentMessages.push({
						peerId,
						message,
						...(options ? { options } : {}),
					});
					if (message.method === "connection/result" && failConnectionResultOnce) {
						failConnectionResultOnce = false;
						throw new TransportError("first attempt fails");
					}
					return {
						received: true,
						requestId: String(message.id),
						status: options?.waitForAck === false ? "published" : "received",
						receivedAt: "2026-03-08T00:00:00.000Z",
					};
				}
			}
			const transport = new FlakyThenSucceedTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();
			await submitConnectionRequest(transport, "peer-inbox-cache-clear");
			await sleep(50);

			// First attempt failed — entry pending, cache holds the peer.
			expect(
				(await requestJournal.listPending("outbound")).some(
					(entry) => entry.method === "connection/result",
				),
			).toBe(true);

			// syncOnce triggers retryPendingConnectionResults, which now succeeds.
			const firstReport = await service.syncOnce();
			expect(firstReport.pendingDeliveries).toHaveLength(0);
			expect(
				(await requestJournal.listPending("outbound")).some(
					(entry) => entry.method === "connection/result",
				),
			).toBe(false);

			// Warm-up inbound: triggers the one-time cache priming scan,
			// which is fine and expected. We measure the NEXT inbound.
			const warmup: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-warmup-after-retry",
				params: {
					message: { parts: [{ kind: "text", text: "hi 1" } as const] },
				},
			};
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-cache-clear",
				message: warmup,
			});
			await sleep(20);

			// Subsequent inbound: if the cache wasn't cleared by the retry-
			// success path, `markPendingConnectionResultsCompletedFor` would
			// do a full journal scan for every following inbound from the
			// peer. After the fix, the cache miss short-circuits before
			// touching the journal.
			const listPendingSpy = vi.spyOn(requestJournal, "listPending");
			const inbound: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "message/send",
				id: "peer-hello-after-retry",
				params: {
					message: { parts: [{ kind: "text", text: "hi 2" } as const] },
				},
			};
			await transport.handlers.onRequest?.({
				from: PEER_AGENT.agentId,
				senderInboxId: "peer-inbox-cache-clear",
				message: inbound,
			});
			await sleep(20);

			expect(listPendingSpy).not.toHaveBeenCalled();
			listPendingSpy.mockRestore();

			await service.stop();
		});

		it("shares a single priming scan across concurrent implicit-completion callers", async () => {
			// Regression for a priming race: two concurrent inbound messages
			// could both enter the implicit-completion path and both trigger
			// full journal scans (instead of sharing one). After the fix,
			// concurrent callers await the same priming promise.
			//
			// State setup: pre-seed the active contact and a stale pending
			// connection/result journal entry to trigger the implicit completion
			// path without relying on the old ordering (which wrote the contact
			// even when the send failed).
			const activeContact = makeActiveContact("conn-prime-race-001");
			const trustStore = createMemoryTrustStore([activeContact]);
			const transport = new FakeTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			await service.start();

			// Manually insert a pending connection/result entry (simulating a
			// stale entry that was not cleaned up, e.g. after a crash).
			const staleRequestId = deriveConnectionResultId({
				chain: PEER_AGENT.chain,
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "prime-race-stale-req",
			});
			const staleResultMessage = buildConnectionResult(
				{
					requestId: "prime-race-stale-req",
					from: { agentId: 1, chain: "eip155:8453" },
					status: "accepted",
					timestamp: "2026-03-08T00:00:00.000Z",
				},
				staleRequestId,
			);
			await requestJournal.putOutbound({
				requestId: staleRequestId,
				requestKey: `outbound:connection/result:${staleRequestId}`,
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "prime-race-stale-req",
				status: "pending",
				metadata: {
					type: "connection-result-delivery",
					peerAgentId: PEER_AGENT.agentId,
					peerChain: PEER_AGENT.chain,
					peerName: PEER_AGENT.registrationFile.name,
					peerAddress: PEER_AGENT.agentAddress,
					request: staleResultMessage,
				},
			});

			// Fire two concurrent inbounds that both trigger implicit
			// completion. The priming scan should run exactly once.
			const listPendingSpy = vi.spyOn(requestJournal, "listPending");
			const inbound = (id: string): ProtocolMessage => ({
				jsonrpc: "2.0",
				method: "message/send",
				id,
				params: { message: { parts: [{ kind: "text", text: id } as const] } },
			});
			await Promise.all([
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-prime-race",
					message: inbound("race-1"),
				}),
				transport.handlers.onRequest?.({
					from: PEER_AGENT.agentId,
					senderInboxId: "peer-inbox-prime-race",
					message: inbound("race-2"),
				}),
			]);

			// Priming + implicit-completion scans: priming runs once. After
			// priming, each caller scans to clear the peer — which is at
			// most 2 extra calls. The race bug would have caused priming to
			// run twice (4+ calls); the fix guarantees a single shared prime.
			const primingCalls = listPendingSpy.mock.calls.filter(
				(call) => call[0] === "outbound",
			).length;
			expect(primingCalls).toBeLessThanOrEqual(3);
			listPendingSpy.mockRestore();

			await service.stop();
		});

		it("delivers legacy pending connection-result entries that were persisted before the peerChain field existed", async () => {
			// Regression: `peerChain` was added to PendingConnectionResultDelivery
			// metadata in a later commit. Entries written by earlier versions
			// lack that field. A strict parser would drop them on the floor
			// during retry and leave them stuck until the 24h stale-GC marked
			// them completed without ever delivering. The parser must accept
			// the legacy shape so retryPendingConnectionResults still calls
			// transport.send on the original request payload.
			const trustStore = createMemoryTrustStore([makeActiveContact("conn-legacy-retry")]);
			const transport = new FakeTransport();
			const { service, requestJournal } = await createService({}, { transport, trustStore });

			// Write a legacy-shaped journal entry directly: valid in every
			// field the delivery path actually reads (peerAgentId + request
			// + peerAddress), but missing peerChain.
			const legacyRequest: ProtocolMessage = {
				jsonrpc: "2.0",
				method: "connection/result",
				id: "legacy-connection-result-id",
				params: {
					from: { agentId: 1, chain: "eip155:8453" },
					status: "accepted",
					requestId: "legacy-correlation-id",
				},
			};
			await requestJournal.putOutbound({
				requestId: String(legacyRequest.id),
				requestKey: `outbound:connection/result:${String(legacyRequest.id)}`,
				direction: "outbound",
				kind: "result",
				method: "connection/result",
				peerAgentId: PEER_AGENT.agentId,
				correlationId: "legacy-correlation-id",
				status: "pending",
				metadata: {
					type: "connection-result-delivery",
					peerAgentId: PEER_AGENT.agentId,
					// NOTE: deliberately no peerChain — this is the legacy shape.
					peerName: PEER_AGENT.registrationFile.name,
					peerAddress: PEER_AGENT.agentAddress,
					request: legacyRequest,
				},
			});

			await service.start();

			// syncOnce drives retryPendingConnectionResults. The legacy entry
			// must be delivered via transport.send and marked completed.
			const report = await service.syncOnce();

			expect(
				transport.sentMessages.filter((e) => e.message.method === "connection/result"),
			).toHaveLength(1);
			expect(
				(await requestJournal.listPending("outbound")).filter(
					(entry) => entry.method === "connection/result",
				),
			).toHaveLength(0);
			expect(report.pendingDeliveries).toHaveLength(0);

			await service.stop();
		});
	});
});

describe("attention enforcement", () => {
	const ATTENTION_CONFIG = {
		attention: { enforce: true, pricing: { grantHolder: "0", standard: "0.001" } },
	};

	function inboundMessage(contact: Contact, text = "hello"): ProtocolMessage {
		return buildOutgoingMessageRequest(contact, text);
	}

	it("rejects un-granted inbound message/send with a quoted -32050 error", async () => {
		const contact = makeActiveContact("conn-attn-1");
		const { service, transport, requestJournal } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				configOverrides: ATTENTION_CONFIG,
			},
		);
		await service.start();
		try {
			const message = inboundMessage(contact);
			const injection = transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-attn",
				message,
			});
			await expect(injection).rejects.toThrow(AttentionPaymentRequiredError);
			await expect(injection).rejects.toMatchObject({
				rpcCode: -32050,
				quote: {
					version: "1.0",
					currency: "USDC",
					chain: "eip155:8453",
					pricing: { grantHolder: "0", standard: "0.001" },
				},
			});

			// The journal entry is completed before the throw so full-history
			// replays take the duplicate short-circuit instead of re-running
			// enforcement.
			const entry = await requestJournal.getByRequestId(String(message.id));
			expect(entry?.status).toBe("completed");
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-attn",
					message,
				}),
			).resolves.toEqual({ status: "duplicate" });
		} finally {
			await service.stop();
		}
	});

	it("exempts senders holding an active message/send grant", async () => {
		const contact = makeActiveContact("conn-attn-2");
		contact.permissions.grantedByMe = createGrantSet(
			[{ grantId: "grant-msg-1", scope: "message/send" }],
			"2026-03-08T00:00:00.000Z",
		);
		const { service, transport } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				configOverrides: ATTENTION_CONFIG,
			},
		);
		await service.start();
		try {
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-attn",
					message: inboundMessage(contact),
				}),
			).resolves.toEqual({ status: "received" });
		} finally {
			await service.stop();
		}
	});

	it("does not enforce when attention.enforce is off (default)", async () => {
		const contact = makeActiveContact("conn-attn-3");
		const { service, transport } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]) },
		);
		await service.start();
		try {
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-attn",
					message: inboundMessage(contact),
				}),
			).resolves.toEqual({ status: "received" });
		} finally {
			await service.stop();
		}
	});

	it("waits for the receipt only when the peer advertises pricing", async () => {
		const contact = makeActiveContact("conn-attn-4");
		const pricedPeer: ResolvedAgent = {
			...PEER_AGENT,
			attention: { version: "1.0", currency: "USDC", pricing: { standard: "0.001" } },
		};
		const { service, transport } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				resolver: createStaticResolver(pricedPeer),
			},
		);
		await service.start();
		try {
			await service.sendMessage("Bob", "hi");
			expect(transport.sentMessages[0]?.options?.waitForAck).toBe(true);
		} finally {
			await service.stop();
		}
	});

	it("keeps fire-and-forget sends for peers without pricing", async () => {
		const contact = makeActiveContact("conn-attn-5");
		const { service, transport } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]) },
		);
		await service.start();
		try {
			await service.sendMessage("Bob", "hi");
			expect(transport.sentMessages[0]?.options?.waitForAck).toBe(false);
		} finally {
			await service.stop();
		}
	});
});

describe("postage", () => {
	const ATTENTION_CONFIG = {
		attention: { enforce: true, pricing: { grantHolder: "0", standard: "0.001" } },
	};
	const PEER_KEY = postagePeerKey({ chain: PEER_AGENT.chain, agentId: PEER_AGENT.agentId });
	const PRICED_PEER: ResolvedAgent = {
		...PEER_AGENT,
		attention: { version: "1.0", currency: "USDC", pricing: { standard: "0.001" } },
	};

	function stampedMessage(contact: Contact, stamp: PostageStamp, text = "hello"): ProtocolMessage {
		return buildOutgoingMessageRequest(contact, text, undefined, { postage: stamp });
	}

	function sentMetadata(sent: { message: ProtocolMessage }): TrustedAgentMetadata | undefined {
		const params = sent.message.params as MessageSendParams | undefined;
		return params?.message?.metadata?.trustedAgent;
	}

	function sentDataPart(sent: { message: ProtocolMessage }): Record<string, unknown> | undefined {
		const params = sent.message.params as
			| { message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> } }
			| {
					requestId?: string;
					message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> };
			  }
			| undefined;
		return params?.message?.parts?.find((part) => part.kind === "data")?.data;
	}

	async function seedIssuedCredit(
		dataDir: string,
		overrides: Partial<Parameters<FilePostageLedger["recordIssued"]>[0]> = {},
	): Promise<void> {
		await new FilePostageLedger(dataDir).recordIssued({
			creditId: "credit-1",
			peer: PEER_KEY,
			amount: "0.01",
			txHash: "0xseed",
			...overrides,
		});
	}

	it("accepts and debits a stamped message from an un-granted sender", async () => {
		const contact = makeActiveContact("conn-postage-1");
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir);
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
				}),
			).resolves.toEqual({ status: "received" });
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.issued["credit-1"]).toMatchObject({ spent: "0.001", lastSeq: 1 });
		} finally {
			await service.stop();
		}
	});

	it("rejects an un-granted, un-stamped message with reason missing_stamp", async () => {
		const contact = makeActiveContact("conn-postage-2");
		const { service, transport, requestJournal } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			const message = buildOutgoingMessageRequest(contact, "hello");
			const injection = transport.handlers.onRequest?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-postage",
				message,
			});
			await expect(injection).rejects.toMatchObject({
				rpcCode: -32050,
				postage: { reason: "missing_stamp" },
			});
			const entry = await requestJournal.getByRequestId(String(message.id));
			expect(entry?.status).toBe("completed");
		} finally {
			await service.stop();
		}
	});

	it("rejects stamps drawing on an unknown credit", async () => {
		const contact = makeActiveContact("conn-postage-3");
		const { service, transport } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "ghost", seq: 1, cost: "0.001" }),
				}),
			).rejects.toMatchObject({
				rpcCode: -32050,
				postage: { reason: "unknown_credit", creditId: "ghost" },
			});
		} finally {
			await service.stop();
		}
	});

	it("rejects a replayed seq without double-spending", async () => {
		const contact = makeActiveContact("conn-postage-4");
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir);
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
				}),
			).resolves.toEqual({ status: "received" });
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(
						contact,
						{ creditId: "credit-1", seq: 1, cost: "0.001" },
						"again",
					),
				}),
			).rejects.toMatchObject({ postage: { reason: "seq_replayed" } });
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.issued["credit-1"]?.spent).toBe("0.001");
		} finally {
			await service.stop();
		}
	});

	it("rejects an exhausted credit with the remaining balance in the quote data", async () => {
		const contact = makeActiveContact("conn-postage-5");
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir, { amount: "0.001" });
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
				}),
			).resolves.toEqual({ status: "received" });
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 2, cost: "0.001" }, "more"),
				}),
			).rejects.toMatchObject({
				postage: { reason: "insufficient_credit", remaining: "0", required: "0.001" },
			});
		} finally {
			await service.stop();
		}
	});

	it("never debits grant holders, stamped or not", async () => {
		const contact = makeActiveContact("conn-postage-6");
		contact.permissions.grantedByMe = createGrantSet(
			[{ grantId: "grant-msg-1", scope: "message/send" }],
			"2026-03-08T00:00:00.000Z",
		);
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir);
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
				}),
			).resolves.toEqual({ status: "received" });
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.issued["credit-1"]).toMatchObject({ spent: "0", lastSeq: 0 });
		} finally {
			await service.stop();
		}
	});

	it("stays granted-peers-only when no standard price is published", async () => {
		const contact = makeActiveContact("conn-postage-7");
		const { service, transport, dataDir } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				configOverrides: { attention: { enforce: true, pricing: { grantHolder: "0" } } },
			},
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir);
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
				}),
			).rejects.toMatchObject({ postage: { reason: "unpriced" } });
		} finally {
			await service.stop();
		}
	});

	it("auto-stamps outbound messages to priced peers from a held credit", async () => {
		const contact = makeActiveContact("conn-postage-8");
		const { service, transport, dataDir } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				resolver: createStaticResolver(PRICED_PEER),
			},
		);
		await service.start();
		try {
			await new FilePostageLedger(dataDir).recordHeld({
				creditId: "held-1",
				peer: PEER_KEY,
				amount: "0.002",
				txHash: "0xseed",
			});
			await service.sendMessage("Bob", "one");
			await service.sendMessage("Bob", "two");
			await service.sendMessage("Bob", "three");
			expect(sentMetadata(transport.sentMessages[0]!)?.postage).toEqual({
				creditId: "held-1",
				seq: 1,
				cost: "0.001",
			});
			expect(sentMetadata(transport.sentMessages[1]!)?.postage).toEqual({
				creditId: "held-1",
				seq: 2,
				cost: "0.001",
			});
			// Credit exhausted: the third message still goes out, unstamped —
			// an enforcing receiver answers it with the -32050 topup quote.
			expect(sentMetadata(transport.sentMessages[2]!)?.postage).toBeUndefined();
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held["held-1"]).toMatchObject({ spent: "0.002", nextSeq: 3 });
		} finally {
			await service.stop();
		}
	});

	it("does not stamp when holding a message/send grant from the peer", async () => {
		const contact = makeActiveContact("conn-postage-9");
		contact.permissions.grantedByPeer = createGrantSet(
			[{ grantId: "grant-msg-2", scope: "message/send" }],
			"2026-03-08T00:00:00.000Z",
		);
		const { service, transport, dataDir } = await createService(
			{},
			{
				trustStore: createMemoryTrustStore([contact]),
				resolver: createStaticResolver(PRICED_PEER),
			},
		);
		await service.start();
		try {
			await new FilePostageLedger(dataDir).recordHeld({
				creditId: "held-1",
				peer: PEER_KEY,
				amount: "0.01",
				txHash: "0xseed",
			});
			await service.sendMessage("Bob", "free ride");
			expect(sentMetadata(transport.sentMessages[0]!)?.postage).toBeUndefined();
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held["held-1"]?.spent).toBe("0");
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage pays, awaits the certificate, verifies it, and records the held credit", async () => {
		const contact = makeActiveContact("conn-postage-10");
		const executeTransfer = vi.fn(async () => ({ txHash: "0xtopup" as `0x${string}` }));
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), hooks: { executeTransfer } },
		);
		await service.start();
		try {
			const topup = service.topUpPostage("Bob", { amount: "0.01", waitMs: 5000 });
			await vi.waitFor(() => {
				expect(transport.sentMessages.length).toBeGreaterThan(0);
			});
			const sentRequest = transport.sentMessages[0]!;
			const payload = sentDataPart(sentRequest)!;
			expect(payload).toMatchObject({ type: "postage/topup", amount: "0.01", txHash: "0xtopup" });
			const certificate = await signPostageCredit(BOB_SIGNING_PROVIDER, {
				creditId: payload.creditId as string,
				issuerChain: contact.peerChain,
				issuerAgentId: contact.peerAgentId,
				holderAgentId: 1,
				amount: "0.01",
				txHash: "0xtopup",
			});
			const resultMessage = buildOutgoingActionResult(
				contact,
				String(sentRequest.message.id),
				"ok",
				{
					type: "postage/topup",
					actionId: payload.actionId,
					creditId: payload.creditId,
					status: "accepted",
					amount: "0.01",
					certificate,
				},
				"postage/topup",
				"completed",
			);
			await transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-postage",
				message: resultMessage,
			});
			const result = await topup;
			expect(result.status).toBe("accepted");
			expect(result.certificateVerified).toBe(true);
			expect(result.txHash).toBe("0xtopup");
			expect(executeTransfer).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					asset: "usdc",
					amount: "0.01",
					toAddress: contact.peerAgentAddress,
				}),
			);
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held[result.creditId]).toMatchObject({
				peer: PEER_KEY,
				amount: "0.01",
				certificateVerified: true,
			});
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage records the held credit optimistically when the peer never answers", async () => {
		const contact = makeActiveContact("conn-postage-11");
		const executeTransfer = vi.fn(async () => ({ txHash: "0xtopup" as `0x${string}` }));
		const { service, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), hooks: { executeTransfer } },
		);
		await service.start();
		try {
			const result = await service.topUpPostage("Bob", { amount: "0.01", waitMs: 100 });
			expect(result.status).toBe("pending");
			expect(result.certificateVerified).toBe(false);
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held[result.creditId]).toMatchObject({ amount: "0.01", peer: PEER_KEY });
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage surfaces a peer rejection without recording a held credit", async () => {
		const contact = makeActiveContact("conn-postage-12");
		const executeTransfer = vi.fn(async () => ({ txHash: "0xtopup" as `0x${string}` }));
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), hooks: { executeTransfer } },
		);
		await service.start();
		try {
			const topup = service.topUpPostage("Bob", { amount: "0.01", waitMs: 5000 });
			await vi.waitFor(() => {
				expect(transport.sentMessages.length).toBeGreaterThan(0);
			});
			const sentRequest = transport.sentMessages[0]!;
			const payload = sentDataPart(sentRequest)!;
			const resultMessage = buildOutgoingActionResult(
				contact,
				String(sentRequest.message.id),
				"no",
				{
					type: "postage/topup",
					actionId: payload.actionId,
					creditId: payload.creditId,
					status: "rejected",
					error: { code: "TOPUP_UNVERIFIED", message: "payment not found" },
				},
				"postage/topup",
				"failed",
			);
			await transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-postage",
				message: resultMessage,
			});
			const result = await topup;
			expect(result.status).toBe("rejected");
			expect(result.error).toContain("payment not found");
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held[result.creditId]).toBeUndefined();
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage keeps the paid credit on record when the request send fails", async () => {
		const contact = makeActiveContact("conn-postage-16");
		const executeTransfer = vi.fn(async () => ({ txHash: "0xtopup" as `0x${string}` }));
		const { service, dataDir } = await createService(
			{ sendError: new Error("xmtp publish failed") },
			{ trustStore: createMemoryTrustStore([contact]), hooks: { executeTransfer } },
		);
		await service.start();
		try {
			// The payment happened before the send failed, so the call must
			// NOT throw: the result carries the txHash recovery handle and the
			// held credit stays recorded.
			const result = await service.topUpPostage("Bob", { amount: "0.01", waitMs: 500 });
			expect(result.status).toBe("pending");
			expect(result.txHash).toBe("0xtopup");
			expect(result.error).toContain("xmtp publish failed");
			expect(result.error).toContain("0xtopup");
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held[result.creditId]).toMatchObject({ amount: "0.01", peer: PEER_KEY });
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage treats a delivered result without actionId as a rejection, not a timeout", async () => {
		const contact = makeActiveContact("conn-postage-17");
		const executeTransfer = vi.fn(async () => ({ txHash: "0xtopup" as `0x${string}` }));
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), hooks: { executeTransfer } },
		);
		await service.start();
		try {
			const topup = service.topUpPostage("Bob", { amount: "0.01", waitMs: 5000 });
			await vi.waitFor(() => {
				expect(transport.sentMessages.length).toBeGreaterThan(0);
			});
			const sentRequest = transport.sentMessages[0]!;
			// A pre-postage peer answers postage/topup with UNSUPPORTED_ACTION:
			// a result whose data part has neither type nor actionId.
			const resultMessage = buildOutgoingActionResult(
				contact,
				String(sentRequest.message.id),
				"unsupported",
				{ error: { code: "UNSUPPORTED_ACTION", message: "No handler for action: postage/topup" } },
				"postage/topup",
				"failed",
			);
			await transport.handlers.onResult?.({
				from: contact.peerAgentId,
				senderInboxId: "peer-inbox-postage",
				message: resultMessage,
			});
			const result = await topup;
			expect(result.status).toBe("rejected");
			expect(result.error).toContain("No handler for action");
			// The provisional held credit is removed — a peer that refused the
			// topup must never feed auto-stamping.
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.held[result.creditId]).toBeUndefined();
		} finally {
			await service.stop();
		}
	});

	it("redelivering an accepted stamped message before its journal entry completed does not double-debit", async () => {
		const contact = makeActiveContact("conn-postage-18");
		const { service, transport, requestJournal, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]), configOverrides: ATTENTION_CONFIG },
		);
		await service.start();
		try {
			await seedIssuedCredit(dataDir);
			const message = stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" });
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message,
				}),
			).resolves.toEqual({ status: "received" });
			// Simulate a crash between the persisted debit and the journal
			// completing: the redelivered message arrives with its entry still
			// pending, re-runs enforcement, and must pass idempotently.
			await requestJournal.updateStatus(String(message.id), "pending");
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message,
				}),
			).resolves.toEqual({ status: "duplicate" });
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.issued["credit-1"]).toMatchObject({ spent: "0.001", lastSeq: 1 });
		} finally {
			await service.stop();
		}
	});

	it("topUpPostage requires a transfer executor", async () => {
		const contact = makeActiveContact("conn-postage-13");
		const { service } = await createService({}, { trustStore: createMemoryTrustStore([contact]) });
		await service.start();
		try {
			await expect(service.topUpPostage("Bob", { amount: "0.01" })).rejects.toThrow(
				"No transfer executor configured",
			);
		} finally {
			await service.stop();
		}
	});

	it("dispatches inbound postage/topup to the built-in app and returns a signed certificate", async () => {
		const contact = makeActiveContact("conn-postage-14");
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]) },
		);
		await service.start();
		try {
			const payload = buildPostageTopupPayload({
				amount: "0.05",
				chain: "eip155:8453",
				txHash: "0xinbound",
				actionId: "topup-action-1",
				creditId: "inbound-credit-1",
			});
			const request = buildOutgoingActionRequest(contact, "topup", payload, "postage/topup");
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: request,
				}),
			).resolves.toEqual({ status: "queued" });
			await vi.waitFor(() => {
				expect(transport.sentMessages.length).toBeGreaterThan(0);
			});
			const result = transport.sentMessages[0]!;
			expect(result.message.method).toBe("action/result");
			const data = sentDataPart(result)!;
			expect(data).toMatchObject({
				type: "postage/topup",
				actionId: "topup-action-1",
				creditId: "inbound-credit-1",
				status: "accepted",
				amount: "0.05",
			});
			// The certificate is signed by this service's own signing provider.
			const verification = await verifyPostageCredit(
				{
					creditId: "inbound-credit-1",
					issuerChain: "eip155:8453",
					issuerAgentId: 1,
					holderAgentId: contact.peerAgentId,
					amount: "0.05",
					txHash: "0xinbound",
				},
				data.certificate as `0x${string}`,
				ALICE.address,
			);
			expect(verification.valid).toBe(true);
			const state = await new FilePostageLedger(dataDir).read();
			expect(state.issued["inbound-credit-1"]).toMatchObject({
				peer: PEER_KEY,
				amount: "0.05",
				spent: "0",
			});
		} finally {
			await service.stop();
		}
	});

	it("answers postage/balance with the asking peer's credits only", async () => {
		const contact = makeActiveContact("conn-postage-15");
		const { service, transport, dataDir } = await createService(
			{},
			{ trustStore: createMemoryTrustStore([contact]) },
		);
		await service.start();
		try {
			const ledger = new FilePostageLedger(dataDir);
			await ledger.recordIssued({
				creditId: "mine",
				peer: PEER_KEY,
				amount: "0.01",
				txHash: "0x1",
			});
			await ledger.recordIssued({
				creditId: "other",
				peer: postagePeerKey({ chain: "eip155:8453", agentId: 999 }),
				amount: "0.5",
				txHash: "0x2",
			});
			const request = buildOutgoingActionRequest(
				contact,
				"balance",
				{ type: "postage/balance", actionId: "balance-action-1" },
				"postage/balance",
			);
			await expect(
				transport.handlers.onRequest?.({
					from: contact.peerAgentId,
					senderInboxId: "peer-inbox-postage",
					message: request,
				}),
			).resolves.toEqual({ status: "queued" });
			await vi.waitFor(() => {
				expect(transport.sentMessages.length).toBeGreaterThan(0);
			});
			const data = sentDataPart(transport.sentMessages[0]!)!;
			expect(data).toMatchObject({
				type: "postage/balance",
				actionId: "balance-action-1",
				status: "completed",
				totalRemaining: "0.01",
			});
			expect(data.credits).toEqual([
				{ creditId: "mine", amount: "0.01", spent: "0", remaining: "0.01", lastSeq: 0 },
			]);
		} finally {
			await service.stop();
		}
	});

	describe("priority tiers (paid wake-ups)", () => {
		const PRIORITY_CONFIG = {
			attention: {
				enforce: true,
				pricing: { grantHolder: "0", standard: "0.001", priority: "0.01" },
			},
		};
		const PRIORITY_PRICED_PEER: ResolvedAgent = {
			...PEER_AGENT,
			attention: {
				version: "1.0",
				currency: "USDC",
				pricing: { standard: "0.001", priority: "0.01" },
			},
		};

		function collectMessageEvents(): {
			events: Array<{ postage?: { tier: string; cost: string } }>;
			hooks: { onTypedEvent: (event: { type: string }) => void };
		} {
			const events: Array<{ postage?: { tier: string; cost: string } }> = [];
			return {
				events,
				hooks: {
					onTypedEvent: (event) => {
						if (event.type === "message.received") {
							events.push(event as (typeof events)[number]);
						}
					},
				},
			};
		}

		it("marks the paid tier on the message.received event", async () => {
			const contact = makeActiveContact("conn-prio-1");
			const { events, hooks } = collectMessageEvents();
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				await seedIssuedCredit(dataDir, { amount: "0.05" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
					}),
				).resolves.toEqual({ status: "received" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(
							contact,
							{ creditId: "credit-1", seq: 2, cost: "0.01" },
							"urgent",
						),
					}),
				).resolves.toEqual({ status: "received" });
				expect(events).toHaveLength(2);
				expect(events[0]?.postage).toEqual({ tier: "standard", cost: "0.001" });
				expect(events[1]?.postage).toEqual({ tier: "priority", cost: "0.01" });
			} finally {
				await service.stop();
			}
		});

		it("charges grant holders for priority stamps — the grant buys delivery, not the wake-up", async () => {
			const contact = makeActiveContact("conn-prio-2");
			contact.permissions.grantedByMe = createGrantSet(
				[{ grantId: "grant-msg-1", scope: "message/send" }],
				"2026-03-08T00:00:00.000Z",
			);
			const { events, hooks } = collectMessageEvents();
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				await seedIssuedCredit(dataDir, { amount: "0.05" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.01" }),
					}),
				).resolves.toEqual({ status: "received" });
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.issued["credit-1"]).toMatchObject({ spent: "0.01", lastSeq: 1 });
				expect(events[0]?.postage).toEqual({ tier: "priority", cost: "0.01" });
			} finally {
				await service.stop();
			}
		});

		it("degrades a grant holder's bad priority stamp to plain grant delivery", async () => {
			const contact = makeActiveContact("conn-prio-3");
			contact.permissions.grantedByMe = createGrantSet(
				[{ grantId: "grant-msg-1", scope: "message/send" }],
				"2026-03-08T00:00:00.000Z",
			);
			const { events, hooks } = collectMessageEvents();
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				// Unknown credit: the stamp cannot be charged, but a grant
				// holder is never rejected — the message lands without a wake.
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(contact, { creditId: "ghost", seq: 1, cost: "0.01" }),
					}),
				).resolves.toEqual({ status: "received" });
				expect(events[0]?.postage).toBeUndefined();
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.issued).toEqual({});
			} finally {
				await service.stop();
			}
		});

		it("does not charge grant holders for standard-value stamps", async () => {
			const contact = makeActiveContact("conn-prio-4");
			contact.permissions.grantedByMe = createGrantSet(
				[{ grantId: "grant-msg-1", scope: "message/send" }],
				"2026-03-08T00:00:00.000Z",
			);
			const { events, hooks } = collectMessageEvents();
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				await seedIssuedCredit(dataDir, { amount: "0.05" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.001" }),
					}),
				).resolves.toEqual({ status: "received" });
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.issued["credit-1"]).toMatchObject({ spent: "0", lastSeq: 0 });
				expect(events[0]?.postage).toBeUndefined();
			} finally {
				await service.stop();
			}
		});

		it("priority sends pay the peer's priority price even while holding a grant", async () => {
			const contact = makeActiveContact("conn-prio-5");
			contact.permissions.grantedByPeer = createGrantSet(
				[{ grantId: "grant-msg-2", scope: "message/send" }],
				"2026-03-08T00:00:00.000Z",
			);
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					resolver: createStaticResolver(PRIORITY_PRICED_PEER),
				},
			);
			await service.start();
			try {
				await new FilePostageLedger(dataDir).recordHeld({
					creditId: "held-1",
					peer: PEER_KEY,
					amount: "0.05",
					txHash: "0xseed",
				});
				await service.sendMessage("Bob", "wake up", undefined, { priority: true });
				expect(sentMetadata(transport.sentMessages[0]!)?.postage).toEqual({
					creditId: "held-1",
					seq: 1,
					cost: "0.01",
				});
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.held["held-1"]?.spent).toBe("0.01");
			} finally {
				await service.stop();
			}
		});

		it("does not stamp an un-granted priority send when the peer has no standard price", async () => {
			const contact = makeActiveContact("conn-prio-7");
			// Priority-only pricing: this receiver admits un-granted mail
			// never, so stamping would burn the credit on a doomed message.
			const priorityOnlyPeer: ResolvedAgent = {
				...PEER_AGENT,
				attention: { version: "1.0", currency: "USDC", pricing: { priority: "0.01" } },
			};
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					resolver: createStaticResolver(priorityOnlyPeer),
				},
			);
			await service.start();
			try {
				await new FilePostageLedger(dataDir).recordHeld({
					creditId: "held-1",
					peer: PEER_KEY,
					amount: "0.05",
					txHash: "0xseed",
				});
				await service.sendMessage("Bob", "urgent into the void", undefined, { priority: true });
				expect(sentMetadata(transport.sentMessages[0]!)?.postage).toBeUndefined();
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.held["held-1"]?.spent).toBe("0");
			} finally {
				await service.stop();
			}
		});

		it("priority sends bypass the pricing cache; normal sends use it", async () => {
			const contact = makeActiveContact("conn-prio-8");
			const maxAges: Array<number | undefined> = [];
			const resolver: IAgentResolver = {
				resolve: async () => PRIORITY_PRICED_PEER,
				resolveWithCache: async (_agentId, _chain, maxAgeMs) => {
					maxAges.push(maxAgeMs);
					return PRIORITY_PRICED_PEER;
				},
			};
			const { service, dataDir } = await createService(
				{},
				{ trustStore: createMemoryTrustStore([contact]), resolver },
			);
			await service.start();
			try {
				await new FilePostageLedger(dataDir).recordHeld({
					creditId: "held-1",
					peer: PEER_KEY,
					amount: "0.05",
					txHash: "0xseed",
				});
				await service.sendMessage("Bob", "urgent", undefined, { priority: true });
				await service.sendMessage("Bob", "calm");
				// A stale cached priority price would debit the credit for a
				// wake-up the receiver no longer sells at that price.
				expect(maxAges[0]).toBe(0);
				expect(maxAges[1]).toBe(60_000);
			} finally {
				await service.stop();
			}
		});

		it("charges an over-standard, under-priority stamp in full at standard tier", async () => {
			const contact = makeActiveContact("conn-prio-9");
			const { events, hooks } = collectMessageEvents();
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				await seedIssuedCredit(dataDir, { amount: "0.05" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message: stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.005" }),
					}),
				).resolves.toEqual({ status: "received" });
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.issued["credit-1"]?.spent).toBe("0.005");
				expect(events[0]?.postage).toEqual({ tier: "standard", cost: "0.005" });
			} finally {
				await service.stop();
			}
		});

		it("re-emits the purchased event when a paid message is redelivered in the crash window", async () => {
			const contact = makeActiveContact("conn-prio-10");
			const { events, hooks } = collectMessageEvents();
			const { service, transport, requestJournal, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					configOverrides: PRIORITY_CONFIG,
					hooks,
				},
			);
			await service.start();
			try {
				await seedIssuedCredit(dataDir, { amount: "0.05" });
				const message = stampedMessage(contact, { creditId: "credit-1", seq: 1, cost: "0.01" });
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message,
					}),
				).resolves.toEqual({ status: "received" });
				// Crash between the persisted debit and the journal completing:
				// the redelivery must re-emit the event the stamp paid for —
				// the charge stands, so the wake-up must not be lost.
				await requestJournal.updateStatus(String(message.id), "pending");
				await expect(
					transport.handlers.onRequest?.({
						from: contact.peerAgentId,
						senderInboxId: "peer-inbox-prio",
						message,
					}),
				).resolves.toEqual({ status: "duplicate" });
				expect(events).toHaveLength(2);
				expect(events[1]?.postage).toEqual({ tier: "priority", cost: "0.01" });
				// Still charged exactly once.
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.issued["credit-1"]?.spent).toBe("0.01");
			} finally {
				await service.stop();
			}
		});

		it("priority falls back to normal treatment when the peer has no priority price", async () => {
			const contact = makeActiveContact("conn-prio-6");
			contact.permissions.grantedByPeer = createGrantSet(
				[{ grantId: "grant-msg-2", scope: "message/send" }],
				"2026-03-08T00:00:00.000Z",
			);
			const { service, transport, dataDir } = await createService(
				{},
				{
					trustStore: createMemoryTrustStore([contact]),
					resolver: createStaticResolver(PRICED_PEER),
				},
			);
			await service.start();
			try {
				await new FilePostageLedger(dataDir).recordHeld({
					creditId: "held-1",
					peer: PEER_KEY,
					amount: "0.05",
					txHash: "0xseed",
				});
				await service.sendMessage("Bob", "wake up please", undefined, { priority: true });
				// No priority tier advertised: the grant's free ride wins and
				// nothing is stamped.
				expect(sentMetadata(transport.sentMessages[0]!)?.postage).toBeUndefined();
				const state = await new FilePostageLedger(dataDir).read();
				expect(state.held["held-1"]?.spent).toBe("0");
			} finally {
				await service.stop();
			}
		});
	});
});
