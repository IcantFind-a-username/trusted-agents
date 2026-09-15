import {
	encodeAbiParameters,
	isAddressEqual,
	keccak256,
	parseAbiParameters,
	recoverMessageAddress,
	toBytes,
} from "viem";
import type { SigningProvider } from "../signing/provider.js";
import { postageAmountToMicros } from "./amounts.js";

/**
 * The facts a postage credit certificate commits to. The issuer (the paid
 * receiver) signs these after accepting a `postage/topup`; the holder (the
 * payer) keeps the signature as portable proof that the credit exists.
 * Amounts are hashed in integer micro-units; the txHash is hashed as a
 * string so mock transports with non-32-byte hashes still round-trip.
 */
export interface PostageCreditFacts {
	creditId: string;
	issuerChain: string;
	issuerAgentId: number;
	holderAgentId: number;
	amount: string;
	txHash: string;
}

function buildDigest(facts: PostageCreditFacts): `0x${string}` {
	return keccak256(
		encodeAbiParameters(
			parseAbiParameters(
				"string creditId, string chain, uint256 issuerAgentId, uint256 holderAgentId, uint256 amountMicros, string txHash",
			),
			[
				facts.creditId,
				facts.issuerChain,
				BigInt(facts.issuerAgentId),
				BigInt(facts.holderAgentId),
				postageAmountToMicros(facts.amount),
				facts.txHash,
			],
		),
	);
}

/**
 * Sign a credit certificate with the issuer's wallet. Same EIP-191
 * personal-sign-over-keccak-digest scheme invites use — all signing goes
 * through the OWS-backed SigningProvider, never a raw key.
 */
export async function signPostageCredit(
	signingProvider: SigningProvider,
	facts: PostageCreditFacts,
): Promise<`0x${string}`> {
	return await signingProvider.signMessage({ raw: toBytes(buildDigest(facts)) });
}

/**
 * Verify a credit certificate against the issuer's known agent address
 * (from the holder's contact entry). Mirrors `verifyInvite`.
 */
export async function verifyPostageCredit(
	facts: PostageCreditFacts,
	signature: `0x${string}`,
	expectedSignerAddress: `0x${string}`,
): Promise<{ valid: boolean; signerAddress?: `0x${string}`; error?: string }> {
	try {
		const signerAddress = await recoverMessageAddress({
			message: { raw: toBytes(buildDigest(facts)) },
			signature,
		});
		if (!isAddressEqual(signerAddress, expectedSignerAddress)) {
			return {
				valid: false,
				signerAddress,
				error: `certificate signed by ${signerAddress}, expected ${expectedSignerAddress}`,
			};
		}
		return { valid: true, signerAddress };
	} catch (error) {
		return { valid: false, error: error instanceof Error ? error.message : String(error) };
	}
}
