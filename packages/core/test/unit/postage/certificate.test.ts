import { describe, expect, it } from "vitest";
import {
	type PostageCreditFacts,
	signPostageCredit,
	verifyPostageCredit,
} from "../../../src/postage/certificate.js";
import { ALICE, ALICE_SIGNING_PROVIDER, BOB } from "../../fixtures/test-keys.js";

const FACTS: PostageCreditFacts = {
	creditId: "credit-1",
	issuerChain: "eip155:8453",
	issuerAgentId: 1,
	holderAgentId: 7,
	amount: "0.01",
	txHash: "0xmock-tx-1",
};

describe("postage credit certificates", () => {
	it("round-trips sign and verify against the issuer address", async () => {
		const signature = await signPostageCredit(ALICE_SIGNING_PROVIDER, FACTS);
		const result = await verifyPostageCredit(FACTS, signature, ALICE.address);
		expect(result.valid).toBe(true);
		expect(result.signerAddress?.toLowerCase()).toBe(ALICE.address.toLowerCase());
	});

	it("rejects a certificate signed by someone other than the issuer", async () => {
		const signature = await signPostageCredit(ALICE_SIGNING_PROVIDER, FACTS);
		const result = await verifyPostageCredit(FACTS, signature, BOB.address);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("expected");
	});

	it("rejects when any committed fact changed", async () => {
		const signature = await signPostageCredit(ALICE_SIGNING_PROVIDER, FACTS);
		for (const tampered of [
			{ ...FACTS, amount: "0.02" },
			{ ...FACTS, creditId: "credit-2" },
			{ ...FACTS, holderAgentId: 8 },
			{ ...FACTS, txHash: "0xother" },
		]) {
			const result = await verifyPostageCredit(tampered, signature, ALICE.address);
			expect(result.valid).toBe(false);
		}
	});

	it("reports malformed signatures as invalid instead of throwing", async () => {
		const result = await verifyPostageCredit(FACTS, "0xdead", ALICE.address);
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});
});
