import type { PostageAppExtension, TapActionContext } from "trusted-agents-core";
import { ValidationError } from "trusted-agents-core";
import { describe, expect, it, vi } from "vitest";
import { handlePostageBalance, handlePostageTopup } from "../src/index.js";

const PEER_KEY = "eip155:8453#2";

function makeTopupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "postage/topup",
		actionId: "action-1",
		creditId: "credit-1",
		amount: "0.01",
		asset: "usdc",
		chain: "eip155:8453",
		txHash: "0xdeadbeef",
		...overrides,
	};
}

function makeExtension(overrides: Partial<PostageAppExtension> = {}): PostageAppExtension {
	return {
		recordIssued: vi.fn(async (input) => ({
			credit: {
				creditId: input.creditId,
				peer: input.peer,
				amount: input.amount,
				spent: "0",
				lastSeq: 0,
				txHash: input.txHash,
				issuedAt: "2026-08-27T00:00:00.000Z",
				...(input.certificate ? { certificate: input.certificate } : {}),
			},
			created: true,
		})),
		issuedFor: vi.fn(async () => []),
		signCredit: vi.fn(async () => "0xcert" as `0x${string}`),
		verifyTopup: vi.fn(async () => true),
		...overrides,
	};
}

function buildMockContext(
	overrides: Partial<{
		payload: Record<string, unknown>;
		extension: PostageAppExtension | undefined;
	}> = {},
): TapActionContext {
	return {
		self: {
			agentId: 1,
			chain: "eip155:8453",
			address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
		},
		peer: {
			contact: {
				connectionId: "conn-1",
				peerAgentId: 2,
				peerChain: "eip155:8453",
				peerOwnerAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
				peerDisplayName: "Test Peer",
				peerAgentAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
				permissions: {
					grantedByMe: { version: "tap-grants/v1", updatedAt: "", grants: [] },
					grantedByPeer: { version: "tap-grants/v1", updatedAt: "", grants: [] },
				},
				establishedAt: "2026-08-27T00:00:00.000Z",
				lastContactAt: "2026-08-27T00:00:00.000Z",
				status: "active",
			},
			grantsFromPeer: [],
			grantsToPeer: [],
		},
		payload: overrides.payload ?? makeTopupPayload(),
		messaging: {
			reply: vi.fn().mockResolvedValue(undefined),
			send: vi.fn().mockResolvedValue(undefined),
		},
		payments: {
			request: vi.fn().mockResolvedValue({ requestId: "req-1" }),
			execute: vi.fn().mockResolvedValue({ txHash: "0xabc" as `0x${string}` }),
		},
		storage: {
			get: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			list: vi.fn().mockResolvedValue({}),
		},
		events: { emit: vi.fn() },
		log: { append: vi.fn().mockResolvedValue(undefined) },
		extensions:
			"extension" in overrides
				? overrides.extension
					? { postage: overrides.extension }
					: {}
				: { postage: makeExtension() },
	};
}

describe("handlePostageTopup", () => {
	it("fails closed when the host injects no postage extension", async () => {
		const ctx = buildMockContext({ extension: undefined });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("POSTAGE_UNAVAILABLE");
	});

	it("rejects malformed payloads", async () => {
		const ctx = buildMockContext({ payload: makeTopupPayload({ amount: "not-money" }) });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("rejects topups whose payment fails host verification", async () => {
		const extension = makeExtension({ verifyTopup: vi.fn(async () => false) });
		const ctx = buildMockContext({ extension });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("TOPUP_UNVERIFIED");
		expect(result.data).toMatchObject({ creditId: "credit-1", status: "rejected" });
		expect(extension.recordIssued).not.toHaveBeenCalled();
	});

	it("records the credit and returns a signed certificate", async () => {
		const extension = makeExtension();
		const ctx = buildMockContext({ extension });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			actionId: "action-1",
			creditId: "credit-1",
			status: "accepted",
			amount: "0.01",
			certificate: "0xcert",
			issuer: { agentId: 1, chain: "eip155:8453" },
		});
		expect(extension.signCredit).toHaveBeenCalledWith(
			expect.objectContaining({
				creditId: "credit-1",
				issuerAgentId: 1,
				holderAgentId: 2,
				amount: "0.01",
				txHash: "0xdeadbeef",
			}),
		);
		expect(extension.recordIssued).toHaveBeenCalledWith(
			expect.objectContaining({ peer: PEER_KEY, certificate: "0xcert" }),
		);
		expect(ctx.events.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "postage/topup" }),
		);
		expect(ctx.log.append).toHaveBeenCalled();
	});

	it("still opens the credit when the signer is unavailable", async () => {
		const extension = makeExtension({ signCredit: vi.fn(async () => null) });
		const ctx = buildMockContext({ extension });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(true);
		expect(result.data?.certificate).toBeUndefined();
		expect(extension.recordIssued).toHaveBeenCalledWith(
			expect.not.objectContaining({ certificate: expect.anything() }),
		);
	});

	it("is idempotent on retries: returns the stored credit without re-announcing", async () => {
		const extension = makeExtension({
			recordIssued: vi.fn(async () => ({
				credit: {
					creditId: "credit-1",
					peer: PEER_KEY,
					amount: "0.01",
					spent: "0.002",
					lastSeq: 2,
					txHash: "0xdeadbeef",
					issuedAt: "2026-08-26T00:00:00.000Z",
					certificate: "0xoriginal" as `0x${string}`,
				},
				created: false,
			})),
		});
		const ctx = buildMockContext({ extension });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(true);
		expect(result.data?.certificate).toBe("0xoriginal");
		expect(ctx.events.emit).not.toHaveBeenCalled();
		expect(ctx.log.append).not.toHaveBeenCalled();
		// The recorded credit already carries its certificate, so a replayed
		// request must not touch the signing provider at all.
		expect(extension.signCredit).not.toHaveBeenCalled();
	});

	it("maps conflicting creditIds to CREDIT_CONFLICT", async () => {
		const extension = makeExtension({
			recordIssued: vi.fn(async () => {
				throw new ValidationError("postage credit credit-1 already exists with a different topup");
			}),
		});
		const ctx = buildMockContext({ extension });
		const result = await handlePostageTopup(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("CREDIT_CONFLICT");
	});
});

describe("handlePostageBalance", () => {
	it("fails closed when the host injects no postage extension", async () => {
		const ctx = buildMockContext({
			extension: undefined,
			payload: { type: "postage/balance", actionId: "b-1" },
		});
		const result = await handlePostageBalance(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("POSTAGE_UNAVAILABLE");
	});

	it("rejects malformed payloads", async () => {
		const ctx = buildMockContext({ payload: { type: "postage/balance" } });
		const result = await handlePostageBalance(ctx);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("INVALID_PAYLOAD");
	});

	it("returns the asking peer's credit rows with remaining balances", async () => {
		const extension = makeExtension({
			issuedFor: vi.fn(async () => [
				{
					creditId: "c1",
					peer: PEER_KEY,
					amount: "0.01",
					spent: "0.004",
					lastSeq: 4,
					txHash: "0x1",
					issuedAt: "2026-08-26T00:00:00.000Z",
				},
				{
					creditId: "c2",
					peer: PEER_KEY,
					amount: "0.5",
					spent: "0",
					lastSeq: 0,
					txHash: "0x2",
					issuedAt: "2026-08-27T00:00:00.000Z",
				},
			]),
		});
		const ctx = buildMockContext({
			extension,
			payload: { type: "postage/balance", actionId: "b-1" },
		});
		const result = await handlePostageBalance(ctx);
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			actionId: "b-1",
			status: "completed",
			totalRemaining: "0.506",
		});
		expect(result.data?.credits).toEqual([
			{ creditId: "c1", amount: "0.01", spent: "0.004", remaining: "0.006", lastSeq: 4 },
			{ creditId: "c2", amount: "0.5", spent: "0", remaining: "0.5", lastSeq: 0 },
		]);
		expect(extension.issuedFor).toHaveBeenCalledWith(PEER_KEY);
	});
});
