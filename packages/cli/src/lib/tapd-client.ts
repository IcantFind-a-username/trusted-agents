import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type {
	Contact,
	ConversationLog,
	PermissionGrantSet,
	TapCancelMeetingResult,
	TapConnectResult,
	TapPendingRequest,
	TapPostageTopupResult,
	TapPublishGrantSetResult,
	TapRequestFundsInput,
	TapRequestFundsResult,
	TapRequestGrantSetResult,
	TapRequestMeetingResult,
	TapSendMessageResult,
	TapSyncReport,
	TimeSlot,
} from "trusted-agents-core";
import { TAPD_PORT_FILE, TAPD_TOKEN_FILE } from "trusted-agents-tapd";

// The Unix socket lives next to the token file. tapd binds it on every start
// at `<dataDir>/.tapd.sock`. The CLI talks to tapd over this socket so it
// shares the same auth/transport boundary as the OpenClaw and Hermes
// clients — only the bundled web UI uses the TCP port, and only because
// browsers can't speak Unix sockets.
const SOCKET_FILE = ".tapd.sock";

/**
 * Thrown when the tapd token file is missing/empty, i.e. tapd hasn't started
 * (or has already cleaned up after itself). Callers can recover by either
 * prompting the user to run `tap daemon start` or falling back to a
 * local-only path.
 */
export class TapdNotRunningError extends Error {
	constructor() {
		super("tapd is not running. Start it with: tap daemon start");
		this.name = "TapdNotRunningError";
	}
}

/**
 * Thrown for non-2xx responses from tapd. Mirrors the TapdApiError shape from
 * the web UI client so callers can surface tapd's structured error code/message.
 */
export class TapdClientError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
		public readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "TapdClientError";
	}
}

export interface TapdConnectionInfo {
	socketPath: string;
	token: string;
}

/**
 * Read the bearer token tapd writes into the data dir at start, and return
 * it alongside the per-data-dir Unix socket path. Throws
 * `TapdNotRunningError` when the token file is missing or empty — that
 * signals tapd is not running for this data dir.
 */
export async function discoverTapd(dataDir: string): Promise<TapdConnectionInfo> {
	let token: string;
	try {
		token = (await readFile(join(dataDir, TAPD_TOKEN_FILE), "utf-8")).trim();
	} catch {
		throw new TapdNotRunningError();
	}
	if (!token) {
		throw new TapdNotRunningError();
	}
	return { socketPath: join(dataDir, SOCKET_FILE), token };
}

/**
 * Returns connection info if tapd appears to be running, otherwise null.
 * Useful for commands that route through tapd opportunistically and fall back
 * to direct file mutation when tapd is offline.
 */
export async function tryDiscoverTapd(dataDir: string): Promise<TapdConnectionInfo | null> {
	try {
		return await discoverTapd(dataDir);
	} catch (err) {
		if (err instanceof TapdNotRunningError) return null;
		throw err;
	}
}

export interface TapdUiInfo {
	baseUrl: string;
	token: string;
}

/**
 * Returns the loopback HTTP URL the bundled web UI listens on, plus the
 * bearer token. CLI commands that open a browser (`tap ui`) or display the
 * UI URL (`tap daemon status`) call this. Normal CLI requests still go over
 * the Unix socket via `discoverTapd` / `TapdClient`.
 */
export async function discoverTapdUiUrl(dataDir: string): Promise<TapdUiInfo> {
	let portRaw: string;
	try {
		portRaw = await readFile(join(dataDir, TAPD_PORT_FILE), "utf-8");
	} catch {
		throw new TapdNotRunningError();
	}
	const port = Number.parseInt(portRaw.trim(), 10);
	if (!Number.isInteger(port) || port <= 0) {
		throw new TapdNotRunningError();
	}
	const { token } = await discoverTapd(dataDir);
	return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export interface TransferRequestBody {
	asset: "native" | "usdc";
	amount: string;
	chain: string;
	toAddress: `0x${string}`;
}

export interface TransferResultBody {
	txHash: `0x${string}`;
}

export interface CreateInviteRequestBody {
	expiresInSeconds?: number;
}

export interface CreateInviteResultBody {
	url: string;
	expiresInSeconds: number;
}

export interface DaemonHealth {
	status: "ok";
	version: string;
	uptime: number;
	transportConnected: boolean;
	lastSyncAt?: string;
}

export interface IdentityResponse {
	agentId: number;
	chain: string;
	address: string;
	displayName: string;
	dataDir: string;
}

/**
 * Flat-shape body the meetings route accepts. CLI builds the slot list
 * locally (with the configured calendar provider) and posts the result; tapd
 * fills in the schedulingId default and validates the proposal.
 */
export interface RequestMeetingBody {
	peer: string;
	title: string;
	duration: number;
	slots?: TimeSlot[];
	preferred?: string;
	location?: string;
	note?: string;
	schedulingId?: string;
	originTimezone?: string;
}

/**
 * Typed HTTP-over-Unix-socket client for the tapd local API. Methods mirror
 * the route surface created in `packages/tapd/src/http/routes/`. Construct
 * with `TapdClient.forDataDir(dataDir)` so the bearer token is picked up
 * automatically.
 */
export class TapdClient {
	constructor(private readonly info: TapdConnectionInfo) {}

	static async forDataDir(dataDir: string): Promise<TapdClient> {
		return new TapdClient(await discoverTapd(dataDir));
	}

	get socketPath(): string {
		return this.info.socketPath;
	}

	get token(): string {
		return this.info.token;
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	getIdentity(): Promise<IdentityResponse> {
		return this.get<IdentityResponse>("/api/identity");
	}

	listContacts(): Promise<Contact[]> {
		return this.get<Contact[]>("/api/contacts");
	}

	getContact(connectionId: string): Promise<Contact | null> {
		return this.get<Contact | null>(`/api/contacts/${encodeURIComponent(connectionId)}`);
	}

	listConversations(): Promise<ConversationLog[]> {
		return this.get<ConversationLog[]>("/api/conversations");
	}

	getConversation(id: string): Promise<ConversationLog | null> {
		return this.get<ConversationLog | null>(`/api/conversations/${encodeURIComponent(id)}`);
	}

	markConversationRead(id: string): Promise<{ ok: true }> {
		return this.post<{ ok: true }>(`/api/conversations/${encodeURIComponent(id)}/mark-read`, {});
	}

	listPending(): Promise<TapPendingRequest[]> {
		return this.get<TapPendingRequest[]>("/api/pending");
	}

	approvePending(id: string, note?: string): Promise<{ resolved: true }> {
		return this.post<{ resolved: true }>(
			`/api/pending/${encodeURIComponent(id)}/approve`,
			note ? { note } : {},
		);
	}

	denyPending(id: string, reason?: string): Promise<{ resolved: true }> {
		return this.post<{ resolved: true }>(
			`/api/pending/${encodeURIComponent(id)}/deny`,
			reason ? { reason } : {},
		);
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	sendMessage(input: {
		peer: string;
		text: string;
		scope?: string;
		priority?: boolean;
	}): Promise<TapSendMessageResult> {
		return this.post<TapSendMessageResult>("/api/messages", input);
	}

	connect(input: { inviteUrl: string; waitMs?: number }): Promise<TapConnectResult> {
		return this.post<TapConnectResult>("/api/connect", input);
	}

	transfer(input: TransferRequestBody): Promise<TransferResultBody> {
		return this.post<TransferResultBody>("/api/transfers", input);
	}

	postageTopup(input: {
		peer: string;
		amount: string;
		waitMs?: number;
	}): Promise<TapPostageTopupResult> {
		return this.post<TapPostageTopupResult>("/api/postage/topup", input);
	}

	createInvite(input: CreateInviteRequestBody = {}): Promise<CreateInviteResultBody> {
		return this.post<CreateInviteResultBody>("/api/invites", input);
	}

	requestFunds(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return this.post<TapRequestFundsResult>("/api/funds-requests", input);
	}

	requestMeeting(input: RequestMeetingBody): Promise<TapRequestMeetingResult> {
		return this.post<TapRequestMeetingResult>("/api/meetings", input);
	}

	respondMeeting(
		schedulingId: string,
		input: { approve: boolean; reason?: string },
	): Promise<{
		resolved: true;
		schedulingId: string;
		requestId: string;
		approve: boolean;
		report: TapSyncReport;
	}> {
		return this.post(`/api/meetings/${encodeURIComponent(schedulingId)}/respond`, input);
	}

	cancelMeeting(schedulingId: string, reason?: string): Promise<TapCancelMeetingResult> {
		return this.post<TapCancelMeetingResult>(
			`/api/meetings/${encodeURIComponent(schedulingId)}/cancel`,
			reason ? { reason } : {},
		);
	}

	publishGrants(input: {
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}): Promise<TapPublishGrantSetResult> {
		return this.post<TapPublishGrantSetResult>("/api/grants/publish", input);
	}

	requestGrants(input: {
		peer: string;
		grantSet: PermissionGrantSet;
		note?: string;
	}): Promise<TapRequestGrantSetResult> {
		return this.post<TapRequestGrantSetResult>("/api/grants/request", input);
	}

	revokeContact(
		connectionId: string,
		reason?: string,
	): Promise<{ revoked: true; connectionId: string; peer: string }> {
		return this.post(
			`/api/contacts/${encodeURIComponent(connectionId)}/revoke`,
			reason ? { reason } : {},
		);
	}

	// ── Daemon control ──────────────────────────────────────────────────────

	health(): Promise<DaemonHealth> {
		return this.get<DaemonHealth>("/daemon/health");
	}

	triggerSync(): Promise<{ ok: true; report?: TapSyncReport }> {
		return this.post<{ ok: true; report?: TapSyncReport }>("/daemon/sync", {});
	}

	shutdown(): Promise<{ ok: true }> {
		return this.post<{ ok: true }>("/daemon/shutdown", {});
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private get<T>(path: string): Promise<T> {
		return this.requestOnce<T>("GET", path);
	}

	private post<T>(path: string, body: unknown): Promise<T> {
		return this.requestOnce<T>("POST", path, body);
	}

	private requestOnce<T>(method: string, path: string, body?: unknown): Promise<T> {
		return tapdHttpRequest<T>(this.info, method, path, body);
	}
}

function tapdHttpRequest<T>(
	info: TapdConnectionInfo,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const payload = body !== undefined ? JSON.stringify(body) : undefined;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${info.token}`,
			Accept: "application/json",
		};
		if (payload !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = String(Buffer.byteLength(payload));
		}
		const req = request({ socketPath: info.socketPath, method, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk as Buffer));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf-8");
				const status = res.statusCode ?? 0;
				if (status >= 400) {
					reject(buildErrorFromBody(text, status));
					return;
				}
				let parsed: unknown;
				try {
					parsed = text ? JSON.parse(text) : undefined;
				} catch {
					parsed = undefined;
				}
				resolve(parsed as T);
			});
			res.on("error", reject);
		});
		req.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
				reject(new TapdNotRunningError());
			} else {
				reject(err);
			}
		});
		if (payload !== undefined) {
			req.write(payload);
		}
		req.end();
	});
}

function buildErrorFromBody(text: string, status: number): TapdClientError {
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = undefined;
	}
	const errPayload = (
		body as
			| { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
			| undefined
	)?.error;
	return new TapdClientError(
		errPayload?.code ?? "unknown_error",
		errPayload?.message ?? `tapd returned HTTP ${status}`,
		status,
		errPayload?.details,
	);
}
