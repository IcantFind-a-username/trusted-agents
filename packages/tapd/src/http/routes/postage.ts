import type { TapMessagingService } from "trusted-agents-core";
import type { RouteHandler } from "../router.js";
import { asRecord, isNonEmptyString, requireBody } from "../validation.js";

interface PostageTopupBody {
	peer: string;
	amount: string;
	waitMs?: number;
}

function isPostageTopupBody(value: unknown): value is PostageTopupBody {
	const v = asRecord(value);
	if (!v) return false;
	if (!isNonEmptyString(v.peer)) return false;
	if (!isNonEmptyString(v.amount)) return false;
	if (v.waitMs !== undefined && (typeof v.waitMs !== "number" || v.waitMs <= 0)) return false;
	return true;
}

/**
 * POST /api/postage/topup — prepay postage credit at a peer: pay USDC
 * through the daemon's transfer executor, request the credit over TAP, and
 * wait for the peer's signed certificate. Body: `{ peer, amount, waitMs? }`.
 */
export function createPostageRoutes(service: TapMessagingService): { topup: RouteHandler } {
	return {
		topup: async (_params, body) => {
			requireBody(
				body,
				isPostageTopupBody,
				"postage topup POST requires { peer: string, amount: string, waitMs?: number }",
			);
			return await service.topUpPostage(body.peer, {
				amount: body.amount,
				...(body.waitMs !== undefined ? { waitMs: body.waitMs } : {}),
			});
		},
	};
}
