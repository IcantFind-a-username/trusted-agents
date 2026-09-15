"""HTTP client over Unix socket for the local tapd daemon.

Identity resolution (F4.1)
--------------------------

Hermes supports multiple TAP identities registered via ``tap hermes
configure``, each pinned to its own ``dataDir``. Each ``dataDir`` hosts
its own ``.tapd.sock`` and talks to a different ``TapMessagingService``.
This client reads the Hermes plugin config on every request and picks
the target identity's socket:

  1. Explicit ``identity`` in params: must match a config entry by name.
  2. No ``identity`` passed, config has exactly one entry: use it.
  3. No ``identity`` passed, config has zero entries: fall back to
     ``$TAP_DATA_DIR`` / ``~/.trustedagents`` (legacy single-agent path).
  4. No ``identity`` passed, config has two or more entries: error out.

The config lives at ``<HERMES_HOME>/plugins/trusted-agents-tap/config.json``.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from typing import Any
from urllib.parse import quote

SOCKET_NAME = ".tapd.sock"
TOKEN_FILE_NAME = ".tapd-token"
DEFAULT_TIMEOUT_SECONDS = 10.0
DAEMON_START_TIMEOUT_SECONDS = 5.0
DAEMON_START_POLL_SECONDS = 0.1
DEFAULT_RECOVERY_GUIDANCE = "Run `tap daemon start` to launch tapd."


class _UnixHTTPConnection(HTTPConnection):
    """HTTPConnection subclass that connects via a Unix domain socket."""

    def __init__(self, socket_path: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:  # type: ignore[override]
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


def _legacy_data_dir() -> Path:
    """Data dir used when no Hermes plugin config entries are present."""
    env_dir = os.environ.get("TAP_DATA_DIR")
    if env_dir and env_dir.strip():
        return Path(env_dir)
    return Path.home() / ".trustedagents"


def _hermes_home() -> Path:
    env_home = os.environ.get("HERMES_HOME")
    if env_home and env_home.strip():
        return Path(env_home)
    return Path.home() / ".hermes"


def _hermes_config_path() -> Path:
    return _hermes_home() / "plugins" / "trusted-agents-tap" / "config.json"


def _load_hermes_identities() -> list[dict[str, Any]]:
    """Read the Hermes plugin config and return the list of identities.

    Returns an empty list if the config file doesn't exist or has no
    identities. Any parse failure raises; callers handle it as a
    structured error back to the agent."""
    config_path = _hermes_config_path()
    try:
        raw = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise RuntimeError(f"failed to read Hermes plugin config at {config_path}: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Hermes plugin config is not valid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("Hermes plugin config must be an object")
    identities = parsed.get("identities") or []
    if not isinstance(identities, list):
        raise RuntimeError("Hermes plugin config.identities must be a list")
    normalized: list[dict[str, Any]] = []
    for entry in identities:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        data_dir = entry.get("dataDir")
        if isinstance(name, str) and isinstance(data_dir, str) and data_dir.strip():
            normalized.append({"name": name, "dataDir": data_dir})
    return normalized


def _resolve_target_data_dir(identity: str | None) -> tuple[Path | None, str | None]:
    """Pick a tapd data dir for this request.

    Returns ``(data_dir, error)``. ``error`` is a user-facing message if
    the identity couldn't be resolved; ``data_dir`` is ``None`` in that
    case. On success, ``data_dir`` is a Path and ``error`` is ``None``.
    """
    try:
        identities = _load_hermes_identities()
    except RuntimeError as exc:
        return None, str(exc)

    if identity is not None:
        if not isinstance(identity, str) or not identity.strip():
            return None, "`identity` must be a non-empty string"
        match = next((entry for entry in identities if entry["name"] == identity), None)
        if not match:
            known = ", ".join(entry["name"] for entry in identities) or "(none configured)"
            return None, f"unknown identity: {identity} (known: {known})"
        return Path(match["dataDir"]), None

    if len(identities) == 1:
        return Path(identities[0]["dataDir"]), None

    if len(identities) == 0:
        return _legacy_data_dir(), None

    return (
        None,
        "multiple TAP Hermes identities configured — pass `identity` to select one",
    )


def _ensure_tapd_running(socket_path: Path, data_dir: Path) -> tuple[bool, str | None]:
    """Auto-start tapd for the chosen identity if the socket is missing.

    The child is spawned with ``TAP_DATA_DIR=<data_dir>`` so the right
    per-identity daemon comes up instead of the default one. Preserves
    the auto-start behavior from before F4.1 but targets the resolved
    identity rather than a global default.
    """
    if socket_path.exists():
        return True, None
    tap_bin = shutil.which("tap")
    if not tap_bin:
        return False, "`tap` binary not found on PATH; cannot start tapd"
    child_env = os.environ.copy()
    child_env["TAP_DATA_DIR"] = str(data_dir)
    try:
        subprocess.Popen(
            [tap_bin, "daemon", "start"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            env=child_env,
        )
    except OSError as exc:
        return False, f"failed to spawn `tap daemon start`: {exc}"
    deadline = time.monotonic() + DAEMON_START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if socket_path.exists():
            return True, None
        time.sleep(DAEMON_START_POLL_SECONDS)
    return False, "tapd did not start within timeout"


def _load_auth_token(socket_path: Path) -> tuple[str | None, str | None]:
    """Read the bearer token tapd persists next to its socket.

    Returns ``(token, error)``. On success, ``error`` is None. On failure,
    ``token`` is None and ``error`` is a user-facing string. The token file
    is mode 0o600, so a same-uid process that cannot read it cannot call
    the daemon — this is the security boundary the unix-socket auth relies
    on. Parent dir of the socket is the tapd dataDir."""
    token_path = socket_path.parent / TOKEN_FILE_NAME
    try:
        raw = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None, f"tapd token missing at {token_path}. {DEFAULT_RECOVERY_GUIDANCE}"
    except OSError as exc:
        return None, f"failed to read tapd token at {token_path}: {exc}"
    if not raw:
        return None, f"tapd token file {token_path} is empty. {DEFAULT_RECOVERY_GUIDANCE}"
    return raw, None


def _http_request(
    method: str,
    path: str,
    socket_path: Path,
    body: dict | None = None,
    auto_start: bool = True,
) -> Any:
    """Send an HTTP request to tapd over a Unix socket.

    ``auto_start`` controls whether a missing socket triggers ``tap daemon
    start`` with a 5-second wait. Interactive paths (send/transfer/connect)
    use ``auto_start=True`` so a first-time request boots tapd. The
    ``pre_llm_call`` notification drain path MUST pass ``auto_start=False``
    because it runs on every prompt — a dead identity would otherwise add
    ``DAEMON_START_TIMEOUT_SECONDS`` of latency to every turn, multiplied by
    the number of dead identities. Drain is strictly a fast-fail read path:
    a missing socket is reported back immediately as an error string and
    surfaced as a meta escalation by ``drain_all_identities``.
    """
    if not socket_path.exists():
        if not auto_start:
            return {"error": f"tapd socket missing at {socket_path}. {DEFAULT_RECOVERY_GUIDANCE}"}
        running, note = _ensure_tapd_running(socket_path, socket_path.parent)
        if not running:
            return {"error": f"tapd is not running: {note}. {DEFAULT_RECOVERY_GUIDANCE}"}

    token, token_err = _load_auth_token(socket_path)
    if token is None:
        return {"error": token_err}

    conn = _UnixHTTPConnection(str(socket_path))
    try:
        headers: dict[str, str] = {"Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        body_json = json.dumps(body) if body is not None else None
        conn.request(method, path, body=body_json, headers=headers)
        response = conn.getresponse()
        raw = response.read().decode("utf-8")
        payload: Any
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return {"error": f"tapd returned invalid JSON: {raw[:200]}"}
        if response.status >= 400:
            error = (payload or {}).get("error") if isinstance(payload, dict) else None
            message = error.get("message") if isinstance(error, dict) else None
            return {"error": message or f"tapd returned HTTP {response.status}"}
        return payload
    except OSError as exc:
        return {"error": f"failed to reach tapd at {socket_path}: {exc}. {DEFAULT_RECOVERY_GUIDANCE}"}
    finally:
        conn.close()


def _pick(params: dict, field_map: dict[str, str]) -> dict[str, Any]:
    """Build an HTTP body by copying present params through a snake→camelCase map."""
    return {body_key: params[param_key] for param_key, body_key in field_map.items() if params.get(param_key) is not None}


def _require_param(params: dict, key: str) -> tuple[str | None, dict | None]:
    """Return (value, None) or (None, error_dict) for a required string param."""
    value = params.get(key)
    if not value:
        return None, {"error": f"{key} is required"}
    return str(value), None


def _dispatch(action: str, params: dict, socket_path: Path) -> Any:
    """Route the action to the matching tapd HTTP endpoint."""
    if action == "status":
        return _http_request("GET", "/daemon/health", socket_path)

    if action == "sync":
        return _http_request("POST", "/daemon/sync", socket_path)

    if action == "restart":
        # tapd is a separate process; this client is a thin HTTP shell
        # over its unix socket. A bare `/daemon/shutdown` leaves tapd
        # down — notification drain runs with auto_start=False and stays
        # dark until a user action happens to trigger the fast-start
        # path, so the action can silently kill background events. Fail
        # loudly and point at the CLI supervisor command instead.
        return {
            "error": (
                "Hermes plugin client cannot restart tapd directly. Run "
                "`tap daemon restart` or `tap hermes restart` from the CLI, "
                "or restart `hermes gateway` so the startup hook relaunches "
                "tapd."
            )
        }

    if action == "create_invite":
        return _http_request("POST", "/api/invites", socket_path, body=_pick(params, {
            "expires_in_seconds": "expiresInSeconds",
        }))

    if action == "connect":
        return _http_request("POST", "/api/connect", socket_path, body=_pick(params, {
            "invite_url": "inviteUrl", "wait_ms": "waitMs",
        }))

    if action == "send_message":
        return _http_request("POST", "/api/messages", socket_path, body=_pick(params, {
            "peer": "peer", "text": "text", "scope": "scope", "auto_generated": "autoGenerated",
            "priority": "priority",
        }))

    if action == "publish_grants":
        return _http_request("POST", "/api/grants/publish", socket_path, body=_pick(params, {
            "peer": "peer", "grant_set": "grantSet", "note": "note",
        }))

    if action == "request_grants":
        return _http_request("POST", "/api/grants/request", socket_path, body=_pick(params, {
            "peer": "peer", "grant_set": "grantSet", "note": "note",
        }))

    if action == "request_funds":
        return _http_request("POST", "/api/funds-requests", socket_path, body=_pick(params, {
            "peer": "peer", "asset": "asset", "amount": "amount",
            "chain": "chain", "to_address": "toAddress", "note": "note",
        }))

    if action == "transfer":
        return _http_request("POST", "/api/transfers", socket_path, body=_pick(params, {
            "asset": "asset", "amount": "amount", "chain": "chain", "to_address": "toAddress",
        }))

    if action == "request_meeting":
        return _http_request("POST", "/api/meetings", socket_path, body=_pick(params, {
            "peer": "peer", "title": "title", "duration": "duration",
            "preferred": "preferred", "location": "location", "note": "note",
            "scheduling_id": "schedulingId",
        }))

    if action == "respond_meeting":
        sid, err = _require_param(params, "scheduling_id")
        if err:
            return err
        body: dict[str, Any] = _pick(params, {"reason": "reason"})
        meeting_action = params.get("meeting_action")
        if meeting_action is not None:
            body["approve"] = meeting_action == "accept"
        return _http_request("POST", f"/api/meetings/{quote(sid, safe='')}/respond", socket_path, body=body)

    if action == "cancel_meeting":
        sid, err = _require_param(params, "scheduling_id")
        if err:
            return err
        return _http_request("POST", f"/api/meetings/{quote(sid, safe='')}/cancel", socket_path, body=_pick(params, {
            "reason": "reason",
        }))

    if action == "list_pending":
        return _http_request("GET", "/api/pending", socket_path)

    if action == "resolve_pending":
        rid, err = _require_param(params, "request_id")
        if err:
            return err
        # Require an explicit boolean. `bool(params.get("approve"))` would
        # coerce a missing value, a string, a dict, anything truthy/falsy —
        # and a missing approve would silently route to /deny, rejecting
        # pending actions without the agent ever intending to. Approval
        # must be a deliberate yes/no.
        approve = params.get("approve")
        if not isinstance(approve, bool):
            return {"error": "approve is required and must be a boolean (true or false)"}
        verb = "approve" if approve else "deny"
        return _http_request("POST", f"/api/pending/{quote(rid, safe='')}/{verb}", socket_path, body=_pick(params, {
            "note": "note", "reason": "reason",
        }))

    if action == "drain_notifications":
        return _http_request("GET", "/api/notifications/drain", socket_path)

    return {"error": f"unknown action: {action}"}


def send_request(action: str, params: dict | None = None) -> Any:
    """Dispatch a Hermes tap_gateway action to the tapd HTTP API.

    Resolves the target identity from the Hermes plugin config on each
    call, then derives the per-identity socket path. The ``identity``
    field in ``params`` is consumed here and NOT forwarded to tapd.
    """
    params = params or {}
    if not isinstance(action, str) or not action.strip():
        return {"error": "action is required"}

    identity_arg = params.get("identity")
    data_dir, err = _resolve_target_data_dir(identity_arg)
    if err is not None or data_dir is None:
        return {"error": err or "failed to resolve tapd data dir"}

    # Strip the identity key so it doesn't leak into tapd request bodies.
    dispatch_params = {k: v for k, v in params.items() if k != "identity"}
    socket_path = data_dir / SOCKET_NAME
    return _dispatch(action, dispatch_params, socket_path)


def _drain_one(socket_path: Path) -> tuple[list[dict], str | None]:
    """Drain notifications from a single tapd socket.

    Returns ``(notifications, error)``. On success, ``error`` is None. On
    failure (socket missing, HTTP error, malformed response), returns an
    empty list plus an error string for the caller to surface as a
    meta-notification.

    Drain runs on every prompt via the ``pre_llm_call`` hook, so it MUST
    be fast-fail: passing ``auto_start=False`` means a dead identity returns
    immediately instead of blocking the prompt for ``DAEMON_START_TIMEOUT_SECONDS``
    waiting for a daemon that may never come up.
    """
    result = _http_request("GET", "/api/notifications/drain", socket_path, auto_start=False)
    if isinstance(result, dict) and "error" in result and "notifications" not in result:
        return [], str(result.get("error") or "unknown error")
    if not isinstance(result, dict):
        return [], "tapd returned a non-object drain response"
    notifications = result.get("notifications")
    if not isinstance(notifications, list):
        return [], "tapd drain response missing `notifications` array"
    normalized: list[dict] = [n for n in notifications if isinstance(n, dict)]
    return normalized, None


def _meta_error_notification(identity_name: str, reason: str) -> dict[str, Any]:
    """Build a meta escalation surfaced when an identity drain fails.

    Operators need to see that a specific tapd is unreachable — silently
    dropping the error would hide approval backlogs accumulating in a
    quiet daemon.
    """
    return {
        "type": "escalation",
        "oneLiner": f"Hermes: unable to reach tapd for identity {identity_name}: {reason}",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "identity": identity_name,
    }


def drain_all_identities() -> list[dict]:
    """Drain notifications from every configured Hermes identity.

    Each identity has its own tapd and its own per-identity notification
    queue, so the Hermes ``pre_llm_call`` hook must drain each one and
    merge the results. Notifications are tagged with the source identity
    so the injection layer can label them when more than one identity
    contributed.

    Fallback rules:
      - Zero entries (legacy single-agent setup or missing config): drain
        once from the default socket (``TAP_DATA_DIR`` / ``~/.trustedagents``).
        The returned notifications carry no identity tag.
      - One entry: drain that identity once and tag its notifications.
      - Two or more entries: drain each identity in config order and tag
        every notification with its ``name``. Per-identity failures are
        surfaced as an escalation meta-notification rather than silently
        swallowed.

    This function never raises; a configuration error is returned as a
    single meta-notification so the operator sees the issue instead of
    an empty injection block.
    """
    try:
        identities = _load_hermes_identities()
    except RuntimeError as exc:
        return [
            {
                "type": "escalation",
                "oneLiner": f"Hermes: TAP plugin config error: {exc}",
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        ]

    if len(identities) == 0:
        data_dir = _legacy_data_dir()
        socket_path = data_dir / SOCKET_NAME
        drained, err = _drain_one(socket_path)
        if err is not None:
            return [_meta_error_notification("default", err)]
        return drained

    merged: list[dict] = []
    for entry in identities:
        name = entry["name"]
        socket_path = Path(entry["dataDir"]) / SOCKET_NAME
        drained, err = _drain_one(socket_path)
        if err is not None:
            merged.append(_meta_error_notification(name, err))
            continue
        for notification in drained:
            tagged = dict(notification)
            tagged.setdefault("identity", name)
            merged.append(tagged)
    return merged


MAX_RENDERED_NOTIFICATIONS = 20


def _count_of(notification: dict) -> int:
    """Number of underlying events a (possibly coalesced) notification covers.

    ``count`` is optional and absent on notifications from an older tapd;
    bool is excluded because it is an int subclass in Python."""
    count = notification.get("count")
    if isinstance(count, int) and not isinstance(count, bool) and count >= 1:
        return count
    return 1


def _count_suffix(notification: dict) -> str:
    events = _count_of(notification)
    return f" (x{events})" if events >= 2 else ""


def _peer_label(notification: dict) -> str | None:
    data = notification.get("data")
    if not isinstance(data, dict):
        return None
    peer_name = data.get("peerName")
    if isinstance(peer_name, str) and peer_name.strip():
        return peer_name.strip()
    peer_agent_id = data.get("peerAgentId")
    if isinstance(peer_agent_id, (int, str)) and not isinstance(peer_agent_id, bool):
        return f"agent #{peer_agent_id}"
    return None


def _type_bucket_label(notification_type: str, events: int) -> str:
    if notification_type == "escalation":
        return "escalation" if events == 1 else "escalations"
    if notification_type == "auto-reply":
        return "auto-reply" if events == 1 else "auto-replies"
    if notification_type == "summary":
        return "summary" if events == 1 else "summaries"
    return "info"


def _summarize_omitted(omitted: list[dict]) -> str:
    """Group the omitted tail by peer (info messages) or type, summing event
    counts, so the footer says what was dropped instead of a bare number."""
    peer_buckets: dict[str, int] = {}
    type_buckets: dict[str, int] = {}
    for notification in omitted:
        events = _count_of(notification)
        notification_type = notification.get("type")
        label = _peer_label(notification) if notification_type == "info" else None
        if label is not None:
            peer_buckets[label] = peer_buckets.get(label, 0) + events
        else:
            key = notification_type if isinstance(notification_type, str) else "info"
            type_buckets[key] = type_buckets.get(key, 0) + events
    parts: list[str] = []
    for label, events in peer_buckets.items():
        noun = "message" if events == 1 else "messages"
        parts.append(f"{events} {noun} from {label}")
    for notification_type, events in type_buckets.items():
        parts.append(f"{events} {_type_bucket_label(notification_type, events)}")
    return ", ".join(parts)


def format_notification_context(notifications: list[dict]) -> dict[str, str] | None:
    """Format drained notifications into a Hermes pre_llm_call context payload.

    Processing order: drop blank one-liners (they never burn a rendered
    slot), stable-partition escalations first (arrival order preserved
    within each class, so the 20-line cap can never silently drop an
    approval request behind peer chatter), cap at 20 lines, then summarize
    the omitted tail grouped by peer/type with event counts. Entries
    coalesced upstream (``count`` >= 2) render an `` (xN)`` suffix; legacy
    notifications without the field render unchanged.

    When notifications come from more than one identity (multi-identity
    Hermes setups), each line is prefixed with ``[identity]`` so the
    operator knows which agent raised it. Legacy single-identity output
    is unchanged: no identity tag on the notifications means no prefix
    in the rendered block.
    """
    if not notifications:
        return None

    labels = {
        "escalation": "ESCALATION",
        "summary": "SUMMARY",
        "auto-reply": "AUTO-REPLY",
        "info": "INFO",
    }

    distinct_identities: set[str] = set()
    for notification in notifications:
        identity = notification.get("identity")
        if isinstance(identity, str) and identity.strip():
            distinct_identities.add(identity.strip())
    show_identity_prefix = len(distinct_identities) >= 2

    renderable = [
        notification
        for notification in notifications
        if str(notification.get("oneLiner") or "").strip()
    ]
    if not renderable:
        return None

    ordered = [n for n in renderable if n.get("type") == "escalation"] + [
        n for n in renderable if n.get("type") != "escalation"
    ]

    lines = ["[TAP Notifications]"]
    for notification in ordered[:MAX_RENDERED_NOTIFICATIONS]:
        label = labels.get(notification.get("type"), "INFO")
        one_liner = str(notification.get("oneLiner") or "").strip()
        suffix = _count_suffix(notification)
        identity = notification.get("identity")
        if (
            show_identity_prefix
            and isinstance(identity, str)
            and identity.strip()
        ):
            lines.append(f"- {label} [{identity.strip()}]: {one_liner}{suffix}")
        else:
            lines.append(f"- {label}: {one_liner}{suffix}")

    omitted = ordered[MAX_RENDERED_NOTIFICATIONS:]
    if omitted:
        lines.append(f"- SUMMARY: omitted: {_summarize_omitted(omitted)}.")

    lines.append("Use tap_gateway for transport-active TAP actions inside Hermes.")
    return {"context": "\n".join(lines)}
