export const PHASES = {
	PREFLIGHT: 0,
	ONBOARDING: 1,
	CONNECTION: 2,
	PERMISSIONS: 3,
	MESSAGING: 4,
	TRANSFERS: 5,
	ATTENTION: 6,
	POSTAGE: 7,
	WAKE_QUOTA: 8,
} as const;

export const SCENARIOS = {
	// Phase 0: Preflight
	VALIDATE_ENV: { name: "Validate OWS wallet env vars", phase: PHASES.PREFLIGHT },
	PREFLIGHT_RPC: { name: "Verify chain RPC is reachable", phase: PHASES.PREFLIGHT },
	PREFLIGHT_OWS: { name: "Verify OWS is available", phase: PHASES.PREFLIGHT },

	// Phase 1: Onboarding & Identity
	INIT_AGENT_A: { name: "Init Agent A from OWS wallet", phase: PHASES.ONBOARDING },
	INIT_AGENT_B: { name: "Init Agent B from OWS wallet", phase: PHASES.ONBOARDING },
	BALANCE_CHECK_A: { name: "Check Agent A funding USDC balance", phase: PHASES.ONBOARDING },
	BALANCE_CHECK_B: { name: "Check Agent B funding USDC balance", phase: PHASES.ONBOARDING },
	REGISTER_AGENT_A: { name: "Register Agent A (IPFS + on-chain)", phase: PHASES.ONBOARDING },
	REGISTER_AGENT_B: { name: "Register Agent B (IPFS + on-chain)", phase: PHASES.ONBOARDING },
	RESOLVE_AGENT_A: { name: "Resolve Agent A identity", phase: PHASES.ONBOARDING },
	RESOLVE_AGENT_B: { name: "Resolve Agent B identity", phase: PHASES.ONBOARDING },

	// Phase 2: Connection & Trust
	CREATE_INVITE: { name: "Create invite (Agent A)", phase: PHASES.CONNECTION },
	ACCEPT_INVITE: { name: "Accept invite and connect (Agent B)", phase: PHASES.CONNECTION },
	SYNC_CONNECTION_A: { name: "Sync connection request (Agent A)", phase: PHASES.CONNECTION },
	SYNC_CONNECTION_B: { name: "Sync connection result (Agent B)", phase: PHASES.CONNECTION },
	VERIFY_CONTACTS_A: { name: "Verify Agent A contacts", phase: PHASES.CONNECTION },
	VERIFY_CONTACTS_B: { name: "Verify Agent B contacts", phase: PHASES.CONNECTION },

	// Phase 3: Permissions & Grants
	VERIFY_NO_GRANTS: { name: "Verify no grants before granting", phase: PHASES.PERMISSIONS },
	GRANT_TRANSFER: { name: "Grant USDC transfer permission", phase: PHASES.PERMISSIONS },
	SYNC_GRANT: { name: "Sync grant to grantee", phase: PHASES.PERMISSIONS },
	VERIFY_GRANT: { name: "Verify grant visible to grantee", phase: PHASES.PERMISSIONS },

	// Phase 4: Messaging
	SEND_MESSAGE_A_TO_B: { name: "Send message A to B", phase: PHASES.MESSAGING },
	SYNC_MESSAGE_B: { name: "Sync message to B", phase: PHASES.MESSAGING },
	SEND_MESSAGE_B_TO_A: { name: "Send message B to A", phase: PHASES.MESSAGING },
	SYNC_MESSAGE_A: { name: "Sync message to A", phase: PHASES.MESSAGING },
	VERIFY_CONVERSATIONS: { name: "Verify conversation logs", phase: PHASES.MESSAGING },

	// Phase 5: Transfers
	RECORD_BALANCE_BEFORE: {
		name: "Record Agent B balance before transfer",
		phase: PHASES.TRANSFERS,
	},
	REQUEST_FUNDS_APPROVED: { name: "Request funds (approved by grant)", phase: PHASES.TRANSFERS },
	SYNC_TRANSFER_A: { name: "Sync transfer approval (Agent A)", phase: PHASES.TRANSFERS },
	SYNC_TRANSFER_RESULT_B: { name: "Sync transfer result (Agent B)", phase: PHASES.TRANSFERS },
	VERIFY_BALANCE_INCREASED: { name: "Verify Agent B balance increased", phase: PHASES.TRANSFERS },
	REVOKE_GRANT: { name: "Revoke transfer grant", phase: PHASES.TRANSFERS },
	SYNC_REVOCATION: { name: "Sync revocation to Agent B", phase: PHASES.TRANSFERS },
	REQUEST_FUNDS_REJECTED: { name: "Request funds (rejected, no grant)", phase: PHASES.TRANSFERS },
	SYNC_REJECTION_A: { name: "Sync rejection (Agent A auto-rejects)", phase: PHASES.TRANSFERS },
	SYNC_REJECTION_RESULT_B: { name: "Sync rejection result (Agent B)", phase: PHASES.TRANSFERS },
	VERIFY_BALANCE_UNCHANGED: { name: "Verify Agent B balance unchanged", phase: PHASES.TRANSFERS },

	// Phase 6: Attention pricing. Mock-only for now: enforcement is off by
	// default so live behavior is unchanged, and the live assertions would be
	// negative ones ("B never logged the message") that are timing-flaky over
	// real XMTP. Mirror into e2e-live once a funded run can validate them.
	ATTENTION_DRY_RUN: {
		name: "Preview message cost with --dry-run (Agent A)",
		phase: PHASES.ATTENTION,
	},
	ATTENTION_ENFORCE_ON: {
		name: "Enable attention enforcement (Agent B)",
		phase: PHASES.ATTENTION,
	},
	ATTENTION_REJECTED: {
		name: "Send without grant rejected with quote (A to B)",
		phase: PHASES.ATTENTION,
	},
	ATTENTION_GRANT_EXEMPT: {
		name: "message/send grant exempts sender (A to B delivers)",
		phase: PHASES.ATTENTION,
	},

	// Phase 7: Prepaid postage. Mock-only for the same reasons as Phase 6:
	// enforcement (and therefore stamping) is opt-in, and the exhaustion
	// scenario relies on the negative "B never logged it" assertion that is
	// timing-flaky over real XMTP. Mirror into e2e-live with a funded run.
	POSTAGE_REVOKE_EXEMPTION: {
		name: "Revoke message/send grant so postage applies again (Agent B)",
		phase: PHASES.POSTAGE,
	},
	POSTAGE_TOPUP: {
		name: "Postage topup buys prepaid credit with a signed certificate (A at B)",
		phase: PHASES.POSTAGE,
	},
	POSTAGE_STAMPED_SEND: {
		name: "Auto-stamped message from un-granted sender delivers and debits (A to B)",
		phase: PHASES.POSTAGE,
	},
	POSTAGE_EXHAUSTED: {
		name: "Exhausted postage credit is rejected with a top-up quote (A to B)",
		phase: PHASES.POSTAGE,
	},
	POSTAGE_BALANCE: {
		name: "Postage balance shows held and issued credits (both agents)",
		phase: PHASES.POSTAGE,
	},

	// Phase 8: Paid wake-ups + notification quotas. Mock-only like Phases
	// 6/7: both mechanisms are opt-in and the assertions inspect the
	// receiver's drained notification batch, which needs the in-process
	// daemon's HTTP surface.
	WAKE_PRICING_ON: {
		name: "Publish a priority attention price (Agent B)",
		phase: PHASES.WAKE_QUOTA,
	},
	WAKE_PRIORITY_STAMP: {
		name: "Priority stamp escalates with a 400-char excerpt (A to B)",
		phase: PHASES.WAKE_QUOTA,
	},
	QUOTA_GRANT_FOLD: {
		name: "Over-quota grant holder's chatter folds to one summary line (A at B)",
		phase: PHASES.WAKE_QUOTA,
	},
	WAKE_GRANT_HOLDER_PRIORITY: {
		name: "Grant holder's priority stamp still buys the wake-up (A to B)",
		phase: PHASES.WAKE_QUOTA,
	},
} as const;
