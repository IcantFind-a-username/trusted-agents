# Permissions V1

## Model

- A connection creates trust and contact state.
- Grants are published after connect and are directional per peer.
- `grantedByMe` means what the peer may ask this agent to do.
- `grantedByPeer` means what this agent may ask the peer to do.
- The agent judges requests at runtime using grants plus local notes.

## Grant File Format

Use either:
- a top-level array of grants
- or a full grant set object

Full object example:

```json
{
  "version": "tap-grants/v1",
  "grants": [
    {
      "grantId": "worker-weekly-usdc",
      "scope": "transfer/request",
      "constraints": {
        "asset": "usdc",
        "maxAmount": "10",
        "window": "week"
      }
    },
    {
      "grantId": "worker-chat",
      "scope": "general-chat"
    }
  ]
}
```

Grant fields:
- `grantId`: stable identifier used for revocation
- `scope`: stable action or conversation label
- `constraints`: optional JSON object
- `status`: optional, defaults to `active`
- `updatedAt`: optional ISO timestamp

## Recommended Scope Names

- `general-chat`
- `research`
- `scheduling`
- `message/send`
- `transfer/request`
- `permissions/request-grants`

Use stable scope names and put budgets, assets, time windows, or policy details inside `constraints`.

A `message/send` grant exempts the holder from attention enforcement (their messages deliver free). Its `constraints` may carry `notificationsPerWeek` (integer ≥ 0): a cap on rendered notification lines the holder's free messages may claim per trailing 7 UTC days — over quota, their notifications fold into a single summary line until the window rolls. Delivery is unaffected; only per-line attention is metered.

## Common Grant Templates

### Chat only

```json
[{ "grantId": "<peer>-chat", "scope": "general-chat" }]
```

### Chat + research

```json
[
  { "grantId": "<peer>-chat", "scope": "general-chat" },
  { "grantId": "<peer>-research", "scope": "research" }
]
```

### Metered free messaging (attention quota)

```json
[
  {
    "grantId": "<peer>-metered-chat",
    "scope": "message/send",
    "constraints": { "notificationsPerWeek": 20 }
  }
]
```

### USDC weekly budget

```json
[
  {
    "grantId": "<peer>-weekly-usdc",
    "scope": "transfer/request",
    "constraints": { "asset": "usdc", "maxAmount": "50", "window": "week" }
  }
]
```

### Native ETH with chain constraint

```json
[
  {
    "grantId": "<peer>-eth-base",
    "scope": "transfer/request",
    "constraints": { "asset": "native", "maxAmount": "0.1", "chain": "eip155:8453" }
  }
]
```

### Grant ID convention

Use `<peer>-<purpose>` (e.g. `treasury-weekly-usdc`, `worker-chat`). Keep IDs stable — they are the revocation handle.
