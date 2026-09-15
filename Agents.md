# Agents.md

## Purpose
This file is for coding agents working in this repository.
It focuses on implementation reality, not aspirational architecture.
When this file conflicts with code, code wins.

## System Snapshot (As Implemented)
- `tap` is a local-first agent protocol stack with:
	- On-chain identity via ERC-8004 (`tokenId` is `agentId`)
	- Registration metadata in a registration file (`ipfs://...` or `https://...`)
	- Peer messaging over XMTP using JSON-RPC 2.0 payloads
- No backend service exists in this repo.
- Package boundaries:
	- `packages/core`: protocol + storage + transport abstractions
	- `packages/cli`: executable UX, config/bootstrap behavior, and Hermes host assets/daemon
	- `packages/openclaw-plugin`: OpenClaw Gateway plugin that owns TAP as a background service
	- `packages/sdk`: Public SDK entry point for building on TAP. Owns `createTapRuntime`, app install/remove, and the public API surface.
	- `packages/app-transfer`: Transfer request handling as a TAP app. Owns grant matching, payload parsing, transfer execution handler.
	- `packages/app-scheduling`: Scheduling request handling as a TAP app. Owns scheduling types, grant matching, calendar integration, scheduling handler.
	- `packages/app-postage`: Prepaid postage as a TAP app. Owns the standalone `postageApp` (`postage/topup`, `postage/balance`); handlers and the postage ledger live in `packages/core`.
- Dependency direction:
	- `cli -> core` (and will migrate to `sdk -> core`)
	- `openclaw-plugin -> core` (and will migrate to `sdk -> core`)
	- `sdk -> core`
	- `app-transfer -> core` (types only)
	- `app-scheduling -> core` (types only)
	- `app-postage -> core`
	- `core` has no internal workspace dependencies

## Package Responsibilities

### `packages/core`
- Source of truth for protocol and runtime behavior.
- Owns:
	- protocol methods/types
	- identity resolution and registration validation
	- XMTP transport + transport interface
	- trust/contact persistence
	- conversation logging
	- request journal / dedupe / reconciliation state
	- transport owner lock
	- `TapMessagingService`
	- attention ledger (`src/attention`)
	- postage credit ledger, stamps, and certificates (`src/postage`)
- If behavior differs between hosts, start by checking whether it should really live here.

### `packages/cli`
- Human/agent-facing `tap` executable.
- Host adapter over `core`, not the source of messaging business logic.
- Owns:
	- command parsing and output formatting
	- CLI-specific prompting / approval UX
	- onboarding commands
	- local operator workflows
	- Hermes host integration assets (`packages/cli/assets/hermes`)
	- Hermes daemon / IPC layer used to hold long-lived TAP runtimes outside the Python plugin process

### `packages/sdk`
- Public entry point for building on TAP.
- Owns:
	- `createTapRuntime()` factory
	- `TapRuntime` wrapper
	- app install/remove lifecycle
	- event subscription
	- public type re-exports

### `packages/app-transfer`
- Transfer request handling as a TAP app.
- Owns:
	- transfer payload parsing
	- transfer grant matching
	- transfer handler
	- `buildTransferPayload` helper

### `packages/app-scheduling`
- Scheduling request handling as a TAP app.
- Owns:
	- scheduling types
	- scheduling payload parsing
	- scheduling grant matching
	- calendar provider interface
	- scheduling handler
	- `buildSchedulingPayload` helper

### `packages/app-postage`
- Prepaid postage as a TAP app. The runtime registers postage as a built-in; this package is the standalone, manifest-installable form.
- Owns:
	- `postageApp` (`postage/topup`, `postage/balance`)
	- re-exports of core postage types/helpers (`buildPostageTopupPayload`, `buildPostageBalancePayload`, certificate sign/verify)
- Handlers and the postage ledger live in `packages/core` (`src/postage/*`). State is `<dataDir>/apps/postage/state.json`, reached through `ctx.extensions.postage` (not `ctx.storage`).

### `packages/openclaw-plugin`
- OpenClaw-specific host adapter. **Thin plugin, fat CLI** — see rule below.
- Owns:
	- Gateway plugin manifest/config
	- one long-lived TAP runtime per configured identity inside Gateway
	- periodic reconcile scheduling inside the plugin host
	- the `tap_gateway` tool surface
	- notification pipeline (event classification, queueing, escalation)
	- approval deferral hooks (connection, transfer, scheduling)
- This is the preferred OpenClaw streaming host. OpenClaw shell background jobs are not.

### CLI vs Plugin Boundary (Thin Plugin, Fat CLI)

**Rule: the plugin should only expose actions that require a long-lived transport connection.**

The plugin exists to hold an always-on XMTP transport inside the Gateway process. Its unique capabilities are:
1. Receiving inbound messages in real-time (notification pipeline, event classification, escalation)
2. Deferring and resolving pending approvals (connections, transfers, scheduling)
3. Sending messages/actions through an already-authenticated transport (no cold-start)

Everything else — setup, inspection, on-chain queries, configuration, conversation history — belongs in the CLI because:
- **Single implementation** — no feature parity maintenance across two surfaces
- **Testable in isolation** — CLI commands are pure functions over core; plugin actions require a running Gateway
- **Composable** — CLI works in scripts, CI, other agent runtimes, not just OpenClaw
- **Lower surface area** — fewer plugin actions = fewer bugs in the always-on process

| Belongs in CLI only | Why |
|---|---|
| `init`, `register`, `install`, `remove` | One-time setup, no transport needed |
| `config show/set`, `identity show/resolve` | Read-only inspection, no transport needed |
| `contacts list/show/remove` | Local file reads/writes |
| `conversations list/show` | Local file reads |
| `permissions show/revoke` | Local reads; revoke is rare enough to not warrant plugin duplication |
| `balance` | Pure RPC call, no TAP transport |
| `calendar setup` | One-time OAuth flow |
| `invite create` | Local crypto operation, no transport needed |

| Belongs in plugin | Why |
|---|---|
| `send_message`, `connect` | Uses live transport |
| `request_funds`, `transfer` | Transport + approval pipeline |
| `publish_grants`, `request_grants` | Transport |
| `request_meeting`, `respond_meeting`, `cancel_meeting` | Transport |
| `list_pending`, `resolve_pending` | Acts on live notification pipeline |
| `status`, `sync`, `restart` | Plugin lifecycle |

**Key invariant: the plugin never implements protocol logic that doesn't exist in core.** It is a thin adapter that calls `TapMessagingService` methods. If you keep that discipline, the two surfaces stay in sync by construction rather than by manual feature parity.

When adding a new feature, ask: "Does this need a live XMTP transport?" If no, it goes in the CLI only.

## Skills Layout

There is one unified TAP skill that covers CLI, OpenClaw plugin mode, and Hermes mode:

- **Canonical location:** `skills/trusted-agents/SKILL.md` + `references/permissions-v1.md`
- **OpenClaw plugin:** `packages/openclaw-plugin/skills/trusted-agents-openclaw/` receives copies of the canonical files at build time via a `prebuild` script (`cp -r ../../skills/trusted-agents skills/trusted-agents`). The copies are `.gitignored`.
- **Hermes install assets:** `packages/cli/assets/skills/trusted-agents/` receives copies of the canonical files at build time so `tap install --runtime hermes` can copy the same skill into `~/.hermes/skills/trusted-agents`.
- Host-specific sections are gated in the canonical skill file ("Skip this section if you're not running inside OpenClaw Gateway.", "Skip this section if you're not running inside Hermes.").

Installation expectations:

- OpenClaw plugin install loads the plugin skill directory from `packages/openclaw-plugin/openclaw.plugin.json`, which uses the build-time copied skills.
- `tap install --runtime openclaw` installs the plugin; `tap install --runtime hermes` installs the Hermes plugin/hook/skill assets; `tap install --runtime claude` installs the skill for Claude Code.
- In this repo, `skills/trusted-agents/` is the single source of truth. The OpenClaw plugin copies and Hermes/other host-installed copies are mirrors.

## Read Order For Fast Orientation
1. `packages/core/src/protocol/*` (wire protocol)
2. `packages/core/src/identity/*` (on-chain + registration resolution)
3. `packages/core/src/transport/interface.ts` then `transport/xmtp.ts`
4. `packages/core/src/trust/*` and `conversation/*` (state persistence)
5. `packages/core/src/runtime/*` (`TapMessagingService`, request journal, transport owner lock)
6. `packages/core/src/attention/*` and `src/postage/*` (attention ledger, postage credits/stamps)
7. `packages/core/src/app/*` (app types, registry, manifest, storage)
8. `packages/cli/src/lib/context.ts`, `lib/cli-runtime.ts`, and `commands/*` (CLI host adapter)
9. `packages/openclaw-plugin/src/*` (Gateway host adapter)
10. `packages/sdk/src/*` (public SDK API)
11. `packages/app-transfer/src/*`, `packages/app-scheduling/src/*`, and `packages/app-postage/src/*` (built-in apps)

## Core Abstractions To Preserve

### 1) `TransportProvider` (replaceable transport seam)
File: `packages/core/src/transport/interface.ts`
- Contract:
	- `send(peerId, message, options?) -> TransportReceipt`
	- `setHandlers({ onRequest?, onResult? })`
	- `isReachable(peerId)`
	- optional `reconcile(options?)`
	- optional `start/stop`
- Architectural intent: transport is swappable.
- Current implementation: only `XmtpTransport`.

### 2) `IAgentResolver` (identity resolution seam)
File: `packages/core/src/identity/resolver.ts`
- Resolves `agentId + chain -> ResolvedAgent` using:
	- `tokenURI(agentId)` from ERC-8004
	- `ownerOf(agentId)` from ERC-8004
	- fetch + validate registration file
- Has in-memory cache with TTL and max entries.

### 3) `ITrustStore` (connection state seam)
Files: `packages/core/src/trust/trust-store.ts`, `file-trust-store.ts`
- Contact CRUD + lookups by `connectionId`, `(agentId, chain)`, and address.
- `FileTrustStore` is the only implementation, with atomic writes.

### 4) `IConversationLogger` (message log seam)
Files: `packages/core/src/conversation/logger.ts`
- Append/list/get conversation logs and generate markdown transcript.
- Backed by one JSON file per conversation.

### 5) `NotificationAdapter` + `ApprovalHandler` (SDK human-in-loop seam)
Files: `packages/sdk/src/notification.ts`, `approval.ts`
- SDK orchestration defers approvals/notifications to host runtime.
- `approveTransfer` is the primary approval hook (transfers need grant-gated decisions).
- `onConnectionEstablished` is a post-success info hook used by the OpenClaw plugin to notify the operator after a handshake completes.
- There is deliberately no `approveConnection` hook — a signed invite is already cryptographic consent, so inbound connection/request handling auto-accepts without per-request approval.

### 6) `TapAppRegistry` (app routing seam)
File: `packages/core/src/app/registry.ts`
- Routes action types to app handlers.
- Supports direct registration and lazy loading from manifest.
- Apps define handlers via `defineTapApp()` from `packages/core/src/app/types.ts`.

## Protocol And Identity Standards Enforced In Code

### JSON-RPC methods (canonical names)
File: `packages/core/src/protocol/methods.ts`
- `connection/request`
- `connection/result`
- `connection/revoke`
- `permissions/update`
- `message/send`
- `action/request`
- `action/result`

`BOOTSTRAP_METHODS` currently contains only:
- `connection/request`
- `connection/result`

### Registration file invariants
File: `packages/core/src/identity/registration-file.ts`
- Must be type `eip-8004-registration-v1`
- Must include at least one `services` entry named `xmtp`
- `xmtp.endpoint` must be a valid Ethereum address
- Non-XMTP services must use `https:` URLs
- `trustedAgentProtocol.agentAddress` must be a valid Ethereum address
- `xmtp.endpoint` must match `trustedAgentProtocol.agentAddress` (case-insensitive)
- `trustedAgentProtocol.attention` is optional (absent = no pricing); when present it needs a non-empty `version` and `currency` and a `pricing` object whose values are decimal amount strings (≤6 decimals). Tier names are open — validate values, not names.

### URI safety rules during registration fetch
File: `packages/core/src/identity/registration-file.ts`
- `ipfs://...` is rewritten to `https://ipfs.io/ipfs/...`
- Direct remote URIs must be `https:`
- Local/private network hosts are blocked (`localhost`, `127.x`, RFC1918 ranges, `.local`)
- 10s fetch timeout via `AbortController`

### Chain identifier standard
- Core expects CAIP-2 (`eip155:<chainId>`)
- CLI accepts aliases (`base`, `taiko`, etc.) and normalizes to CAIP-2

## Runtime Composition (Where behavior is decided)

### CLI composition
File: `packages/cli/src/lib/context.ts`
- Builds:
	- `FileTrustStore`
	- `AgentResolver`
	- `FileRequestJournal`
	- `XmtpTransport` (when transport is needed)
- Transport gets resolver injected for bootstrap sender verification.

### SDK composition
File: `packages/sdk/src/orchestrator.ts`
- Reuses the same core abstractions.
- Can use custom `transport` or construct `XmtpTransport` from `xmtp` config.
- `start()` is idempotent with an internal `transportStarted` flag.

## Non-Obvious Behavior You Need To Know

1. One OWS wallet per agent (no raw private key):
- Each agent identity is backed by an Open Wallet Service (OWS) wallet
- A scoped API key authenticates CLI/SDK requests to OWS
- All signing (ERC-8004 ownership, invite signing, XMTP identity) goes through OWS policy-gated signing
- The agent process never sees or stores a raw private key
- Config stores `ows.wallet` (wallet ID) and `ows.api_key` (scoped API key)
- Env overrides: `TAP_OWS_WALLET`, `TAP_OWS_API_KEY`

2. XMTP DB encryption key:
- New agents: derived from `signMessage("xmtp-db-encryption-key")` via OWS, then hashed
- Migrated agents: key computed from the old private key and persisted as `xmtp.db_encryption_key` in config.yaml during migration
- Once persisted, the config value is used directly on subsequent startups

3. Unknown inbound senders are hard-rejected unless bootstrap path passes:
- In `XmtpTransport`, unknown sender can only proceed via `connection/request` or `connection/result`
- Requires `agentResolver` and inbox address verification against resolved `agentAddress`

4. Known senders are still blocked unless contact status is `active`.

5. Trust store lookup by address can throw:
- `findByAgentAddress()` throws if multiple active contacts match same address (+ optional chain)

6. File stores are atomic but process-local locked:
- Uses `AsyncMutex` per instance + `tmp file -> rename`
- No cross-process lock exists
- `TapMessagingService` adds a `.transport.lock` owner file per `dataDir`
- Do not run multiple transport-owning TAP processes against the same agent/data dir at once. If a listener or plugin runtime already owns the identity, other transport-active CLI commands should stop that owner first or use the owner process surface instead.

7. `loadConfig()` requires `agent_id` by default:
- Most commands fail unless `agent_id >= 0`
- `register` explicitly bypasses this with `{ requireAgentId: false }`

8. `init` writes `agent_id: -1` until successful registration updates config.

9. **Config lives inside data-dir** — `--data-dir` (or `TAP_DATA_DIR`) is the single root for all per-agent state:
```
<dataDir>/
├── config.yaml              # agent_id, chain, xmtp.env, ows.wallet, ows.api_key, xmtp.db_encryption_key
├── contacts.json            # Connected peers (trust store) — includes `connecting` rows for in-flight outbound connects
├── request-journal.json     # Single source of truth for in-flight and completed wire requests + queued command intents
├── ipfs-cache.json          # Content hash → CID (avoids re-upload)
├── apps.json                # installed apps manifest
├── attention-ledger.json    # per-peer notification attention spend
├── apps/                    # app-scoped state
│   ├── transfer/state.json
│   ├── scheduling/state.json
│   └── postage/state.json
├── conversations.db         # SQLite store for conversation logs (v2, replaces conversations/*.json)
├── conversations.bak/       # Pre-migration JSON backups (safe to delete after a release)
└── xmtp/<inboxId>.db3       # XMTP client DB (encrypted)
```
- Resolution order: `--data-dir` flag > `TAP_DATA_DIR` env > `~/.trustedagents`
- Config resolution: `--config` flag > `<dataDir>/config.yaml`
- This means setting `TAP_DATA_DIR` alone fully isolates an agent (useful for running multiple agents on one machine)

10. Chain support differs between layers:
- Core defaults: Base
- CLI extends chain map with Taiko
- Wallet helper has explicit viem mappings for known chain IDs

11. Register upload path has hidden cache:
- `packages/cli/src/commands/register.ts` stores content-hash cache at `<dataDir>/ipfs-cache.json`
- Cached CID is reused only if `HEAD https://ipfs.io/ipfs/<cid>` succeeds

12. x402 payment is chain-asymmetric:
- Registration tx can be on other chains
- IPFS x402 payment still uses Base mainnet USDC

13. Transfer approval is grant-based:
- `decideTransfer()` in `TapMessagingService` calls `findApplicableTransferGrants()` to check for matching active grants
- If no grants match and an `approveTransfer` hook is registered, the hook decides (can return `null` to leave pending)
- If no grants match and no hook is registered, the request is rejected
- The OpenClaw plugin wires `approveTransfer` to auto-approve when grants cover it and leave pending otherwise
- CLI does not wire `approveTransfer` — no-grant requests are rejected

14. Conversation logging is wired into CLI messaging flows:
- `message send`, `request-funds`, listener processing, and reconciliation append conversation entries
- Conversation commands read the persisted logs from disk

15. Async connection and action outcomes share one durable store (`request-journal.json`):
- `connect` upserts a `connecting` contact in the trust store BEFORE any wire traffic, so Bob's "I asked" record is durable and sticky across restarts. The contact flips to `active` when the matching `connection/result` arrives.
- `connect()` is truly synchronous: it registers an in-memory waiter keyed on `requestId` and blocks up to `waitMs` (default 30_000) for the result to arrive. On timeout it returns `status: "pending"` and the async completion still lands on the next `sync`.
- The inviter-side `processConnectionRequest` sends `connection/result` BEFORE writing the contact as active. If the send fails, the contact stays unwritten and reconciliation retries it. This eliminates the old divergence where Alice could end up "active" while Bob never heard back.
- `handleConnectionRequest` and `handleConnectionResult` are fully idempotent on every contact state, so re-running `tap connect` with a fresh invite always repairs divergent state without manual cleanup (spec §5.2, §5.3).
- `request-journal.json` holds four kinds of entries with a minimum state machine (`queued` | `pending` | `completed`): inbound requests, inbound results, outbound requests, and outbound results. `queued` is used for command intents whose wire request hasn't been sent yet (transport owned by another process). `lastError` metadata on a `pending` entry tracks transient failures for debugging via `tap journal show`.
- The `tap-commands-outbox/` directory and `pending-connects.json` file were removed — their state moved onto the trust store (`connecting` contacts) and the journal (`queued` entries). Legacy files are migrated once at `TapMessagingService.start()` via `runLegacyStateMigrations()`.

16. OpenClaw plugin mode owns transport inside Gateway:
- `packages/openclaw-plugin` starts one `TapMessagingService` per configured TAP identity
- OpenClaw agents should use the `tap_gateway` tool for transport-active operations when the plugin is installed
- `tap message sync` remains the safe fallback when the plugin is not installed
- The plugin wires `emitEvent` to classify inbound messages and push to a per-identity in-memory `TapNotificationQueue`
- Escalation events (ungrantable transfers, scheduling proposals) trigger `requestHeartbeatNow()` + `enqueueSystemEvent()` to wake the agent
- A `before_prompt_build` hook drains the notification queue and injects `[TAP Notifications]` into the agent's context
- **Connection requests are auto-accepted on valid invites** — the `approveConnection` hook was removed because a signed invite is already cryptographic consent. The plugin emits a post-success `connection-established` info notification via the `onConnectionEstablished` hook instead.
- `resolvePending` handles only `ACTION_REQUEST` entries (transfers, scheduling). Connection requests never appear as deferred work.

17. Recovery primitives are unified:
- Three commands cover every realistic recovery path: `tap connect <invite>`, `tap message sync`, `tap contacts remove <connectionId>`. See `skills/trusted-agents/SKILL.md` Recovery section for the full table.
- `tap contacts remove` sends `connection/revoke` to the peer before deleting locally, so both sides converge on "not connected" even if the user clears a contact unilaterally.

17. SDK connect requirement:
- `TrustedAgentsOrchestrator.connect()` returns an explicit error unless `transport` or `xmtp` config is provided

18. Invite chain value is not strongly validated in invite generation:
- `generateInvite()` signs any chain string given by caller
- CAIP-2 correctness is enforced at higher layers, not inside invite generation

19. Hermes mode owns transport in a sidecar daemon, not in the Python plugin:
- `packages/cli/assets/hermes/plugin/` is a thin Python Hermes plugin that exposes `tap_gateway` and injects `[TAP Notifications]` through `pre_llm_call`
- `packages/cli/assets/hermes/hook/` is a Hermes startup hook that launches `tap hermes daemon run`
- `packages/cli/src/hermes/daemon.ts` holds one long-lived `TapRuntime` per configured identity and serves local IPC over a Unix socket
- Hermes has no OpenClaw-style immediate wake API; escalation notifications are shown on the next Hermes turn rather than waking an idle session immediately

## If You Change X, Also Check Y

### Adding/changing a protocol method
- Update `packages/core/src/protocol/methods.ts`
- Decide if it belongs in `BOOTSTRAP_METHODS`
- Update transport request handling logic in `xmtp.ts`
- Update CLI/SDK command callers and tests

### Adding a new chain
- Add to CLI `lib/chains.ts` alias map and `ALL_CHAINS`
- Add viem mapping in CLI `lib/wallet.ts` (or confirm fallback behavior is acceptable)
- Ensure config loading/overrides still produce CAIP-2 keys

### Changing contact or conversation persistence
- Keep atomic write pattern (`tmp + rename`) and strict file modes
- Keep safe path checks for user-derived file components
- Update tests that rely on persistence across instances

### Changing register flow
- Keep registration file invariants aligned with validator
- Keep config auto-update behavior for `agent_id`
- Re-run cache and upload tests (`register`, `ipfs` behavior)

### Changing transport identity checks
- Preserve bootstrap sender verification semantics
- Preserve pending request timeout cleanup to avoid memory leaks
- Validate both unit tests and optional XMTP integration test

### Changing signing or wallet integration
- All signing goes through `SigningProvider` (backed by OWS), never raw private keys
- If adding a new signing operation, wire it through the existing `SigningProvider` from context
- Update OWS wallet provisioning tests if wallet creation flow changes
- Keep `ows.wallet` and `ows.api_key` config fields in sync with env overrides (`TAP_OWS_WALLET`, `TAP_OWS_API_KEY`)

### Adding/changing/removing a CLI command
- Update `skills/trusted-agents/SKILL.md` (the single unified skill). The OpenClaw plugin copies this file at build time, so both hosts update automatically.
- Every CLI command must appear in the skill file as a documented command.
- OpenClaw-specific content (tap_gateway actions, notifications) lives in the "OpenClaw Plugin Mode" section, gated with "Skip this section if you're not running inside OpenClaw Gateway."
- Keep skills concise: command syntax + flags + one example + errors. No internal implementation details.
- The `SKILL.md` must have YAML frontmatter with `name` and `description`
- Commands that perform signing should accept a `SigningProvider` from context, never raw keys

### Adding/changing a TAP app or the app interface
- Update `packages/core/src/app/types.ts` for interface changes
- If changing `TapActionContext`, update `packages/core/src/app/context.ts` (`buildActionContext`)
- Test with built-in apps (`app-transfer`, `app-scheduling`, `app-postage`) as they validate the interface
- Update the skill file if adding new CLI commands

### Changing TAP skill/reference semantics
- The unified skill lives in `skills/trusted-agents/SKILL.md`. The OpenClaw plugin copies skills at build time. Edit only the canonical file at `skills/trusted-agents/`.
- OpenClaw-specific content goes in the "OpenClaw Plugin Mode" section with clear gating ("Skip this section if not OpenClaw").
- If you add OpenClaw-specific behavior, also add the corresponding "In OpenClaw plugin mode, use X instead" note in the relevant command section.

## Build/Test Commands Agents Should Actually Use
```bash
bun install
bun run lint
bun run typecheck
bun run test
# Optional integration:
XMTP_INTEGRATION=true bun run test:xmtp
# Test a specific app package:
bun run test -- packages/app-transfer/test/
bun run test -- packages/app-scheduling/test/
bun run test -- packages/app-postage/test/
bun run test -- packages/sdk/test/
```
Note: OWS (Open Wallet Service) must be installed and accessible for tests that exercise signing or wallet operations. Tests that mock `SigningProvider` do not require a live OWS instance.

## E2E Test Maintenance

Two E2E test files cover the same scenarios:

- **`packages/cli/test/e2e/e2e-live.test.ts`** — Real E2E against mainnet (XMTP, OWS, on-chain). Runs as a release gate.
- **`packages/cli/test/e2e/e2e-mock.test.ts`** — Mocked E2E with loopback transport. Runs on every PR.
- **`packages/cli/test/e2e/scenarios.ts`** — Canonical scenario list shared by both.
- **`packages/cli/test/e2e/helpers.ts`** — Shared assertion and polling utilities.

Update both test files whenever there is a meaningful behavioral change. A change counts as meaningful if it changes any of:
- protocol method names or payload fields
- CLI command names, flags, or required sequencing for `invite`, `connect`, `permissions`, `message`, `contacts`, or `conversations`
- trust/contact persistence shape
- directional grant schema or ledger schema
- listener approval behavior or action request/response semantics
- transfer execution semantics
- multi-agent `dataDir` isolation behavior

A change does **not** count as meaningful if it is only:
- formatting, comments, or copy-only docs with no behavioral change
- internal refactors that preserve observable CLI/protocol behavior

### Live E2E secrets
The real E2E uses 4 GitHub Actions secrets:
- `E2E_AGENT_A_OWS_WALLET` / `E2E_AGENT_A_OWS_MNEMONIC` — Agent A wallet name + mnemonic for CI import
- `E2E_AGENT_B_OWS_WALLET` / `E2E_AGENT_B_OWS_MNEMONIC` — Agent B wallet name + mnemonic for CI import

The CI workflow imports the wallets from mnemonics into the OWS vault on each ephemeral runner.
Both wallets have policies for Base (`eip155:8453`) and Taiko (`eip155:167000`).
Fund the wallet addresses with USDC on both chains. The tests fail-fast if balance < 0.50 USDC.

## Repository Conventions Worth Respecting
- ESM only; TypeScript imports use `.js` extension in source.
- Named exports only.
- Biome handles both lint and format.
- TypeScript strictness includes `noUnusedLocals` and `noUnusedParameters`.
