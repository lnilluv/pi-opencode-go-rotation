# pi-opencode-go-rotation

Rotate between multiple OpenCode Go API keys. When one key hits a rate limit (429), the extension switches to the next available key automatically.

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

When the OpenCode Go API returns a rate-limit error (HTTP 429, or any message matching `rate.limit`, `quota`, `usage limit`), the extension:

1. Marks the current key as on cooldown
2. Switches to the next key not on cooldown
3. Applies the new key via `setRuntimeApiKey`

Pi's built-in auto-retry picks up the new key on the next request.

Cooldowns default to 60 minutes. After cooldown expires, the key becomes available again.

## Commands

| Command | Description |
|---------|-------------|
| `/opencode` or `/opencode status` | Show all keys, active key marker, cooldown status |
| `/opencode use <n>` | Switch to key number `n` (1-based) |
| `/opencode add <name> <key>` | Add a new key |
| `/opencode rm <n>` | Remove key number `n` |
| `/opencode reset` | Clear all cooldowns |
| `/opencode cooldown <min>` | Set or view cooldown duration in minutes |

## Configuration

Keys are stored in `~/.pi/agent/opencode-keys.json` with file permissions `0600`.

```json
{
  "keys": [
    { "name": "personal", "key": "sk-xxx" },
    { "name": "work", "key": "sk-yyy" }
  ],
  "activeKeyIndex": 0,
  "cooldownMinutes": 60,
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

- OpenCode Go has no API for checking remaining quota proactively. Rotation is reactive (triggered by 429 errors).
- When all keys are rate-limited simultaneously, the extension force-advances to the next key and clears its cooldown.
- Keys added via `/opencode add` are stored in plaintext. The config file is created with `0600` permissions.

## License

MIT