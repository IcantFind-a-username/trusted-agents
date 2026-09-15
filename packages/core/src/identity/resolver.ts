import type { PublicClient } from "viem";
import { IdentityError } from "../common/index.js";
import { nowISO } from "../common/index.js";
import type { ChainConfig } from "../config/index.js";
import { fetchRegistrationFile } from "./registration-file.js";
import { ERC8004Registry } from "./registry.js";
import type { ResolvedAgent } from "./types.js";

export interface IAgentResolver {
	resolve(agentId: number, chain: string): Promise<ResolvedAgent>;
	resolveWithCache(agentId: number, chain: string, maxAgeMs?: number): Promise<ResolvedAgent>;
}

interface CacheEntry {
	agent: ResolvedAgent;
	cachedAt: number;
}

interface AgentResolverOptions {
	maxCacheEntries?: number;
}

export class AgentResolver implements IAgentResolver {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly maxCacheEntries: number;

	constructor(
		private readonly chains: Record<string, ChainConfig>,
		private readonly createClient: (chainConfig: ChainConfig) => PublicClient,
		options?: AgentResolverOptions,
	) {
		this.maxCacheEntries = options?.maxCacheEntries ?? 1000;
	}

	async resolve(agentId: number, chain: string): Promise<ResolvedAgent> {
		const chainConfig = this.chains[chain];
		if (!chainConfig) {
			throw new IdentityError(`Unknown chain: ${chain}`);
		}

		const client = this.createClient(chainConfig);
		const registry = new ERC8004Registry(client, chainConfig.registryAddress);

		const [tokenURI, ownerAddress] = await Promise.all([
			registry.getTokenURI(agentId),
			registry.getOwner(agentId),
		]);

		const registrationFile = await fetchRegistrationFile(tokenURI);

		const xmtpService = registrationFile.services.find((s) => s.name === "xmtp");

		if (!xmtpService) {
			throw new IdentityError("Registration file has no XMTP transport service endpoint");
		}

		return {
			agentId,
			chain,
			ownerAddress,
			agentAddress: registrationFile.trustedAgentProtocol.agentAddress,
			xmtpEndpoint: xmtpService.endpoint as `0x${string}`,
			executionAddress: registrationFile.trustedAgentProtocol.execution?.address,
			executionMode: registrationFile.trustedAgentProtocol.execution?.mode,
			paymasterProvider: registrationFile.trustedAgentProtocol.execution?.paymaster,
			endpoint: xmtpService.endpoint,
			capabilities: registrationFile.trustedAgentProtocol.capabilities,
			attention: registrationFile.trustedAgentProtocol.attention,
			registrationFile,
			resolvedAt: nowISO(),
		};
	}

	async resolveWithCache(
		agentId: number,
		chain: string,
		maxAgeMs = 86400000,
	): Promise<ResolvedAgent> {
		const cacheKey = `${chain}:${agentId}`;
		const cached = this.cache.get(cacheKey);

		if (cached && Date.now() - cached.cachedAt < maxAgeMs) {
			return cached.agent;
		}

		const agent = await this.resolve(agentId, chain);

		this.cache.set(cacheKey, {
			agent,
			cachedAt: Date.now(),
		});
		this.evictIfNeeded();

		return agent;
	}

	private evictIfNeeded(): void {
		while (this.cache.size > this.maxCacheEntries) {
			const first = this.cache.keys().next();
			if (first.done) {
				return;
			}
			this.cache.delete(first.value);
		}
	}
}
