export interface RegistrationFileService {
	name: string;
	endpoint: string;
}

export interface RegistrationFileExecution {
	mode: "eoa" | "eip4337" | "eip7702";
	address: `0x${string}`;
	paymaster?: string;
}

/**
 * Advertised attention price list: what it costs a peer to have a message
 * rendered into this agent's LLM context. Tier names are open (well-known:
 * "grantHolder", "standard", "priority"); values are decimal currency
 * strings (USDC, 6 decimals max). Absence of the block means no pricing —
 * old registrations stay valid and free.
 */
export interface RegistrationFileAttention {
	version: string;
	currency: string;
	/** CAIP-2 settlement chain hint; defaults to the registration's chain. */
	chain?: string;
	pricing: Record<string, string>;
}

export interface RegistrationFileTrustedAgentProtocol {
	version: string;
	agentAddress: `0x${string}`;
	capabilities: string[];
	execution?: RegistrationFileExecution;
	attention?: RegistrationFileAttention;
}

export interface RegistrationFile {
	type: "eip-8004-registration-v1";
	name: string;
	description: string;
	services: RegistrationFileService[];
	trustedAgentProtocol: RegistrationFileTrustedAgentProtocol;
}

export interface ResolvedAgent {
	agentId: number;
	chain: string;
	ownerAddress: `0x${string}`;
	agentAddress: `0x${string}`;
	xmtpEndpoint?: `0x${string}`;
	executionAddress?: `0x${string}`;
	executionMode?: "eoa" | "eip4337" | "eip7702";
	paymasterProvider?: string;
	endpoint?: string;
	capabilities: string[];
	attention?: RegistrationFileAttention;
	registrationFile: RegistrationFile;
	resolvedAt: string;
}
