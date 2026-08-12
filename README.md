# pi-opencode-go-rotation

Rotate between multiple OpenCode Go API keys. The extension checks OpenCode Go usage when a 429 response arrives, rotates on transient rate limits, pauses on fixed-window quota exhaustion, and recovers silent stalls detected by the watchdog.

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

The extension has three recovery paths:

1. **Usage-verified Go quota exhaustion**: when OpenCode Go returns HTTP 429, the extension sends the active key only to `https://opencode.ai/zen/go/v1/usage`. If any usage window is already `rate-limited`, automatic rotation pauses so the extension does not cycle keys that share the same workspace quota.
2. **Transient limit errors**: when the usage endpoint is unavailable, does not report a rate-limited window, or does not finish within 10 seconds, the extension preserves the existing transient 429 behavior. It aborts a timed-out usage request, marks the current key as on cooldown, switches to the next key not on cooldown, and applies it via `setRuntimeApiKey`.
3. **Silent stalls**: when an `opencode-go` provider request has no response or stream activity for the watchdog window, the extension rotates keys, aborts the hung turn, and rewrites the abort as a retryable timeout error.

This is still reactive: it does not poll usage or check limits before normal requests.

Fixed-window Go plan quota errors pause automatic rotation so the extension does not cycle through keys that may share the same workspace quota. Use `/opencode next` or `/opencode use <n>` to try an independent key manually.

Pi's built-in auto-retry picks up the new key on the next request.

Cooldowns default to 60 minutes. After cooldown expires, the key becomes available again.

Usage commands use `https://opencode.ai/zen/go/v1/usage` and stop waiting after 10 seconds. A timeout reports `Usage request timed out after 10s.`.

## Commands

| Command | Description |
|---------|-------------|
| `/opencode` or `/opencode status` | Show all keys, active key marker, cooldown status |
| `/opencode usage` or `/opencode quota` | Fetch OpenCode Go usage for the active key without showing key material |
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

- The watchdog is scoped to the `opencode-go` provider only. Other providers are not aborted or rotated.
- A legitimate long-running request with no stream activity can be treated as stalled; tune with `/opencode watchdog <seconds>` or disable with `/opencode watchdog off`.
- When all keys are transiently rate-limited simultaneously, the extension force-advances to the next key and clears its cooldown.
- Go plan usage limits are tied to the subscription workspace; multiple keys from one workspace should not be assumed to provide independent quota. See the [OpenCode Go documentation](https://opencode.ai/docs/go/).
- Keys added via `/opencode add` are stored in plaintext. The config file is created and maintained with `0600` permissions.

## License

MIT
