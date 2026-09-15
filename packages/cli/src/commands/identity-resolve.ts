import { loadConfig } from "../lib/config-loader.js";
import { buildContext } from "../lib/context.js";
import { handleCommandError } from "../lib/errors.js";
import { success, verbose } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

async function resolveIdentity(
	agentId: number,
	resolveChain: string,
	config: Awaited<ReturnType<typeof loadConfig>>,
	opts: GlobalOptions,
	startTime: number,
): Promise<void> {
	const ctx = buildContext(config);

	verbose(`Resolving agent ${agentId} on ${resolveChain}...`, opts);

	const agent = await ctx.resolver.resolve(agentId, resolveChain);

	success(
		{
			agent_id: agent.agentId,
			chain: agent.chain,
			owner: agent.ownerAddress,
			agent_address: agent.agentAddress,
			xmtp_endpoint: agent.xmtpEndpoint,
			execution_address: agent.executionAddress,
			execution_mode: agent.executionMode,
			paymaster_provider: agent.paymasterProvider,
			name: agent.registrationFile.name,
			description: agent.registrationFile.description,
			capabilities: agent.capabilities,
			attention: agent.attention ?? null,
			resolved_at: agent.resolvedAt,
		},
		opts,
		startTime,
	);
}

export async function identityResolveCommand(
	agentId: number,
	opts: GlobalOptions,
	chain?: string,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const resolveChain = chain ?? config.chain;
		await resolveIdentity(agentId, resolveChain, config, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}

export async function identityResolveSelfCommand(
	opts: GlobalOptions,
	chain?: string,
): Promise<void> {
	const startTime = Date.now();

	try {
		const config = await loadConfig(opts);
		const resolveChain = chain ?? config.chain;
		await resolveIdentity(config.agentId, resolveChain, config, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
