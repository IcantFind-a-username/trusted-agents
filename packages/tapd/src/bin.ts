#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ALL_CHAINS,
	OwsSigningProvider,
	TapMessagingService,
	buildDefaultTapRuntimeContext,
	executeOnchainTransfer,
	generateInvite,
	loadTrustedAgentConfigFromDataDir,
	toErrorMessage,
} from "trusted-agents-core";
import { resolveTapdConfig } from "./config.js";
import { Daemon, TAPD_VERSION } from "./daemon.js";

async function main(): Promise<void> {
	const tapdConfig = resolveTapdConfig(process.env, {});

	process.stdout.write(`tapd ${TAPD_VERSION} starting (dataDir=${tapdConfig.dataDir})\n`);

	// Pass the full chain map so every tapd-hosted flow has access to the same
	// set of chains the CLI documents (Base + Taiko today). Without this, a
	// Base-configured daemon cannot execute a Taiko transfer even though the
	// CLI advertises support. See the adversarial review's F3.3 finding.
	const trustedAgentsConfig = await loadTrustedAgentConfigFromDataDir(tapdConfig.dataDir, {
		extraChains: ALL_CHAINS,
	});

	// The startup signing provider is scoped to the agent's default chain and
	// is used for things that don't vary per request (identity resolution,
	// invite signing, XMTP client identity). Transfers take a different chain
	// at request time and must create their own signer — see `executeTransfer`
	// below.
	const startupSigningProvider = new OwsSigningProvider(
		trustedAgentsConfig.ows.wallet,
		trustedAgentsConfig.chain,
		trustedAgentsConfig.ows.apiKey,
	);

	const context = await buildDefaultTapRuntimeContext(trustedAgentsConfig, {
		signingProvider: startupSigningProvider,
	});

	// Capture the agent's own address once at startup so the identity route can
	// surface it to clients (e.g. `tap message request-funds` defaulting --to).
	let agentAddress = "";
	try {
		agentAddress = await startupSigningProvider.getAddress();
	} catch (err) {
		process.stderr.write(
			`tapd warning: failed to resolve own address from signing provider: ${toErrorMessage(err)}\n`,
		);
	}

	const buildService = async (): Promise<TapMessagingService> => {
		return new TapMessagingService(context, {
			ownerLabel: `tapd:${process.pid}`,
			hooks: {
				log: (level, message) => {
					process.stdout.write(`[tapd:${level}] ${message}\n`);
				},
				// Postage topups pay through the service's transfer hook (the
				// route-level executor below only serves POST /api/transfers).
				// Same per-request-chain signer rationale as that executor.
				executeTransfer: async (serviceConfig, request) => {
					const chainSigner = new OwsSigningProvider(
						trustedAgentsConfig.ows.wallet,
						request.chain,
						trustedAgentsConfig.ows.apiKey,
					);
					return await executeOnchainTransfer(serviceConfig, chainSigner, request);
				},
			},
		});
	};

	// The bundled UI lives next to this binary at `<dist>/ui/`. The tapd
	// `postbuild` script copies `packages/ui/out` into that location, so the
	// daemon ships with the entire dashboard inline.
	const here = dirname(fileURLToPath(import.meta.url));
	const staticAssetsDir = join(here, "ui");

	// tapd intentionally passes `calendarProvider: null` here. The CLI's
	// `tap message request-meeting` command resolves a Google Calendar
	// provider from <dataDir>/config.yaml and pre-builds the slot list
	// before POSTing /api/meetings, so it never needs the daemon's
	// provider. Hermes/OpenClaw clients omit `slots` and let tapd fall
	// back to a single placeholder slot ~24h ahead (or the caller-supplied
	// `preferred` time). A shared calendar resolver in core that tapd can
	// own is a follow-up.
	const daemon = new Daemon({
		config: tapdConfig,
		calendarProvider: null,
		identityAgentId: trustedAgentsConfig.agentId,
		identitySource: () => ({
			agentId: trustedAgentsConfig.agentId,
			chain: trustedAgentsConfig.chain,
			address: agentAddress,
			displayName: "",
			dataDir: tapdConfig.dataDir,
		}),
		buildService,
		trustStore: context.trustStore,
		conversationLogger: context.conversationLogger,
		executeTransfer: async (request) => {
			// Create a fresh signer scoped to the request chain so OWS policies
			// and wallet accounts are evaluated under the correct chain context.
			// A single startup-time signer bound to `trustedAgentsConfig.chain`
			// would silently sign cross-chain transfers with the wrong scope.
			const chainSigner = new OwsSigningProvider(
				trustedAgentsConfig.ows.wallet,
				request.chain,
				trustedAgentsConfig.ows.apiKey,
			);
			return await executeOnchainTransfer(trustedAgentsConfig, chainSigner, {
				type: "transfer/request",
				actionId: `tapd-${randomUUID()}`,
				asset: request.asset,
				amount: request.amount,
				chain: request.chain,
				toAddress: request.toAddress,
			});
		},
		createInvite: async (request) => {
			const expirySeconds = request.expiresInSeconds ?? 3600;
			const result = await generateInvite({
				agentId: trustedAgentsConfig.agentId,
				chain: trustedAgentsConfig.chain,
				signingProvider: startupSigningProvider,
				expirySeconds,
			});
			return { url: result.url, expiresInSeconds: expirySeconds };
		},
		staticAssetsDir,
	});

	try {
		await daemon.runUntilSignal();
		process.stdout.write("tapd shut down cleanly\n");
		process.exit(0);
	} catch (error: unknown) {
		process.stderr.write(`tapd failed: ${toErrorMessage(error)}\n`);
		process.exit(1);
	}
}

void main();
