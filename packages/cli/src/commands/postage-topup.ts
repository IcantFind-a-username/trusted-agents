import { ValidationError, isValidPostageAmount } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import { promptYesNo } from "../lib/prompt.js";
import { TapdClient } from "../lib/tapd-client.js";
import type { GlobalOptions } from "../types.js";

interface PostageTopupCommandOptions {
	amount: string;
	waitMs?: string;
	dryRun?: boolean;
	yes?: boolean;
}

/**
 * `tap postage topup <peer> --amount <usdc>` — prepay postage credit at a
 * peer through the running daemon: the daemon pays USDC to the peer's agent
 * address with its owned signing provider, sends `postage/topup`, and waits
 * for the peer's signed credit certificate. Stamps then attach to
 * `tap message send` automatically until the credit runs dry.
 */
export async function postageTopupCommand(
	peer: string,
	cmdOpts: PostageTopupCommandOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const config = await loadConfig(opts);
		const amount = cmdOpts.amount.trim();
		if (!isValidPostageAmount(amount) || Number(amount) <= 0) {
			throw new ValidationError(
				`Invalid postage amount: ${cmdOpts.amount}. Use a positive decimal USDC string with at most 6 decimals.`,
			);
		}
		const waitMs = cmdOpts.waitMs !== undefined ? Number(cmdOpts.waitMs) : undefined;
		if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs <= 0)) {
			throw new ValidationError(`Invalid --wait-ms: ${cmdOpts.waitMs}`);
		}

		const base = { peer, amount, currency: "USDC", scope: "postage/topup" };

		if (cmdOpts.dryRun) {
			success({ status: "preview", dry_run: true, ...base }, opts, startTime);
			return;
		}

		const approved = cmdOpts.yes
			? true
			: await promptYesNo(
					[
						"Postage topup confirmation:",
						`- Peer: ${peer}`,
						`- Amount: ${amount} USDC (paid on-chain to the peer's agent address)`,
						"Proceed? [y/N] ",
					].join("\n"),
				);
		if (!approved) {
			success({ status: "cancelled", cancelled: true, ...base }, opts, startTime);
			return;
		}

		const client = await TapdClient.forDataDir(config.dataDir);
		const result = await client.postageTopup({
			peer,
			amount,
			...(waitMs !== undefined ? { waitMs } : {}),
		});

		success(
			{
				status: result.status,
				...base,
				peer_name: result.peerName,
				peer_agent_id: result.peerAgentId,
				credit_id: result.creditId,
				tx_hash: result.txHash,
				certificate_verified: result.certificateVerified,
				...(result.error ? { error: result.error } : {}),
			},
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
