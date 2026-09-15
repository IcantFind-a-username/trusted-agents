import { mkdir, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, extname } from "node:path";
import {
	ATTENTION_PAYMENT_REQUIRED_CODE,
	AttentionPaymentRequiredError,
	TransportRpcError,
	toErrorMessage,
} from "trusted-agents-core";
import { authorizeRequest } from "./auth.js";
import { HttpError } from "./errors.js";
import { sendError, sendJson, sendNotFound, sendUnauthorized } from "./response.js";
import type { Router } from "./router.js";
import { resolveStaticAsset } from "./static-assets.js";

export interface TapdHttpServerOptions {
	router: Router;
	socketPath: string;
	tcpHost: string;
	tcpPort: number;
	authToken: string;
	/** Optional hook for SSE upgrade — see Task 14. Returns true if handled. */
	sseHandler?: (req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp") => boolean;
	/**
	 * Directory containing the bundled UI's static export. When set, GET
	 * requests for non-API paths attempt to serve files from here before
	 * falling through to the route dispatcher.
	 */
	staticAssetsDir?: string;
}

interface BoundServer {
	server: Server;
	transport: "unix" | "tcp";
}

export class TapdHttpServer {
	private readonly router: Router;
	private readonly socketPath: string;
	private readonly tcpHost: string;
	private readonly tcpPort: number;
	private readonly authToken: string;
	private readonly sseHandler?: TapdHttpServerOptions["sseHandler"];
	private readonly staticAssetsDir?: string;

	private bound: BoundServer[] = [];
	private actualTcpPort = 0;

	constructor(options: TapdHttpServerOptions) {
		this.router = options.router;
		this.socketPath = options.socketPath;
		this.tcpHost = options.tcpHost;
		this.tcpPort = options.tcpPort;
		this.authToken = options.authToken;
		this.sseHandler = options.sseHandler;
		this.staticAssetsDir = options.staticAssetsDir;
	}

	async start(): Promise<void> {
		await this.bindUnix();
		await this.bindTcp();
	}

	async stop(): Promise<void> {
		await Promise.all(
			this.bound.map(
				({ server }) =>
					new Promise<void>((resolve) => {
						// Force-close any in-flight connections (e.g., long-lived SSE
						// streams) so server.close() can resolve. Without this, an open
						// SSE connection holds the server open forever.
						server.closeAllConnections?.();
						server.close(() => resolve());
					}),
			),
		);
		this.bound = [];
		await rm(this.socketPath, { force: true }).catch(() => {});
	}

	boundTcpPort(): number {
		return this.actualTcpPort;
	}

	private async bindUnix(): Promise<void> {
		await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		await rm(this.socketPath, { force: true }).catch(() => {});

		const server = createServer((req, res) => this.handle(req, res, "unix"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "unix" });
	}

	private async bindTcp(): Promise<void> {
		const server = createServer((req, res) => this.handle(req, res, "tcp"));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.tcpPort, this.tcpHost, () => {
				const address = server.address();
				if (address && typeof address === "object") {
					this.actualTcpPort = address.port;
				}
				server.off("error", reject);
				resolve();
			});
		});
		this.bound.push({ server, transport: "tcp" });
	}

	private handle(req: IncomingMessage, res: ServerResponse, transport: "unix" | "tcp"): void {
		void this.handleAsync(req, res, transport).catch((error) => {
			// Client-caused errors (malformed JSON, payload too large, invalid
			// route params) arrive as HttpError so we can surface the intended
			// 4xx status. Unknown exceptions fall through to 500 — those are
			// bugs, not user input, and clients shouldn't auto-retry them.
			if (error instanceof HttpError) {
				sendError(res, error.status, error.code, error.message);
				return;
			}
			// Attention rejections carry a machine-readable quote; surface it
			// as a structured 402 whether the rejection happened in-process
			// (this daemon enforcing) or came back from a remote peer over the
			// transport as JSON-RPC -32050.
			if (error instanceof AttentionPaymentRequiredError) {
				sendError(res, 402, "attention_payment_required", error.message, {
					attention: error.quote,
					...(error.postage ? { postage: error.postage } : {}),
				});
				return;
			}
			if (error instanceof TransportRpcError && error.rpcCode === ATTENTION_PAYMENT_REQUIRED_CODE) {
				sendError(
					res,
					402,
					"attention_payment_required",
					error.message,
					typeof error.rpcData === "object" && error.rpcData !== null
						? (error.rpcData as Record<string, unknown>)
						: undefined,
				);
				return;
			}
			sendError(res, 500, "internal_error", toErrorMessage(error));
		});
	}

	private async handleAsync(
		req: IncomingMessage,
		res: ServerResponse,
		transport: "unix" | "tcp",
	): Promise<void> {
		const method = req.method ?? "GET";
		const rawUrl = req.url ?? "/";
		const requestPath = rawUrl.split("?")[0];
		const isApiPath = requestPath.startsWith("/api/") || requestPath.startsWith("/daemon/");

		// Static assets (the bundled UI bundle) are served unauthenticated. The
		// JS bundle itself contains no secrets — the bearer token is supplied
		// by the user's own URL hash and never embedded in the build. Letting
		// the HTML/JS load without auth is the only way the in-page React app
		// can then read the token and start making authenticated API calls.
		if (
			method === "GET" &&
			!isApiPath &&
			this.staticAssetsDir &&
			(await this.tryServeStatic(requestPath, res))
		) {
			return;
		}

		if (
			!authorizeRequest(req, {
				transport,
				expectedToken: this.authToken,
				method,
				requestPath,
			})
		) {
			sendUnauthorized(res);
			return;
		}

		if (this.sseHandler?.(req, res, transport)) {
			return;
		}

		let body: unknown;
		if (method !== "GET" && method !== "HEAD") {
			body = await readJsonBody(req);
		}

		const result = await this.router.dispatch(method, requestPath, body);
		if (result === null) {
			sendNotFound(res);
			return;
		}
		sendJson(res, 200, result);
	}

	private async tryServeStatic(requestPath: string, res: ServerResponse): Promise<boolean> {
		if (!this.staticAssetsDir) return false;

		const asset =
			(await resolveStaticAsset(this.staticAssetsDir, requestPath)) ??
			// SPA fallback: serve index.html for client-routed paths so the React
			// app can resolve its own routes. Skip paths with file extensions
			// (those are real misses for fonts, images, etc.) so 404s on missing
			// assets remain honest.
			(!extname(requestPath) ? await resolveStaticAsset(this.staticAssetsDir, "/") : null);

		if (!asset) return false;
		res.writeHead(200, {
			"Content-Type": asset.contentType,
			"Content-Length": asset.body.length,
			"Cache-Control": "no-store",
		});
		res.end(asset.body);
		return true;
	}
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk: string) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				req.destroy();
				reject(new HttpError(413, "payload_too_large", "request body too large"));
			}
		});
		req.on("end", () => {
			if (raw.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new HttpError(400, "invalid_json", "invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
