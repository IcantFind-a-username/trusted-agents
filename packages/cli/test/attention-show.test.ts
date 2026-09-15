import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAttentionLedger } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attentionShowCommand } from "../src/commands/attention-show.js";
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

interface AttentionRow {
	peer: string;
	notifications_rendered: number;
	tokens_injected: number;
	escalations: number;
	overflow_suppressed: number;
}

describe("tap attention show", () => {
	let tempRoot: string;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-attention-"));
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("returns an empty list when no ledger exists", async () => {
		const dataDir = await makeAgentDir(tempRoot);

		await attentionShowCommand({ output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { peers?: AttentionRow[]; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.peers).toEqual([]);
		expect(output.data?.count).toBe(0);
		expect(stderrWrites).toEqual([]);
	});

	it("summarizes the ledger per peer, highest token spend first", async () => {
		const dataDir = await makeAgentDir(tempRoot);
		const ledger = new FileAttentionLedger(dataDir);
		await ledger.record(
			[
				{
					peer: { chain: "eip155:8453", agentId: 7 },
					notificationsRendered: 3,
					tokensInjected: 40,
					escalations: 1,
				},
				{ peer: { chain: "eip155:8453", agentId: 8 }, tokensInjected: 90, overflowSuppressed: 12 },
				{ peer: null, tokensInjected: 6 },
			],
			{ at: "2026-08-27T10:00:00.000Z", identity: { chain: "eip155:8453", agentId: 42 } },
		);

		await attentionShowCommand({ output: "json", dataDir });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { peers?: AttentionRow[]; count?: number };
		};
		expect(output.status).toBe("ok");
		expect(output.data?.count).toBe(3);
		const peers = output.data?.peers ?? [];
		expect(peers.map((p) => p.peer)).toEqual(["eip155:8453#8", "eip155:8453#7", "unattributed"]);
		expect(peers[0]).toEqual({
			peer: "eip155:8453#8",
			notifications_rendered: 0,
			tokens_injected: 90,
			escalations: 0,
			overflow_suppressed: 12,
		});
		expect(peers[1]?.escalations).toBe(1);
	});
});
