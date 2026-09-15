import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	FileAttentionLedger,
	type ICalendarProvider,
	type IConversationLogger,
	type ITrustStore,
	type TapMessagingService,
	toErrorMessage,
} from "trusted-agents-core";
import { generateAuthToken, persistAuthToken } from "./auth-token.js";
import { TAPD_PORT_FILE, TAPD_TOKEN_FILE, type TapdConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { Router } from "./http/router.js";
import { createConnectRoute } from "./http/routes/connect.js";
import { createContactsWriteRoutes } from "./http/routes/contacts-write.js";
import { createContactsRoutes } from "./http/routes/contacts.js";
import { createConversationsRoutes } from "./http/routes/conversations.js";
import {
	type DaemonControlOptions,
	createDaemonControlRoutes,
} from "./http/routes/daemon-control.js";
import { createFundsRequestsRoute } from "./http/routes/funds-requests.js";
import { createGrantsRoutes } from "./http/routes/grants.js";
import { type IdentitySource, createIdentityRoute } from "./http/routes/identity.js";
import { type InviteCreator, createInvitesRoute } from "./http/routes/invites.js";
import { createMeetingsRoutes } from "./http/routes/meetings.js";
import { createMessagesRoute } from "./http/routes/messages.js";
import { createNotificationsRoute } from "./http/routes/notifications.js";
import { createPendingRoutes } from "./http/routes/pending.js";
import { createPostageRoutes } from "./http/routes/postage.js";
import { type TransferExecutor, createTransfersRoute } from "./http/routes/transfers.js";
import { TapdHttpServer } from "./http/server.js";
import { handleSseConnection } from "./http/sse.js";
import { classifyEventToNotification } from "./notification-classifier.js";
import { NotificationQueue } from "./notification-queue.js";
import { TapdRuntime } from "./runtime.js";

export const TAPD_VERSION = "0.2.0-beta.7";

export interface DaemonOptions {
	config: TapdConfig;
	identityAgentId: number;
	identitySource: IdentitySource;
	/** Factory that returns the service the daemon should own. */
	buildService: () => Promise<TapMessagingService>;
	trustStore: ITrustStore;
	conversationLogger: IConversationLogger;
	/**
	 * On-chain transfer executor invoked by `POST /api/transfers`. The host is
	 * responsible for wiring this to the OWS signing provider + the chain
	 * configs the daemon was started with. When omitted the route returns 500.
	 */
	executeTransfer?: TransferExecutor;
	/**
	 * Creates a signed TAP invite URL. Wired by the host to `generateInvite`
	 * from core using the daemon's signing provider. When omitted the
	 * `POST /api/invites` route returns 500.
	 */
	createInvite?: InviteCreator;
	/**
	 * Directory containing the bundled UI's static export. When set, tapd
	 * serves the UI at `/` and at any non-API GET path.
	 */
	staticAssetsDir?: string;
	/**
	 * Optional calendar provider used by `/api/meetings` when a client
	 * posts the flat shape with a `preferred` time but no explicit
	 * `slots`. Currently unused by `packages/tapd/src/bin.ts` (passes
	 * null) — the CLI command still resolves its own provider from
	 * `<dataDir>/config.yaml` via `resolveConfiguredCalendarProvider`. A
	 * shared calendar resolver in core is a follow-up.
	 */
	calendarProvider?: ICalendarProvider | null;
}

export class Daemon {
	private readonly options: DaemonOptions;
	private readonly bus: EventBus;
	private readonly notifications: NotificationQueue;
	private readonly attentionLedger: FileAttentionLedger;
	private runtime: TapdRuntime | null = null;
	private server: TapdHttpServer | null = null;
	private token = "";
	private startedAt = 0;
	private shuttingDown = false;
	private signalHandlersInstalled = false;
	private shutdownResolve: (() => void) | null = null;
	private boundSignalHandler: (() => void) | null = null;
	private notificationUnsubscribe: (() => void) | null = null;

	constructor(options: DaemonOptions) {
		this.options = options;
		this.bus = new EventBus({ ringBufferSize: options.config.ringBufferSize });
		this.notifications = new NotificationQueue();
		this.attentionLedger = new FileAttentionLedger(options.config.dataDir);
	}

	async start(): Promise<void> {
		if (this.runtime) return;

		this.startedAt = Date.now();
		this.token = generateAuthToken();
		await persistAuthToken(this.options.config.dataDir, this.token);

		// Bus → NotificationQueue. Host plugins (Hermes, OpenClaw) drain the
		// queue on their pre-prompt hook; this is what keeps their context
		// notifications non-empty. Installed in start() (not the constructor)
		// so tests can wire alternate classifiers if needed, but the default
		// daemon always has the canonical producer hooked up.
		this.notificationUnsubscribe = this.bus.subscribe((event) => {
			const notification = classifyEventToNotification(event);
			if (notification) {
				this.notifications.enqueue(notification);
			}
		});

		const service = await this.options.buildService();
		this.runtime = new TapdRuntime({
			service,
			identityAgentId: this.options.identityAgentId,
			bus: this.bus,
		});
		await this.runtime.start();

		// Everything after runtime.start() must be unwound on failure. The
		// runtime holds the transport owner lock, so if any later step throws
		// (HTTP bind failure, port-file write failure, etc.) we MUST stop the
		// runtime before propagating the error. Otherwise the lock stays held,
		// the transport stays up, there is no reachable control plane, and
		// every operator retry hits the owner lock (finding F1.1).
		try {
			const router = this.buildRouter(service);
			this.server = new TapdHttpServer({
				router,
				socketPath: this.options.config.socketPath,
				tcpHost: this.options.config.tcpHost,
				tcpPort: this.options.config.tcpPort,
				authToken: this.token,
				staticAssetsDir: this.options.staticAssetsDir,
				sseHandler: (req, res, _transport) => {
					if (req.method !== "GET") return false;
					const url = req.url ?? "";
					const path = url.split("?")[0];
					if (path !== "/api/events/stream") return false;
					handleSseConnection(req, res, this.bus);
					return true;
				},
			});
			await this.server.start();

			// Publish the bound TCP port so clients (CLI `tap ui`, the Playwright
			// fixture) can discover where to reach us without parsing stdout.
			const boundPort = this.server.boundTcpPort();
			if (boundPort > 0) {
				await writeFile(join(this.options.config.dataDir, TAPD_PORT_FILE), String(boundPort), {
					encoding: "utf-8",
					mode: 0o600,
				});
			}
		} catch (error) {
			await this.releaseResources();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		await this.releaseResources();
		this.removeSignalHandlers();
		if (this.shutdownResolve) {
			const resolve = this.shutdownResolve;
			this.shutdownResolve = null;
			resolve();
		}
	}

	private async releaseResources(): Promise<void> {
		if (this.server) {
			try {
				await this.server.stop();
			} catch {
				// Best effort — the caller's error (or the shutdown itself) takes priority.
			}
			this.server = null;
		}
		if (this.runtime) {
			try {
				await this.runtime.stop();
			} catch {
				// Best effort.
			}
			this.runtime = null;
		}
		if (this.notificationUnsubscribe) {
			this.notificationUnsubscribe();
			this.notificationUnsubscribe = null;
		}
		await Promise.all([
			rm(join(this.options.config.dataDir, TAPD_PORT_FILE), { force: true }).catch(() => {}),
			rm(join(this.options.config.dataDir, TAPD_TOKEN_FILE), { force: true }).catch(() => {}),
		]);
	}

	authToken(): string {
		return this.token;
	}

	/**
	 * Internal accessor exposed for lifecycle/unwind tests. Not intended for
	 * production callers — the event bus is otherwise an internal fan-out
	 * point between the runtime and the HTTP/SSE layer.
	 */
	eventBus(): EventBus {
		return this.bus;
	}

	boundTcpPort(): number {
		return this.server?.boundTcpPort() ?? 0;
	}

	async runUntilSignal(): Promise<void> {
		await this.start();
		this.installSignalHandlers();
		await new Promise<void>((resolve) => {
			this.shutdownResolve = resolve;
		});
	}

	private installSignalHandlers(): void {
		if (this.signalHandlersInstalled) return;
		this.signalHandlersInstalled = true;
		this.boundSignalHandler = () => {
			void this.stop();
		};
		process.on("SIGINT", this.boundSignalHandler);
		process.on("SIGTERM", this.boundSignalHandler);
	}

	private removeSignalHandlers(): void {
		if (!this.signalHandlersInstalled) return;
		if (this.boundSignalHandler) {
			process.off("SIGINT", this.boundSignalHandler);
			process.off("SIGTERM", this.boundSignalHandler);
			this.boundSignalHandler = null;
		}
		this.signalHandlersInstalled = false;
	}

	// `service` is the live TapMessagingService just started by the runtime.
	// Passing it directly (rather than going through a Proxy) keeps route
	// handlers strongly typed against `TapMessagingService` and lets `tsc`
	// catch renames at compile time. The daemon never restarts the runtime
	// in-place — `releaseResources` tears both runtime and server down
	// together — so there is no need for lazy resolution here.
	private buildRouter(service: TapMessagingService): Router {
		const router = new Router();

		const identityRoute = createIdentityRoute(this.options.identitySource);
		router.add("GET", "/api/identity", identityRoute);

		const contacts = createContactsRoutes(this.options.trustStore);
		router.add("GET", "/api/contacts", contacts.list);
		router.add("GET", "/api/contacts/:connectionId", contacts.get);

		const conversations = createConversationsRoutes(this.options.conversationLogger);
		router.add("GET", "/api/conversations", conversations.list);
		router.add("GET", "/api/conversations/:id", conversations.get);
		router.add("POST", "/api/conversations/:id/mark-read", conversations.markRead);

		const pending = createPendingRoutes(service);
		router.add("GET", "/api/pending", pending.list);
		router.add("POST", "/api/pending/:id/approve", pending.approve);
		router.add("POST", "/api/pending/:id/deny", pending.deny);

		router.add("POST", "/api/messages", createMessagesRoute(service));
		router.add("POST", "/api/connect", createConnectRoute(service));
		router.add("POST", "/api/funds-requests", createFundsRequestsRoute(service));

		const postage = createPostageRoutes(service);
		router.add("POST", "/api/postage/topup", postage.topup);

		const meetings = createMeetingsRoutes(service, {
			calendarProvider: this.options.calendarProvider ?? null,
		});
		router.add("POST", "/api/meetings", meetings.request);
		router.add("POST", "/api/meetings/:id/respond", meetings.respond);
		router.add("POST", "/api/meetings/:id/cancel", meetings.cancel);

		const grants = createGrantsRoutes(service);
		router.add("POST", "/api/grants/publish", grants.publish);
		router.add("POST", "/api/grants/request", grants.request);

		const contactsWrite = createContactsWriteRoutes(service, this.options.trustStore);
		router.add("POST", "/api/contacts/:connectionId/revoke", contactsWrite.revoke);

		function notWired(name: string): never {
			throw new Error(`${name} is not wired: pass ${name} when constructing the daemon`);
		}

		const executeTransfer: TransferExecutor =
			this.options.executeTransfer ?? (() => notWired("executeTransfer"));
		router.add("POST", "/api/transfers", createTransfersRoute(executeTransfer));

		const createInvite: InviteCreator =
			this.options.createInvite ?? (() => notWired("createInvite"));
		router.add("POST", "/api/invites", createInvitesRoute(createInvite));

		const notifications = createNotificationsRoute(this.notifications, {
			ledger: this.attentionLedger,
			identity: () => {
				const identity = this.options.identitySource();
				return { chain: identity.chain, agentId: identity.agentId };
			},
			// Grants (weekly notification quotas) are looked up per drained
			// peer so over-quota chatter folds before it reaches any host.
			trustStore: this.options.trustStore,
			onLedgerError: (error) => {
				console.warn(`tapd: attention ledger accounting failed: ${toErrorMessage(error)}`);
			},
		});
		router.add("GET", "/api/notifications/drain", notifications);

		const controlOptions: DaemonControlOptions = {
			version: TAPD_VERSION,
			startedAt: this.startedAt,
			isTransportConnected: () => this.runtime !== null,
			lastSyncAt: () => undefined,
			triggerSync: async () => await service.syncOnce(),
			requestShutdown: () => {
				void this.stop();
			},
		};
		const control = createDaemonControlRoutes(controlOptions);
		router.add("GET", "/daemon/health", control.health);
		router.add("POST", "/daemon/sync", control.sync);
		router.add("POST", "/daemon/shutdown", control.shutdown);

		return router;
	}
}
