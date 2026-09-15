import { generateNonce } from "../common/index.js";
import type { MessageSendParams, PostageStamp } from "../protocol/types.js";
import { isValidPostageAmount } from "./amounts.js";

export const POSTAGE_TOPUP_ACTION = "postage/topup";
export const POSTAGE_BALANCE_ACTION = "postage/balance";

/** `postage/topup` action payload: "I paid you on-chain, open me a credit." */
export interface PostageTopupRequest {
	type: typeof POSTAGE_TOPUP_ACTION;
	actionId: string;
	creditId: string;
	amount: string;
	asset: "usdc";
	chain: string;
	txHash: string;
}

/** `postage/balance` action payload: "what do my credits look like on your ledger?" */
export interface PostageBalanceRequest {
	type: typeof POSTAGE_BALANCE_ACTION;
	actionId: string;
}

/** Loosely-typed view of a `postage/topup` action result's data part. */
export interface PostageTopupResponseData {
	actionId?: string;
	creditId?: string;
	status?: string;
	amount?: string;
	certificate?: `0x${string}`;
	error?: { code?: string; message?: string };
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function parsePostageTopupRequest(
	payload: Record<string, unknown>,
): PostageTopupRequest | null {
	if (payload.type !== POSTAGE_TOPUP_ACTION) return null;
	if (!nonEmptyString(payload.actionId)) return null;
	if (!nonEmptyString(payload.creditId)) return null;
	if (payload.asset !== "usdc") return null;
	if (!isValidPostageAmount(payload.amount)) return null;
	if (!nonEmptyString(payload.chain)) return null;
	if (!nonEmptyString(payload.txHash)) return null;
	return {
		type: POSTAGE_TOPUP_ACTION,
		actionId: payload.actionId,
		creditId: payload.creditId,
		amount: payload.amount,
		asset: "usdc",
		chain: payload.chain,
		txHash: payload.txHash,
	};
}

export function parsePostageBalanceRequest(
	payload: Record<string, unknown>,
): PostageBalanceRequest | null {
	if (payload.type !== POSTAGE_BALANCE_ACTION) return null;
	if (!nonEmptyString(payload.actionId)) return null;
	return { type: POSTAGE_BALANCE_ACTION, actionId: payload.actionId };
}

export function parsePostageTopupResponse(
	data: Record<string, unknown>,
): PostageTopupResponseData | null {
	if (data.type !== POSTAGE_TOPUP_ACTION) return null;
	const error =
		typeof data.error === "object" && data.error !== null
			? (data.error as { code?: string; message?: string })
			: undefined;
	return {
		...(nonEmptyString(data.actionId) ? { actionId: data.actionId } : {}),
		...(nonEmptyString(data.creditId) ? { creditId: data.creditId } : {}),
		...(nonEmptyString(data.status) ? { status: data.status } : {}),
		...(isValidPostageAmount(data.amount) ? { amount: data.amount } : {}),
		...(nonEmptyString(data.certificate) && data.certificate.startsWith("0x")
			? { certificate: data.certificate as `0x${string}` }
			: {}),
		...(error ? { error } : {}),
	};
}

export function buildPostageTopupPayload(params: {
	amount: string;
	chain: string;
	txHash: string;
	creditId?: string;
	actionId?: string;
}): Record<string, unknown> {
	return {
		type: POSTAGE_TOPUP_ACTION,
		actionId: params.actionId ?? generateNonce(),
		creditId: params.creditId ?? generateNonce(),
		amount: params.amount,
		asset: "usdc",
		chain: params.chain,
		txHash: params.txHash,
	};
}

export function buildPostageBalancePayload(params?: { actionId?: string }): Record<
	string,
	unknown
> {
	return {
		type: POSTAGE_BALANCE_ACTION,
		actionId: params?.actionId ?? generateNonce(),
	};
}

/**
 * Pull a shape-valid postage stamp out of inbound `message/send` params.
 * Economic validity (price, balance, seq freshness) is the ledger's call —
 * this only guards types so enforcement can't be crashed by a malformed
 * stamp.
 */
export function extractPostageStamp(params: unknown): PostageStamp | null {
	const trustedAgent = (params as MessageSendParams | undefined)?.message?.metadata?.trustedAgent;
	const stamp = (trustedAgent as { postage?: unknown } | undefined)?.postage;
	if (typeof stamp !== "object" || stamp === null) return null;
	const { creditId, seq, cost } = stamp as Record<string, unknown>;
	if (!nonEmptyString(creditId)) return null;
	if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= 0) return null;
	if (typeof cost !== "string") return null;
	return { creditId, seq, cost };
}
