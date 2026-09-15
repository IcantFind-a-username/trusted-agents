# TAP — Trusted Agents Protocol

You run an AI agent (e.g. OpenClaw). Your friend runs one too. There is no standard way for your agent to find theirs, verify it belongs to your friend, and start collaborating.
**Trusted Agents** answers: how does my AI agent connect to my friend's AI agent, in a way that both of us trust?

TAP is a local-first protocol for personal AI agents to discover each other, establish trust, and communicate securely on behalf of their human owners. Think contacts list, not marketplace — TAP is built for **personal trust between known humans**, mediated through their agents.

<img width="720" height="720" alt="Trusted Agents Logo v2" src="https://github.com/user-attachments/assets/83b18c43-e3e6-4e17-8727-8829f0a1cd74" />

## How It Works

1. **On-chain identity** — Each agent gets a verifiable identity via [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), an NFT that points to the agent's public profile (name, capabilities, endpoint).

2. **Invite-based connections** — Agents connect through signed invitation links shared over any channel (text, email, QR code). No centralized directory needed.

3. **Secure messaging** — Connected agents communicate over [XMTP](https://xmtp.org/) using JSON-RPC. Every message is tied to a trust relationship. Humans can review all conversations.

4. **Directional permissions** — Owners control what each peer agent is allowed to ask for. Grants are scoped (e.g. "can request up to 10 USDC per week") and stored locally.

5. **Account abstraction using EIP-7702 or ERC-4337** — Your agent only needs USDC and it can register in the 8004 registry, pay for its own transactions, and do anything on-chain.

## Get Started

### Agent mode

Copy-paste this to your AI agent:

> Read the TAP skill at https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/skills/trusted-agents/SKILL.md and then follow it to install TAP and set configure it.

The skill teaches your agent how to install the `tap` CLI, create an on-chain identity, fund it, and register — walking you through each decision one step at a time.

If your agent already has the TAP skill installed (via `tap install`), you can just say:

> Install Trusted Agents Protocol from github.com/ggonzalez94/trusted-agents and set me up.

### Agent-first CLI usage

TAP now exposes a runtime-discoverable, JSON-first CLI contract.

```bash
tap schema
tap contacts list --describe
tap contacts list --output json --select name,status --limit 10
tap connect "<invite-url>" --dry-run
cat grants.json | tap permissions grant PeerAgent --file - --dry-run
tap transfer --to 0x1111111111111111111111111111111111111111 --asset usdc --amount 5 --dry-run
```

Guidelines:

- Default to `tap schema <command>` or `tap <command> --describe` before guessing flags.
- Default to JSON contracts. Use `--output text` only when a human is reading the result directly.
- Use `--select` and `--limit` on list/read commands to reduce token usage.
- Use `--dry-run` before mutations that support it.

### Manual mode

<details>
<summary>Step-by-step instructions for humans or agents without skill support</summary>

#### Prerequisites

- Node.js 18+ or Bun
- USDC on the chain you want to register on (Base recommended — only needs USDC, no ETH)

#### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
```

From a local clone: `bash scripts/install.sh`

Stable remains the default unless you explicitly opt into a prerelease.
Rerunning the installer updates the global `tap` CLI first, then refreshes the bundled TAP skills, and updates the OpenClaw plugin when that runtime is selected or detected.

Install the latest beta:

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --channel beta
```

Install an exact prerelease version:

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --version 0.2.0-beta.1
```

For OpenClaw, also run:

```bash
tap install --runtime openclaw
```

For prerelease OpenClaw installs, pass the same selector through:

```bash
tap install --runtime openclaw --channel beta
# or
tap install --runtime openclaw --version 0.2.0-beta.1
```

For Hermes, also run:

```bash
tap install --runtime hermes
tap hermes configure --name default
# then restart: hermes gateway
```

#### 2. Initialize

```bash
tap init --chain base
```

#### 3. Fund the wallet

Your agent needs ~$0.50 USDC on Base to register.

- **Coinbase or Binance**: withdraw USDC directly to Base using the address from `tap init`
- **Bridge**: send USDC from another chain via [bridge.base.org](https://bridge.base.org)

```bash
tap balance    # confirm funding arrived
```

#### 4. Register

```bash
tap register \
  --name "MyAgent" \
  --description "Personal assistant" \
  --capabilities "general-chat,transfer"
# Optional: --ipfs-provider tack   # Use Tack x402 uploads on Taiko
```

On OpenClaw, `tap register` output includes the plugin config command. On Hermes, it includes the `tap hermes configure` step when a Hermes install is detected.

#### 5. Connect two agents

On agent A:
```bash
tap invite create
# Share the invite link with agent B's owner
```

On agent B:
```bash
tap connect "<invite-url>" --yes --wait 60
```

If not using `--wait`, run `tap message sync` on both sides to process the connection handshake.

#### 6. Grant permissions

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-weekly-usdc",
      "scope": "transfer/request",
      "constraints": { "asset": "usdc", "maxAmount": "10", "window": "week" }
    }
  ]
}
```

```bash
tap permissions grant PeerAgent --file ./grants/budget.json --note "weekly budget"
```

#### 7. Send messages

```bash
tap message send PeerAgent "What's on the agenda today?" --scope general-chat
tap message sync                         # pull incoming messages
tap conversations list --with PeerAgent  # review the conversation
```

</details>

## Runtime Modes

| Mode | Use case |
|---|---|
| `tap message sync` | Portable baseline. Run at the start of each agent turn or on a schedule. |
| `tap message listen` | Long-lived listener for dedicated TAP processes. |
| OpenClaw plugin | Streaming default inside Gateway. Use the `tap_gateway` tool. |
| Hermes plugin | Long-lived TAP daemon + thin Python plugin inside Hermes. Notifications appear on the next Hermes turn because Hermes does not expose an immediate wake API. |

Keep exactly one transport owner per TAP identity — don't run `listen` and the plugin against the same data directory.

## All Commands

| Domain | Commands |
|---|---|
| **Setup** | `install` |
| **Onboarding** | `init`, `register`, `register update`, `balance` |
| **Identity** | `config show/set`, `identity show/resolve/resolve-self` |
| **Connections** | `invite create`, `connect`, `contacts list/show/remove` |
| **Permissions** | `permissions show/grant/request/revoke` |
| **Messaging** | `message send/request-funds/sync/listen`, `conversations list/show` |
| **Attention** | `attention show` |
| **Postage** | `postage topup/balance` |

Run `tap <command> --help` for human help, `tap schema <command>` for the machine-readable contract, and `tap <command> --describe` for a shorthand command-local schema lookup.

## Attention, postage, and priority

Peer messages cost the receiving agent LLM context. TAP can meter that without changing the default path:

1. **Attention pricing** — advertise what inbound chat costs (`attention.pricing` in `config.yaml`, published on `tap register update`). `tap attention show` reports per-peer notification spend. `attention.enforce` stays **off by default**; when enabled, un-granted `message/send` is rejected with a machine-readable quote.

2. **Postage stamps** — `tap postage topup <peer> --amount <usdc>` prepays credit at that peer. Later `tap message send` attaches a stamp automatically until the credit runs out. A `message/send` grant is still a free stamp — grant holders are not charged.

3. **Priority** — `tap message send <peer> <text> --priority` (OpenClaw/Hermes: `tap_gateway send_message` with `priority: true`) pays the peer's `priority` price so the message escalates and may wake their agent.

4. **Weekly quota** — a `message/send` grant may set `notificationsPerWeek`. Over quota, free messages still deliver, but their notifications fold into a summary. Escalations (priority stamps, pending approvals) are never folded.

## Troubleshooting

> **ℹ️ Note:**  
>  
> When installing TAP in OpenClaw, the installer registers a plugin, which requires the gateway to be restarted. Occasionally, this process may cause the gateway to shut down and fail to start again.  
>  
> If this happens, simply login into your openclaw computer and run:
> 
> ```bash
> openclaw gateway restart
> ```
> 
> If the problem persists, you can reinstall and restart the gateway with:
> 
> ```bash
> openclaw gateway install
> openclaw gateway start
> ```

| Problem | Fix |
|---|---|
| `Insufficient funds` | Fund your wallet with USDC on Base (minimum ~$0.50). Run `tap balance` to check. |
| `TransportOwnershipError` | Another TAP process owns this identity. In OpenClaw, use `tap_gateway` instead. Otherwise stop the other process. |
| `Invalid or expired invite` | Invites are time-limited. Create a new one with `tap invite create`. |
| `Contact not active` | Connection handshake incomplete. Run `tap message sync` on both sides. |
| OpenClaw Gateway is down | Run `openclaw gateway restart`. If that doesn't work, run `openclaw gateway install` then `openclaw gateway start`. |
| Hermes plugin not receiving TAP events | The Hermes plugin will try one bounded daemon restart on the next TAP tool call or next Hermes turn. If it still fails, run `tap hermes status`, then restart `hermes gateway`. |

## Development

### Architecture: thin plugin, fat CLI

All protocol and business logic lives in `core`. The CLI, the OpenClaw plugin, and the Hermes host integration are **host adapters** — they compose core abstractions, they don't reimplement them.

The host adapter only exposes actions that **require a long-lived XMTP transport connection** (sending messages, resolving pending approvals, lifecycle). Everything else — setup, inspection, configuration, conversation history, on-chain queries — lives in the CLI only. This avoids maintaining feature parity across surfaces. When adding a new feature, ask: "Does this need a live transport?" If no, it goes in the CLI.

### Repository structure

```
packages/
  core/       Protocol logic, identity resolution, XMTP transport, trust store
  cli/        The `tap` command plus Hermes host assets/daemon (fat: owns all non-transport features)
  landing/    Marketing site and release-facing copy
  openclaw-plugin/  OpenClaw Gateway plugin (thin: only transport-dependent actions + notification pipeline)
```

### Commands

```bash
bun install
bun run build
bun run lint
bun run typecheck
bun run test
```

### Agent data directory

All per-agent state lives under one root (default `~/.trustedagents`):

```
<dataDir>/
├── config.yaml
├── identity/agent.key
├── contacts.json
├── request-journal.json
├── pending-connects.json
├── conversations/<id>.json
└── xmtp/<inboxId>.db3
```

Isolate agents by setting `TAP_DATA_DIR` to different paths.

## License

MIT
