import { isIP } from "node:net";
import { IdentityError, isEthereumAddress, toErrorMessage } from "../common/index.js";
import type { RegistrationFile } from "./types.js";

export function validateRegistrationFile(data: unknown): RegistrationFile {
	if (typeof data !== "object" || data === null) {
		throw new IdentityError("Registration file must be a JSON object");
	}

	const obj = data as Record<string, unknown>;

	if (obj.type !== "eip-8004-registration-v1") {
		throw new IdentityError(
			`Invalid registration file type: ${String(obj.type)}. Expected "eip-8004-registration-v1"`,
		);
	}

	if (typeof obj.name !== "string" || obj.name.length === 0) {
		throw new IdentityError("Registration file must have a non-empty name");
	}

	if (typeof obj.description !== "string") {
		throw new IdentityError("Registration file must have a description");
	}

	if (!Array.isArray(obj.services) || obj.services.length === 0) {
		throw new IdentityError("Registration file must have at least one service");
	}

	const hasXmtpService = obj.services.some(
		(s: unknown) =>
			typeof s === "object" &&
			s !== null &&
			(s as Record<string, unknown>).name === "xmtp" &&
			typeof (s as Record<string, unknown>).endpoint === "string",
	);

	if (!hasXmtpService) {
		throw new IdentityError("Registration file must have an 'xmtp' transport service");
	}

	for (const service of obj.services) {
		if (typeof service !== "object" || service === null) {
			throw new IdentityError("Each service must be an object");
		}
		const svc = service as Record<string, unknown>;
		if (typeof svc.name !== "string" || svc.name.length === 0) {
			throw new IdentityError("Each service must have a non-empty name");
		}
		if (typeof svc.endpoint !== "string" || svc.endpoint.length === 0) {
			throw new IdentityError("Each service must have a non-empty endpoint");
		}
		if (svc.name === "xmtp") {
			if (!isEthereumAddress(svc.endpoint)) {
				throw new IdentityError(
					`XMTP service endpoint must be a valid Ethereum address: ${String(svc.endpoint)}`,
				);
			}
		} else {
			let endpointUrl: URL;
			try {
				endpointUrl = new URL(svc.endpoint);
			} catch {
				throw new IdentityError(`Invalid service endpoint URL: ${String(svc.endpoint)}`);
			}
			if (endpointUrl.protocol !== "https:") {
				throw new IdentityError(`Service endpoint must use https: ${String(svc.endpoint)}`);
			}
		}
	}

	if (typeof obj.trustedAgentProtocol !== "object" || obj.trustedAgentProtocol === null) {
		throw new IdentityError("Registration file must have a trustedAgentProtocol section");
	}

	const tap = obj.trustedAgentProtocol as Record<string, unknown>;

	if (typeof tap.version !== "string" || tap.version.length === 0) {
		throw new IdentityError("trustedAgentProtocol must have a non-empty version");
	}

	if (typeof tap.agentAddress !== "string" || !isEthereumAddress(tap.agentAddress)) {
		throw new IdentityError("trustedAgentProtocol must have a valid agentAddress");
	}

	if (!Array.isArray(tap.capabilities)) {
		throw new IdentityError("trustedAgentProtocol must have a capabilities array");
	}

	if (tap.execution !== undefined) {
		if (typeof tap.execution !== "object" || tap.execution === null) {
			throw new IdentityError("trustedAgentProtocol.execution must be an object");
		}

		const execution = tap.execution as Record<string, unknown>;
		if (execution.mode !== "eoa" && execution.mode !== "eip4337" && execution.mode !== "eip7702") {
			throw new IdentityError(
				"trustedAgentProtocol.execution.mode must be eoa, eip4337, or eip7702",
			);
		}

		if (typeof execution.address !== "string" || !isEthereumAddress(execution.address)) {
			throw new IdentityError(
				"trustedAgentProtocol.execution.address must be a valid Ethereum address",
			);
		}

		if (
			execution.paymaster !== undefined &&
			(typeof execution.paymaster !== "string" || execution.paymaster.length === 0)
		) {
			throw new IdentityError(
				"trustedAgentProtocol.execution.paymaster must be a non-empty string",
			);
		}
	}

	if (tap.attention !== undefined) {
		if (typeof tap.attention !== "object" || tap.attention === null) {
			throw new IdentityError("trustedAgentProtocol.attention must be an object");
		}

		const attention = tap.attention as Record<string, unknown>;
		if (typeof attention.version !== "string" || attention.version.length === 0) {
			throw new IdentityError("trustedAgentProtocol.attention must have a non-empty version");
		}

		if (typeof attention.currency !== "string" || attention.currency.length === 0) {
			throw new IdentityError("trustedAgentProtocol.attention must have a non-empty currency");
		}

		if (
			attention.chain !== undefined &&
			(typeof attention.chain !== "string" || attention.chain.length === 0)
		) {
			throw new IdentityError("trustedAgentProtocol.attention.chain must be a non-empty string");
		}

		if (typeof attention.pricing !== "object" || attention.pricing === null) {
			throw new IdentityError("trustedAgentProtocol.attention must have a pricing object");
		}

		// Tier names are open (additive for future tiers); only values are
		// validated: decimal currency strings, USDC's 6 decimals max.
		for (const [tier, amount] of Object.entries(attention.pricing as Record<string, unknown>)) {
			if (typeof amount !== "string" || !/^\d+(\.\d{1,6})?$/.test(amount)) {
				throw new IdentityError(
					`trustedAgentProtocol.attention.pricing.${tier} must be a decimal amount string`,
				);
			}
		}
	}

	const xmtpService = obj.services.find(
		(service) =>
			typeof service === "object" &&
			service !== null &&
			(service as Record<string, unknown>).name === "xmtp",
	) as Record<string, unknown> | undefined;

	if (xmtpService) {
		const xmtpEndpoint = String(xmtpService.endpoint).toLowerCase();
		if (xmtpEndpoint !== tap.agentAddress.toLowerCase()) {
			throw new IdentityError("XMTP service endpoint must match trustedAgentProtocol.agentAddress");
		}
	}

	return data as RegistrationFile;
}

export async function fetchRegistrationFile(uri: string): Promise<RegistrationFile> {
	const resolvedUri = resolveRegistrationUri(uri);
	if (!isSafeRemoteUri(resolvedUri)) {
		throw new IdentityError(`Registration URI is not allowed: ${resolvedUri}`);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);

	try {
		const response = await fetchRegistrationResponse(resolvedUri, controller.signal);
		if (!response.ok) {
			throw new IdentityError(
				`Failed to fetch registration file from ${resolvedUri}: HTTP ${response.status}`,
			);
		}
		const data = await response.json();
		return validateRegistrationFile(data);
	} catch (error) {
		if (error instanceof IdentityError) throw error;
		const isTimeout =
			(error instanceof DOMException && error.name === "AbortError") ||
			(error instanceof Error && error.message.toLowerCase().includes("aborted"));
		if (isTimeout) {
			throw new IdentityError(
				`Registration file fetch timed out for ${resolvedUri}. If you just updated the registration, IPFS propagation can take up to a minute — wait and retry.`,
			);
		}
		throw new IdentityError(
			`Failed to fetch registration file from ${resolvedUri}: ${toErrorMessage(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

function resolveRegistrationUri(uri: string): string {
	if (uri.startsWith("ipfs://")) {
		const cidAndPath = uri.slice("ipfs://".length);
		if (!cidAndPath) {
			throw new IdentityError("Invalid ipfs:// registration URI");
		}
		return `https://ipfs.io/ipfs/${cidAndPath}`;
	}

	const parsed = parseRegistrationUrl(uri);
	if (parsed.protocol !== "https:") {
		throw new IdentityError(`Unsupported registration URI protocol: ${parsed.protocol}`);
	}
	return parsed.toString();
}

function isSafeRemoteUri(uri: string): boolean {
	const url = parseRegistrationUrl(uri);
	const host = normalizeHostname(url.hostname);

	if (host === "localhost" || host.endsWith(".local")) {
		return false;
	}
	if (isBlockedIpHost(host)) return false;

	return true;
}

async function fetchRegistrationResponse(uri: string, signal: AbortSignal): Promise<Response> {
	let currentUri = uri;

	for (let redirects = 0; redirects <= 5; redirects += 1) {
		if (!isSafeRemoteUri(currentUri)) {
			throw new IdentityError(`Registration URI is not allowed: ${currentUri}`);
		}

		const response = await fetch(currentUri, {
			signal,
			redirect: "manual",
		});
		if (!isRedirectResponse(response.status)) {
			return response;
		}

		const location = response.headers.get("location");
		if (!location) {
			throw new IdentityError(`Registration fetch redirect missing Location header: ${currentUri}`);
		}

		const nextUrl = new URL(location, currentUri);
		if (nextUrl.protocol !== "https:") {
			throw new IdentityError(`Unsupported registration URI protocol: ${nextUrl.protocol}`);
		}
		currentUri = nextUrl.toString();
	}

	throw new IdentityError(`Registration fetch exceeded redirect limit for ${uri}`);
}

function parseRegistrationUrl(uri: string): URL {
	try {
		return new URL(uri);
	} catch {
		throw new IdentityError(`Invalid registration URI: ${uri}`);
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isBlockedIpHost(host: string): boolean {
	const mappedIpv4 = extractMappedIpv4(host);
	if (mappedIpv4) {
		return isBlockedIpv4Host(mappedIpv4);
	}

	const ipVersion = isIP(host);
	if (ipVersion === 4) {
		return isBlockedIpv4Host(host);
	}
	if (ipVersion !== 6) {
		return false;
	}

	return isBlockedIpv6Host(host);
}

function isBlockedIpv4Host(host: string): boolean {
	return (
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
	);
}

function isBlockedIpv6Host(host: string): boolean {
	if (host === "::1") {
		return true;
	}

	const firstHextet = getLeadingIpv6Hextet(host);
	if (firstHextet === null) {
		return false;
	}

	return (
		(firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
		(firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
	);
}

function getLeadingIpv6Hextet(host: string): number | null {
	const firstSegment = host.split(":", 1)[0];
	if (!firstSegment) {
		return null;
	}

	const parsed = Number.parseInt(firstSegment, 16);
	return Number.isNaN(parsed) ? null : parsed;
}

function extractMappedIpv4(host: string): string | null {
	const normalized = host.toLowerCase();
	const prefix = "::ffff:";
	if (!normalized.startsWith(prefix)) {
		return null;
	}
	const ipv4 = normalized.slice(prefix.length);
	if (isIP(ipv4) === 4) {
		return ipv4;
	}

	const parts = ipv4.split(":");
	if (parts.length !== 2) {
		return null;
	}

	const high = Number.parseInt(parts[0] ?? "", 16);
	const low = Number.parseInt(parts[1] ?? "", 16);
	if (
		Number.isNaN(high) ||
		Number.isNaN(low) ||
		high < 0 ||
		high > 0xffff ||
		low < 0 ||
		low > 0xffff
	) {
		return null;
	}

	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

function isRedirectResponse(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
