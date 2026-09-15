import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FileConversationLogger,
	FileRequestJournal,
	FileTrustStore,
	generateInvite,
} from "trusted-agents-core";
import type { SigningProvider, TransportProvider, TransportReceipt } from "trusted-agents-core";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearCliRuntimeOverride, setCliRuntimeOverride } from "../../src/lib/runtime-overrides.js";
import { type InProcessTapd, startInProcessTapd } from "../helpers/in-process-tapd.ts";
import {
	LoopbackTransportNetwork,
	StaticAgentResolver,
	clearLoopbackRuntime,
	createResolvedAgentFixture,
	installLoopbackRuntime,
} from "../helpers/loopback-runtime.js";
import { runCli } from "../helpers/run-cli.js";
import { type PermissionSnapshot, parseJsonOutput, writeGrantFile } from "./helpers.js";
import { SCENARIOS } from "./scenarios.js";

// ── Keys & addresses ─────────────────────────────────────────────────────────

const CHAIN = "eip155:8453";
const AGENT_A_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const AGENT_B_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const AGENT_A_ADDRESS = privateKeyToAccount(AGENT_A_KEY).address;
const AGENT_B_ADDRESS = privateKeyToAccount(AGENT_B_KEY).address;
const AGENT_A_ID = 7001;
const AGENT_B_ID = 7002;
const AGENT_A_NAME = "E2E-Agent-A-mock";
const AGENT_B_NAME = "E2E-Agent-B-mock";
const GRANT_ID = "e2e-usdc-transfer";

// ── Signing providers ────────────────────────────────────────────────────────

function createTestSigningProvider(key: `0x${string}`): SigningProvider {
	const account = privateKeyToAccount(key);
	return {
		getAddress: async () => account.address,
		signMessage: async (message) => await account.signMessage({ message }),
		signTypedData: async (params) =>
			await account.signTypedData({
				domain: params.domain as Record<string, unknown>,
				types: params.types as Record<string, readonly { name: string; type: string }[]>,
				primaryType: params.primaryType,
				message: params.message as Record<string, unknown>,
			}),
		signTransaction: async (tx) => await account.signTransaction(tx as never),
		signAuthorization: async () => {
			throw new Error("not implemented in test");
		},
	};
}

const agentASigningProvider = createTestSigningProvider(AGENT_A_KEY);
const agentBSigningProvider = createTestSigningProvider(AGENT_B_KEY);

// ── OWS mock ─────────────────────────────────────────────────────────────────

vi.mock("trusted-agents-core", async () => {
	const actual = await vi.importActual<typeof import("trusted-agents-core")>("trusted-agents-core");
	return {
		...actual,
		OwsSigningProvider: class MockOwsSigningProvider {
			private provider: SigningProvider;
			constructor(wallet: string) {
				this.provider = wallet === "agent-b-wallet" ? agentBSigningProvider : agentASigningProvider;
			}
			getAddress() {
				return this.provider.getAddress();
			}
			signMessage(msg: unknown) {
				return this.provider.signMessage(msg as never);
			}
			signTypedData(params: unknown) {
				return this.provider.signTypedData(params as never);
			}
			signTransaction(tx: unknown) {
				return this.provider.signTransaction(tx as never);
			}
			signAuthorization(params: unknown) {
				return this.provider.signAuthorization(params as never);
			}
		},
	};
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setOwsConfig(
	dataDir: string,
	walletName: string,
	apiKey: string,
	agentId: number,
): Promise<void> {
	const configPath = join(dataDir, "config.yaml");
	const { default: YAML } = await import("yaml");
	const content = await readFile(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown>;
	yaml.agent_id = agentId;
	yaml.ows = { wallet: walletName, api_key: apiKey };
	await writeFile(configPath, YAML.stringify(yaml), "utf-8");
}

async function setAttentionConfig(
	dataDir: string,
	attention: { enforce?: boolean; pricing?: Record<string, string> },
): Promise<void> {
	const configPath = join(dataDir, "config.yaml");
	const { default: YAML } = await import("yaml");
	const content = await readFile(configPath, "utf-8");
	const yaml = YAML.parse(content) as Record<string, unknown>;
	yaml.attention = attention;
	await writeFile(configPath, YAML.stringify(yaml), "utf-8");
}

async function waitForPermissionsMock(
	dataDir: string,
	peer: string,
	predicate: (data: PermissionSnapshot) => boolean,
	timeoutMs = 2_000,
): Promise<PermissionSnapshot> {
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot: PermissionSnapshot | undefined;

	while (Date.now() < deadline) {
		const result = await runCli(["--json", "--data-dir", dataDir, "permissions", "show", peer]);
		if (result.exitCode === 0) {
			const data = (JSON.parse(result.stdout) as { data: PermissionSnapshot }).data;
			lastSnapshot = data;
			if (predicate(data)) {
				return data;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error(
		`Timed out waiting for permissions for ${peer}: ${JSON.stringify(lastSnapshot ?? null)}`,
	);
}

// ── Shared state ──────────────────────────────────────────────────────────────

let tempRoot: string;
let agentADir: string;
let agentBDir: string;
let inviteUrl: string;
let agentATapd: InProcessTapd | undefined;
let agentBTapd: InProcessTapd | undefined;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("TAP mocked E2E — loopback transport + static resolver", { timeout: 20_000 }, () => {
	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "tap-e2e-mock-"));
		agentADir = join(tempRoot, "agent-a");
		agentBDir = join(tempRoot, "agent-b");
		await mkdir(agentADir, { recursive: true });
		await mkdir(agentBDir, { recursive: true });

		const resolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: AGENT_A_NAME,
				description: "Loopback E2E agent A",
				capabilities: ["general-chat", "payments"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: AGENT_B_NAME,
				description: "Loopback E2E agent B",
				capabilities: ["general-chat", "payments"],
				// Phase 6 exercises attention pricing: B advertises a price list
				// so A's dry-run can quote it and A's sends wait for receipts.
				// The priority tier is Phase 8's paid wake-up price.
				attention: {
					version: "1.0",
					currency: "USDC",
					chain: CHAIN,
					pricing: { grantHolder: "0", standard: "0.001", priority: "0.002" },
				},
			}),
		]);

		const network = new LoopbackTransportNetwork();

		installLoopbackRuntime({
			dataDir: agentADir,
			network,
			resolver,
			txHashPrefix: "a1",
		});
		installLoopbackRuntime({
			dataDir: agentBDir,
			network,
			resolver,
			txHashPrefix: "b2",
		});
	});

	afterAll(async () => {
		await agentBTapd?.stop();
		await agentATapd?.stop();
		clearLoopbackRuntime(agentBDir);
		clearLoopbackRuntime(agentADir);
		await rm(tempRoot, { recursive: true, force: true });
	});

	// ── Phase 1: Onboarding ───────────────────────────────────────────────────

	describe("Phase 1: Onboarding", () => {
		it(SCENARIOS.INIT_AGENT_A.name, async () => {
			const result = await runCli(["--plain", "--data-dir", agentADir, "init", "--chain", "base"]);
			expect(result.exitCode, `Agent A init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.INIT_AGENT_B.name, async () => {
			const result = await runCli(["--plain", "--data-dir", agentBDir, "init", "--chain", "base"]);
			expect(result.exitCode, `Agent B init failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.RESOLVE_AGENT_A.name, async () => {
			await setOwsConfig(agentADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);

			const result = await runCli(["--json", "--data-dir", agentADir, "identity", "resolve-self"]);
			expect(result.exitCode, `Agent A resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string };
			expect(data.name, "Agent A resolved name should match fixture").toBe(AGENT_A_NAME);
		});

		it(SCENARIOS.RESOLVE_AGENT_B.name, async () => {
			await setOwsConfig(agentBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			const result = await runCli(["--json", "--data-dir", agentBDir, "identity", "resolve-self"]);
			expect(result.exitCode, `Agent B resolve-self failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { name: string };
			expect(data.name, "Agent B resolved name should match fixture").toBe(AGENT_B_NAME);
		});

		it("starts in-process tapd for both agents", async () => {
			// Phase 3: every transport-touching CLI command goes through tapd's
			// HTTP API, so we spin up a real Daemon per agent against the
			// configured loopback runtime override. The CLI `runCli` calls
			// will discover these via the per-dataDir `.tapd-token` files.
			agentATapd = await startInProcessTapd({
				dataDir: agentADir,
				identityAgentId: AGENT_A_ID,
				approveTransfer: async ({ activeTransferGrants }) => activeTransferGrants.length > 0,
			});
			agentBTapd = await startInProcessTapd({
				dataDir: agentBDir,
				identityAgentId: AGENT_B_ID,
			});
			expect(agentATapd.port).toBeGreaterThan(0);
			expect(agentBTapd.port).toBeGreaterThan(0);
		});
	});

	// ── Phase 2: Connection ───────────────────────────────────────────────────

	describe("Phase 2: Connection", () => {
		it(SCENARIOS.CREATE_INVITE.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "invite", "create"]);
			expect(result.exitCode, `Agent A invite create failed:\n${result.stderr}`).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			const data = parsed.data as { url: string };
			expect(data.url, "Invite URL should be defined").toBeTruthy();
			inviteUrl = data.url;
		});

		it(SCENARIOS.ACCEPT_INVITE.name, async () => {
			expect(inviteUrl, "Invite URL must be set from previous test").toBeTruthy();

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"connect",
				inviteUrl,
				"--no-wait",
			]);
			expect(result.exitCode, `Agent B connect failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Status:");
		});

		it(SCENARIOS.SYNC_CONNECTION_A.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "message", "sync"]);
			expect(result.exitCode, `Agent A sync failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.SYNC_CONNECTION_B.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "message", "sync"]);
			expect(result.exitCode, `Agent B sync failed:\n${result.stderr}`).toBe(0);
		});

		it(SCENARIOS.VERIFY_CONTACTS_A.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentADir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const contacts = (
				JSON.parse(result.stdout) as { data: { contacts: Array<{ name: string; status: string }> } }
			).data.contacts;
			const contact = contacts.find((c) => c.name === AGENT_B_NAME);
			expect(contact, `Agent B contact should exist in Agent A's contacts`).toBeDefined();
			expect(contact?.status, "Agent A should have active contact with Agent B").toBe("active");
		});

		it(SCENARIOS.VERIFY_CONTACTS_B.name, async () => {
			const result = await runCli(["--json", "--data-dir", agentBDir, "contacts", "list"]);
			expect(result.exitCode).toBe(0);
			const contacts = (
				JSON.parse(result.stdout) as { data: { contacts: Array<{ name: string; status: string }> } }
			).data.contacts;
			const contact = contacts.find((c) => c.name === AGENT_A_NAME);
			expect(contact, `Agent A contact should exist in Agent B's contacts`).toBeDefined();
			expect(contact?.status, "Agent B should have active contact with Agent A").toBe("active");
		});
	});

	// ── Phase 3: Permissions ──────────────────────────────────────────────────

	describe("Phase 3: Permissions", () => {
		it(SCENARIOS.VERIFY_NO_GRANTS.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"permissions",
				"show",
				AGENT_A_NAME,
			]);
			expect(result.exitCode, `permissions show failed:\n${result.stderr}`).toBe(0);

			const parsed = JSON.parse(result.stdout) as { data: PermissionSnapshot };
			expect(
				parsed.data.granted_by_peer.grants,
				"Agent B should have no grants from Agent A before granting",
			).toEqual([]);
		});

		it(SCENARIOS.GRANT_TRANSFER.name, async () => {
			// Listeners are no longer needed: the in-process tapd started in
			// Phase 1.5 owns the transport for both agents, and the
			// approveTransfer hook is wired into agent A's in-process tapd at
			// startup time.
			const grantFilePath = await writeGrantFile(agentADir, "transfer-grant.json", [
				{
					grantId: GRANT_ID,
					scope: "transfer/request",
					constraints: {
						asset: "native",
						chain: CHAIN,
						maxAmount: "0.001",
					},
				},
			]);

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"grant",
				AGENT_B_NAME,
				"--file",
				grantFilePath,
				"--note",
				"e2e mock transfer grant",
			]);
			expect(result.exitCode, `Agent A permissions grant failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Published:    true");
		});

		it(SCENARIOS.VERIFY_GRANT.name, async () => {
			const snapshot = await waitForPermissionsMock(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "active"),
				2_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant, `Grant "${GRANT_ID}" should be visible to Agent B`).toBeDefined();
			expect(grant?.status, `Grant "${GRANT_ID}" should be active`).toBe("active");
		});
	});

	// ── Phase 4: Messaging ────────────────────────────────────────────────────

	describe("Phase 4: Messaging", () => {
		it(SCENARIOS.SEND_MESSAGE_A_TO_B.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"ping from agent A",
				"--scope",
				"general-chat",
			]);
			expect(result.exitCode, `Agent A message send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");
		});

		it(SCENARIOS.SEND_MESSAGE_B_TO_A.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"send",
				AGENT_A_NAME,
				"pong from agent B",
				"--scope",
				"general-chat",
			]);
			expect(result.exitCode, `Agent B message send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");
		});

		it(SCENARIOS.VERIFY_CONVERSATIONS.name, async () => {
			// With loopback listeners active, messages are delivered instantly through the listener.
			// A sync pass ensures any queued messages from non-listener sends are also processed.
			await runCli(["--json", "--data-dir", agentADir, "message", "sync"]);
			await runCli(["--json", "--data-dir", agentBDir, "message", "sync"]);

			const aResult = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"conversations",
				"list",
				"--with",
				AGENT_B_NAME,
			]);
			expect(aResult.exitCode, `Agent A conversations list failed:\n${aResult.stderr}`).toBe(0);
			const aConvos = (
				JSON.parse(aResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			expect(
				aConvos.length,
				"Agent A should have at least one conversation with Agent B",
			).toBeGreaterThan(0);
			expect(
				aConvos[0]!.messages,
				"Agent A conversation should contain at least one message",
			).toBeGreaterThan(0);

			const bResult = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"conversations",
				"list",
				"--with",
				AGENT_A_NAME,
			]);
			expect(bResult.exitCode, `Agent B conversations list failed:\n${bResult.stderr}`).toBe(0);
			const bConvos = (
				JSON.parse(bResult.stdout) as {
					data: { conversations: Array<{ id: string; messages: number }> };
				}
			).data.conversations;
			expect(
				bConvos.length,
				"Agent B should have at least one conversation with Agent A",
			).toBeGreaterThan(0);
			expect(
				bConvos[0]!.messages,
				"Agent B conversation should contain at least one message",
			).toBeGreaterThan(0);
		});
	});

	// ── Phase 5: Transfers ────────────────────────────────────────────────────

	describe("Phase 5: Transfers", () => {
		it(SCENARIOS.REQUEST_FUNDS_APPROVED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"native",
				"--amount",
				"0.0002",
				"--chain",
				"base",
				"--note",
				"e2e mock approved transfer",
			]);
			expect(result.exitCode, `Agent B request-funds failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Status:                   completed");
			// The loopback executor mints per-call unique hashes with A's "a1"
			// prefix (real chains never reuse a txHash, and neither may mocks).
			expect(result.stdout).toMatch(/0xa1[0-9a-f]{62}/);
		});

		it(SCENARIOS.REVOKE_GRANT.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"permissions",
				"revoke",
				AGENT_B_NAME,
				"--grant-id",
				GRANT_ID,
				"--note",
				"e2e mock revoke after transfer test",
			]);
			expect(result.exitCode, `Agent A permissions revoke failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Revoked:   true");
		});

		it(SCENARIOS.SYNC_REVOCATION.name, async () => {
			const snapshot = await waitForPermissionsMock(
				agentBDir,
				AGENT_A_NAME,
				(data) =>
					data.granted_by_peer.grants.some((g) => g.grantId === GRANT_ID && g.status === "revoked"),
				2_000,
			);

			const grant = snapshot.granted_by_peer.grants.find((g) => g.grantId === GRANT_ID);
			expect(grant?.status, `Grant "${GRANT_ID}" should be revoked`).toBe("revoked");
		});

		it(SCENARIOS.REQUEST_FUNDS_REJECTED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"message",
				"request-funds",
				AGENT_A_NAME,
				"--asset",
				"native",
				"--amount",
				"0.0001",
				"--chain",
				"base",
				"--note",
				"e2e mock rejected transfer (no grant)",
			]);
			// Accept exit code 0 (queued) or 3 (immediately rejected)
			expect(
				[0, 3].includes(result.exitCode),
				`Expected exit code 0 or 3, got ${result.exitCode}:\n${result.stderr}`,
			).toBe(true);
		});
	});

	// ═══════════════════════════════════════════════════════
	// Edge case: pending outbound connect without contact
	// ═══════════════════════════════════════════════════════

	it("persists pending outbound connects without creating a contact", async () => {
		const pendingRoot = await mkdtemp(join(tmpdir(), "tap-e2e-pending-"));
		const pendingDir = join(pendingRoot, "connector");
		await mkdir(pendingDir, { recursive: true });

		const pendingAgentId = 7010;
		const pendingAgent = createResolvedAgentFixture({
			agentId: pendingAgentId,
			chain: CHAIN,
			address: AGENT_A_ADDRESS,
			name: "PendingPeer",
			description: "Pending peer agent",
			capabilities: ["general-chat"],
		});

		class PendingTransport implements TransportProvider {
			setHandlers(): void {}
			async start(): Promise<void> {}
			async stop(): Promise<void> {}
			async isReachable(): Promise<boolean> {
				return true;
			}
			async send(): Promise<TransportReceipt> {
				return {
					received: true,
					requestId: "pending-response",
					status: "queued",
					receivedAt: "2026-03-06T00:00:00.000Z",
				};
			}
		}

		let pendingTapd: InProcessTapd | undefined;
		try {
			setCliRuntimeOverride(pendingDir, {
				createContext: () => ({
					trustStore: new FileTrustStore(pendingDir),
					resolver: new StaticAgentResolver([pendingAgent]),
					conversationLogger: new FileConversationLogger(pendingDir),
					requestJournal: new FileRequestJournal(pendingDir),
				}),
				createTransport: () => new PendingTransport(),
			});

			expect(
				await runCli(["--plain", "--data-dir", pendingDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(pendingDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			pendingTapd = await startInProcessTapd({
				dataDir: pendingDir,
				identityAgentId: AGENT_B_ID,
			});

			const invite = await generateInvite({
				agentId: pendingAgentId,
				chain: CHAIN,
				signingProvider: agentASigningProvider,
				expirySeconds: 3600,
			});

			const connect = await runCli([
				"--json",
				"--data-dir",
				pendingDir,
				"connect",
				invite.url,
				"--no-wait",
			]);
			expect(connect.exitCode).toBe(0);

			const output = parseJsonOutput(connect.stdout).data as {
				connection_id?: string;
				status: string;
			};
			expect(output.status).toBe("pending");
			// connection_id is now defined — the connecting contact is written
			// to the trust store before any wire traffic (spec §1.1).
			expect(output.connection_id).toBeDefined();

			const trustStore = new FileTrustStore(pendingDir);
			const contacts = await trustStore.getContacts();
			expect(contacts).toHaveLength(1);
			expect(contacts[0]).toMatchObject({
				peerAgentId: pendingAgentId,
				status: "connecting",
			});
		} finally {
			await pendingTapd?.stop();
			clearCliRuntimeOverride(pendingDir);
			await rm(pendingRoot, { recursive: true, force: true });
		}
	});

	// ── Phase 6: Attention pricing ────────────────────────────────────────────

	describe("Phase 6: Attention pricing", () => {
		it(SCENARIOS.ATTENTION_DRY_RUN.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"cost preview",
				"--dry-run",
			]);
			expect(result.exitCode, `dry-run failed:\n${result.stderr}`).toBe(0);

			const data = parseJsonOutput(result.stdout).data as {
				dry_run: boolean;
				attention_currency: string | null;
				attention_pricing: Record<string, string> | null;
				estimated_tier: string | null;
				estimated_cost: string | null;
			};
			expect(data.dry_run).toBe(true);
			expect(data.attention_currency).toBe("USDC");
			expect(data.attention_pricing).toEqual({
				grantHolder: "0",
				standard: "0.001",
				priority: "0.002",
			});
			expect(data.estimated_tier).toBe("standard");
			expect(data.estimated_cost).toBe("0.001");
		});

		it(SCENARIOS.ATTENTION_ENFORCE_ON.name, async () => {
			// The daemon reads config at startup, so flipping enforcement means
			// restarting Agent B's in-process tapd.
			await setAttentionConfig(agentBDir, {
				enforce: true,
				pricing: { grantHolder: "0", standard: "0.001" },
			});
			await agentBTapd?.stop();
			agentBTapd = await startInProcessTapd({
				dataDir: agentBDir,
				identityAgentId: AGENT_B_ID,
			});
			expect(agentBTapd.port).toBeGreaterThan(0);
		});

		it(SCENARIOS.ATTENTION_REJECTED.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"unpaid ping",
			]);
			expect(result.exitCode, "un-granted send must be rejected").not.toBe(0);
			expect(`${result.stdout}\n${result.stderr}`).toContain("attention payment required");

			// The rejected message never reached Agent B's conversation log.
			const conversations = await runCli([
				"--json",
				"--data-dir",
				agentBDir,
				"conversations",
				"list",
				"--with",
				AGENT_A_NAME,
			]);
			expect(conversations.stdout).not.toContain("unpaid ping");
		});

		it(SCENARIOS.ATTENTION_GRANT_EXEMPT.name, async () => {
			const grantFilePath = await writeGrantFile(agentBDir, "message-grant.json", [
				{ grantId: "e2e-message-send", scope: "message/send" },
			]);
			const grant = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"permissions",
				"grant",
				AGENT_A_NAME,
				"--file",
				grantFilePath,
				"--note",
				"e2e attention exemption",
			]);
			expect(grant.exitCode, `Agent B message/send grant failed:\n${grant.stderr}`).toBe(0);

			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"granted ping",
			]);
			expect(result.exitCode, `granted send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");
		});
	});

	// ── Phase 7: Prepaid postage ──────────────────────────────────────────────

	describe("Phase 7: Prepaid postage", () => {
		let topupCreditId: string | undefined;

		// Delivery in this phase is asserted through B's issued postage ledger,
		// not B's conversation log: the debit happens on B only after
		// enforcement accepted the stamp (the point of this phase), while the
		// mock runtime's legacy file conversation logger is invisible to the
		// CLI's SQLite-backed conversations commands after their one-shot
		// migration — even Phase 6's granted ping never shows up there.
		async function issuedLedgerB(): Promise<
			Array<{ credit_id: string; spent: string; remaining: string; last_seq: number }>
		> {
			const balance = await runCli(["--json", "--data-dir", agentBDir, "postage", "balance"]);
			return (
				parseJsonOutput(balance.stdout).data as {
					issued: Array<{ credit_id: string; spent: string; remaining: string; last_seq: number }>;
				}
			).issued;
		}

		it(SCENARIOS.POSTAGE_REVOKE_EXEMPTION.name, async () => {
			// Phase 6 left Agent A holding a message/send grant from B. Revoke
			// it so postage is the only way A's messages buy attention again.
			const revoke = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"permissions",
				"revoke",
				AGENT_A_NAME,
				"--grant-id",
				"e2e-message-send",
			]);
			expect(revoke.exitCode, `revoke failed:\n${revoke.stderr}`).toBe(0);

			// A's runtime must see the revocation before it decides whether to
			// stamp — auto-stamping consults A's grantedByPeer view.
			await waitForPermissionsMock(agentADir, AGENT_B_NAME, (snapshot) =>
				snapshot.granted_by_peer.grants.some(
					(grant) => grant.grantId === "e2e-message-send" && grant.status === "revoked",
				),
			);
		});

		it(SCENARIOS.POSTAGE_TOPUP.name, async () => {
			const result = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"postage",
				"topup",
				AGENT_B_NAME,
				"--amount",
				"0.002",
				"--yes",
			]);
			expect(result.exitCode, `postage topup failed:\n${result.stderr}`).toBe(0);

			const data = parseJsonOutput(result.stdout).data as {
				status: string;
				credit_id: string;
				tx_hash: string;
				certificate_verified: boolean;
			};
			expect(data.status).toBe("accepted");
			expect(data.certificate_verified).toBe(true);
			expect(data.credit_id).toBeTruthy();
			expect(data.tx_hash).toBeTruthy();
			topupCreditId = data.credit_id;

			// Both sides recorded the credit: A holds it, B issued it.
			const balanceA = await runCli(["--json", "--data-dir", agentADir, "postage", "balance"]);
			const heldA = (
				parseJsonOutput(balanceA.stdout).data as {
					held: Array<{ credit_id: string; remaining: string }>;
				}
			).held;
			expect(heldA).toMatchObject([{ credit_id: data.credit_id, remaining: "0.002" }]);

			const balanceB = await runCli(["--json", "--data-dir", agentBDir, "postage", "balance"]);
			const issuedB = (
				parseJsonOutput(balanceB.stdout).data as {
					issued: Array<{ credit_id: string; remaining: string }>;
				}
			).issued;
			expect(issuedB).toMatchObject([{ credit_id: data.credit_id, remaining: "0.002" }]);
		});

		it(SCENARIOS.POSTAGE_STAMPED_SEND.name, async () => {
			const result = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"stamped ping",
			]);
			expect(result.exitCode, `stamped send failed:\n${result.stderr}`).toBe(0);
			expect(result.stdout).toContain("Sent:      true");

			// B accepted the stamp and debited the issued credit — the debit
			// only happens after enforcement let the message through.
			expect(await issuedLedgerB()).toMatchObject([
				{ credit_id: topupCreditId, spent: "0.001", remaining: "0.001", last_seq: 1 },
			]);
		});

		it(SCENARIOS.POSTAGE_EXHAUSTED.name, async () => {
			// Second stamp drains the 0.002 credit...
			const second = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"stamped ping two",
			]);
			expect(second.exitCode, `second stamped send failed:\n${second.stderr}`).toBe(0);

			// ...so the third send goes out unstamped and B rejects it with the
			// machine-readable top-up quote.
			const third = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"over budget ping",
			]);
			expect(third.exitCode, "exhausted send must be rejected").not.toBe(0);
			expect(`${third.stdout}\n${third.stderr}`).toContain("attention payment required");

			// The rejected message consumed nothing on B: the ledger still
			// shows exactly the two accepted stamps.
			expect(await issuedLedgerB()).toMatchObject([
				{ credit_id: topupCreditId, spent: "0.002", remaining: "0", last_seq: 2 },
			]);
		});

		it(SCENARIOS.POSTAGE_BALANCE.name, async () => {
			const balanceA = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"postage",
				"balance",
				"--peer",
				AGENT_B_NAME,
			]);
			const dataA = parseJsonOutput(balanceA.stdout).data as {
				held: Array<{ credit_id: string; remaining: string; next_seq: number }>;
				issued: unknown[];
			};
			expect(dataA.held).toMatchObject([{ credit_id: topupCreditId, remaining: "0", next_seq: 3 }]);
			expect(dataA.issued).toEqual([]);

			const balanceB = await runCli(["--json", "--data-dir", agentBDir, "postage", "balance"]);
			const dataB = parseJsonOutput(balanceB.stdout).data as {
				issued: Array<{ credit_id: string; spent: string; last_seq: number }>;
			};
			expect(dataB.issued).toMatchObject([
				{ credit_id: topupCreditId, spent: "0.002", last_seq: 2 },
			]);
		});
	});

	// ── Phase 8: Paid wake-ups + notification quotas ──────────────────────────

	describe("Phase 8: Paid wake-ups + notification quotas", () => {
		const PRIORITY_TEXT = "priority payload needing the full excerpt ".repeat(6).trim();
		let wakeCreditId: string | undefined;

		// Drain B's notification queue over the in-process daemon's HTTP
		// surface — exactly what the OpenClaw/Hermes hosts consume, with the
		// quota fold already applied server-side.
		async function drainB(): Promise<Array<{ type: string; oneLiner: string; count?: number }>> {
			const response = await fetch(`http://127.0.0.1:${agentBTapd?.port}/api/notifications/drain`, {
				headers: { authorization: `Bearer ${agentBTapd?.token}` },
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				notifications: Array<{ type: string; oneLiner: string; count?: number }>;
			};
			return body.notifications;
		}

		it(SCENARIOS.WAKE_PRICING_ON.name, async () => {
			await setAttentionConfig(agentBDir, {
				enforce: true,
				pricing: { grantHolder: "0", standard: "0.001", priority: "0.002" },
			});
			await agentBTapd?.stop();
			agentBTapd = await startInProcessTapd({
				dataDir: agentBDir,
				identityAgentId: AGENT_B_ID,
			});
			expect(agentBTapd.port).toBeGreaterThan(0);
		});

		it(SCENARIOS.WAKE_PRIORITY_STAMP.name, async () => {
			// Fresh credit — Phase 7 drained the first one dry.
			const topup = await runCli([
				"--json",
				"--data-dir",
				agentADir,
				"postage",
				"topup",
				AGENT_B_NAME,
				"--amount",
				"0.004",
				"--yes",
			]);
			expect(topup.exitCode, `topup failed:\n${topup.stderr}`).toBe(0);
			wakeCreditId = (parseJsonOutput(topup.stdout).data as { credit_id: string }).credit_id;

			const send = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				PRIORITY_TEXT,
				"--priority",
			]);
			expect(send.exitCode, `priority send failed:\n${send.stderr}`).toBe(0);

			const drained = await drainB();
			const escalation = drained.find((n) => n.type === "escalation");
			expect(escalation, "priority message must escalate").toBeDefined();
			expect(escalation?.oneLiner).toContain("Priority message from");
			// The paid excerpt keeps far more than the standard 80 chars.
			expect(escalation?.oneLiner).toContain(PRIORITY_TEXT.slice(0, 200));

			// The stamp paid the priority price, not standard.
			const balanceB = await runCli(["--json", "--data-dir", agentBDir, "postage", "balance"]);
			const issued = (
				parseJsonOutput(balanceB.stdout).data as {
					issued: Array<{ credit_id: string; spent: string }>;
				}
			).issued;
			expect(issued.find((c) => c.credit_id === wakeCreditId)).toMatchObject({
				spent: "0.002",
			});
		});

		it(SCENARIOS.QUOTA_GRANT_FOLD.name, async () => {
			// B re-grants A message/send, now metered: 2 rendered lines/week.
			// The priority escalation above already billed A one rendered line.
			const grantFilePath = await writeGrantFile(agentBDir, "quota-grant.json", [
				{
					grantId: "e2e-quota-msg",
					scope: "message/send",
					constraints: { notificationsPerWeek: 2 },
				},
			]);
			const grant = await runCli([
				"--plain",
				"--data-dir",
				agentBDir,
				"permissions",
				"grant",
				AGENT_A_NAME,
				"--file",
				grantFilePath,
				"--note",
				"e2e metered exemption",
			]);
			expect(grant.exitCode, `quota grant failed:\n${grant.stderr}`).toBe(0);
			await waitForPermissionsMock(agentADir, AGENT_B_NAME, (snapshot) =>
				snapshot.granted_by_peer.grants.some(
					(entry) => entry.grantId === "e2e-quota-msg" && entry.status === "active",
				),
			);

			// Under quota (1 of 2 rendered): free chatter still renders,
			// coalesced into one counted line.
			for (const text of ["quota chatter one", "quota chatter two"]) {
				const result = await runCli([
					"--plain",
					"--data-dir",
					agentADir,
					"message",
					"send",
					AGENT_B_NAME,
					text,
				]);
				expect(result.exitCode, `free send failed:\n${result.stderr}`).toBe(0);
			}
			const first = await drainB();
			expect(first).toHaveLength(1);
			expect(first[0]).toMatchObject({ type: "info", count: 2 });

			// Quota reached (2 of 2): the next batch folds to a summary line.
			for (const text of ["quota chatter three", "quota chatter four"]) {
				const result = await runCli([
					"--plain",
					"--data-dir",
					agentADir,
					"message",
					"send",
					AGENT_B_NAME,
					text,
				]);
				expect(result.exitCode, `free send failed:\n${result.stderr}`).toBe(0);
			}
			const second = await drainB();
			expect(second).toHaveLength(1);
			expect(second[0]?.type).toBe("summary");
			expect(second[0]?.oneLiner).toContain("folded — weekly notification quota reached (2/week)");
			expect(second[0]?.oneLiner).not.toContain("quota chatter three");
		});

		it(SCENARIOS.WAKE_GRANT_HOLDER_PRIORITY.name, async () => {
			// A now holds the (exhausted-quota) grant — a priority stamp still
			// buys the escalation, and escalations are never quota-folded.
			const send = await runCli([
				"--plain",
				"--data-dir",
				agentADir,
				"message",
				"send",
				AGENT_B_NAME,
				"granted but urgent: wake up",
				"--priority",
			]);
			expect(send.exitCode, `grant-holder priority send failed:\n${send.stderr}`).toBe(0);

			const drained = await drainB();
			expect(drained).toHaveLength(1);
			expect(drained[0]?.type).toBe("escalation");
			expect(drained[0]?.oneLiner).toContain("granted but urgent");

			// Charged at priority on top of the earlier spend: 0.004 total.
			const balanceB = await runCli(["--json", "--data-dir", agentBDir, "postage", "balance"]);
			const issued = (
				parseJsonOutput(balanceB.stdout).data as {
					issued: Array<{ credit_id: string; spent: string; remaining: string }>;
				}
			).issued;
			expect(issued.find((c) => c.credit_id === wakeCreditId)).toMatchObject({
				spent: "0.004",
				remaining: "0",
			});
		});
	});

	// ═══════════════════════════════════════════════════════
	// Edge case: wipe-and-recover (spec §3.1.1 recovery)
	// ═══════════════════════════════════════════════════════

	it("reconnects after one side wipes its local trust store (spec §3.1.1 recovery)", async () => {
		const wipeRoot = await mkdtemp(join(tmpdir(), "tap-e2e-wipe-"));
		const wipeADir = join(wipeRoot, "agent-a");
		const wipeBDir = join(wipeRoot, "agent-b");
		await mkdir(wipeADir, { recursive: true });
		await mkdir(wipeBDir, { recursive: true });

		const wipeNetwork = new LoopbackTransportNetwork();
		const wipeResolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: AGENT_A_NAME,
				description: "Wipe test Agent A",
				capabilities: ["general-chat"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: AGENT_B_NAME,
				description: "Wipe test Agent B",
				capabilities: ["general-chat"],
			}),
		]);

		installLoopbackRuntime({
			dataDir: wipeADir,
			network: wipeNetwork,
			resolver: wipeResolver,
			txHashPrefix: "e1",
		});
		installLoopbackRuntime({
			dataDir: wipeBDir,
			network: wipeNetwork,
			resolver: wipeResolver,
			txHashPrefix: "f2",
		});

		let wipeATapd: InProcessTapd | undefined;
		let wipeBTapd: InProcessTapd | undefined;
		try {
			// ── 1. Init and configure both agents ──────────────────────────
			expect(
				await runCli(["--plain", "--data-dir", wipeADir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			expect(
				await runCli(["--plain", "--data-dir", wipeBDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(wipeADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);
			await setOwsConfig(wipeBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			// Phase 3: spin up an in-process tapd per agent so the CLI commands
			// have an HTTP target to dispatch transport-touching work to.
			wipeATapd = await startInProcessTapd({
				dataDir: wipeADir,
				identityAgentId: AGENT_A_ID,
			});
			wipeBTapd = await startInProcessTapd({
				dataDir: wipeBDir,
				identityAgentId: AGENT_B_ID,
			});

			// ── 2. Initial invite + connect handshake ──────────────────────
			const firstInvite = await runCli(["--json", "--data-dir", wipeADir, "invite", "create"]);
			expect(firstInvite.exitCode, `Agent A invite create failed:\n${firstInvite.stderr}`).toBe(0);
			const firstInviteUrl = (parseJsonOutput(firstInvite.stdout).data as { url: string }).url;

			const firstConnect = await runCli([
				"--json",
				"--data-dir",
				wipeBDir,
				"connect",
				firstInviteUrl,
				"--no-wait",
			]);
			expect(firstConnect.exitCode, `Agent B first connect failed:\n${firstConnect.stderr}`).toBe(
				0,
			);

			// Sync both sides so the connection/result round-trip completes
			await runCli(["--json", "--data-dir", wipeADir, "message", "sync"]);
			await runCli(["--json", "--data-dir", wipeBDir, "message", "sync"]);

			// Assert both sides have active contact
			const aContactsAfterFirst = await runCli([
				"--json",
				"--data-dir",
				wipeADir,
				"contacts",
				"list",
			]);
			const bContactsAfterFirst = await runCli([
				"--json",
				"--data-dir",
				wipeBDir,
				"contacts",
				"list",
			]);
			const aListFirst = (
				parseJsonOutput(aContactsAfterFirst.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			const bListFirst = (
				parseJsonOutput(bContactsAfterFirst.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			expect(aListFirst[0]?.status, "Agent A should be active after first connect").toBe("active");
			expect(bListFirst[0]?.status, "Agent B should be active after first connect").toBe("active");

			// ── 3. Simulate Agent A wiping her trust store ─────────────────
			// Agent A deletes her contact record for Agent B (simulates data loss
			// or manual trust store wipe). Agent B's store is untouched.
			const wipeTrustStore = new FileTrustStore(wipeADir);
			const wipeContacts = await wipeTrustStore.getContacts();
			expect(wipeContacts, "Agent A should have exactly one contact before wipe").toHaveLength(1);
			await wipeTrustStore.removeContact(wipeContacts[0]!.connectionId);

			// Verify the asymmetric state: A has no contacts, B still has A as active
			const aAfterWipe = await runCli(["--json", "--data-dir", wipeADir, "contacts", "list"]);
			const bAfterWipe = await runCli(["--json", "--data-dir", wipeBDir, "contacts", "list"]);
			const aListWiped = (
				parseJsonOutput(aAfterWipe.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			const bListWiped = (
				parseJsonOutput(bAfterWipe.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			expect(aListWiped, "Agent A trust store should be empty after wipe").toHaveLength(0);
			expect(
				bListWiped[0]?.status,
				"Agent B should still have Agent A as active (asymmetric wipe)",
			).toBe("active");

			// ── 4. Agent A issues a new invite ─────────────────────────────
			const secondInvite = await runCli(["--json", "--data-dir", wipeADir, "invite", "create"]);
			expect(
				secondInvite.exitCode,
				`Agent A second invite create failed:\n${secondInvite.stderr}`,
			).toBe(0);
			const secondInviteUrl = (parseJsonOutput(secondInvite.stdout).data as { url: string }).url;

			// ── 5. Agent B runs connect on the new invite ──────────────────
			const secondConnect = await runCli([
				"--json",
				"--data-dir",
				wipeBDir,
				"connect",
				secondInviteUrl,
				"--no-wait",
			]);
			expect(
				secondConnect.exitCode,
				`Agent B second connect failed:\n${secondConnect.stderr}`,
			).toBe(0);

			// Sync so the connection/result completes on agent A's side
			await runCli(["--json", "--data-dir", wipeADir, "message", "sync"]);
			await runCli(["--json", "--data-dir", wipeBDir, "message", "sync"]);

			// ── 6. Assert both sides converge back to active ───────────────
			const finalA = await runCli(["--json", "--data-dir", wipeADir, "contacts", "list"]);
			const finalB = await runCli(["--json", "--data-dir", wipeBDir, "contacts", "list"]);
			const finalAContacts = (
				parseJsonOutput(finalA.stdout).data as {
					contacts: Array<{ status: string; name: string }>;
				}
			).contacts;
			const finalBContacts = (
				parseJsonOutput(finalB.stdout).data as {
					contacts: Array<{ status: string; name: string }>;
				}
			).contacts;

			// Agent A should have Agent B recreated as active (self-healing via
			// idempotent handleConnectionRequest — spec §3.1.1 "missing" path)
			const aHasB = finalAContacts.find((c) => c.status === "active");
			expect(
				aHasB,
				`Agent A should have an active contact after recovery. Got: ${JSON.stringify(finalAContacts)}`,
			).toBeDefined();

			// Agent B should still have Agent A as active (was already, still is)
			const bHasA = finalBContacts.find((c) => c.status === "active");
			expect(
				bHasA,
				`Agent B should still have Agent A as active after recovery. Got: ${JSON.stringify(finalBContacts)}`,
			).toBeDefined();
		} finally {
			await wipeBTapd?.stop();
			await wipeATapd?.stop();
			clearLoopbackRuntime(wipeBDir);
			clearLoopbackRuntime(wipeADir);
			await rm(wipeRoot, { recursive: true, force: true });
		}
	});

	// ═══════════════════════════════════════════════════════
	// Edge case: connect queued behind live listener
	//
	// Skipped after Phase 3: tapd is single-process so there is no transport
	// owner contention; the queueing path no longer exists. Left as a marker
	// for the historical scenario.
	// ═══════════════════════════════════════════════════════

	it.skip("queues connect behind a live listener and still converges to active", async () => {
		const queueRoot = await mkdtemp(join(tmpdir(), "tap-e2e-queue-"));
		const queueADir = join(queueRoot, "agent-a");
		const queueBDir = join(queueRoot, "agent-b");
		await mkdir(queueADir, { recursive: true });
		await mkdir(queueBDir, { recursive: true });

		const queueNetwork = new LoopbackTransportNetwork();
		const queueResolver = new StaticAgentResolver([
			createResolvedAgentFixture({
				agentId: AGENT_A_ID,
				chain: CHAIN,
				address: AGENT_A_ADDRESS,
				name: AGENT_A_NAME,
				description: "Queue test Agent A",
				capabilities: ["general-chat"],
			}),
			createResolvedAgentFixture({
				agentId: AGENT_B_ID,
				chain: CHAIN,
				address: AGENT_B_ADDRESS,
				name: AGENT_B_NAME,
				description: "Queue test Agent B",
				capabilities: ["general-chat"],
			}),
		]);

		installLoopbackRuntime({
			dataDir: queueADir,
			network: queueNetwork,
			resolver: queueResolver,
			txHashPrefix: "c1",
		});
		installLoopbackRuntime({
			dataDir: queueBDir,
			network: queueNetwork,
			resolver: queueResolver,
			txHashPrefix: "d2",
		});

		let listenerA: MessageListenerSession | undefined;
		let listenerB: MessageListenerSession | undefined;

		try {
			expect(
				await runCli(["--plain", "--data-dir", queueADir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			expect(
				await runCli(["--plain", "--data-dir", queueBDir, "init", "--chain", "base"]),
			).toMatchObject({ exitCode: 0 });
			await setOwsConfig(queueADir, "agent-a-wallet", "agent-a-key", AGENT_A_ID);
			await setOwsConfig(queueBDir, "agent-b-wallet", "agent-b-key", AGENT_B_ID);

			const invite = await runCli(["--json", "--data-dir", queueADir, "invite", "create"]);
			const inviteUrl = parseJsonOutput(invite.stdout).data as { url: string };

			// Start listeners BEFORE connect — connect must queue behind them
			listenerA = await createMessageListenerSession({ plain: true, dataDir: queueADir }, {});
			listenerB = await createMessageListenerSession({ plain: true, dataDir: queueBDir }, {});

			const connect = await runCli([
				"--json",
				"--data-dir",
				queueBDir,
				"connect",
				inviteUrl.url,
				"--no-wait",
			]);
			expect(connect.exitCode).toBe(0);
			const connectData = parseJsonOutput(connect.stdout).data as {
				status: string;
				queued?: boolean;
			};
			expect(connectData.queued).toBe(true);
			expect(["pending", "active"]).toContain(connectData.status);

			// Poll until both sides converge to active
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline) {
				const aContacts = await runCli(["--json", "--data-dir", queueADir, "contacts", "list"]);
				const bContacts = await runCli(["--json", "--data-dir", queueBDir, "contacts", "list"]);
				const aList = (
					parseJsonOutput(aContacts.stdout).data as {
						contacts: Array<{ status: string }>;
					}
				).contacts;
				const bList = (
					parseJsonOutput(bContacts.stdout).data as {
						contacts: Array<{ status: string }>;
					}
				).contacts;

				if (aList.some((c) => c.status === "active") && bList.some((c) => c.status === "active")) {
					break;
				}
				await new Promise((r) => setTimeout(r, 25));
			}

			// Final assertions
			const finalA = await runCli(["--json", "--data-dir", queueADir, "contacts", "list"]);
			const finalB = await runCli(["--json", "--data-dir", queueBDir, "contacts", "list"]);
			const contactsA = (
				parseJsonOutput(finalA.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			const contactsB = (
				parseJsonOutput(finalB.stdout).data as {
					contacts: Array<{ status: string }>;
				}
			).contacts;
			expect(contactsA[0]?.status).toBe("active");
			expect(contactsB[0]?.status).toBe("active");
		} finally {
			await listenerB?.stop();
			await listenerA?.stop();
			clearLoopbackRuntime(queueBDir);
			clearLoopbackRuntime(queueADir);
			await rm(queueRoot, { recursive: true, force: true });
		}
	});
});
