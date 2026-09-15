import { describe, expect, it } from "vitest";
import { microsToPostageAmount, postageAmountToMicros } from "../../../src/postage/amounts.js";
import {
	buildPostageBalancePayload,
	buildPostageTopupPayload,
	extractPostageStamp,
	parsePostageBalanceRequest,
	parsePostageTopupRequest,
	parsePostageTopupResponse,
} from "../../../src/postage/payload.js";

describe("postage amounts", () => {
	it("converts between decimal strings and micro-units without floats", () => {
		expect(postageAmountToMicros("0.000001")).toBe(1n);
		expect(postageAmountToMicros("1.5")).toBe(1_500_000n);
		expect(microsToPostageAmount(1_500_000n)).toBe("1.5");
		expect(() => postageAmountToMicros("0.0000001")).toThrow();
		expect(() => postageAmountToMicros("1e-3")).toThrow();
		expect(() => postageAmountToMicros("-1")).toThrow();
	});
});

describe("postage payloads", () => {
	it("builds and parses a topup request round-trip", () => {
		const payload = buildPostageTopupPayload({
			amount: "0.01",
			chain: "eip155:8453",
			txHash: "0xabc",
		});
		const parsed = parsePostageTopupRequest(payload);
		expect(parsed).toMatchObject({
			type: "postage/topup",
			amount: "0.01",
			asset: "usdc",
			chain: "eip155:8453",
			txHash: "0xabc",
		});
		expect(parsed?.actionId).toBeTruthy();
		expect(parsed?.creditId).toBeTruthy();
	});

	it("rejects malformed topup requests", () => {
		const valid = buildPostageTopupPayload({
			amount: "0.01",
			chain: "eip155:8453",
			txHash: "0xabc",
		});
		expect(parsePostageTopupRequest({ ...valid, asset: "native" })).toBeNull();
		expect(parsePostageTopupRequest({ ...valid, amount: "nope" })).toBeNull();
		expect(parsePostageTopupRequest({ ...valid, txHash: "" })).toBeNull();
		expect(parsePostageTopupRequest({ ...valid, type: "postage/balance" })).toBeNull();
	});

	it("builds and parses balance requests", () => {
		const payload = buildPostageBalancePayload({ actionId: "a-1" });
		expect(parsePostageBalanceRequest(payload)).toEqual({
			type: "postage/balance",
			actionId: "a-1",
		});
		expect(parsePostageBalanceRequest({ type: "postage/balance" })).toBeNull();
	});

	it("parses topup responses leniently", () => {
		expect(
			parsePostageTopupResponse({
				type: "postage/topup",
				actionId: "a",
				creditId: "c",
				status: "accepted",
				certificate: "0xsig",
			}),
		).toMatchObject({ status: "accepted", certificate: "0xsig" });
		expect(
			parsePostageTopupResponse({
				type: "postage/topup",
				error: { code: "TOPUP_UNVERIFIED", message: "no" },
			}),
		).toMatchObject({ error: { code: "TOPUP_UNVERIFIED" } });
		expect(parsePostageTopupResponse({ type: "transfer/response" })).toBeNull();
	});
});

describe("extractPostageStamp", () => {
	const params = (postage: unknown) => ({
		message: {
			messageId: "m1",
			role: "user",
			parts: [],
			metadata: {
				trustedAgent: {
					connectionId: "c",
					conversationId: "v",
					scope: "general-chat",
					requiresHumanApproval: false,
					postage,
				},
			},
		},
	});

	it("extracts a well-formed stamp", () => {
		expect(extractPostageStamp(params({ creditId: "c1", seq: 3, cost: "0.001" }))).toEqual({
			creditId: "c1",
			seq: 3,
			cost: "0.001",
		});
	});

	it("returns null for missing or malformed stamps", () => {
		expect(extractPostageStamp(undefined)).toBeNull();
		expect(extractPostageStamp(params(undefined))).toBeNull();
		expect(extractPostageStamp(params({ creditId: "", seq: 1, cost: "0.001" }))).toBeNull();
		expect(extractPostageStamp(params({ creditId: "c", seq: 0, cost: "0.001" }))).toBeNull();
		expect(extractPostageStamp(params({ creditId: "c", seq: 1.5, cost: "0.001" }))).toBeNull();
		expect(extractPostageStamp(params({ creditId: "c", seq: 1, cost: 5 }))).toBeNull();
	});
});
