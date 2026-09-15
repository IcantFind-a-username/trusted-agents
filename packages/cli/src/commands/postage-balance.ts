import { FilePostageLedger, postagePeerKey } from "trusted-agents-core";
import { loadConfig } from "../lib/config-loader.js";
import { buildContext } from "../lib/context.js";
import { handleCommandError } from "../lib/errors.js";
import { success } from "../lib/output.js";
import type { GlobalOptions } from "../types.js";

interface PostageBalanceCommandOptions {
	peer?: string;
}

/**
 * `tap postage balance` — local read of both sides of the postage ledger:
 * credits this agent holds at peers (spendable stamps) and credits peers
 * bought here (their prepaid attention). No transport; the daemon's ledger
 * file is read directly, like `tap attention show`.
 */
export async function postageBalanceCommand(
	cmdOpts: PostageBalanceCommandOptions,
	opts: GlobalOptions,
): Promise<void> {
	const startTime = Date.now();
	try {
		const config = await loadConfig(opts, { requireAgentId: false });
		const ledger = new FilePostageLedger(config.dataDir);
		const state = await ledger.read();

		let peerFilter: string | undefined;
		if (cmdOpts.peer) {
			const context = buildContext(config);
			const contacts = await context.trustStore.getContacts();
			const needle = cmdOpts.peer.toLowerCase();
			const agentIdNum = Number.parseInt(cmdOpts.peer, 10);
			const contact = contacts.find(
				(candidate) =>
					candidate.peerDisplayName.toLowerCase() === needle ||
					(!Number.isNaN(agentIdNum) && candidate.peerAgentId === agentIdNum),
			);
			peerFilter = contact
				? postagePeerKey({ chain: contact.peerChain, agentId: contact.peerAgentId })
				: cmdOpts.peer;
		}

		const held = Object.values(state.held)
			.filter((credit) => !peerFilter || credit.peer === peerFilter)
			.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
			.map((credit) => ({
				credit_id: credit.creditId,
				peer: credit.peer,
				amount: credit.amount,
				spent: credit.spent,
				remaining: FilePostageLedger.remainingOf(credit),
				next_seq: credit.nextSeq,
				certificate_verified: credit.certificateVerified,
			}));
		const issued = Object.values(state.issued)
			.filter((credit) => !peerFilter || credit.peer === peerFilter)
			.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
			.map((credit) => ({
				credit_id: credit.creditId,
				peer: credit.peer,
				amount: credit.amount,
				spent: credit.spent,
				remaining: FilePostageLedger.remainingOf(credit),
				last_seq: credit.lastSeq,
			}));

		success(
			{ held, issued, held_count: held.length, issued_count: issued.length },
			opts,
			startTime,
		);
	} catch (err) {
		handleCommandError(err, opts);
	}
}
