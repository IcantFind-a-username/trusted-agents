import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePostageLedger, postagePeerKey } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postageBalanceCommand } from "../src/commands/postage-balance.js";
import { useCapturedOutput } from "./helpers/capture-output.js";

const MINIMAL_CONFIG = [
	"agent_id: -1",
	"chain: eip155:8453",
	"ows:",
	"  wallet: demo-wallet",
	"  api_key: demo-key",
].join("\n");

async function makeAgentDir(root: string): Promise<string> {
	const dataDir = join(root, "agent");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "config.yaml"), MINIMAL_CONFIG, "utf-8");
	return dataDir;
}

interface BalanceOutput {
	status: string;
	data?: {
		held?: Array<Record<string, unknown>>;
		issued?: Array<Record<string, unknown>>;
		held_count?: number;
		issued_count?: number;
	};
}

describe("tap postage balance", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-postage-"));
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("returns empty lists when no ledger exists", async () => {
		const dataDir = await makeAgentDir(tempRoot);

		await postageBalanceCommand({}, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as BalanceOutput;
		expect(output.status).toBe("ok");
		expect(output.data?.held).toEqual([]);
		expect(output.data?.issued).toEqual([]);
		expect(output.data?.held_count).toBe(0);
		expect(output.data?.issued_count).toBe(0);
		expect(stderrWrites).toEqual([]);
	});

	it("reports held and issued credits with remaining balances", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const ledger = new FilePostageLedger(dataDir);
		const bobKey = postagePeerKey({ chain: "eip155:8453", agentId: 7 });
		await ledger.recordHeld({
			creditId: "held-1",
			peer: bobKey,
			amount: "0.01",
			txHash: "0x1",
			certificateVerified: true,
		});
		await ledger.stampHeld({ peer: bobKey, cost: "0.001" });
		await ledger.recordIssued({
			creditId: "issued-1",
			peer: postagePeerKey({ chain: "eip155:8453", agentId: 8 }),
			amount: "0.5",
			txHash: "0x2",
		});

		await postageBalanceCommand({}, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as BalanceOutput;
		expect(output.status).toBe("ok");
		expect(output.data?.held).toEqual([
			{
				credit_id: "held-1",
				peer: "eip155:8453#7",
				amount: "0.01",
				spent: "0.001",
				remaining: "0.009",
				next_seq: 2,
				certificate_verified: true,
			},
		]);
		expect(output.data?.issued).toEqual([
			{
				credit_id: "issued-1",
				peer: "eip155:8453#8",
				amount: "0.5",
				spent: "0",
				remaining: "0.5",
				last_seq: 0,
			},
		]);
	});

	it("filters by peer key when --peer does not match a contact", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const ledger = new FilePostageLedger(dataDir);
		await ledger.recordHeld({
			creditId: "held-1",
			peer: postagePeerKey({ chain: "eip155:8453", agentId: 7 }),
			amount: "0.01",
			txHash: "0x1",
		});
		await ledger.recordHeld({
			creditId: "held-2",
			peer: postagePeerKey({ chain: "eip155:8453", agentId: 8 }),
			amount: "0.02",
			txHash: "0x2",
		});

		await postageBalanceCommand({ peer: "eip155:8453#8" }, { output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as BalanceOutput;
		expect(output.data?.held_count).toBe(1);
		expect(output.data?.held?.[0]?.credit_id).toBe("held-2");
	});
});
