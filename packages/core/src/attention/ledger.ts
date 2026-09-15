import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncMutex, resolveDataDir } from "../common/index.js";

/** A peer identity as the ledger attributes attention to it. */
export interface AttentionPeerRef {
	chain: string;
	agentId: number;
}

/**
 * What one peer cost this agent's attention inside one bucket:
 * notification lines actually rendered into the `[TAP Notifications]`
 * block, the estimated tokens those lines injected (ceil(chars/4)),
 * escalation notifications surfaced, and events suppressed past the
 * render cap.
 */
export interface AttentionStats {
	notificationsRendered: number;
	tokensInjected: number;
	escalations: number;
	overflowSuppressed: number;
}

/** One accounting increment. `peer` null/absent means unattributable. */
export interface AttentionDelta extends Partial<AttentionStats> {
	peer?: AttentionPeerRef | null;
}

export interface AttentionDayBucket {
	peers: Record<string, AttentionStats>;
	totals: AttentionStats;
}

export interface AttentionLedgerFile {
	version: 1;
	/** The identity whose attention is being spent (the ledger's owner). */
	identity?: AttentionPeerRef;
	/** UTC day (YYYY-MM-DD) → per-peer stats for that day. */
	days: Record<string, AttentionDayBucket>;
}

export interface AttentionSummaryRow extends AttentionStats {
	peerKey: string;
	peer: AttentionPeerRef | null;
}

export interface AttentionRecordOptions {
	/** ISO timestamp of the drain; bucketed by its UTC date. Defaults to now. */
	at?: string;
	identity?: AttentionPeerRef;
}

export interface FileAttentionLedgerOptions {
	/** Days of buckets to retain; older buckets are pruned on write. */
	retentionDays?: number;
}

export const UNATTRIBUTED_PEER_KEY = "unattributed";

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function attentionPeerKey(peer: AttentionPeerRef | null | undefined): string {
	return peer ? `${peer.chain}#${peer.agentId}` : UNATTRIBUTED_PEER_KEY;
}

function emptyStats(): AttentionStats {
	return { notificationsRendered: 0, tokensInjected: 0, escalations: 0, overflowSuppressed: 0 };
}

function addDelta(target: AttentionStats, delta: AttentionDelta): void {
	target.notificationsRendered += delta.notificationsRendered ?? 0;
	target.tokensInjected += delta.tokensInjected ?? 0;
	target.escalations += delta.escalations ?? 0;
	target.overflowSuppressed += delta.overflowSuppressed ?? 0;
}

function parsePeerKey(key: string): AttentionPeerRef | null {
	const separator = key.lastIndexOf("#");
	if (separator <= 0) return null;
	const agentId = Number(key.slice(separator + 1));
	if (!Number.isInteger(agentId)) return null;
	return { chain: key.slice(0, separator), agentId };
}

/**
 * File-backed rolling ledger of what the notification pipeline spends of
 * this agent's LLM attention, per peer. Written only by the tapd daemon
 * process (single writer): the AsyncMutex is process-local, so a second
 * writing process would race the tmp+rename cycle.
 */
export class FileAttentionLedger {
	private readonly dataDir: string;
	private readonly ledgerPath: string;
	private readonly retentionDays: number;
	private readonly writeMutex = new AsyncMutex();

	constructor(
		dataDir = join(process.env.HOME ?? "~", ".trustedagents"),
		options: FileAttentionLedgerOptions = {},
	) {
		this.dataDir = resolveDataDir(dataDir);
		this.ledgerPath = join(this.dataDir, "attention-ledger.json");
		const retention = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
		if (!Number.isInteger(retention) || retention <= 0) {
			throw new Error("FileAttentionLedger retentionDays must be a positive integer");
		}
		this.retentionDays = retention;
	}

	async record(deltas: AttentionDelta[], options: AttentionRecordOptions = {}): Promise<void> {
		if (deltas.length === 0) return;
		const at = options.at ?? new Date().toISOString();
		const parsed = new Date(at);
		if (Number.isNaN(parsed.getTime())) {
			throw new Error(`FileAttentionLedger record got an invalid timestamp: ${at}`);
		}
		const day = parsed.toISOString().slice(0, 10);

		await this.writeMutex.runExclusive(async () => {
			const data = await this.load();
			if (options.identity) {
				data.identity = options.identity;
			}
			let bucket = data.days[day];
			if (!bucket) {
				bucket = { peers: {}, totals: emptyStats() };
				data.days[day] = bucket;
			}
			for (const delta of deltas) {
				const key = attentionPeerKey(delta.peer ?? null);
				let stats = bucket.peers[key];
				if (!stats) {
					stats = emptyStats();
					bucket.peers[key] = stats;
				}
				addDelta(stats, delta);
				addDelta(bucket.totals, delta);
			}
			this.prune(data, parsed.getTime());
			await this.save(data);
		});
	}

	async read(): Promise<AttentionLedgerFile> {
		return await this.load();
	}

	/**
	 * Notifications rendered for one peer over the trailing `days` UTC days
	 * (today inclusive). This is the number notification quotas enforce
	 * against: the ledger records exactly what the render plan billed, so
	 * "rendered" here means lines that actually reached a host context.
	 * Window sizes beyond the retention window under-count by design.
	 */
	async renderedInWindow(peer: AttentionPeerRef, days: number, now = new Date()): Promise<number> {
		if (!Number.isInteger(days) || days <= 0) {
			throw new Error("renderedInWindow days must be a positive integer");
		}
		const cutoff = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
		const key = attentionPeerKey(peer);
		const data = await this.load();
		let rendered = 0;
		for (const [day, bucket] of Object.entries(data.days)) {
			if (day >= cutoff) {
				rendered += bucket.peers[key]?.notificationsRendered ?? 0;
			}
		}
		return rendered;
	}

	/** Aggregate all retained days per peer, sorted by tokens injected. */
	async summarize(): Promise<AttentionSummaryRow[]> {
		const data = await this.load();
		const byPeer = new Map<string, AttentionSummaryRow>();
		for (const bucket of Object.values(data.days)) {
			for (const [key, stats] of Object.entries(bucket.peers)) {
				let row = byPeer.get(key);
				if (!row) {
					row = { peerKey: key, peer: parsePeerKey(key), ...emptyStats() };
					byPeer.set(key, row);
				}
				addDelta(row, stats);
			}
		}
		return [...byPeer.values()].sort((a, b) => b.tokensInjected - a.tokensInjected);
	}

	private prune(data: AttentionLedgerFile, nowMs: number): void {
		const cutoff = new Date(nowMs - this.retentionDays * DAY_MS).toISOString().slice(0, 10);
		for (const day of Object.keys(data.days)) {
			if (day < cutoff) {
				delete data.days[day];
			}
		}
	}

	private async load(): Promise<AttentionLedgerFile> {
		try {
			const raw = await readFile(this.ledgerPath, "utf-8");
			return JSON.parse(raw) as AttentionLedgerFile;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { version: 1, days: {} };
			}
			throw err;
		}
	}

	private async save(data: AttentionLedgerFile): Promise<void> {
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		const tmpPath = `${this.ledgerPath}.${randomUUID()}.tmp`;
		await writeFile(tmpPath, JSON.stringify(data, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		await rename(tmpPath, this.ledgerPath);
	}
}
