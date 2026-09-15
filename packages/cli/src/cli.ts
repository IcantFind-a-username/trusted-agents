import { createRequire } from "node:module";
import { Command } from "commander";
import { chainAliasHelpText } from "./lib/chains.js";
import { formatMetadataHelp } from "./lib/command-metadata.js";
import { errorCode, exitCodeForError } from "./lib/errors.js";
import { error, success } from "./lib/output.js";
import { commandPath, findCommand, serializeCommand } from "./lib/schema.js";
import type { GlobalOptions } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function createCli(): Command {
	const program = new Command();

	program
		.name("tap")
		.description("Trusted Agents Protocol CLI for agents and operators")
		.version(version)
		.option("--output <format>", "Output format: json, text, ndjson")
		.option("--json", "Force JSON output")
		.option("--plain", "Force text output")
		.option("--config <path>", "Override config file path")
		.option("--data-dir <path>", "Override data directory")
		.option("--chain <caip2>", "Override chain (e.g. eip155:8453)")
		.option("--rpc-url <url>", "Override the RPC URL for the selected chain")
		.option("--select <fields>", "Comma-separated response fields to include")
		.option("--fields <fields>", "Alias for --select")
		.option("--limit <count>", "Maximum records to return from list-style responses")
		.option("--offset <count>", "Offset into list-style responses")
		.option("--describe", "Print machine-readable schema for the selected command")
		.option("-v, --verbose", "Verbose logging to stderr")
		.option("-q, --quiet", "Suppress non-essential output");

	program
		.command("schema")
		.description("Print the machine-readable TAP CLI schema")
		.argument("[command...]", "Optional command path to describe")
		.action(async (requestedPath?: string[]) => {
			const opts = program.opts<GlobalOptions>();
			const startTime = Date.now();
			const path = requestedPath ?? [];
			const target = path.length === 0 ? program : findCommand(program, path);
			if (!target) {
				error("NOT_FOUND", `Unknown command path: ${path.join(" ")}`, opts);
				process.exitCode = 4;
				return;
			}

			success(
				serializeCommand(target, {
					includeInheritedOptions: path.length > 0,
				}),
				opts,
				startTime,
			);
		});

	program
		.command("install")
		.description("Install TAP skills and integrations for detected agent runtimes")
		.option(
			"--runtime <runtimes...>",
			"Install for specific runtimes only (claude, codex, openclaw, hermes)",
			[],
		)
		.option("--channel <name>", "Install prerelease packages from a named npm dist-tag")
		.option("--version <version>", "Install an exact prerelease package version")
		.action(async (cmdOpts: { runtime?: string[]; channel?: string; version?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { installCommand } = await import("./commands/install.js");
			await installCommand(
				{ runtimes: cmdOpts.runtime, channel: cmdOpts.channel, version: cmdOpts.version },
				opts,
			);
		});

	// daemon — control the long-lived tapd background process
	const daemon = program
		.command("daemon")
		.description("Manage the tapd background daemon (start, stop, status, restart, logs)");

	daemon
		.command("start")
		.description("Start tapd in the background")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { daemonStartCommand } = await import("./commands/daemon-start.js");
			await daemonStartCommand(opts);
		});

	daemon
		.command("stop")
		.description("Stop the running tapd daemon")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { daemonStopCommand } = await import("./commands/daemon-stop.js");
			await daemonStopCommand(opts);
		});

	daemon
		.command("status")
		.description("Check whether tapd is running and report its health")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { daemonStatusCommand } = await import("./commands/daemon-status.js");
			await daemonStatusCommand(opts);
		});

	daemon
		.command("restart")
		.description("Stop and start tapd (no-op stop if not running)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { daemonRestartCommand } = await import("./commands/daemon-restart.js");
			await daemonRestartCommand(opts);
		});

	daemon
		.command("logs")
		.description("Print the tapd log file; pass --follow to tail it")
		.option("--follow", "Tail the log file (Ctrl+C to stop)")
		.action(async (cmdOpts: { follow?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { daemonLogsCommand } = await import("./commands/daemon-logs.js");
			await daemonLogsCommand(opts, cmdOpts);
		});

	program
		.command("ui")
		.description("Open the tapd web dashboard in your default browser")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { uiCommand } = await import("./commands/ui.js");
			await uiCommand(opts);
		});

	const hermes = program.command("hermes").description("Manage the TAP Hermes gateway integration");

	hermes
		.command("configure")
		.description("Install or update the TAP Hermes plugin config for the current TAP data dir")
		.option("--name <name>", "Configured Hermes TAP identity name", "default")
		.option("--hermes-home <path>", "Override HERMES_HOME for the Hermes integration")
		.option(
			"--reconcile-interval-minutes <minutes>",
			"Background reconcile interval for this TAP identity",
		)
		.action(
			async (cmdOpts: {
				name?: string;
				hermesHome?: string;
				reconcileIntervalMinutes?: string;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { hermesConfigureCommand } = await import("./commands/hermes.js");
				await hermesConfigureCommand(cmdOpts, opts);
			},
		);

	hermes
		.command("status")
		.description("Show tapd status (alias for `tap daemon status`)")
		.option("--identity <name>", "Configured TAP Hermes identity name")
		.option("--hermes-home <path>", "Override HERMES_HOME for the Hermes integration")
		.action(async (cmdOpts: { identity?: string; hermesHome?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { hermesStatusCommand } = await import("./commands/hermes.js");
			await hermesStatusCommand(cmdOpts, opts);
		});

	hermes
		.command("sync")
		.description("Trigger a tapd reconcile (alias for `tap message sync`)")
		.option("--identity <name>", "Configured TAP Hermes identity name")
		.option("--hermes-home <path>", "Override HERMES_HOME for the Hermes integration")
		.action(async (cmdOpts: { identity?: string; hermesHome?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { hermesSyncCommand } = await import("./commands/hermes.js");
			await hermesSyncCommand(cmdOpts, opts);
		});

	hermes
		.command("restart")
		.description("Restart tapd (the single TAP daemon used by Hermes)")
		.option("--identity <name>", "Configured TAP Hermes identity name")
		.option("--hermes-home <path>", "Override HERMES_HOME for the Hermes integration")
		.action(async (cmdOpts: { identity?: string; hermesHome?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { hermesRestartCommand } = await import("./commands/hermes.js");
			await hermesRestartCommand(cmdOpts, opts);
		});

	program
		.command("status")
		.description("Show host-aware runtime state for the current TAP data dir")
		.option("--hermes-home <path>", "Override HERMES_HOME for the Hermes integration probe")
		.addHelpText(
			"after",
			`
First-step debug command. Reports which host is managing the data dir
(CLI listener, Hermes daemon, OpenClaw plugin, or idle), who currently
owns the transport lock, contact state (handshake), message/send state
(actual peer communication), and journal pending work. All reads are
filesystem-only: no transport is started.

Examples:
  tap status
  tap status --data-dir /path/to/agent
  tap status --json
`,
		)
		.action(async (cmdOpts: { hermesHome?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { statusCommand } = await import("./commands/status.js");
			await statusCommand(cmdOpts, opts);
		});

	program
		.command("remove")
		.description("Remove local TAP agent data")
		.option("--dry-run", "Show the local TAP files and directories that would be removed")
		.option("--unsafe-wipe-data-dir", "Delete the entire resolved TAP data dir after confirmation")
		.option(
			"--yes",
			"Required for non-interactive removal; interactive sessions still prompt for confirmation",
		)
		.addHelpText(
			"after",
			`
This only removes local TAP state under the resolved data dir. It does not unregister the agent on-chain, notify peers, or update external host config that still points at the same data dir.
Interactive runs show the current native on-chain balance and can optionally transfer remaining funds before the final wipe confirmation.
The command also refuses to wipe a directory that contains non-TAP top-level files.

Examples:
  tap remove --dry-run
  tap remove --unsafe-wipe-data-dir
  tap remove --unsafe-wipe-data-dir --yes --data-dir /path/to/agent
`,
		)
		.action(async (cmdOpts: { dryRun?: boolean; unsafeWipeDataDir?: boolean; yes?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { removeCommand } = await import("./commands/remove.js");
			await removeCommand(cmdOpts, opts);
		});

	// init
	program
		.command("init")
		.description("First-time setup wizard")
		.option("--chain <name>", "Chain to register on (alias or CAIP-2)")
		.option("--wallet <name>", "Use an existing OWS wallet by name")
		.option("--passphrase <passphrase>", "Wallet passphrase for API key creation")
		.option("--non-interactive", "Skip prompts and use defaults")
		.addHelpText(
			"after",
			`
Supported chains:
${chainAliasHelpText()}
`,
		)
		.action(
			async (cmdOpts: {
				chain?: string;
				wallet?: string;
				passphrase?: string;
				nonInteractive?: boolean;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { initCommand } = await import("./commands/init.js");
				await initCommand(opts, {
					chain: opts.chain ?? cmdOpts.chain,
					wallet: cmdOpts.wallet,
					passphrase: cmdOpts.passphrase,
					nonInteractive: cmdOpts.nonInteractive,
				});
			},
		);

	// migrate-wallet
	program
		.command("migrate-wallet")
		.description("Migrate an existing agent from raw key file to OWS")
		.option("--passphrase <passphrase>", "Wallet passphrase for import and API key creation")
		.option("--non-interactive", "Skip prompts and use defaults")
		.action(
			async (cmdOpts: {
				passphrase?: string;
				nonInteractive?: boolean;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { migrateWalletCommand } = await import("./commands/migrate-wallet.js");
				await migrateWalletCommand(opts, {
					passphrase: cmdOpts.passphrase,
					nonInteractive: cmdOpts.nonInteractive,
				});
			},
		);

	// register
	const register = program
		.command("register")
		.description("Manage ERC-8004 registration")
		.addHelpText(
			"after",
			`
Capabilities are freeform strings describing what your agent can do.
Common capabilities: general-chat, scheduling, research, payments, file-sharing
You can use any string — these are advertised to peers during discovery.

Examples:
  tap register --name "Cal" --description "Scheduling assistant" --capabilities "scheduling,general-chat"
  tap register update --description "Updated description"
  tap register --name "Scout" --description "Web researcher" --capabilities "research,general-chat"
  tap register --name "Treasury" --description "Payment agent" --capabilities "payments,general-chat"
`,
		);

	register
		.command("create")
		.description("Register agent on-chain via ERC-8004")
		.requiredOption("--name <name>", "Agent display name")
		.requiredOption("--description <desc>", "Agent description")
		.requiredOption("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload (or set TAP_PINATA_JWT)")
		.option("--ipfs-provider <provider>", "IPFS upload provider: auto, x402, pinata, or tack")
		.action(
			async (cmdOpts: {
				name: string;
				description: string;
				capabilities: string;
				uri?: string;
				pinataJwt?: string;
				ipfsProvider?: string;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { registerCommand } = await import("./commands/register.js");
				await registerCommand(cmdOpts, opts);
			},
		);

	register
		.command("update")
		.description("Update an existing agent's registration URI/manifest")
		.option("--name <name>", "Agent display name")
		.option("--description <desc>", "Agent description")
		.option("--capabilities <list>", "Comma-separated capabilities")
		.option("--uri <url>", "Pre-hosted registration file URI (skips IPFS upload)")
		.option("--pinata-jwt <token>", "Pinata JWT for IPFS upload")
		.option("--ipfs-provider <provider>", "IPFS upload provider: auto, x402, pinata, or tack")
		.action(
			async (cmdOpts: {
				name?: string;
				description?: string;
				capabilities?: string;
				uri?: string;
				pinataJwt?: string;
				ipfsProvider?: string;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { registerUpdateCommand } = await import("./commands/register.js");
				await registerUpdateCommand(cmdOpts, opts);
			},
		);

	program
		.command("balance")
		.description("Show native ETH and USDC balances for this agent")
		.argument("[chain]", "Chain override (alias like base or CAIP-2 like eip155:8453)")
		.action(async (chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { balanceCommand } = await import("./commands/balance.js");
			await balanceCommand(opts, chain);
		});

	program
		.command("transfer")
		.description("Transfer native ETH or USDC from this agent wallet to an address")
		.requiredOption("--to <address>", "Recipient Ethereum address")
		.requiredOption("--asset <asset>", "Asset to transfer: native or usdc")
		.requiredOption("--amount <amount>", "Human-readable transfer amount")
		.option("--chain <chain>", "Chain alias or CAIP-2 ID (defaults to local config chain)")
		.option("--dry-run", "Validate and preview the transfer without sending it")
		.option("--yes", "Skip the confirmation prompt")
		.action(
			async (cmdOpts: {
				to: string;
				asset: string;
				amount: string;
				chain?: string;
				dryRun?: boolean;
				yes?: boolean;
			}) => {
				const opts = program.opts<GlobalOptions>();
				const { transferCommand } = await import("./commands/transfer.js");
				await transferCommand(cmdOpts, opts);
			},
		);

	// config
	const config = program.command("config").description("Manage configuration");

	config
		.command("show")
		.description("Print resolved config (secrets redacted)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { configShowCommand } = await import("./commands/config-show.js");
			await configShowCommand(opts);
		});

	config
		.command("set <key> <value>")
		.description("Set a config value")
		.action(async (key: string, value: string) => {
			const opts = program.opts<GlobalOptions>();
			const { configSetCommand } = await import("./commands/config-set.js");
			await configSetCommand(key, value, opts);
		});

	// identity
	const identity = program.command("identity").description("Manage agent identity");

	identity
		.command("show")
		.description("Show this agent's identity")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { identityShowCommand } = await import("./commands/identity-show.js");
			await identityShowCommand(opts);
		});

	identity
		.command("resolve <agentId>")
		.description("Resolve a peer from on-chain registry")
		.argument("[chain]", "Chain override (CAIP-2)")
		.action(async (agentId: string, chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const parsed = Number.parseInt(agentId, 10);
			if (Number.isNaN(parsed) || parsed < 0) {
				const { error: outputError } = await import("./lib/output.js");
				outputError("VALIDATION_ERROR", `Invalid agent ID: ${agentId}`, opts);
				process.exitCode = 2;
				return;
			}
			const { identityResolveCommand } = await import("./commands/identity-resolve.js");
			await identityResolveCommand(parsed, opts, chain);
		});

	identity
		.command("resolve-self")
		.description("Resolve this agent from on-chain registry (includes capabilities)")
		.argument("[chain]", "Chain override (CAIP-2)")
		.action(async (chain?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { identityResolveSelfCommand } = await import("./commands/identity-resolve.js");
			await identityResolveSelfCommand(opts, chain);
		});

	// invite
	const invite = program.command("invite").description("Manage invites");

	invite
		.command("create")
		.description("Generate invite link")
		.option("--expiry <seconds>", "Expiry in seconds", "86400")
		.action(async (cmdOpts: { expiry: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { inviteCreateCommand } = await import("./commands/invite-create.js");
			await inviteCreateCommand(Number.parseInt(cmdOpts.expiry, 10), opts);
		});

	// connect
	program
		.command("connect <invite-url>")
		.description("Send a connection request from an invite")
		.option("--dry-run", "Validate the invite and preview the connection without sending it")
		.option("--no-wait", "Return immediately without waiting for the peer to respond")
		.option("--wait-seconds <seconds>", "Override the default 30s wait timeout", Number.parseInt)
		.addHelpText(
			"after",
			`
Connect establishes trust only. Publish or request grants separately after the contact is active.

By default, blocks up to 30s waiting for the peer to accept. Exit 0 on active, exit 2 on timeout.

Examples:
  tap connect "<invite-url>"
  tap connect "<invite-url>" --no-wait
  tap connect "<invite-url>" --wait-seconds 120
`,
		)
		.action(
			async (
				inviteUrl: string,
				// Commander stores --no-wait as `wait: false` (boolean negation pattern)
				cmdOpts: { dryRun?: boolean; wait?: boolean; waitSeconds?: number },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { connectCommand } = await import("./commands/connect.js");
				// noWait is true when --no-wait was passed (commander sets wait=false)
				const noWait = cmdOpts.wait === false;
				await connectCommand(inviteUrl, opts, cmdOpts.waitSeconds, noWait, !!cmdOpts.dryRun);
			},
		);

	const permissions = program.command("permissions").description("Manage directional grants");

	permissions
		.command("show [peer]")
		.description("Show grants for one peer or list grant counts for all peers")
		.action(async (peer?: string) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsShowCommand } = await import("./commands/permissions-show.js");
			await permissionsShowCommand(peer, opts);
		});

	permissions
		.command("grant <peer>")
		.description("Publish the grants you give to a peer from a JSON file")
		.requiredOption("--file <path>", "Path to a JSON grant file")
		.option("--note <text>", "Optional note recorded in the ledger")
		.option("--dry-run", "Validate the grant set and preview the update without sending it")
		.action(async (peer: string, cmdOpts: { file: string; note?: string; dryRun?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsGrantCommand } = await import("./commands/permissions-update.js");
			await permissionsGrantCommand(peer, cmdOpts.file, opts, {
				note: cmdOpts.note,
				dryRun: cmdOpts.dryRun,
			});
		});

	permissions
		.command("request <peer>")
		.description("Request that a peer grants you permissions from a JSON file")
		.requiredOption("--file <path>", "Path to a JSON grant file")
		.option("--note <text>", "Optional note included with the request")
		.option("--dry-run", "Validate the grant request and preview it without sending")
		.action(async (peer: string, cmdOpts: { file: string; note?: string; dryRun?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsRequestCommand } = await import("./commands/permissions-update.js");
			await permissionsRequestCommand(peer, cmdOpts.file, opts, {
				note: cmdOpts.note,
				dryRun: cmdOpts.dryRun,
			});
		});

	permissions
		.command("revoke <peer>")
		.description("Revoke one grant you previously published to a peer")
		.requiredOption("--grant-id <id>", "Grant ID to revoke")
		.option("--note <text>", "Optional note recorded in the ledger")
		.option("--dry-run", "Preview the revocation without sending it")
		.action(async (peer: string, cmdOpts: { grantId: string; note?: string; dryRun?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { permissionsRevokeCommand } = await import("./commands/permissions-revoke.js");
			await permissionsRevokeCommand(peer, cmdOpts.grantId, opts, {
				note: cmdOpts.note,
				dryRun: cmdOpts.dryRun,
			});
		});

	// contacts
	const contacts = program.command("contacts").description("Manage contacts");

	contacts
		.command("list")
		.description("List all contacts")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { contactsListCommand } = await import("./commands/contacts-list.js");
			await contactsListCommand(opts);
		});

	contacts
		.command("show <name-or-id>")
		.description("Detail for one contact")
		.action(async (nameOrId: string) => {
			const opts = program.opts<GlobalOptions>();
			const { contactsShowCommand } = await import("./commands/contacts-show.js");
			await contactsShowCommand(nameOrId, opts);
		});

	contacts
		.command("remove <connectionId>")
		.description("Remove a contact")
		.action(async (connectionId: string) => {
			const opts = program.opts<GlobalOptions>();
			const { contactsRemoveCommand } = await import("./commands/contacts-remove.js");
			await contactsRemoveCommand(connectionId, opts);
		});

	// message
	const message = program.command("message").description("Send and receive messages");

	message
		.command("send <peer> <text>")
		.description("Send message to connected peer")
		.option("--scope <scope>", "Semantic message scope", "general-chat")
		.option(
			"--priority",
			"Pay the peer's priority attention price so the message escalates and may wake their agent",
		)
		.option(
			"--dry-run",
			"Preview the message and the peer's advertised attention cost without sending",
		)
		.action(
			async (
				peer: string,
				text: string,
				cmdOpts: { scope?: string; dryRun?: boolean; priority?: boolean },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { messageSendCommand } = await import("./commands/message-send.js");
				await messageSendCommand(peer, text, opts, {
					scope: cmdOpts.scope,
					dryRun: cmdOpts.dryRun,
					priority: cmdOpts.priority,
				});
			},
		);

	message
		.command("request-funds <peer>")
		.description("Request native ETH or USDC from a connected peer")
		.requiredOption("--asset <asset>", "Asset to request: native or usdc")
		.requiredOption("--amount <amount>", "Human-readable amount to request")
		.option("--chain <chain>", "Chain alias or CAIP-2 ID (defaults to local config chain)")
		.option("--to <address>", "Recipient address (defaults to this agent wallet)")
		.option("--note <text>", "Optional note included with the request")
		.option("--dry-run", "Validate and preview the request without sending it")
		.action(
			async (
				peer: string,
				cmdOpts: {
					asset: string;
					amount: string;
					chain?: string;
					to?: string;
					note?: string;
					dryRun?: boolean;
				},
			) => {
				const opts = program.opts<GlobalOptions>();
				const { messageRequestFundsCommand } = await import("./commands/message-request-funds.js");
				await messageRequestFundsCommand(peer, cmdOpts, opts);
			},
		);

	message
		.command("listen")
		.description("Stream incoming messages and process results (long-running)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { messageListenCommand } = await import("./commands/message-listen.js");
			await messageListenCommand(opts);
		});

	message
		.command("sync")
		.description("Reconcile missed XMTP messages and process queued work once")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { messageSyncCommand } = await import("./commands/message-sync.js");
			await messageSyncCommand(opts);
		});

	message
		.command("request-meeting <peer>")
		.description("Request a meeting with a connected peer")
		.requiredOption("--title <title>", "Meeting title")
		.option("--duration <minutes>", "Duration in minutes", "60")
		.option("--preferred <datetime>", "Preferred time (ISO 8601)")
		.option("--location <location>", "Meeting location")
		.option("--note <note>", "Additional note")
		.option("--dry-run", "Validate and preview the meeting request without sending it")
		.action(
			async (
				peer: string,
				cmdOpts: {
					title: string;
					duration?: string;
					preferred?: string;
					location?: string;
					note?: string;
					dryRun?: boolean;
				},
			) => {
				const opts = program.opts<GlobalOptions>();
				const { messageRequestMeetingCommand } = await import(
					"./commands/message-request-meeting.js"
				);
				await messageRequestMeetingCommand(peer, cmdOpts, opts);
			},
		);

	message
		.command("respond-meeting <schedulingId>")
		.description("Accept or reject a pending scheduling request")
		.option("--accept", "Accept the scheduling request")
		.option("--reject", "Reject the scheduling request")
		.option("--reason <reason>", "Reason for rejection")
		.option("--dry-run", "Preview the response without resolving the pending request")
		.action(
			async (
				schedulingId: string,
				cmdOpts: { accept?: boolean; reject?: boolean; reason?: string; dryRun?: boolean },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { messageRespondMeetingCommand } = await import(
					"./commands/message-respond-meeting.js"
				);
				await messageRespondMeetingCommand(schedulingId, cmdOpts, opts);
			},
		);

	message
		.command("cancel-meeting <schedulingId>")
		.description("Cancel a previously requested or accepted meeting")
		.option("--reason <reason>", "Reason for cancellation")
		.option("--dry-run", "Preview the cancellation without sending it")
		.action(async (schedulingId: string, cmdOpts: { reason?: string; dryRun?: boolean }) => {
			const opts = program.opts<GlobalOptions>();
			const { messageCancelMeetingCommand } = await import("./commands/message-cancel-meeting.js");
			await messageCancelMeetingCommand(schedulingId, cmdOpts, opts);
		});

	// calendar
	const calendar = program.command("calendar").description("Calendar management");

	calendar
		.command("setup")
		.description("Configure a calendar provider for scheduling")
		.option("--provider <provider>", "Calendar provider", "google")
		.action(async (cmdOpts: { provider?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { calendarSetupCommand } = await import("./commands/calendar-setup.js");
			await calendarSetupCommand(cmdOpts, opts);
		});

	calendar
		.command("check")
		.description("Check calendar provider status and availability")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { calendarCheckCommand } = await import("./commands/calendar-check.js");
			await calendarCheckCommand(opts);
		});

	// conversations
	const conversations = program.command("conversations").description("View conversation history");

	conversations
		.command("list")
		.description("Conversation summaries")
		.option("--with <name>", "Filter by peer name")
		.action(async (cmdOpts: { with?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { conversationsListCommand } = await import("./commands/conversations-list.js");
			await conversationsListCommand(opts, cmdOpts.with);
		});

	conversations
		.command("show <id>")
		.description("Full transcript")
		.action(async (id: string) => {
			const opts = program.opts<GlobalOptions>();
			const { conversationsShowCommand } = await import("./commands/conversations-show.js");
			await conversationsShowCommand(id, opts);
		});

	// journal
	const journalCmd = program.command("journal").description("Inspect the TAP request journal");

	journalCmd
		.command("list")
		.description("List journal entries (optionally filtered)")
		.option("-d, --direction <dir>", "Filter by direction: inbound | outbound")
		.option("-s, --status <status>", "Filter by status: queued | pending | completed")
		.option("-m, --method <method>", "Filter by JSON-RPC method")
		.action(async (cmdOpts: { direction?: string; status?: string; method?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { journalListCommand } = await import("./commands/journal-list.js");
			await journalListCommand(
				{
					direction: cmdOpts.direction as "inbound" | "outbound" | undefined,
					status: cmdOpts.status as "queued" | "pending" | "completed" | undefined,
					method: cmdOpts.method,
				},
				opts,
			);
		});

	journalCmd
		.command("show <request-id>")
		.description("Show details of a single journal entry by request ID")
		.action(async (requestId: string) => {
			const opts = program.opts<GlobalOptions>();
			const { journalShowCommand } = await import("./commands/journal-show.js");
			await journalShowCommand(requestId, opts);
		});

	// attention
	const attention = program
		.command("attention")
		.description("Inspect the notification attention ledger");

	attention
		.command("show")
		.description("Per-peer notification attention usage (local read, no transport)")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { attentionShowCommand } = await import("./commands/attention-show.js");
			await attentionShowCommand(opts);
		});

	// postage
	const postage = program
		.command("postage")
		.description("Prepaid postage credits (paid attention)");

	postage
		.command("topup <peer>")
		.description("Buy prepaid postage credit at a peer (pays USDC via the daemon)")
		.requiredOption("--amount <amount>", "Decimal USDC amount to prepay (≤6 decimals)")
		.option("--wait-ms <ms>", "How long to wait for the peer's credit certificate")
		.option("--dry-run", "Preview without paying or sending")
		.option("--yes", "Skip the confirmation prompt")
		.action(
			async (
				peer: string,
				cmdOpts: { amount: string; waitMs?: string; dryRun?: boolean; yes?: boolean },
			) => {
				const opts = program.opts<GlobalOptions>();
				const { postageTopupCommand } = await import("./commands/postage-topup.js");
				await postageTopupCommand(peer, cmdOpts, opts);
			},
		);

	postage
		.command("balance")
		.description("Held and issued postage credits (local read, no transport)")
		.option("--peer <peer>", "Only credits for this peer (name or agent id)")
		.action(async (cmdOpts: { peer?: string }) => {
			const opts = program.opts<GlobalOptions>();
			const { postageBalanceCommand } = await import("./commands/postage-balance.js");
			await postageBalanceCommand(cmdOpts, opts);
		});

	// app
	const app = program.command("app").description("Manage TAP apps");

	app
		.command("install <name>")
		.description("Install a TAP app package")
		.action(async (name: string) => {
			const opts = program.opts<GlobalOptions>();
			const { appInstallCommand } = await import("./commands/app.js");
			await appInstallCommand(name, opts);
		});

	app
		.command("remove <name>")
		.description("Remove an installed TAP app")
		.action(async (name: string) => {
			const opts = program.opts<GlobalOptions>();
			const { appRemoveCommand } = await import("./commands/app.js");
			await appRemoveCommand(name, opts);
		});

	app
		.command("list")
		.description("List installed TAP apps")
		.action(async () => {
			const opts = program.opts<GlobalOptions>();
			const { appListCommand } = await import("./commands/app.js");
			await appListCommand(opts);
		});

	// Error handling
	program.exitOverride();
	program.configureOutput({
		writeErr: () => {},
	});

	program.hook("preAction", (_, actionCommand) => {
		Object.assign(program.opts(), { commandPath: commandPath(actionCommand) });
	});

	process.on("uncaughtException", (err) => {
		const opts = program.opts<GlobalOptions>();
		error(errorCode(err), err.message, opts);
		process.exitCode = exitCodeForError(err);
	});

	attachMetadataHelp(program);

	return program;
}

function attachMetadataHelp(command: Command): void {
	const help = formatMetadataHelp(commandPath(command));
	if (help) {
		command.addHelpText("after", help);
	}

	for (const child of command.commands) {
		if (child.name() === "help") {
			continue;
		}
		attachMetadataHelp(child);
	}
}
