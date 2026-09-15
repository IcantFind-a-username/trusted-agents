import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTrustedAgentConfigFromDataDir } from "../../../src/config/load.js";
import { validateConfig } from "../../../src/config/schema.js";

describe("attention config", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "attention-config-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("loads the attention block from config.yaml", async () => {
		await writeFile(
			join(dataDir, "config.yaml"),
			[
				"agent_id: 1",
				"chain: eip155:8453",
				"attention:",
				"  enforce: true",
				"  pricing:",
				'    grantHolder: "0"',
				'    standard: "0.001"',
			].join("\n"),
			"utf-8",
		);

		const config = await loadTrustedAgentConfigFromDataDir(dataDir, { requireAgentId: false });
		expect(config.attention).toEqual({
			enforce: true,
			pricing: { grantHolder: "0", standard: "0.001" },
		});
	});

	it("leaves attention undefined when the block is absent", async () => {
		await writeFile(
			join(dataDir, "config.yaml"),
			["agent_id: 1", "chain: eip155:8453"].join("\n"),
			"utf-8",
		);

		const config = await loadTrustedAgentConfigFromDataDir(dataDir, { requireAgentId: false });
		expect(config.attention).toBeUndefined();
	});

	it("validateConfig accepts a well-formed attention section", () => {
		expect(() =>
			validateConfig({
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "w", apiKey: "ows_key_x" },
				attention: { enforce: true, pricing: { standard: "0.001" } },
			}),
		).not.toThrow();
	});

	it("validateConfig requires the priority price to exceed standard", () => {
		const base = {
			agentId: 1,
			chain: "eip155:8453",
			ows: { wallet: "w", apiKey: "ows_key_x" },
		} as const;
		// priority <= standard would classify every standard-paid message as
		// a wake-up and disable coalescing for all paid mail.
		expect(() =>
			validateConfig({
				...base,
				attention: { pricing: { standard: "0.001", priority: "0.001" } },
			}),
		).toThrow("must exceed");
		expect(() =>
			validateConfig({
				...base,
				attention: { pricing: { standard: "0.001", priority: "0.0005" } },
			}),
		).toThrow("must exceed");
		expect(() =>
			validateConfig({
				...base,
				attention: { pricing: { standard: "0.001", priority: "0.01" } },
			}),
		).not.toThrow();
	});

	it("validateConfig rejects non-decimal pricing values and non-boolean enforce", () => {
		expect(() =>
			validateConfig({
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "w", apiKey: "ows_key_x" },
				attention: { pricing: { standard: "1,50" } },
			}),
		).toThrow("decimal amount string");

		expect(() =>
			validateConfig({
				agentId: 1,
				chain: "eip155:8453",
				ows: { wallet: "w", apiKey: "ows_key_x" },
				attention: { enforce: "yes" as unknown as boolean },
			}),
		).toThrow("attention.enforce must be a boolean");
	});
});
