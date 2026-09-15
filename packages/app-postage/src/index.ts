import {
	POSTAGE_APP_ID,
	defineTapApp,
	handlePostageBalance,
	handlePostageTopup,
} from "trusted-agents-core";

export type {
	HeldPostageCredit,
	IssuedPostageCredit,
	PostageAppExtension,
	PostageBalanceRequest,
	PostageCreditFacts,
	PostageStamp,
	PostageTopupRequest,
	PostageTopupResponseData,
	TapActionContext,
	TapActionResult,
} from "trusted-agents-core";
export {
	POSTAGE_APP_ID,
	POSTAGE_BALANCE_ACTION,
	POSTAGE_TOPUP_ACTION,
	buildPostageBalancePayload,
	buildPostageTopupPayload,
	handlePostageBalance,
	handlePostageTopup,
	parsePostageBalanceRequest,
	parsePostageTopupRequest,
	parsePostageTopupResponse,
	postagePeerKey,
	signPostageCredit,
	verifyPostageCredit,
} from "trusted-agents-core";

/**
 * Prepaid postage as a TAP app. The handlers are the same functions the
 * core service registers as a built-in — this package is the standalone,
 * manifest-installable form for hosts that assemble their own app set.
 * State lives in the postage ledger at `<dataDir>/apps/postage/state.json`,
 * reached through the host-injected `ctx.extensions.postage` (never
 * `ctx.storage`, so one mutex serializes topups against stamp debits).
 */
export const postageApp = defineTapApp({
	id: POSTAGE_APP_ID,
	name: "Postage",
	version: "1.0.0",
	actions: {
		"postage/topup": { handler: handlePostageTopup },
		"postage/balance": { handler: handlePostageBalance },
	},
	grantScopes: [],
});

export default postageApp;
