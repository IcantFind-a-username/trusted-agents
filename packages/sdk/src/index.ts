// ── SDK runtime ──
export {
	TapRuntime,
	createTapRuntime,
	type CreateTapRuntimeOptions,
	type SigningProviderLike,
} from "./runtime.js";

// ── App interface types (from core) ──
export {
	defineTapApp,
	type TapApp,
	type TapActionContext,
	type TapActionResult,
	type TapActionHandler,
	type TapAppStorage,
	type TapAppEvent,
	type ReadonlyContact,
	type PaymentRequestParams,
	type TransferExecuteParams,
} from "trusted-agents-core";

// ── Seam interfaces (from core) ──
export type {
	TransportProvider,
	IAgentResolver,
	ITrustStore,
	IConversationLogger,
	IRequestJournal,
	PermissionGrant,
} from "trusted-agents-core";

// ── Service + messaging types (from core) ──
export { TapMessagingService } from "trusted-agents-core";
export type {
	TapConnectResult,
	TapSendMessageResult,
	TapPublishGrantSetResult,
	TapRequestGrantSetResult,
	TapRequestFundsInput,
	TapRequestFundsResult,
	TapPostageTopupInput,
	TapPostageTopupResult,
	TapRequestMeetingInput,
	TapRequestMeetingResult,
	TapCancelMeetingResult,
	TapSyncReport,
	TapServiceStatus,
	TapPendingRequest,
	TapServiceHooks,
	TapServiceOptions,
	TapTransferApprovalContext,
	TapPendingRequestDetails,
	TapPendingSchedulingDetails,
	TapPendingTransferDetails,
	RegisteredAppInfo,
	PermissionGrantSet,
} from "trusted-agents-core";

// ── Scheduling (from core) ──
export { SchedulingHandler } from "trusted-agents-core";
export type {
	SchedulingHooks,
	SchedulingApprovalContext,
	SchedulingDecision,
	ProposedMeeting,
	ConfirmedMeeting,
	SchedulingProposal,
	TimeSlot,
	ICalendarProvider,
	AvailabilityWindow,
	CalendarEvent,
} from "trusted-agents-core";

// ── Config (from core) ──
export { loadTrustedAgentConfigFromDataDir } from "trusted-agents-core";
export type {
	TrustedAgentsConfig,
	LoadTrustedAgentConfigOptions,
	ChainConfig,
} from "trusted-agents-core";

// ── Trust / contacts (from core) ──
export { FileTrustStore } from "trusted-agents-core";
export type {
	Contact,
	ConnectionStatus,
	ContactPermissionState,
} from "trusted-agents-core";

// ── Conversation (from core) ──
export {
	FileConversationLogger,
	SqliteConversationLogger,
	generateMarkdownTranscript,
	migrateFileLogsToSqlite,
} from "trusted-agents-core";
export type {
	ConversationMessage,
	ConversationLog,
	MigrationReport,
} from "trusted-agents-core";

// ── Request journal (from core) ──
export { FileRequestJournal } from "trusted-agents-core";
export type { RequestJournalEntry } from "trusted-agents-core";

// ── Transport (from core) ──
export { XmtpTransport } from "trusted-agents-core";
export type {
	XmtpTransportConfig,
	TransportReceipt,
} from "trusted-agents-core";

// ── Signing (from core) ──
export { OwsSigningProvider } from "trusted-agents-core";
export type { SigningProvider } from "trusted-agents-core";

// ── Runtime context (from core) ──
export { buildDefaultTapRuntimeContext } from "trusted-agents-core";
export type {
	BuildTapRuntimeContextOptions,
	TapRuntimeContext,
} from "trusted-agents-core";

// ── Permissions (from core) ──
export type { PermissionGrantStatus } from "trusted-agents-core";
