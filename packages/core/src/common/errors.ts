export class TrustedAgentError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "TrustedAgentError";
	}
}

export class AuthenticationError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "AUTH_ERROR");
		this.name = "AuthenticationError";
	}
}

export class IdentityError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "IDENTITY_ERROR");
		this.name = "IdentityError";
	}
}

export class ConnectionError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "CONNECTION_ERROR");
		this.name = "ConnectionError";
	}
}

export class PermissionError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "PERMISSION_ERROR");
		this.name = "PermissionError";
	}
}

export class TransportError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "TRANSPORT_ERROR");
		this.name = "TransportError";
	}
}

/**
 * A peer replied with a structured JSON-RPC error envelope. Preserves the
 * numeric code and machine-readable `error.data` that a bare TransportError
 * would strip — senders need both to react to codes like -32050.
 */
export class TransportRpcError extends TransportError {
	constructor(
		message: string,
		public readonly rpcCode: number,
		public readonly rpcData?: unknown,
	) {
		super(message);
		this.name = "TransportRpcError";
	}
}

export const ATTENTION_PAYMENT_REQUIRED_CODE = -32050;

/**
 * Machine-readable quote carried in the `error.data` of a -32050 rejection.
 * Structurally identical to the registration file's advertised
 * `trustedAgentProtocol.attention` block (x402 semantics over XMTP).
 */
export interface AttentionQuote {
	version: string;
	currency: string;
	chain?: string;
	pricing: Record<string, string>;
}

/** Why a postage stamp did not buy attention. */
export type PostageRejectionReason =
	| "missing_stamp"
	| "unpriced"
	| "unknown_credit"
	| "seq_replayed"
	| "below_price"
	| "insufficient_credit";

/**
 * Machine-readable postage detail carried alongside the attention quote in
 * `error.data.postage` of a -32050 rejection. Tells the sender whether a
 * top-up would help (`insufficient_credit` / `unknown_credit`) or the stamp
 * itself was malformed relative to the receiver's ledger.
 */
export interface PostageRejection {
	reason: PostageRejectionReason;
	creditId?: string;
	/** Remaining balance on the referenced credit, decimal currency string. */
	remaining?: string;
	/** Price the stamp needed to cover, decimal currency string. */
	required?: string;
}

/**
 * Thrown by the receiving service when attention enforcement rejects an
 * inbound request; the transport maps it to a JSON-RPC -32050 error with
 * the quote in `error.data` instead of the generic -32603. When postage
 * enforcement produced the rejection, `postage` explains why the stamp
 * (or its absence) did not pay for the message.
 */
export class AttentionPaymentRequiredError extends TrustedAgentError {
	readonly rpcCode = ATTENTION_PAYMENT_REQUIRED_CODE;
	constructor(
		message: string,
		public readonly quote: AttentionQuote,
		public readonly postage?: PostageRejection,
	) {
		super(message, "ATTENTION_PAYMENT_REQUIRED");
		this.name = "AttentionPaymentRequiredError";
	}
}

export class ConfigError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "CONFIG_ERROR");
		this.name = "ConfigError";
	}
}

export class ValidationError extends TrustedAgentError {
	constructor(message: string) {
		super(message, "VALIDATION_ERROR");
		this.name = "ValidationError";
	}
}

export function toErrorMessage(error: unknown): string {
	if (error instanceof Error && "shortMessage" in error) {
		const { shortMessage } = error as { shortMessage: unknown };
		if (typeof shortMessage === "string") return shortMessage;
	}
	return error instanceof Error ? error.message : String(error);
}

export function fsErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}
