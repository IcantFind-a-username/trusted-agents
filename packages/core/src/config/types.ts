export interface ChainConfig {
	chainId: number;
	caip2: string;
	name: string;
	rpcUrl: string;
	registryAddress: `0x${string}`;
	blockExplorerUrl?: string;
}

export type ExecutionMode = "eoa" | "eip4337" | "eip7702";
export type ExecutionPaymasterProvider = "circle" | "candide" | "servo";
export type IpfsUploadProvider = "auto" | "x402" | "pinata" | "tack";

export interface ExecutionConfig {
	mode?: ExecutionMode;
	paymasterProvider?: ExecutionPaymasterProvider;
}

export interface IpfsConfig {
	provider?: IpfsUploadProvider;
	tackApiUrl?: string;
}

export interface OwsConfig {
	wallet: string;
	apiKey: string;
}

export interface AttentionConfig {
	/**
	 * When true, inbound message/send from a sender holding no active
	 * "message/send" grant is rejected with JSON-RPC -32050 carrying a
	 * machine-readable quote. Off by default — the payment rail that makes
	 * paying the quote possible ships separately.
	 */
	enforce?: boolean;
	/** Advertised price list; tier name → decimal currency string (USDC). */
	pricing?: Record<string, string>;
}

export interface TrustedAgentsConfig {
	agentId: number;
	chain: string;
	ows: OwsConfig;
	dataDir: string;
	chains: Record<string, ChainConfig>;
	inviteExpirySeconds: number;
	resolveCacheTtlMs: number;
	resolveCacheMaxEntries: number;
	xmtpDbPath?: string;
	xmtpDbEncryptionKey?: `0x${string}`;
	execution?: ExecutionConfig;
	ipfs?: IpfsConfig;
	attention?: AttentionConfig;
}
