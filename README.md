# pi-opencode-go-rotation

Rotate between multiple OpenCode Go API keys. The extension is reactive: it rotates on HTTP 429 responses, surfaced rate-limit errors, and silent stalls detected by the watchdog.

## Install

```bash
pi install npm:@lnilluv/pi-opencode-go-rotation
```

## Setup

Add your API keys:

```
/opencode add personal sk-xxxx
/opencode add work sk-yyyy
/opencode add backup sk-zzzz
```

The first key added becomes active immediately.

## How it works

The extension sets the active key as a runtime override, which takes priority over `OPENCODE_API_KEY` environment variables and `auth.json` credentials.

The extension has two recovery paths:

1. **Transient limit errors**: when `opencode` returns a matching 429/rate-limit error, the extension marks the current key as on cooldown, switches to the next key not on cooldown, and applies it via `setRuntimeApiKey`.
2. **Silent stalls**: when an `opencode-go` provider request has no response or stream activity for the watchdog window, the extension rotates keys, aborts the hung turn, and rewrites the abort as a retryable timeout error.

This is still reactive: it does not check usage or limits ahead of time.

Fixed-window Go plan quota errors pause automatic rotation so the extension does not cycle through keys that may share the same workspace quota. Use `/opencode next` or `/opencode use <n>` to try an independent key manually.

Pi's built-in auto-retry picks up the new key on the next request.

Cooldowns default to 60 minutes. After cooldown expires, the key becomes available again.

## Commands

| Command | Description |
|---------|-------------|
| `/opencode` or `/opencode status` | Show all keys, active key marker, cooldown status |
| `/opencode use <n>` | Switch to key number `n` (1-based) |
| `/opencode next` | Advance to the next configured key and clear its cooldown before activating it |
| `/opencode add <name> <key>` | Add a new key |
| `/opencode rm <n>` | Remove key number `n` |
| `/opencode reset` | Clear all cooldowns |
| `/opencode cooldown <min>` | Set or view cooldown duration in minutes |
| `/opencode events` | Show recent watchdog timeout history (last 10) |
| `/opencode watchdog [status\|on\|off\|<seconds>]` | Configure silent-stall detection |

## Configuration

Keys are stored in `~/.pi/agent/opencode-keys.json` with file permissions `0600`. Status output shows key names only; it does not display key material.

```json
{
  "keys": [
    { "name": "personal", "key": "sk-xxx" },
    { "name": "work", "key": "sk-yyy" }
  ],
  "activeKeyIndex": 0,
  "cooldownMinutes": 60,
  "watchdogEnabled": true,
  "watchdogIdleMs": 90000,
  "cooldowns": {}
}
```

### Retry settings

Pair with pi's auto-retry for best results. In `~/.pi/agent/settings.json`:

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

Set `maxRetries` to at least the number of keys so all keys get a chance before pi gives up.

## Limitations

- OpenCode Go currently has no API endpoint for checking usage, remaining quota, or limits proactively.
- The watchdog is scoped to the `opencode-go` provider only. Other providers are not aborted or rotated.
- A legitimate long-running request with no stream activity can be treated as stalled; tune with `/opencode watchdog <seconds>` or disable with `/opencode watchdog off`.
- When all keys are transiently rate-limited simultaneously, the extension force-advances to the next key and clears its cooldown.
- Go plan usage limits are tied to the subscription workspace; multiple keys from one workspace should not be assumed to provide independent quota. See the [OpenCode Go documentation](https://opencode.ai/docs/go/).
- Keys added via `/opencode add` are stored in plaintext. The config file is created and maintained with `0600` permissions.
- If `opencode` later adds an API endpoint for Go plan usage/limit verification, this extension can be updated to use it.

## License

MIT
