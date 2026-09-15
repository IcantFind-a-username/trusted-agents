import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTrustStore, createEmptyPermissionState, createGrantSet } from "trusted-agents-core";
import type { Contact } from "trusted-agents-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageSendCommand } from "../src/commands/message-send.js";
import { useCapturedOutput } from "./helpers/capture-output.js";

// A chain with no configured RPC: price resolution fails immediately and
// offline instead of touching a public endpoint from a unit test.
const MINIMAL_CONFIG = [
	"agent_id: 1",
	"chain: eip155:999999",
	"ows:",
	"  wallet: demo-wallet",
	"  api_key: demo-key",
].join("\n");

const PEER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

function makeContact(): Contact {
	return {
		connectionId: "conn-dry-run",
		peerAgentId: 42,
		peerChain: "eip155:999999",
		peerOwnerAddress: PEER_ADDRESS,
		peerDisplayName: "Bob",
		peerAgentAddress: PEER_ADDRESS,
		permissions: createEmptyPermissionState("2026-08-27T00:00:00.000Z"),
		establishedAt: "2026-08-27T00:00:00.000Z",
		lastContactAt: "2026-08-27T00:00:00.000Z",
		status: "active",
	};
}

describe("tap message send --dry-run", () => {
	let tempRoot: string;
	let dataDir: string;
	const { stdout: stdoutWrites, stderr: stderrWrites } = useCapturedOutput();

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-msg-dry-run-"));
		dataDir = join(tempRoot, "agent");
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(dataDir, "config.yaml"), MINIMAL_CONFIG, "utf-8");
		process.exitCode = undefined;
	});

	afterEach(async () => {
		process.exitCode = undefined;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("previews the message without sending; unknown pricing renders as null", async () => {
		// No tapd is running and no resolver chain is configured: a dry-run
		// must still succeed (nothing is sent) and price resolution failure
		// degrades to "unknown", never to an error.
		const store = new FileTrustStore(dataDir);
		await store.addContact(makeContact());

		await messageSendCommand("Bob", "hello there", { output: "json", dataDir }, { dryRun: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: {
				dry_run: boolean;
				peer: string;
				agent_id: number;
				scope: string;
				text_chars: number;
				attention_pricing: unknown;
				estimated_tier: unknown;
				estimated_cost: unknown;
			};
		};
		expect(output.status).toBe("ok");
		expect(output.data?.dry_run).toBe(true);
		expect(output.data?.peer).toBe("Bob");
		expect(output.data?.agent_id).toBe(42);
		expect(output.data?.scope).toBe("general-chat");
		expect(output.data?.text_chars).toBe("hello there".length);
		expect(output.data?.attention_pricing).toBeNull();
		expect(output.data?.estimated_tier).toBeNull();
		expect(output.data?.estimated_cost).toBeNull();
		expect(stderrWrites).toEqual([]);
	});

	it("errors when the peer is not a contact", async () => {
		await messageSendCommand("Nobody", "hi", { output: "json", dataDir }, { dryRun: true });
		expect(process.exitCode).not.toBeUndefined();
		expect(process.exitCode).not.toBe(0);
		// The JSON error envelope goes to stdout in --output json mode.
		const combined = stdoutWrites.join("") + stderrWrites.join("");
		expect(combined).toContain("Peer not found in contacts");
	});

	it("keeps a granted peer's grant set readable for tier estimation", async () => {
		const contact = makeContact();
		contact.permissions.grantedByPeer = createGrantSet(
			[{ grantId: "g-msg", scope: "message/send" }],
			"2026-08-27T00:00:00.000Z",
		);
		const store = new FileTrustStore(dataDir);
		await store.addContact(contact);

		await messageSendCommand("Bob", "hello", { output: "json", dataDir }, { dryRun: true });

		const output = JSON.parse(stdoutWrites.join("")) as {
			status: string;
			data?: { estimated_tier: unknown };
		};
		expect(output.status).toBe("ok");
		// Pricing resolution fails in this offline fixture, so the tier stays
		// null even though the grant exists — the tier is only meaningful
		// alongside an actual price list (covered end-to-end in e2e-mock).
		expect(output.data?.estimated_tier).toBeNull();
	});
});
