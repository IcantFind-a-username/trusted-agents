import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	FilePostageLedger,
	postagePeerKey,
} from "../packages/core/src/postage/ledger.ts";

async function main(): Promise<void> {
	const tempRoot = await mkdtemp(join(tmpdir(), "postage-benchmark-"));

	try {
		const ledger = new FilePostageLedger(tempRoot);

		const peer = postagePeerKey({
			chain: "eip155:8453",
			agentId: 7001,
		});

		const creditId = "benchmark-credit-1";

		await ledger.recordIssued({
			creditId,
			peer,
			amount: "0.002",
			txHash: "0xbenchmarktopup",
		});

		console.log("Top-up created: 0.002 USDC");

        const first = await ledger.debitIssued({
	creditId,
	peer,
	seq: 1,
	cost: "0.001",
	required: "0.001",
	stampKey: "message-1",
});

console.log("Message 1:", first);

const second = await ledger.debitIssued({
	creditId,
	peer,
	seq: 2,
	cost: "0.001",
	required: "0.001",
	stampKey: "message-2",
});

console.log("Message 2:", second);

const third = await ledger.debitIssued({
	creditId,
	peer,
	seq: 3,
	cost: "0.001",
	required: "0.001",
	stampKey: "message-3",
});

console.log("Message 3:", third);

console.log("\n=== POSTAGE BENCHMARK SUMMARY ===");

console.table([
	{
		Message: 1,
		Cost: "0.001",
		Result: first.ok ? "Accepted" : "Rejected",
		Remaining: first.ok ? first.remaining : "-",
	},
	{
		Message: 2,
		Cost: "0.001",
		Result: second.ok ? "Accepted" : "Rejected",
		Remaining: second.ok ? second.remaining : "-",
	},
	{
		Message: 3,
		Cost: "0.001",
		Result: third.ok ? "Accepted" : "Rejected",
		Remaining:
			third.ok
				? third.remaining
				: "remaining" in third.rejection
					? third.rejection.remaining
					: "-",
	},
]);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}



await main();