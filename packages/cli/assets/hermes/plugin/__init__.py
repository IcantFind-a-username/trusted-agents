"""Trusted Agents TAP plugin for Hermes."""

from __future__ import annotations

import json

from .client import drain_all_identities, format_notification_context, send_request

TOOLSET = "plugin_trusted_agents_tap"
ACTIONS = [
    "status",
    "sync",
    "restart",
    "create_invite",
    "connect",
    "send_message",
    "publish_grants",
    "request_grants",
    "request_funds",
    "transfer",
    "request_meeting",
    "respond_meeting",
    "cancel_meeting",
    "list_pending",
    "resolve_pending",
]

TAP_GATEWAY_SCHEMA = {
    "name": "tap_gateway",
    "description": (
        "Operate the long-lived Trusted Agents Protocol runtime inside Hermes. "
        "Use this for status, sync, invites, connections, messaging, grant updates, "
        "fund requests, direct transfers, meeting scheduling, and approval resolution."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "action": {
                "type": "string",
                "enum": ACTIONS,
                "description": "Action to perform.",
            },
            "identity": {
                "type": "string",
                "description": "Configured TAP Hermes identity name. Required when more than one identity is configured.",
            },
            "peer": {
                "type": "string",
                "description": "Peer name or agent ID.",
            },
            "invite_url": {
                "type": "string",
                "description": "Trusted Agents invite URL.",
            },
            "text": {
                "type": "string",
                "description": "Message text.",
            },
            "scope": {
                "type": "string",
                "description": "Optional TAP message scope.",
            },
            "auto_generated": {
                "type": "boolean",
                "description": "Set true for auto-generated replies to prevent reply loops.",
            },
            "priority": {
                "type": "boolean",
                "description": (
                    "Pay the peer's priority attention price so the message escalates "
                    "and may wake their agent."
                ),
            },
            "note": {
                "type": "string",
                "description": "Optional operator note.",
            },
            "grant_set": {
                "description": "Grant array or tap-grants/v1 object.",
            },
            "request_id": {
                "type": "string",
                "description": "Pending TAP request ID.",
            },
            "approve": {
                "type": "boolean",
                "description": "Approve or reject the pending request.",
            },
            "asset": {
                "type": "string",
                "enum": ["native", "usdc"],
                "description": "Requested transfer asset.",
            },
            "amount": {
                "type": "string",
                "description": "Transfer amount as a string.",
            },
            "chain": {
                "type": "string",
                "description": "CAIP-2 chain ID override.",
            },
            "to_address": {
                "type": "string",
                "description": "Recipient address for fund requests or direct transfers.",
            },
            "expires_in_seconds": {
                "type": "number",
                "minimum": 1,
                "description": "Invite expiry in seconds.",
            },
            "title": {
                "type": "string",
                "description": "Meeting title.",
            },
            "duration": {
                "type": "number",
                "minimum": 1,
                "description": "Meeting duration in minutes.",
            },
            "preferred": {
                "type": "string",
                "description": "Preferred meeting time in ISO 8601 format.",
            },
            "location": {
                "type": "string",
                "description": "Optional meeting location.",
            },
            "scheduling_id": {
                "type": "string",
                "description": "Scheduling request identifier.",
            },
            "meeting_action": {
                "type": "string",
                "enum": ["accept", "reject"],
                "description": "Response action for a meeting request.",
            },
            "reason": {
                "type": "string",
                "description": "Optional reason for rejection or cancellation.",
            },
        },
        "required": ["action"],
    },
}


def handle_tap_gateway(args: dict, **kwargs) -> str:
    action = args.get("action")
    if not isinstance(action, str) or not action.strip():
        return json.dumps({"error": "action is required"})

    params = {key: value for key, value in args.items() if key != "action" and value is not None}
    return json.dumps(send_request(action, params))


def inject_tap_notifications(**kwargs):
    # Drain from every configured identity so multi-identity Hermes
    # setups surface pending approvals and escalations from every agent,
    # not just the default one. ``drain_all_identities`` never raises —
    # per-identity failures come back as meta escalations so they
    # aren't silently swallowed.
    notifications = drain_all_identities()
    return format_notification_context(notifications)


def register(ctx):
    ctx.register_tool(
        name="tap_gateway",
        toolset=TOOLSET,
        schema=TAP_GATEWAY_SCHEMA,
        handler=handle_tap_gateway,
        description="Operate the long-lived TAP Hermes runtime.",
    )
    ctx.register_hook("pre_llm_call", inject_tap_notifications)
