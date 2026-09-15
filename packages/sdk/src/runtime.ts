import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type AppManifestEntry,
	type BuildTapRuntimeContextOptions,
	type IAgentResolver,
	type IRequestJournal,
	type ITrustStore,
	type LoadTrustedAgentConfigOptions,
	OwsSigningProvider,
	type PermissionGrantSet,
	type RegisteredAppInfo,
	type SchedulingHandler,
	type SigningProvider,
	type TapCancelMeetingResult,
	type TapConnectResult,
	TapMessagingService,
	type TapPendingRequest,
	type TapPostageTopupInput,
	type TapPostageTopupResult,
	type TapPublishGrantSetResult,
	type TapRequestFundsInput,
	type TapRequestFundsResult,
	type TapRequestGrantSetResult,
	type TapRequestMeetingInput,
	type TapRequestMeetingResult,
	type TapRuntimeContext,
	type TapSendMessageResult,
	type TapServiceHooks,
	type TapServiceStatus,
	type TapSyncReport,
	type TrustedAgentsConfig,
	addAppToManifest,
	buildDefaultTapRuntimeContext,
	loadTrustedAgentConfigFromDataDir,
	removeAppFromManifest,
} from "trusted-agents-core";

const DEFAULT_DATA_DIR = "~/.trustedagents";

export interface CreateTapRuntimeOptions {
	/** Path to the agent data directory. Defaults to ~/.trustedagents */
	dataDir?: string;

	/** Preloaded config to use instead of re-reading from disk. */
	preloadedConfig?: TrustedAgentsConfig;

	/** Override options for config loading */
	configOptions?: LoadTrustedAgentConfigOptions;

	/** Override options for runtime context building (transport, stores, etc.) */
	contextOptions?: Omit<BuildTapRuntimeContextOptions, "signingProvider">;

	/** Service hooks (approval handlers, event emitter, logging, etc.) */
	hooks?: TapServiceHooks;

	/** Label identifying this runtime owner (for transport lock) */
	ownerLabel?: string;

	/** Scheduling handler for calendar integration and scheduling approval hooks */
	schedulingHandler?: SchedulingHandler;

	/** Factory for creating a SigningProvider. Called during init() with loaded config. */
	createSigningProvider?: (config: TrustedAgentsConfig) => Promise<SigningProviderLike>;
}

/**
 * Minimal signing provider shape the SDK accepts.
 * Compatible with both OwsSigningProvider and custom implementations.
 */
export interface SigningProviderLike {
	getAddress(): Promise<`0x${string}`>;
	signMessage(message: unknown): Promise<`0x${string}`>;
	signTypedData(params: unknown): Promise<`0x${string}`>;
	signTransaction(tx: unknown): Promise<`0x${string}`>;
	signAuthorization(params: unknown): Promise<unknown>;
}

/**
 * TapRuntime is the public SDK entry point for all TAP hosts.
 *
 * It wraps TapMessagingService and provides a simplified, event-driven API
 * for building on the Trusted Agents Protocol.
 *
 * Usage:
 * ```ts
 * const runtime = await createTapRuntime({ dataDir: "~/.myagent" });
 * await runtime.start();
 * runtime.on("event", (payload) => console.log(payload));
 * ```
 */
export class TapRuntime extends EventEmitter {
	private readonly options: CreateTapRuntimeOptions;
	private _config: TrustedAgentsConfig | undefined;
	private context: TapRuntimeContext | undefined;
	private _service: TapMessagingService | undefined;
	private initialized = false;

	constructor(options: CreateTapRuntimeOptions) {
		super();
		this.options = options;
	}

	/**
	 * Initialize the runtime: load config, create signing provider,
	 * build runtime context, and create the messaging service.
	 *
	 * Called automatically by `createTapRuntime`. Can also be called
	 * manually if constructing via `new TapRuntime()`.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		const dataDir = this.options.dataDir ?? DEFAULT_DATA_DIR;

		this._config =
			this.options.preloadedConfig ??
			(await loadTrustedAgentConfigFromDataDir(dataDir, this.options.configOptions ?? {}));

		let signingProvider: SigningProviderLike;
		if (this.options.createSigningProvider) {
			signingProvider = await this.options.createSigningProvider(this._config);
		} else {
			signingProvider = new OwsSigningProvider(
				this._config.ows.wallet,
				this._config.chain,
				this._config.ows.apiKey,
			);
		}

		const contextOptions: BuildTapRuntimeContextOptions = {
			// biome-ignore lint/suspicious/noExplicitAny: SigningProviderLike is compatible with SigningProvider
			signingProvider: signingProvider as any,
			...this.options.contextOptions,
		};
		this.context = await buildDefaultTapRuntimeContext(this._config, contextOptions);

		// Wire up event emission through hooks
		const userHooks = this.options.hooks ?? {};
		const hooks: TapServiceHooks = {
			...userHooks,
			emitEvent: (payload) => {
				this.emit("event", payload);
				userHooks.emitEvent?.(payload);
			},
			log: (level, message) => {
				this.emit("log", { level, message });
				userHooks.log?.(level, message);
			},
		};

		// Create the messaging service
		this._service = new TapMessagingService(this.context, {
			hooks,
			ownerLabel: this.options.ownerLabel,
			schedulingHandler: this.options.schedulingHandler,
		});

		this.initialized = true;
	}

	/**
	 * Advanced escape hatch: access the underlying TapMessagingService directly.
	 *
	 * Use this when you need service methods not yet wrapped by the SDK.
	 * Requires the runtime to be initialized (call start() first).
	 */
	get service(): TapMessagingService {
		return this.requireService();
	}

	/** Access the trust store for contact lookups. Requires start() first. */
	get trustStore(): ITrustStore {
		return this.requireContext().trustStore;
	}

	/** Access the agent resolver. Requires start() first. */
	get resolver(): IAgentResolver {
		return this.requireContext().resolver;
	}

	/** Access the signing provider. Requires start() first. */
	get signingProvider(): SigningProvider {
		return this.requireContext().signingProvider;
	}

	/** Access the request journal. Requires start() first. */
	get requestJournal(): IRequestJournal {
		return this.requireContext().requestJournal;
	}

	/** Access the loaded TAP config. Requires init() first. */
	get config(): TrustedAgentsConfig {
		if (!this._config) {
			throw new Error("Runtime not initialized. Call start() first.");
		}
		return this._config;
	}

	private requireService(): TapMessagingService {
		if (!this._service) {
			throw new Error("Runtime not initialized. Call start() first.");
		}
		return this._service;
	}

	private requireContext(): TapRuntimeContext {
		if (!this.context) {
			throw new Error("Runtime not initialized. Call start() first.");
		}
		return this.context;
	}

	// ── Lifecycle ──

	async start(): Promise<void> {
		await this.init();
		await this.requireService().start();
	}

	async stop(): Promise<void> {
		await this.requireService().stop();
	}

	// ── Sync ──

	async syncOnce(): Promise<TapSyncReport> {
		return await this.requireService().syncOnce();
	}

	// ── Connection ──

	async connect(params: { inviteUrl: string }): Promise<TapConnectResult> {
		return await this.requireService().connect(params);
	}

	// ── Messaging ──

	async sendMessage(peerId: number, text: string): Promise<TapSendMessageResult> {
		return await this.requireService().sendMessage(String(peerId), text);
	}

	async sendAction(
		peerId: number,
		actionType: string,
		payload: Record<string, unknown>,
		text?: string,
	): Promise<TapSendMessageResult> {
		return await this.requireService().sendActionRequest(
			{ agentId: peerId },
			actionType,
			payload,
			text,
		);
	}

	// ── Funds ──

	async requestFunds(input: TapRequestFundsInput): Promise<TapRequestFundsResult> {
		return await this.requireService().requestFunds(input);
	}

	// ── Postage ──

	async topUpPostage(peerId: number, input: TapPostageTopupInput): Promise<TapPostageTopupResult> {
		return await this.requireService().topUpPostage(String(peerId), input);
	}

	// ── Scheduling ──

	async requestMeeting(input: TapRequestMeetingInput): Promise<TapRequestMeetingResult> {
		return await this.requireService().requestMeeting(input);
	}

	async cancelMeeting(schedulingId: string, reason?: string): Promise<TapCancelMeetingResult> {
		return await this.requireService().cancelMeeting(schedulingId, reason);
	}

	async cancelPendingSchedulingRequest(requestId: string, reason?: string): Promise<TapSyncReport> {
		return await this.requireService().cancelPendingSchedulingRequest(requestId, reason);
	}

	// ── Outbox ──

	async processOutboxOnce(): Promise<number> {
		return await this.requireService().processOutboxOnce();
	}

	// ── Grants ──

	async publishGrants(
		peerId: number,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapPublishGrantSetResult> {
		return await this.requireService().publishGrantSet(String(peerId), grantSet, note);
	}

	async requestGrants(
		peerId: number,
		grantSet: PermissionGrantSet,
		note?: string,
	): Promise<TapRequestGrantSetResult> {
		return await this.requireService().requestGrantSet(String(peerId), grantSet, note);
	}

	// ── Status & Pending ──

	async getStatus(): Promise<TapServiceStatus> {
		return await this.requireService().getStatus();
	}

	async listPendingRequests(): Promise<TapPendingRequest[]> {
		return await this.requireService().listPendingRequests();
	}

	async resolvePending(
		requestId: string,
		approve: boolean,
		reason?: string,
	): Promise<TapSyncReport> {
		return await this.requireService().resolvePending(requestId, approve, reason);
	}

	// ── App Management ──

	async installApp(packageName: string): Promise<void> {
		const ctx = this.requireContext();

		// Resolve the package entry point
		let entryPoint: string;
		try {
			entryPoint = import.meta.resolve(packageName);
		} catch {
			// Fallback: use the package name directly as path
			entryPoint = packageName;
		}

		// Load the module to validate it's a valid TapApp
		const mod = await import(entryPoint);
		const app = mod.default ?? mod.app ?? mod;
		if (!app.id || !app.actions || typeof app.actions !== "object") {
			throw new Error(
				`Package "${packageName}" does not export a valid TapApp (missing id or actions)`,
			);
		}

		// Register in the live registry first — if this throws (e.g., action
		// type conflict), we avoid leaving a ghost entry in the manifest.
		ctx.appRegistry.registerApp(app);

		// Persist to manifest only after successful registration
		const entry: AppManifestEntry = {
			package: packageName,
			entryPoint,
			installedAt: new Date().toISOString(),
			status: "active",
		};
		await addAppToManifest(ctx.config.dataDir, app.id, entry);
	}

	private static readonly BUILTIN_APP_IDS = new Set([
		"postage",
		"tap-transfer",
		"scheduling",
		"tap-permissions",
	]);

	async removeApp(appId: string, options?: { removeState?: boolean }): Promise<void> {
		if (TapRuntime.BUILTIN_APP_IDS.has(appId)) {
			throw new Error(`Cannot remove built-in app "${appId}"`);
		}
		const ctx = this.requireContext();

		// Unregister from live registry
		ctx.appRegistry.unregisterApp(appId);

		// Remove from manifest
		await removeAppFromManifest(ctx.config.dataDir, appId);

		// Optionally remove app state directory
		if (options?.removeState) {
			const stateDir = join(ctx.config.dataDir, "apps", appId);
			await rm(stateDir, { recursive: true, force: true });
		}
	}

	listApps(): RegisteredAppInfo[] {
		if (!this.context) {
			return [];
		}
		return this.context.appRegistry.listApps();
	}
}

/**
 * Creates a new TapRuntime instance.
 *
 * The runtime is lazily initialized -- config is loaded and the signing provider
 * is created on the first call to `start()` or `init()`.
 */
export async function createTapRuntime(options: CreateTapRuntimeOptions): Promise<TapRuntime> {
	const runtime = new TapRuntime(options);
	return runtime;
}
