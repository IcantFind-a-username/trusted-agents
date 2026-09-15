import { formatUnits, parseUnits } from "viem";

/**
 * Postage amounts are decimal USDC strings with at most 6 decimal places —
 * the same format the attention price list uses (`config/schema.ts`).
 * All arithmetic happens in integer micro-units (1e-6 USDC) via bigint so
 * balances never touch floating point.
 */
const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

export const POSTAGE_CURRENCY_DECIMALS = 6;

export function isValidPostageAmount(value: unknown): value is string {
	return typeof value === "string" && DECIMAL_AMOUNT_PATTERN.test(value);
}

/** Parse a validated decimal amount string into integer micro-units. */
export function postageAmountToMicros(amount: string): bigint {
	if (!isValidPostageAmount(amount)) {
		throw new Error(`invalid postage amount: ${JSON.stringify(amount)}`);
	}
	return parseUnits(amount, POSTAGE_CURRENCY_DECIMALS);
}

/** Format integer micro-units back into a decimal amount string. */
export function microsToPostageAmount(micros: bigint): string {
	if (micros < 0n) {
		throw new Error(`postage amounts are never negative, got ${micros}`);
	}
	return formatUnits(micros, POSTAGE_CURRENCY_DECIMALS);
}
