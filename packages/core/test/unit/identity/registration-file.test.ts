import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityError } from "../../../src/common/index.js";
import {
	fetchRegistrationFile,
	validateRegistrationFile,
} from "../../../src/identity/registration-file.js";
import {
	REGISTRATION_INVALID_ADDRESS,
	REGISTRATION_MISSING_PROTOCOL,
	REGISTRATION_MISSING_SERVICES,
	REGISTRATION_MISSING_TYPE,
	REGISTRATION_NO_XMTP_SERVICE,
	REGISTRATION_WRONG_TYPE,
	VALID_MIXED_REGISTRATION_FILE,
	VALID_REGISTRATION_FILE,
	VALID_XMTP_REGISTRATION_FILE,
} from "../../fixtures/registration-files.js";

describe("validateRegistrationFile", () => {
	it("should accept a valid registration file", () => {
		const result = validateRegistrationFile(VALID_REGISTRATION_FILE);

		expect(result.type).toBe("eip-8004-registration-v1");
		expect(result.name).toBe("Alice's Agent");
		expect(result.services).toHaveLength(1);
		expect(result.trustedAgentProtocol.version).toBe("1.0");
	});

	it("should throw for a non-object input", () => {
		expect(() => validateRegistrationFile(null)).toThrow("must be a JSON object");
		expect(() => validateRegistrationFile("string")).toThrow("must be a JSON object");
		expect(() => validateRegistrationFile(42)).toThrow("must be a JSON object");
	});

	it.each([
		["type field is missing", REGISTRATION_MISSING_TYPE, "Invalid registration file type"],
		["type field has the wrong value", REGISTRATION_WRONG_TYPE, "Invalid registration file type"],
		["services array is empty", REGISTRATION_MISSING_SERVICES, "at least one service"],
		["no XMTP transport service is present", REGISTRATION_NO_XMTP_SERVICE, "xmtp"],
	])("should throw when %s", (_, input, expectedMessage) => {
		expect(() => validateRegistrationFile(input)).toThrow(expectedMessage);
	});

	it("should accept a valid XMTP-only registration file", () => {
		const result = validateRegistrationFile(VALID_XMTP_REGISTRATION_FILE);
		expect(result.services).toHaveLength(1);
		expect(result.services[0].name).toBe("xmtp");
	});

	it("should accept a well-formed attention price block and return it intact", () => {
		const withAttention = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				attention: {
					version: "1.0",
					currency: "USDC",
					chain: "eip155:8453",
					pricing: { grantHolder: "0", standard: "0.001", priority: "0.01" },
				},
			},
		};
		const result = validateRegistrationFile(withAttention);
		expect(result.trustedAgentProtocol.attention?.pricing.standard).toBe("0.001");
		expect(result.trustedAgentProtocol.attention?.currency).toBe("USDC");
	});

	it("should treat an absent attention block as no pricing", () => {
		const result = validateRegistrationFile(VALID_REGISTRATION_FILE);
		expect(result.trustedAgentProtocol.attention).toBeUndefined();
	});

	it("should accept unknown attention pricing tiers (additive)", () => {
		const withFutureTier = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				attention: {
					version: "1.0",
					currency: "USDC",
					pricing: { standard: "0.001", "some-future-tier": "5" },
				},
			},
		};
		expect(() => validateRegistrationFile(withFutureTier)).not.toThrow();
	});

	it.each([
		["attention is not an object", "must be an object", { attention: "cheap" }],
		[
			"attention version is missing",
			"non-empty version",
			{ attention: { currency: "USDC", pricing: {} } },
		],
		[
			"attention currency is missing",
			"non-empty currency",
			{ attention: { version: "1.0", pricing: {} } },
		],
		[
			"attention pricing is missing",
			"pricing object",
			{ attention: { version: "1.0", currency: "USDC" } },
		],
		[
			"a pricing amount is not a string",
			"decimal amount string",
			{ attention: { version: "1.0", currency: "USDC", pricing: { standard: 0.001 } } },
		],
		[
			"a pricing amount is not decimal",
			"decimal amount string",
			{ attention: { version: "1.0", currency: "USDC", pricing: { standard: "1,50" } } },
		],
		[
			"a pricing amount has more than 6 decimals",
			"decimal amount string",
			{ attention: { version: "1.0", currency: "USDC", pricing: { standard: "0.1234567" } } },
		],
	])("should throw when %s", (_, expectedMessage, tapOverride) => {
		const invalid = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				...tapOverride,
			},
		};
		expect(() => validateRegistrationFile(invalid)).toThrow(expectedMessage);
	});

	it("should tolerate unknown extra fields at every level (backward compat)", () => {
		const withExtras = {
			...VALID_REGISTRATION_FILE,
			someFutureTopLevelField: { nested: true },
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				someFutureProtocolField: "ignored",
			},
		};
		expect(() => validateRegistrationFile(withExtras)).not.toThrow();
	});

	it("should accept a registration file with both a2a and xmtp services", () => {
		const result = validateRegistrationFile(VALID_MIXED_REGISTRATION_FILE);
		expect(result.services).toHaveLength(2);
	});

	it("should throw when xmtp service has invalid Ethereum address endpoint", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			services: [{ name: "xmtp", endpoint: "not-an-address" }],
		};
		expect(() => validateRegistrationFile(file)).toThrow("valid Ethereum address");
	});

	it("should throw when xmtp endpoint does not match trustedAgentProtocol.agentAddress", () => {
		const file = {
			...VALID_XMTP_REGISTRATION_FILE,
			services: [{ name: "xmtp", endpoint: "0x1234567890123456789012345678901234567890" }],
		};
		expect(() => validateRegistrationFile(file)).toThrow(
			"XMTP service endpoint must match trustedAgentProtocol.agentAddress",
		);
	});

	it("should throw when trustedAgentProtocol is missing", () => {
		expect(() => validateRegistrationFile(REGISTRATION_MISSING_PROTOCOL)).toThrow(
			"trustedAgentProtocol",
		);
	});

	it("should throw when agentAddress is invalid", () => {
		expect(() => validateRegistrationFile(REGISTRATION_INVALID_ADDRESS)).toThrow(
			"valid agentAddress",
		);
	});

	it("should throw when name is empty", () => {
		const file = { ...VALID_REGISTRATION_FILE, name: "" };
		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});

	it("should throw when services contain invalid entries", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			services: [
				{ name: "xmtp", endpoint: VALID_REGISTRATION_FILE.services[0].endpoint },
				{ name: "", endpoint: "https://example.com/other" },
			],
		};
		expect(() => validateRegistrationFile(file)).toThrow("non-empty name");
	});

	it("should accept execution metadata when it is well-formed", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				execution: {
					mode: "eip7702",
					address: VALID_REGISTRATION_FILE.trustedAgentProtocol.agentAddress,
					paymaster: "circle",
				},
			},
		};

		const result = validateRegistrationFile(file);
		expect(result.trustedAgentProtocol.execution?.mode).toBe("eip7702");
		expect(result.trustedAgentProtocol.execution?.paymaster).toBe("circle");
	});

	it("should reject execution metadata with an invalid address", () => {
		const file = {
			...VALID_REGISTRATION_FILE,
			trustedAgentProtocol: {
				...VALID_REGISTRATION_FILE.trustedAgentProtocol,
				execution: {
					mode: "eip7702",
					address: "not-an-address",
				},
			},
		};

		expect(() => validateRegistrationFile(file)).toThrow("execution.address");
	});
});

describe("fetchRegistrationFile", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it.each(["not-a-uri", "https://[invalid"])(
		"should wrap malformed registration URIs in IdentityError: %s",
		async (uri) => {
			const fetchMock = vi.spyOn(globalThis, "fetch");
			const result = fetchRegistrationFile(uri);

			await expect(result).rejects.toBeInstanceOf(IdentityError);
			await expect(result).rejects.toThrow("Invalid registration URI");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://169.254.10.20/registration.json",
		"https://[::1]/registration.json",
		"https://[::ffff:127.0.0.1]/registration.json",
		"https://[fe80::1]/registration.json",
		"https://[fc00::1]/registration.json",
		"https://[fd12:3456::1]/registration.json",
	])("should reject unsafe registration hosts: %s", async (uri) => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const result = fetchRegistrationFile(uri);

		await expect(result).rejects.toBeInstanceOf(IdentityError);
		await expect(result).rejects.toThrow("Registration URI is not allowed");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects redirects to unsafe hosts", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: {
					location: "https://127.0.0.1/registration.json",
				},
			}),
		);

		await expect(
			fetchRegistrationFile("https://safe.example.test/registration.json"),
		).rejects.toThrow("Registration URI is not allowed");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
