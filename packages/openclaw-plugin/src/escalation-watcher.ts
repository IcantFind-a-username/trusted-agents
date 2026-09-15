import { readFile } from "node:fs/promises";
import { type ClientRequest, type IncomingMessage, request } from "node:http";
import { dirname, join } from "node:path";
import { toErrorMessage } from "trusted-agents-core";

const ESCALATION_EVENT_TYPES = new Set(["action.pending", "connection.requested"]);
const RECONNECT_DELAY_MS = 1000;
const TOKEN_FILE_NAME = ".tapd-token";

/** A message.received event whose stamp paid the priority (wake-up) tier. */
function isPriorityMessagePayload(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return false;
	const postage = (payload as { postage?: unknown }).postage;
	if (typeof postage !== "object" || postage === null) return false;
	return (postage as { tier?: unknown }).tier === "priority";
}

export interface EscalationEvent {
	type: string;
	payload: unknown;
}

export interface EscalationWatcherLogger {
	warn: (message: string) => void;
}

export interface EscalationWatcherOptions {
	socketPath: string;
	onEscalation: (event: EscalationEvent) => void;
	logger?: EscalationWatcherLogger;
	/** Override the reconnect delay; tests use a small value to keep them quick. */
	reconnectDelayMs?: number;
}

/**
 * Subscribes to tapd's `/api/events/stream` over the local Unix socket and
 * fires the configured `onEscalation` callback whenever an escalation-class
 * SSE event arrives. The OpenClaw plugin uses this to call
 * `requestHeartbeatNow()` so the agent wakes immediately rather than waiting
 * for the next prompt cycle.
 *
 * The watcher is intentionally minimal: SSE framing is parsed by hand
 * (no extra deps), reconnect after a closed stream is a fixed delay, and
 * non-escalation events are ignored.
 */
export class EscalationWatcher {
	private req: ClientRequest | null = null;
	private res: IncomingMessage | null = null;
	private buffer = "";
	private stopped = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private readonly reconnectDelayMs: number;

	constructor(private readonly options: EscalationWatcherOptions) {
		this.reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
	}

	start(): void {
		// Already running — ignore repeat start() calls.
		if (this.req) return;
		// Allow start() after stop(). `stopped` is a signal to the reconnect
		// loop, not a terminal state; if the plugin service lifecycle calls
		// stop+start (Gateway reload without process replacement), we want
		// the SSE stream to come back up instead of silently staying dark.
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.res) {
			this.res.destroy();
			this.res = null;
		}
		if (this.req) {
			this.req.destroy();
			this.req = null;
		}
	}

	private async connect(): Promise<void> {
		let token: string;
		try {
			const tokenPath = join(dirname(this.options.socketPath), TOKEN_FILE_NAME);
			token = (await readFile(tokenPath, "utf-8")).trim();
			if (!token) throw new Error(`tapd token file ${tokenPath} is empty`);
		} catch (err) {
			this.options.logger?.warn(
				`escalation watcher cannot read tapd token: ${toErrorMessage(err)}`,
			);
			this.handleEnd();
			return;
		}
		if (this.stopped) return;

		const req = request(
			{
				socketPath: this.options.socketPath,
				method: "GET",
				path: "/api/events/stream",
				headers: {
					Accept: "text/event-stream",
					Authorization: `Bearer ${token}`,
				},
			},
			(res) => {
				if (this.stopped) {
					res.destroy();
					return;
				}
				this.res = res;
				res.setEncoding("utf-8");
				res.on("data", (chunk: string) => this.handleChunk(chunk));
				res.on("end", () => this.handleEnd());
				res.on("error", () => this.handleEnd());
			},
		);
		req.on("error", (err) => {
			this.options.logger?.warn(`escalation watcher request error: ${err.message}`);
			this.handleEnd();
		});
		req.end();
		this.req = req;
	}

	private handleChunk(chunk: string): void {
		this.buffer += chunk;
		while (this.buffer.includes("\n\n")) {
			const idx = this.buffer.indexOf("\n\n");
			const block = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 2);
			this.parseBlock(block);
		}
	}

	private parseBlock(block: string): void {
		let eventType = "";
		let dataLine = "";
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) continue; // SSE comment / heartbeat
			if (line.startsWith("event:")) {
				eventType = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				dataLine = line.slice("data:".length).trim();
			}
		}
		if (!eventType || !dataLine) return;
		const alwaysEscalates = ESCALATION_EVENT_TYPES.has(eventType);
		// message.received escalates only when the sender paid the priority
		// attention tier — that stamp bought the wake-up.
		if (!alwaysEscalates && eventType !== "message.received") return;

		let payload: unknown;
		try {
			payload = JSON.parse(dataLine);
		} catch {
			return;
		}
		if (!alwaysEscalates && !isPriorityMessagePayload(payload)) return;
		try {
			this.options.onEscalation({ type: eventType, payload });
		} catch (error: unknown) {
			this.options.logger?.warn(`escalation watcher callback threw: ${toErrorMessage(error)}`);
		}
	}

	private handleEnd(): void {
		this.req = null;
		this.res = null;
		this.buffer = "";
		if (this.stopped) return;
		// Reconnect after a short delay. The Unix socket should always be
		// available when tapd is running; if it goes away, we wait briefly and
		// retry rather than spamming reconnect attempts.
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) void this.connect();
		}, this.reconnectDelayMs);
	}
}
