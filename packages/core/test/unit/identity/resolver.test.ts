import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResolver } from "../../../src/identity/resolver.js";
import {
	VALID_MIXED_REGISTRATION_FILE,
	VALID_REGISTRATION_FILE,
	VALID_XMTP_REGISTRATION_FILE,
} from "../../fixtures/registration-files.js";
import { ALICE } from "../../fixtures/test-keys.js";
import { createMockPublicClient } from "../../helpers/mock-chain.js";

describe("AgentResolver", () => {
	const chains = {
		"eip155:1": {
			rpcUrl: "https://rpc.example.com",
			registryAddress: "0x0000000000000000000000000000000000001234" as `0x${string}`,
		},
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("should resolve an agent by querying the chain and fetching the registration file", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(VALID_REGISTRATION_FILE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const resolver = new AgentResolver(chains, () => mockClient);

		const result = await resolver.resolve(1, "eip155:1");

		expect(result.agentId).toBe(1);
		expect(result.chain).toBe("eip155:1");
		expect(result.ownerAddress).toBe(ALICE.address);
		expect(result.agentAddress).toBe(ALICE.address);
		expect(result.xmtpEndpoint?.toLowerCase()).toBe(ALICE.address.toLowerCase());
		expect(result.capabilities).toEqual(["scheduling", "general-chat"]);
		expect(result.resolvedAt).toBeDefined();

		fetchMock.mockRestore();
	});

	it("should surface execution metadata from the registration file", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					...VALID_REGISTRATION_FILE,
					trustedAgentProtocol: {
						...VALID_REGISTRATION_FILE.trustedAgentProtocol,
						execution: {
							mode: "eip7702",
							address: "0x00000000000000000000000000000000000000aa",
							paymaster: "circle",
						},
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const resolver = new AgentResolver(chains, () => mockClient);
		const result = await resolver.resolve(1, "eip155:1");

		expect(result.executionMode).toBe("eip7702");
		expect(result.executionAddress).toBe("0x00000000000000000000000000000000000000aa");
		expect(result.paymasterProvider).toBe("circle");

		fetchMock.mockRestore();
	});

	it("should surface attention pricing from the registration file", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					...VALID_REGISTRATION_FILE,
					trustedAgentProtocol: {
						...VALID_REGISTRATION_FILE.trustedAgentProtocol,
						attention: {
							version: "1.0",
							currency: "USDC",
							chain: "eip155:8453",
							pricing: { grantHolder: "0", standard: "0.001" },
						},
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const resolver = new AgentResolver(chains, () => mockClient);
		const result = await resolver.resolve(1, "eip155:1");

		expect(result.attention?.currency).toBe("USDC");
		expect(result.attention?.pricing).toEqual({ grantHolder: "0", standard: "0.001" });

		fetchMock.mockRestore();
	});

	it.each([
		["XMTP transport", 2, VALID_XMTP_REGISTRATION_FILE],
		["mixed services (XMTP always used)", 3, VALID_MIXED_REGISTRATION_FILE],
	] as const)("should resolve an agent with %s", async (_, agentId, registrationFile) => {
		const mockClient = createMockPublicClient({
			tokenURI: `https://example.com/agent/${agentId}/registration.json`,
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(registrationFile), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const resolver = new AgentResolver(chains, () => mockClient);
		const result = await resolver.resolve(agentId, "eip155:1");

		expect(result.xmtpEndpoint?.toLowerCase()).toBe(ALICE.address.toLowerCase());

		fetchMock.mockRestore();
	});

	it("should throw for an unknown chain", async () => {
		const resolver = new AgentResolver(chains, () => createMockPublicClient());

		await expect(resolver.resolve(1, "eip155:999")).rejects.toThrow("Unknown chain");
	});

	it("should cache resolved agents and return cached results within maxAge", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/1/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(VALID_REGISTRATION_FILE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const resolver = new AgentResolver(chains, () => mockClient);

		const result1 = await resolver.resolveWithCache(1, "eip155:1");
		const result2 = await resolver.resolveWithCache(1, "eip155:1");

		// Second call should use cache - fetch should only be called once
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result1.endpoint).toBe(result2.endpoint);

		fetchMock.mockRestore();
	});

	it("should create a resolver from config", async () => {
		const mockClient = createMockPublicClient({
			tokenURI: "https://example.com/agent/5/registration.json",
			ownerAddress: ALICE.address,
		});

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(VALID_REGISTRATION_FILE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const configChains = {
			"eip155:1": {
				chainId: 1,
				caip2: "eip155:1",
				name: "Ethereum",
				rpcUrl: "https://rpc.example.com",
				registryAddress: "0x0000000000000000000000000000000000001234" as `0x${string}`,
			},
		};

		const resolver = new AgentResolver(configChains, () => mockClient, {
			maxCacheEntries: 200,
		});
		const result = await resolver.resolve(5, "eip155:1");

		expect(result.agentId).toBe(5);
		fetchMock.mockRestore();
	});
});
