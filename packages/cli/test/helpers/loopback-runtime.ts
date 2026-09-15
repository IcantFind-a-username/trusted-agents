import {
	ACTION_RESULT,
	CONNECTION_RESULT,
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
} from "trusted-agents-core";
import type {
	IAgentResolver,
	ICalendarProvider,
	ProtocolMessage,
	RegistrationFileAttention,
	ResolvedAgent,
	TransportAck,
	TransportHandlers,
	TransportProvider,
	TransportReceipt,
} from "trusted-agents-core";
import { clearCliRuntimeOverride, setCliRuntimeOverride } from "../../src/lib/runtime-overrides.js";

interface TestAgentFixture {
	agentId: number;
	chain: string;
	address: `0x${string}`;
	name: string;
	description: string;
	capabilities: string[];
	attention?: RegistrationFileAttention;
}

interface LoopbackEnvelope {
	from: number;
	message: ProtocolMessage;
}

export function createResolvedAgentFixture(fixture: TestAgentFixture): ResolvedAgent {
	const address = fixture.address;
	return {
		agentId: fixture.agentId,
		chain: fixture.chain,
		ownerAddress: address,
		agentAddress: address,
		xmtpEndpoint: address,
		endpoint: undefined,
		capabilities: fixture.capabilities,
		attention: fixture.attention,
		registrationFile: {
			type: "eip-8004-registration-v1",
			name: fixture.name,
			description: fixture.description,
			services: [{ name: "xmtp", endpoint: address }],
			trustedAgentProtocol: {
				version: "1.0",
				agentAddress: address,
				capabilities: fixture.capabilities,
				attention: fixture.attention,
			},
		},
		resolvedAt: "2026-03-06T00:00:00.000Z",
	};
}

export class StaticAgentResolver implements IAgentResolver {
	private readonly byKey = new Map<string, ResolvedAgent>();

	constructor(agents: ResolvedAgent[]) {
		for (const agent of agents) {
			this.byKey.set(this.key(agent.agentId, agent.chain), agent);
		}
	}

	async resolve(agentId: number, chain: string): Promise<ResolvedAgent> {
		const agent = this.byKey.get(this.key(agentId, chain));
		if (!agent) {
			throw new Error(`Agent not found in static resolver: ${agentId} on ${chain}`);
		}
		return agent;
	}

	async resolveWithCache(agentId: number, chain: string): Promise<ResolvedAgent> {
		return await this.resolve(agentId, chain);
	}

	private key(agentId: number, chain: string): string {
		return `${agentId}:${chain}`;
	}
}

export class LoopbackTransportNetwork {
	private readonly stacks = new Map<number, LoopbackTransport[]>();
	private readonly mailboxes = new Map<number, LoopbackEnvelope[]>();

	register(agentId: number, transport: LoopbackTransport): void {
		const stack = this.stacks.get(agentId) ?? [];
		stack.push(transport);
		this.stacks.set(agentId, stack);
	}

	unregister(agentId: number, transport: LoopbackTransport): void {
		const stack = this.stacks.get(agentId);
		if (!stack) {
			return;
		}

		const index = stack.lastIndexOf(transport);
		if (index >= 0) {
			stack.splice(index, 1);
		}

		if (stack.length === 0) {
			this.stacks.delete(agentId);
			return;
		}

		this.stacks.set(agentId, stack);
	}

	getActive(agentId: number): LoopbackTransport | undefined {
		const stack = this.stacks.get(agentId);
		return stack?.[stack.length - 1];
	}

	async deliver(peerId: number, envelope: LoopbackEnvelope): Promise<TransportReceipt> {
		const peer = this.getActive(peerId);
		if (!peer) {
			const queued = this.mailboxes.get(peerId) ?? [];
			queued.push(structuredClone(envelope));
			this.mailboxes.set(peerId, queued);
			return createReceipt(envelope.message, "queued");
		}

		const ack = await peer.receive(structuredClone(envelope));
		return createReceipt(envelope.message, ack.status);
	}

	drain(agentId: number): LoopbackEnvelope[] {
		const queued = this.mailboxes.get(agentId) ?? [];
		this.mailboxes.delete(agentId);
		return queued.map((envelope) => structuredClone(envelope));
	}
}

export class LoopbackTransport implements TransportProvider {
	private handlers: TransportHandlers = {};
	private started = false;

	constructor(
		private readonly network: LoopbackTransportNetwork,
		private readonly localAgentId: number,
	) {}

	async send(peerId: number, message: ProtocolMessage): Promise<TransportReceipt> {
		return await this.network.deliver(peerId, {
			from: this.localAgentId,
			message: structuredClone(message) as ProtocolMessage,
		});
	}

	setHandlers(handlers: TransportHandlers): void {
		this.handlers = { ...handlers };
	}

	async isReachable(peerId: number): Promise<boolean> {
		return this.network.getActive(peerId) !== undefined;
	}

	async reconcile(): Promise<{ synced: true; processed: number }> {
		let processed = 0;
		for (const envelope of this.network.drain(this.localAgentId)) {
			await this.receive(envelope);
			processed += 1;
		}
		return { synced: true, processed };
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.network.register(this.localAgentId, this);
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) {
			return;
		}
		this.network.unregister(this.localAgentId, this);
		this.started = false;
	}

	async receive(envelope: LoopbackEnvelope): Promise<TransportAck> {
		const handler = isResultMethod(envelope.message.method)
			? this.handlers.onResult
			: this.handlers.onRequest;
		if (!handler) {
			return { status: "received" };
		}
		return await handler({
			from: envelope.from,
			senderInboxId: `loopback:${envelope.from}`,
			message: structuredClone(envelope.message) as ProtocolMessage,
		});
	}
}

export function installLoopbackRuntime(params: {
	dataDir: string;
	network: LoopbackTransportNetwork;
	resolver: StaticAgentResolver;
	txHashPrefix: string;
	calendarProvider?: ICalendarProvider;
}): void {
	// Real chains never reuse a transaction hash; the postage ledger relies
	// on that (one credit per txHash), so the mock executor must too.
	let txCounter = 0;
	setCliRuntimeOverride(params.dataDir, {
		createContext: () => ({
			trustStore: new FileTrustStore(params.dataDir),
			resolver: params.resolver,
			conversationLogger: new FileConversationLogger(params.dataDir),
			requestJournal: new FileRequestJournal(params.dataDir),
			...(params.calendarProvider ? { calendarProvider: params.calendarProvider } : {}),
		}),
		createTransport: (config) => new LoopbackTransport(params.network, config.agentId),
		executeTransferAction: async () => {
			txCounter += 1;
			// Fixed-width counter: formatTxHash right-pads with zeros, so a
			// variable-width suffix would collide (counter 1 "a11…0" ===
			// counter 16 "a110…0").
			return {
				txHash: formatTxHash(`${params.txHashPrefix}${txCounter.toString(16).padStart(8, "0")}`),
			};
		},
	});
}

export function clearLoopbackRuntime(dataDir: string): void {
	clearCliRuntimeOverride(dataDir);
}

function isResultMethod(method: string): boolean {
	return method === CONNECTION_RESULT || method === ACTION_RESULT;
}

function createReceipt(
	message: ProtocolMessage,
	status: TransportReceipt["status"],
): TransportReceipt {
	return {
		received: true,
		requestId: String(message.id),
		status,
		receivedAt: "2026-03-06T00:00:00.000Z",
	};
}

function formatTxHash(seed: string): `0x${string}` {
	const hex = seed.replace(/^0x/, "").toLowerCase();
	return `0x${hex.padEnd(64, "0").slice(0, 64)}` as `0x${string}`;
}
