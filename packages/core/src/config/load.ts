import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { resolveDataDir } from "../common/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import type {
	ChainConfig,
	ExecutionMode,
	ExecutionPaymasterProvider,
	IpfsUploadProvider,
	TrustedAgentsConfig,
} from "./types.js";

interface StoredYamlConfig {
	agent_id?: number;
	chain?: string;
	ows?: {
		wallet?: string;
		api_key?: string;
	};
	execution?: {
		mode?: ExecutionMode;
		paymaster_provider?: ExecutionPaymasterProvider;
	};
	xmtp?: {
		db_encryption_key?: string;
	};
	ipfs?: {
		provider?: IpfsUploadProvider;
		tack_api_url?: string;
	};
	attention?: {
		enforce?: boolean;
		pricing?: Record<string, string>;
	};
	chains?: Record<
		string,
		{
			rpc_url?: string;
			registry_address?: string;
		}
	>;
	invite_expiry_seconds?: number;
}

export interface LoadTrustedAgentConfigOptions {
	requireAgentId?: boolean;
	agentId?: number;
	chain?: string;
	owsWallet?: string;
	owsApiKey?: string;
	configPath?: string;
	extraChains?: Record<string, ChainConfig>;
	executionMode?: ExecutionMode;
	paymasterProvider?: ExecutionPaymasterProvider;
}

function resolveTrustedAgentConfigPath(dataDir: string): string {
	return join(resolveDataDir(dataDir), "config.yaml");
}

export function getDefaultExecutionModeForChain(chain: string): ExecutionMode {
	if (["base", "eip155:8453"].includes(chain)) {
		return "eip7702";
	}

	if (["taiko", "taiko-mainnet", "eip155:167000"].includes(chain)) {
		return "eip4337";
	}

	return "eoa";
}

export function getDefaultPaymasterProviderForMode(
	mode: ExecutionMode,
): ExecutionPaymasterProvider | undefined {
	if (mode === "eoa") {
		return undefined;
	}

	if (mode === "eip4337") {
		return "servo";
	}

	return DEFAULT_CONFIG.execution?.paymasterProvider ?? "circle";
}

export async function loadTrustedAgentConfigFromDataDir(
	dataDir: string,
	options: LoadTrustedAgentConfigOptions = {},
): Promise<TrustedAgentsConfig> {
	const resolvedDataDir = resolveDataDir(dataDir);
	const configPath = options.configPath ?? resolveTrustedAgentConfigPath(resolvedDataDir);
	const yaml = loadYamlConfig(configPath);

	const agentId = options.agentId ?? yaml?.agent_id;
	if (options.requireAgentId ?? true) {
		if (agentId === undefined || Number.isNaN(agentId) || agentId < 0) {
			throw new Error(
				"agent_id is required and must be >= 0. Set it in config.yaml or through the host runtime before using TAP",
			);
		}
	}

	const owsWallet = options.owsWallet ?? yaml?.ows?.wallet ?? "";
	const owsApiKey = options.owsApiKey ?? yaml?.ows?.api_key ?? "";
	const chain = options.chain ?? yaml?.chain ?? "eip155:8453";
	const executionMode =
		options.executionMode ?? yaml?.execution?.mode ?? getDefaultExecutionModeForChain(chain);
	const paymasterProvider =
		executionMode === "eoa"
			? undefined
			: (options.paymasterProvider ??
				yaml?.execution?.paymaster_provider ??
				getDefaultPaymasterProviderForMode(executionMode));
	const chains = {
		...DEFAULT_CONFIG.chains,
		...(options.extraChains ?? {}),
	};

	if (yaml?.chains) {
		for (const [caip2, override] of Object.entries(yaml.chains)) {
			const existing = chains[caip2];
			if (existing && override.rpc_url) {
				chains[caip2] = { ...existing, rpcUrl: override.rpc_url };
			}
			if (existing && override.registry_address) {
				chains[caip2] = {
					...existing,
					registryAddress: override.registry_address as `0x${string}`,
				};
			}
		}
	}

	return {
		agentId: agentId ?? 0,
		chain,
		ows: { wallet: owsWallet, apiKey: owsApiKey },
		dataDir: resolvedDataDir,
		chains,
		inviteExpirySeconds: yaml?.invite_expiry_seconds ?? DEFAULT_CONFIG.inviteExpirySeconds,
		resolveCacheTtlMs: DEFAULT_CONFIG.resolveCacheTtlMs,
		resolveCacheMaxEntries: DEFAULT_CONFIG.resolveCacheMaxEntries,
		xmtpDbEncryptionKey: yaml?.xmtp?.db_encryption_key as `0x${string}` | undefined,
		ipfs: {
			provider: yaml?.ipfs?.provider ?? DEFAULT_CONFIG.ipfs?.provider,
			tackApiUrl: yaml?.ipfs?.tack_api_url,
		},
		execution: {
			mode: executionMode,
			...(paymasterProvider ? { paymasterProvider } : {}),
		},
		...(yaml?.attention
			? {
					attention: {
						...(yaml.attention.enforce !== undefined ? { enforce: yaml.attention.enforce } : {}),
						...(yaml.attention.pricing ? { pricing: yaml.attention.pricing } : {}),
					},
				}
			: {}),
	};
}

function loadYamlConfig(configPath: string): StoredYamlConfig | undefined {
	if (!existsSync(configPath)) {
		return undefined;
	}
	return YAML.parse(readFileSync(configPath, "utf-8")) as StoredYamlConfig;
}
