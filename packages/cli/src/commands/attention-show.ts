import { FileAttentionLedger } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

export async function attentionShowCommand(opts: GlobalOptions): Promise<void> {
	const startTime = Date.now();
	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const ledger = new FileAttentionLedger(config.dataDir);
		const rows = (await ledger.summarize()).map((row) => ({
			peer: row.peerKey,
			notifications_rendered: row.notificationsRendered,
			tokens_injected: row.tokensInjected,
			escalations: row.escalations,
			overflow_suppressed: row.overflowSuppressed,
		}));
		success({ peers: rows, count: rows.length }, opts, startTime);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
