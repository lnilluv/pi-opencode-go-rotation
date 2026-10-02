import { ConfigLoadError, DEFAULT_COOLDOWN_MINUTES, DEFAULT_WATCHDOG_IDLE_MS, createEmptyConfig, loadConfig, updateConfig, } from "./config-store.js";
const PROVIDER = "opencode-go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;
const FIXED_WINDOW_QUOTA_RE = /\b(?:5[- ]hour|weekly|monthly)\b[\s\S]*\b(?:usage\s+)?(?:quota|limit)\b|\b(?:usage|plan)\s+allocated\s+quota\s+exceeded\b|\b(?:quota|limit)\b[\s\S]*\b(?:will\s+reset|resets?\s+at|fixed[- ]window)\b/i;
const TRANSIENT_RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;
function getCooldownMs(config) {
    return (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60_000;
}
function getWatchdogIdleMs(config) {
    return config.watchdogIdleMs > 0 ? config.watchdogIdleMs : DEFAULT_WATCHDOG_IDLE_MS;
}
export function shouldWatchProvider(provider) {
    return provider === PROVIDER;
}
export function classifyRateLimitError(message) {
    if (FIXED_WINDOW_QUOTA_RE.test(message))
        return "fixed-window-quota";
    if (TRANSIENT_RATE_LIMIT_RE.test(message))
        return "transient";
    return undefined;
}
export function shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated) {
    return timeoutInfo.lastStatus !== 401 && (timeoutInfo.lastStatus !== 429 || !rateLimitAlreadyRotated);
}
export class ProviderIdleWatchdog {
    timer;
    active = false;
    timedOut = false;
    phase = "waiting-for-response";
    startedAt = 0;
    lastActivityAt = 0;
    lastStatus;
    timeoutInfo;
    options;
    constructor(options) {
        this.options = options;
    }
    start() {
        const now = this.now();
        this.active = true;
        this.timedOut = false;
        this.timeoutInfo = undefined;
        this.phase = "waiting-for-response";
        this.startedAt = now;
        this.lastActivityAt = now;
        this.lastStatus = undefined;
        this.schedule();
    }
    response(status) {
        if (!this.active || this.timedOut)
            return;
        this.phase = "waiting-for-stream";
        this.lastStatus = status;
        this.markActivity();
    }
    streamActivity() {
        if (!this.active || this.timedOut)
            return;
        this.phase = "streaming";
        this.markActivity();
    }
    activity() {
        if (!this.active || this.timedOut)
            return;
        this.markActivity();
    }
    stop() {
        this.active = false;
        this.clear();
    }
    consumeTimeoutInfo() {
        const result = this.timeoutInfo;
        this.timeoutInfo = undefined;
        this.timedOut = false;
        return result;
    }
    currentTimeoutInfo() {
        return this.timeoutInfo;
    }
    markActivity() {
        this.lastActivityAt = this.now();
        this.schedule();
    }
    now() {
        return this.options.clock?.now() ?? Date.now();
    }
    getTimers() {
        return this.options.timers ?? {
            setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
            clearTimeout: (timer) => globalThis.clearTimeout(timer),
        };
    }
    schedule() {
        this.clear();
        const timers = this.getTimers();
        this.timer = timers.setTimeout(() => {
            if (!this.active || this.timedOut)
                return;
            const now = this.now();
            this.timeoutInfo = {
                phase: this.phase,
                idleMs: this.options.idleMs,
                elapsedMs: Math.max(0, now - this.startedAt),
                idleForMs: Math.max(0, now - this.lastActivityAt),
                lastStatus: this.lastStatus,
            };
            this.timedOut = true;
            this.active = false;
            this.timer = undefined;
            this.options.onTimeout();
        }, this.options.idleMs);
    }
    clear() {
        if (this.timer === undefined)
            return;
        const timers = this.getTimers();
        timers.clearTimeout(this.timer);
        this.timer = undefined;
    }
}
function getQuotaBlockedUntil(config, keyIndex, now) {
    const blockedUntil = config.quotaBlockedUntil[keyIndex];
    return typeof blockedUntil === "number" && Number.isFinite(blockedUntil) && blockedUntil > now
        ? blockedUntil
        : undefined;
}
/** Keys held by a live recorded block, optionally ignoring the key that just failed. */
function getQuotaBlockedTargets(config, now, skipKeyIndex) {
    const targets = [];
    for (let keyIndex = 0; keyIndex < config.keys.length; keyIndex++) {
        if (keyIndex === skipKeyIndex)
            continue;
        if (getQuotaBlockedUntil(config, keyIndex, now) === undefined)
            continue;
        const target = getUsageTargetForKeyIndex(config, keyIndex);
        if (target)
            targets.push(target);
    }
    return targets;
}
function pickAvailableKeyIndex(config, now = Date.now()) {
    const cdMs = getCooldownMs(config);
    for (let i = 0; i < config.keys.length; i++) {
        const idx = (config.activeKeyIndex + i) % config.keys.length;
        if (getQuotaBlockedUntil(config, idx, now) !== undefined)
            continue;
        const cooldownStart = config.cooldowns[idx];
        if (cooldownStart === undefined || now - cooldownStart >= cdMs)
            return idx;
    }
    return undefined;
}
function rotateToNextKey(config, options = {}) {
    if (config.keys.length === 0)
        return undefined;
    const now = options.now ?? Date.now();
    config.cooldowns[config.activeKeyIndex] = now;
    const next = pickAvailableKeyIndex(config, now);
    if (next !== undefined) {
        config.activeKeyIndex = next;
        return next;
    }
    for (let offset = 1; offset <= config.keys.length; offset++) {
        const candidate = (config.activeKeyIndex + offset) % config.keys.length;
        if (getQuotaBlockedUntil(config, candidate, now) !== undefined)
            continue;
        config.activeKeyIndex = candidate;
        delete config.cooldowns[candidate];
        return candidate;
    }
    return undefined;
}
// Key equality detects credential changes, but persisted history has no issuer
// provenance (including after reload). Never replay signed reasoning on this
// rotating route, even before this process observes its first rotation.
const droppedReasoningDetail = Symbol("dropped-caller-bound-reasoning");
function projectReasoningDetails(details) {
    // map/filter, never flatMap: entries that are not plain reasoning detail
    // objects (nested arrays, numbers, booleans, ...) must pass through as the
    // same element in the same position, with their original shape intact.
    return details
        .map((detail) => {
        if (!isRecord(detail))
            return detail;
        if (detail.type === "reasoning.encrypted")
            return droppedReasoningDetail;
        const { signature: _signature, ...unsigned } = detail;
        return unsigned;
    })
        .filter((detail) => detail !== droppedReasoningDetail);
}
/**
 * Anthropic serializes signed thinking as `thinking` blocks and opaque redacted
 * reasoning as `redacted_thinking`. Emit the SDK's own unsigned shape instead: a
 * plain text block. Drop entries emptied by that projection, and report an
 * assistant message for omission only when the projection emptied it.
 */
function projectAssistantContent(content) {
    let projected = false;
    const result = [];
    for (const block of content) {
        if (!isRecord(block)) {
            result.push(block);
            continue;
        }
        if (block.type === "thinking") {
            projected = true;
            const thinking = typeof block.thinking === "string" ? block.thinking : "";
            if (block.redacted !== true && thinking.trim().length > 0)
                result.push({ type: "text", text: thinking });
            continue;
        }
        if (block.type === "redacted_thinking") {
            projected = true;
            continue;
        }
        result.push(block);
    }
    if (!projected)
        return content;
    return result.length === 0 ? undefined : result;
}
function sanitizeReasoningPayload(payload) {
    if (!isRecord(payload))
        return payload;
    const request = { ...payload };
    if (Array.isArray(request.messages)) {
        const messages = [];
        for (const message of request.messages) {
            if (!isRecord(message) || message.role !== "assistant") {
                messages.push(message);
                continue;
            }
            let projected = message;
            if (Array.isArray(message.content)) {
                const content = projectAssistantContent(message.content);
                if (content === undefined)
                    continue;
                if (content !== message.content)
                    projected = { ...projected, content };
            }
            if (Array.isArray(message.reasoning_details)) {
                const { reasoning_details: _details, ...visible } = projected;
                const reasoning_details = projectReasoningDetails(message.reasoning_details);
                // Strip the key entirely when nothing remains to send: an empty array is an
                // unvalidated request shape, and this sanitiser exists to emit only shapes the
                // provider accepts. Non-detail entries above keep identity/position/shape.
                projected = reasoning_details.length === 0 ? visible : { ...visible, reasoning_details };
            }
            messages.push(projected);
        }
        request.messages = messages;
    }
    if (Array.isArray(request.input)) {
        request.input = request.input.filter((item) => !isRecord(item) || item.type !== "reasoning");
    }
    return request;
}
const lastAppliedRuntimeKeys = new WeakMap();
function getRuntimeKeyStore(modelRegistry) {
    const store = modelRegistry.authStorage ?? modelRegistry.runtime;
    if (!store)
        throw new Error("Model registry does not expose runtime API key storage");
    return store;
}
function ignoreAsyncRefresh(result) {
    void result?.catch(() => { });
}
/** Set the active key as runtime override (highest priority in auth chain). */
function applyActiveKey(config, modelRegistry, now = Date.now()) {
    const idx = pickAvailableKeyIndex(config, now);
    if (idx === undefined)
        return undefined;
    if (config.activeKeyIndex !== idx)
        config.activeKeyIndex = idx;
    const key = config.keys[idx].key;
    if (lastAppliedRuntimeKeys.get(modelRegistry) !== key) {
        lastAppliedRuntimeKeys.set(modelRegistry, key);
        ignoreAsyncRefresh(getRuntimeKeyStore(modelRegistry).setRuntimeApiKey(PROVIDER, key));
    }
    return config.keys[idx].name || `key-${idx + 1}`;
}
function getUsageTargetForKeyIndex(config, keyIndex) {
    const entry = config.keys[keyIndex];
    if (!entry)
        return undefined;
    return {
        keyIndex,
        keyName: entry.name || `key-${keyIndex + 1}`,
        bearerToken: entry.key,
    };
}
function getActiveUsageTarget(config) {
    return getUsageTargetForKeyIndex(config, config.activeKeyIndex);
}
function captureSelectionSnapshot(config, currentTime, keyIndex) {
    const target = getUsageTargetForKeyIndex(config, keyIndex);
    if (!target)
        return undefined;
    return {
        ...target,
        blockedUntil: getQuotaBlockedUntil(config, target.keyIndex, currentTime),
        cooldownStart: config.cooldowns[target.keyIndex],
    };
}
/**
 * A deferred decision owns one credential, selection, block and cooldown. Every later
 * mutation re-checks that exact snapshot under the lock, so an operation that started
 * before an external update can never write to the replacement state.
 */
function matchesSelectionSnapshot(config, snapshot, currentTime) {
    const entry = config.keys[snapshot.keyIndex];
    if (entry === undefined)
        return false;
    if ((entry.name || `key-${snapshot.keyIndex + 1}`) !== snapshot.keyName)
        return false;
    if (entry.key !== snapshot.bearerToken)
        return false;
    if (getQuotaBlockedUntil(config, snapshot.keyIndex, currentTime) !== snapshot.blockedUntil)
        return false;
    return config.cooldowns[snapshot.keyIndex] === snapshot.cooldownStart;
}
function captureRotationOperation(config, currentTime, keyIndex, epoch) {
    const selection = captureSelectionSnapshot(config, currentTime, keyIndex);
    return selection ? { epoch, currentTime, selection } : undefined;
}
function isRotationOperationCurrent(operation, config, epoch) {
    return epoch === operation.epoch
        && config.activeKeyIndex === operation.selection.keyIndex
        && matchesSelectionSnapshot(config, operation.selection, operation.currentTime);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function readNumber(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return undefined;
}
function parseOpenCodeGoUsageWindow(value) {
    if (!isRecord(value))
        return undefined;
    const status = value.status === "ok" || value.status === "active"
        ? "active"
        : value.status === "rate-limited" ? "rate-limited" : "unknown";
    const name = readString(value, ["name", "window", "period", "label"]);
    const usagePercent = readNumber(value, ["usagePercent", "usage_percent", "percent"]);
    const resetInSec = readNumber(value, ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds"]);
    const used = readNumber(value, ["used", "usage", "usedTokens"]);
    const limit = readNumber(value, ["limit", "quota", "total"]);
    const remaining = readNumber(value, ["remaining", "remainingTokens"]);
    const resetAt = readString(value, ["resetAt", "reset_at", "resetsAt", "resets_at"]);
    const startAt = readString(value, ["startAt", "start_at", "startsAt", "starts_at"]);
    const endAt = readString(value, ["endAt", "end_at", "endsAt", "ends_at"]);
    return {
        status,
        ...(name === undefined ? {} : { name }),
        ...(usagePercent === undefined ? {} : { usagePercent }),
        ...(resetInSec === undefined ? {} : { resetInSec }),
        ...(used === undefined ? {} : { used }),
        ...(limit === undefined ? {} : { limit }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(startAt === undefined ? {} : { startAt }),
        ...(endAt === undefined ? {} : { endAt }),
    };
}
export function parseOpenCodeGoUsage(value) {
    if (!isRecord(value))
        return undefined;
    const windows = [];
    if (Array.isArray(value.windows)) {
        for (const window of value.windows) {
            const parsed = parseOpenCodeGoUsageWindow(window);
            if (!parsed)
                return undefined;
            windows.push(parsed);
        }
        return { windows };
    }
    if (!isRecord(value.usage))
        return undefined;
    for (const [name, window] of Object.entries(value.usage)) {
        const parsed = parseOpenCodeGoUsageWindow(window);
        if (!parsed)
            return undefined;
        windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
    }
    return { windows };
}
async function fetchOpenCodeGoUsage(target, fetchApi, timers) {
    if (!target)
        return { ok: false, message: "No OpenCode keys configured." };
    const controller = new AbortController();
    const timeoutFailure = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
    const timerApi = timers ?? {
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    let didTimeout = false;
    let timeout;
    const request = (async () => {
        try {
            const response = await fetchApi(OPENCODE_GO_USAGE_URL, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${target.bearerToken}`,
                },
                signal: controller.signal,
            });
            if (!response.ok) {
                return { ok: false, keyName: target.keyName, message: `Usage request failed with HTTP ${response.status}.` };
            }
            const usage = parseOpenCodeGoUsage(await response.json());
            if (!usage)
                return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
            return { ok: true, keyName: target.keyName, usage };
        }
        catch {
            if (didTimeout)
                return timeoutFailure;
            return { ok: false, keyName: target.keyName, message: "Usage request failed." };
        }
    })();
    const timedOut = new Promise((resolve) => {
        timeout = timerApi.setTimeout(() => {
            didTimeout = true;
            controller.abort();
            resolve(timeoutFailure);
        }, OPENCODE_GO_USAGE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([request, timedOut]);
    }
    finally {
        timerApi.clearTimeout(timeout);
    }
}
function captureUsageDecision(config, epoch) {
    const target = getActiveUsageTarget(config);
    return target ? { epoch, target } : undefined;
}
function isValidUsageDecisionTarget(decision, config, epoch) {
    return epoch === decision.epoch && matchesUsageTarget(config, decision.target);
}
function matchesUsageTarget(config, target) {
    const entry = config.keys[target.keyIndex];
    return entry !== undefined
        && (entry.name || `key-${target.keyIndex + 1}`) === target.keyName
        && entry.key === target.bearerToken;
}
function hasRateLimitedUsageWindow(result) {
    return result.ok && result.usage.windows.some((window) => window.status === "rate-limited");
}
/**
 * A recorded block can go stale: the plan was topped up, or the window reset before the
 * deadline we stored. Only a clean reading releases it -- a failed or unrecognised usage
 * response is not evidence of headroom. A response with no windows, or with any window
 * that is not positively active, stays conservative and keeps the recorded block.
 */
function hasConfirmedHeadroom(result) {
    return result.ok
        && result.usage.windows.length > 0
        && result.usage.windows.every((window) => window.status === "active");
}
function getRateLimitedUntil(usage, now, fallbackMs) {
    let blockedUntil = now;
    for (const window of usage.windows) {
        if (window.status !== "rate-limited")
            continue;
        const resetTimes = [];
        if (window.resetInSec !== undefined) {
            const reset = now + window.resetInSec * 1000;
            if (Number.isFinite(reset) && reset > now)
                resetTimes.push(reset);
        }
        for (const timestamp of [window.resetAt, window.endAt]) {
            if (!timestamp)
                continue;
            const parsed = Date.parse(timestamp);
            if (Number.isFinite(parsed) && parsed > now)
                resetTimes.push(parsed);
        }
        blockedUntil = Math.max(blockedUntil, resetTimes.length > 0 ? Math.max(...resetTimes) : now + fallbackMs);
    }
    return blockedUntil > now ? blockedUntil : now + fallbackMs;
}
function parseFixedWindowQuotaReset(message, now) {
    const resetText = message.match(/\b(?:will\s+)?resets?(?:\s+at|\s+on)?\s+([^.;\n]+)/i)?.[1];
    if (resetText) {
        const parsed = Date.parse(resetText.trim());
        if (Number.isFinite(parsed) && parsed > now)
            return parsed;
    }
    return undefined;
}
function getEarliestQuotaReset(config, now) {
    const resets = Object.values(config.quotaBlockedUntil).filter((reset) => typeof reset === "number" && Number.isFinite(reset) && reset > now);
    return resets.length > 0 ? Math.min(...resets) : undefined;
}
function setQuotaBlock(config, keyIndex, blockedUntil, now) {
    config.quotaBlockedUntil[keyIndex] = Math.max(getQuotaBlockedUntil(config, keyIndex, now) ?? 0, blockedUntil);
}
function blockQuotaAndSelectNext(config, keyIndex, blockedUntil, now, isAuthoritative = false) {
    if (isAuthoritative) {
        config.quotaBlockedUntil[keyIndex] = blockedUntil;
    }
    else {
        setQuotaBlock(config, keyIndex, blockedUntil, now);
    }
    let next = pickAvailableKeyIndex(config, now);
    if (next === undefined) {
        for (let offset = 1; offset <= config.keys.length; offset++) {
            const candidate = (keyIndex + offset) % config.keys.length;
            if (getQuotaBlockedUntil(config, candidate, now) !== undefined)
                continue;
            next = candidate;
            delete config.cooldowns[candidate];
            break;
        }
    }
    if (next !== undefined)
        config.activeKeyIndex = next;
    return next;
}
function reindexAfterRemoval(record, removedIndex) {
    const shifted = {};
    for (const [key, value] of Object.entries(record)) {
        const index = Number(key);
        if (index === removedIndex)
            continue;
        shifted[index > removedIndex ? index - 1 : index] = value;
    }
    return shifted;
}
function formatUsageAmount(value) {
    return value === undefined ? undefined : value.toLocaleString("en-US");
}
export function formatResetIn(seconds) {
    if (seconds <= 0)
        return "now";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.ceil((seconds % 3_600) / 60);
    if (days > 0)
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0)
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return minutes > 0 ? `${minutes}m` : "less than 1m";
}
function formatUsageWindow(window, index) {
    const label = window.name ?? `window ${index + 1}`;
    const details = [`${label}: ${window.status}`];
    const used = formatUsageAmount(window.used);
    const limit = formatUsageAmount(window.limit);
    const remaining = formatUsageAmount(window.remaining);
    if (window.usagePercent !== undefined)
        details.push(`${Math.round(window.usagePercent)}% used`);
    if (used !== undefined && limit !== undefined)
        details.push(`${used}/${limit} used`);
    else if (used !== undefined)
        details.push(`${used} used`);
    if (remaining !== undefined)
        details.push(`${remaining} remaining`);
    if (window.resetInSec !== undefined)
        details.push(`resets in ${formatResetIn(window.resetInSec)}`);
    else if (window.resetAt)
        details.push(`resets ${window.resetAt}`);
    else if (window.endAt)
        details.push(`ends ${window.endAt}`);
    return details.join("; ");
}
export function formatUsageStatus(result) {
    if (!result.ok) {
        return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
    }
    if (result.usage.windows.length === 0)
        return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
    return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}
function formatStatus(config, now = Date.now()) {
    const watchdogStatus = `Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`;
    if (config.keys.length === 0) {
        return `No keys configured. Use /opencode add <name> <key>.\n${watchdogStatus}`;
    }
    const cdMs = getCooldownMs(config);
    return `${config.keys.map((key, i) => {
        const marker = i === config.activeKeyIndex ? "→" : " ";
        const cooldownStart = config.cooldowns[i];
        let tag = "";
        const quotaReset = getQuotaBlockedUntil(config, i, now);
        if (quotaReset !== undefined) {
            tag = ` [quota-blocked ${formatResetIn(Math.ceil((quotaReset - now) / 1000))}]`;
        }
        else if (cooldownStart !== undefined) {
            const remaining = cdMs - (now - cooldownStart);
            if (remaining > 0)
                tag = ` [cooldown ${Math.ceil(remaining / 60_000)}m]`;
        }
        return `${marker} ${i + 1}. ${key.name}${tag}`;
    }).join("\n")}\n${watchdogStatus}`;
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
function formatTimeoutInfo(info) {
    const status = info.lastStatus === undefined ? "" : `, last HTTP ${info.lastStatus}`;
    return `${info.phase.replaceAll("-", " ")} stalled after ${formatDuration(info.elapsedMs)} (${formatDuration(info.idleForMs)} idle${status})`;
}
function formatWatchdogEvents(events, now = Date.now()) {
    if (events.length === 0)
        return "No OpenCode Go watchdog timeouts recorded this session.";
    return events
        .slice()
        .reverse()
        .map((event, index) => {
        const age = formatDuration(now - event.time);
        const key = event.keyName ? ` key=${event.keyName}` : "";
        const rotation = event.rotatedTo ? ` rotated=${event.rotatedTo}` : event.activeKey ? ` using=${event.activeKey}` : " rotated=none";
        const status = event.lastStatus === undefined ? "" : ` status=${event.lastStatus}`;
        return `${index + 1}. ${age} ago ${event.phase.replaceAll("-", " ")}${status}${key}${rotation} elapsed=${formatDuration(event.elapsedMs)} idle=${formatDuration(event.idleForMs)}`;
    })
        .join("\n");
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export function createOpencodeGoRotationExtension(options = {}) {
    return function opencodeGoRotationExtension(pi) {
        let config = createEmptyConfig();
        let configError;
        let watchdog;
        let watchdogAbortPending = false;
        let watchdogAbortMessage;
        let watchdogTimeoutInfo;
        let watchdogRequestTimedOut = false;
        let usageDecisionEpoch = 0;
        let requestRateLimitState;
        const watchdogEvents = [];
        /** Key currently advertised through the provider registry, if any. */
        let registeredProviderKey;
        const now = () => options.clock?.now() ?? Date.now();
        const fetchApi = options.fetch ?? globalThis.fetch.bind(globalThis);
        function formatConfigError(error) {
            if (error instanceof ConfigLoadError)
                return error.message;
            if (error instanceof Error)
                return error.message;
            return "Unknown configuration error";
        }
        function refreshConfig() {
            try {
                config = loadConfig();
                configError = undefined;
                return true;
            }
            catch (error) {
                configError = formatConfigError(error);
                return false;
            }
        }
        function mutateSharedConfig(mutator) {
            try {
                const updated = updateConfig(mutator);
                config = updated.config;
                configError = undefined;
                syncRegisteredProvider();
                return updated.result;
            }
            catch (error) {
                configError = formatConfigError(error);
                return undefined;
            }
        }
        function ensureConfig(ctx) {
            if (refreshConfig())
                return true;
            ctx.ui.notify(`OpenCode: ${configError}. No configuration was changed.`, "error");
            return false;
        }
        /**
         * Advertise the current key through the provider registry.
         *
         * Pi resolves `enabledModels`/scoped models during startup, before
         * `session_start` runs, so a runtime key applied there is too late: every
         * configured opencode-go pattern fails to match and the saved selection is
         * dropped. Registering a key at load time marks the provider as configured
         * for startup selection; the per-request runtime override still rotates keys.
         */
        function syncRegisteredProvider() {
            const api = pi;
            if (typeof api.registerProvider !== "function")
                return;
            const availableIndex = pickAvailableKeyIndex(config, now());
            const entry = (availableIndex === undefined ? config.keys[config.activeKeyIndex] : config.keys[availableIndex])
                ?? config.keys[0];
            if (!entry) {
                if (registeredProviderKey !== undefined) {
                    registeredProviderKey = undefined;
                    api.unregisterProvider?.(PROVIDER);
                }
                return;
            }
            if (entry.key === registeredProviderKey)
                return;
            registeredProviderKey = entry.key;
            api.registerProvider(PROVIDER, { apiKey: entry.key });
        }
        function applySynchronizedActiveKey(ctx) {
            if (!refreshConfig())
                return undefined;
            const availableIndex = pickAvailableKeyIndex(config, now());
            if (availableIndex !== undefined && availableIndex !== config.activeKeyIndex) {
                const selectedIndex = mutateSharedConfig((freshConfig) => {
                    const freshAvailableIndex = pickAvailableKeyIndex(freshConfig, now());
                    if (freshAvailableIndex !== undefined)
                        freshConfig.activeKeyIndex = freshAvailableIndex;
                    return freshAvailableIndex;
                });
                if (selectedIndex === undefined)
                    return undefined;
            }
            const keyName = applyActiveKey(config, ctx.modelRegistry, now());
            syncRegisteredProvider();
            return keyName;
        }
        function invalidateAutomaticDecisions() {
            usageDecisionEpoch++;
        }
        function beginProviderRequest(ctx) {
            invalidateAutomaticDecisions();
            if (applySynchronizedActiveKey(ctx) === undefined) {
                requestRateLimitState = undefined;
                return;
            }
            const decision = captureUsageDecision(config, usageDecisionEpoch);
            requestRateLimitState = decision ? { decision, responseHandled: false } : undefined;
        }
        function getCurrentRequestRateLimitState() {
            if (!requestRateLimitState)
                return undefined;
            return isValidUsageDecisionTarget(requestRateLimitState.decision, config, usageDecisionEpoch)
                ? requestRateLimitState
                : undefined;
        }
        function markResponseRateLimitHandled(decision) {
            requestRateLimitState = {
                decision: { ...decision, epoch: usageDecisionEpoch },
                responseHandled: true,
            };
        }
        function currentRotationOperation(currentTime) {
            return captureRotationOperation(config, currentTime, config.activeKeyIndex, usageDecisionEpoch);
        }
        /** Post-await effects are allowed only while the completed decision still owns the state. */
        function isCompletionCurrent(outcome) {
            return (outcome.kind === "rotated" || outcome.kind === "none")
                && refreshConfig()
                && isRotationOperationCurrent(outcome.completion, config, usageDecisionEpoch);
        }
        /**
         * A benched key can become usable again after we recorded its block. Probe the blocked
         * keys without mutating anything; only a positive reading is collected as candidate
         * headroom. The probes are data-only, so a stale result can never be applied without the
         * guarded commit re-checking the credential, block and cooldown it was sampled from.
         */
        async function probeRecoveredHeadroom(currentTime, skipKeyIndex) {
            if (!refreshConfig())
                return [];
            const candidates = getQuotaBlockedTargets(config, currentTime, skipKeyIndex)
                .map((target) => captureSelectionSnapshot(config, currentTime, target.keyIndex))
                .filter((snapshot) => snapshot !== undefined);
            const recovered = [];
            for (const candidate of candidates) {
                const usage = await fetchOpenCodeGoUsage(candidate, fetchApi, options.timers);
                if (hasConfirmedHeadroom(usage))
                    recovered.push(candidate);
                // Keep the in-memory config aligned with writers active during the probes.
                if (!refreshConfig())
                    break;
            }
            return recovered;
        }
        function selectNextKey(mode, freshConfig, startIndex, currentTime) {
            return mode.kind === "quota"
                ? blockQuotaAndSelectNext(freshConfig, startIndex, mode.blockedUntil, currentTime, mode.authoritative)
                : rotateToNextKey(freshConfig, { now: currentTime });
        }
        /**
         * Block the failed key and select a replacement, re-probing benched keys only when the
         * fast path found nothing. Every mutation re-validates the operation snapshot under the
         * lock, so a decision invalidated while probes were in flight is cancelled instead of
         * being rebased onto the newer state.
         */
        async function rotateWithRecovery(ctx, operation, currentTime, mode) {
            const startIndex = operation.selection.keyIndex;
            const fast = mutateSharedConfig((freshConfig) => {
                if (!isRotationOperationCurrent(operation, freshConfig, usageDecisionEpoch)) {
                    return { outcome: "cancelled" };
                }
                return { outcome: "done", value: selectNextKey(mode, freshConfig, startIndex, currentTime) };
            });
            if (fast === undefined)
                return { kind: "unavailable" };
            if (fast.outcome === "cancelled")
                return { kind: "cancelled" };
            if (fast.value !== undefined && fast.value !== startIndex) {
                const completion = currentRotationOperation(currentTime);
                return completion ? { kind: "rotated", keyIndex: fast.value, completion } : { kind: "cancelled" };
            }
            // Snapshot the state this operation just produced, so a later commit can detect any
            // external change to the same credential, block, cooldown or selection.
            const retryOperation = currentRotationOperation(currentTime);
            const failedKey = captureSelectionSnapshot(config, currentTime, startIndex);
            if (!retryOperation || !failedKey)
                return { kind: "cancelled" };
            const recovered = await probeRecoveredHeadroom(currentTime, startIndex);
            if (configError)
                return { kind: "unavailable" };
            if (usageDecisionEpoch !== operation.epoch)
                return { kind: "cancelled" };
            if (recovered.length === 0) {
                // Still verify the state this operation owns: a shared writer may have moved the
                // selection, credential, block or cooldown while the probes were in flight.
                const current = matchesSelectionSnapshot(config, failedKey, currentTime)
                    && isRotationOperationCurrent(retryOperation, config, usageDecisionEpoch);
                return current ? { kind: "none", completion: retryOperation } : { kind: "cancelled" };
            }
            const commit = mutateSharedConfig((freshConfig) => {
                if (!isRotationOperationCurrent(retryOperation, freshConfig, usageDecisionEpoch))
                    return { outcome: "cancelled" };
                if (!matchesSelectionSnapshot(freshConfig, failedKey, currentTime))
                    return { outcome: "cancelled" };
                if (!recovered.every((snapshot) => matchesSelectionSnapshot(freshConfig, snapshot, currentTime)))
                    return { outcome: "cancelled" };
                for (const snapshot of recovered) {
                    delete freshConfig.quotaBlockedUntil[snapshot.keyIndex];
                    delete freshConfig.cooldowns[snapshot.keyIndex];
                }
                return { outcome: "done", value: selectNextKey(mode, freshConfig, startIndex, currentTime) };
            });
            if (commit === undefined)
                return { kind: "unavailable" };
            if (commit.outcome === "cancelled")
                return { kind: "cancelled" };
            for (const snapshot of recovered) {
                ctx.ui.notify(`OpenCode: ${snapshot.keyName} has headroom again → quota block cleared`, "info");
            }
            const completion = currentRotationOperation(currentTime);
            if (!completion)
                return { kind: "cancelled" };
            const selected = commit.value;
            return selected === undefined || selected === startIndex
                ? { kind: "none", completion }
                : { kind: "rotated", keyIndex: selected, completion };
        }
        /** Guarded startup/reload recovery: clears only blocks whose snapshot is still current. */
        async function recoverQuotaBlocksGuarded(ctx, operation, currentTime) {
            const recovered = await probeRecoveredHeadroom(currentTime);
            if (configError)
                return "unavailable";
            if (usageDecisionEpoch !== operation.epoch)
                return "cancelled";
            if (recovered.length === 0) {
                return isRotationOperationCurrent(operation, config, usageDecisionEpoch) ? "none" : "cancelled";
            }
            const commit = mutateSharedConfig((freshConfig) => {
                if (!isRotationOperationCurrent(operation, freshConfig, usageDecisionEpoch))
                    return { outcome: "cancelled" };
                if (!recovered.every((snapshot) => matchesSelectionSnapshot(freshConfig, snapshot, currentTime)))
                    return { outcome: "cancelled" };
                for (const snapshot of recovered) {
                    delete freshConfig.quotaBlockedUntil[snapshot.keyIndex];
                    delete freshConfig.cooldowns[snapshot.keyIndex];
                }
                return { outcome: "done", value: true };
            });
            if (commit === undefined)
                return "unavailable";
            if (commit.outcome === "cancelled")
                return "cancelled";
            for (const snapshot of recovered) {
                ctx.ui.notify(`OpenCode: ${snapshot.keyName} has headroom again → quota block cleared`, "info");
            }
            return "recovered";
        }
        function reportQuotaExhausted(ctx, exhaustedName, currentTime) {
            if (configError) {
                ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                return;
            }
            invalidateAutomaticDecisions();
            const earliestReset = getEarliestQuotaReset(config, currentTime);
            const reset = earliestReset === undefined
                ? "an unknown reset time"
                : formatResetIn(Math.ceil((earliestReset - currentTime) / 1000));
            ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota; all configured keys are quota-blocked. Earliest reset in ${reset}.`, "warning");
        }
        function stopWatchdog() {
            const timeoutInfo = watchdog?.consumeTimeoutInfo();
            watchdog?.stop();
            watchdog = undefined;
            return timeoutInfo;
        }
        function resetWatchdogAbortState() {
            watchdogAbortPending = false;
            watchdogAbortMessage = undefined;
            watchdogTimeoutInfo = undefined;
        }
        function clearWatchdogTimeoutGuard() {
            watchdogRequestTimedOut = false;
        }
        function recordWatchdogEvent(event) {
            watchdogEvents.push(event);
            while (watchdogEvents.length > 10)
                watchdogEvents.shift();
        }
        function rotateForWatchdog(ctx, timeoutInfo, rateLimitAlreadyRotated) {
            if (!refreshConfig())
                return { rotated: false };
            const currentTime = now();
            if (config.keys.length <= 1)
                return { rotated: false };
            if (shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated)) {
                const previousIndex = config.activeKeyIndex;
                const nextIndex = mutateSharedConfig((freshConfig) => rotateToNextKey(freshConfig, { now: currentTime }));
                if (nextIndex === undefined)
                    return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
                const rotated = nextIndex !== previousIndex;
                if (rotated)
                    invalidateAutomaticDecisions();
                return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated };
            }
            return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
        }
        function startWatchdog(ctx) {
            if (!refreshConfig())
                return;
            applyActiveKey(config, ctx.modelRegistry, now());
            stopWatchdog();
            resetWatchdogAbortState();
            clearWatchdogTimeoutGuard();
            if (!config.watchdogEnabled)
                return;
            const idleMs = getWatchdogIdleMs(config);
            watchdog = new ProviderIdleWatchdog({
                idleMs,
                onTimeout: () => {
                    const rateLimitAlreadyHandled = getCurrentRequestRateLimitState()?.responseHandled ?? false;
                    invalidateAutomaticDecisions();
                    watchdogRequestTimedOut = true;
                    const timeoutInfo = watchdog?.currentTimeoutInfo() ?? {
                        phase: "waiting-for-response",
                        idleMs,
                        elapsedMs: idleMs,
                        idleForMs: idleMs,
                    };
                    const previousKey = config.keys[config.activeKeyIndex]?.name;
                    const rotation = rotateForWatchdog(ctx, timeoutInfo, rateLimitAlreadyHandled);
                    watchdogTimeoutInfo = timeoutInfo;
                    recordWatchdogEvent({
                        time: now(),
                        keyName: previousKey,
                        rotatedTo: rotation.rotated ? rotation.keyName : undefined,
                        activeKey: rotation.keyName,
                        ...timeoutInfo,
                    });
                    watchdogAbortPending = true;
                    watchdogAbortMessage = rotation.keyName
                        ? `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; ${rotation.rotated ? "rotated to" : "using"} ${rotation.keyName}; retrying.`
                        : `OpenCode Go timeout: ${formatTimeoutInfo(timeoutInfo)}; no other key available.`;
                    ctx.ui.notify(watchdogAbortMessage, rotation.keyName ? "info" : "warning");
                    ctx.abort();
                },
                timers: options.timers,
                clock: options.clock,
            });
            watchdog.start();
        }
        async function autoImportFromAuth(ctx) {
            const authKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
            if (!authKey)
                return false;
            const imported = mutateSharedConfig((freshConfig) => {
                if (freshConfig.keys.some((entry) => entry.key === authKey))
                    return false;
                freshConfig.keys.push({ name: "auth", key: authKey });
                return true;
            });
            return imported === true;
        }
        // Resolve the active key before Pi's startup model selection runs, so saved
        // enabledModels/scoped models keep matching this provider. The runtime key
        // override still follows rotations per request.
        refreshConfig();
        syncRegisteredProvider();
        pi.on("session_start", async (event, ctx) => {
            lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
            invalidateAutomaticDecisions();
            requestRateLimitState = undefined;
            clearWatchdogTimeoutGuard();
            if (!ensureConfig(ctx))
                return;
            // A block recorded in an earlier session can be stale: the plan was topped up, or the
            // window reset before the deadline we stored. Re-check before it decides which key this
            // session uses, rather than benching a key that is usable again -- or leaving every key
            // held by a block with nothing left to rotate to.
            if (config.keys.length > 0) {
                const currentTime = now();
                const activeBlocked = getQuotaBlockedUntil(config, config.activeKeyIndex, currentTime) !== undefined;
                if (activeBlocked || pickAvailableKeyIndex(config, currentTime) === undefined) {
                    const operation = currentRotationOperation(currentTime);
                    if (!operation)
                        return;
                    const recovery = await recoverQuotaBlocksGuarded(ctx, operation, currentTime);
                    // A startup continuation invalidated while probes were in flight must not
                    // clear blocks or re-apply a key on top of the newer decision.
                    if (recovery === "cancelled")
                        return;
                    if (usageDecisionEpoch !== operation.epoch)
                        return;
                    if (!refreshConfig())
                        return;
                }
            }
            // On reload: re-apply active key, skip auto-import
            if (event.reason === "reload") {
                const keyName = applySynchronizedActiveKey(ctx);
                if (keyName)
                    ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
                return;
            }
            if (config.keys.length === 0) {
                if (await autoImportFromAuth(ctx)) {
                    const keyName = applySynchronizedActiveKey(ctx);
                    if (keyName)
                        ctx.ui.notify(`OpenCode: Imported key from auth.json → ${keyName}`, "info");
                }
                else if (configError) {
                    ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                    return;
                }
                else {
                    ctx.ui.notify("OpenCode: No keys configured. Use /opencode add <name> <key>", "warning");
                    return;
                }
            }
            const keyName = applySynchronizedActiveKey(ctx);
            if (keyName)
                ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
        });
        pi.on("before_provider_request", (event, ctx) => {
            if (!shouldWatchProvider(ctx.model?.provider)) {
                invalidateAutomaticDecisions();
                requestRateLimitState = undefined;
                stopWatchdog();
                resetWatchdogAbortState();
                clearWatchdogTimeoutGuard();
                return;
            }
            beginProviderRequest(ctx);
            startWatchdog(ctx);
            return sanitizeReasoningPayload(event.payload);
        });
        pi.on("message_update", (event) => {
            const message = event.message;
            if (message.role !== "assistant" || !shouldWatchProvider(message.provider))
                return;
            watchdog?.streamActivity();
        });
        pi.on("message_end", async (event, ctx) => {
            const message = event.message;
            if (message.role !== "assistant" || message.provider !== PROVIDER)
                return;
            const timeoutInfo = stopWatchdog() ?? watchdogTimeoutInfo;
            if (timeoutInfo || watchdogAbortPending) {
                const errorMessage = watchdogAbortMessage ?? `OpenCode Go timeout: ${timeoutInfo ? formatTimeoutInfo(timeoutInfo) : "no provider activity"}; retrying.`;
                resetWatchdogAbortState();
                return {
                    message: {
                        ...message,
                        stopReason: "error",
                        errorMessage,
                    },
                };
            }
            if (message.stopReason !== "error") {
                invalidateAutomaticDecisions();
                return;
            }
            const rateLimitKind = classifyRateLimitError(message.errorMessage ?? "");
            if (!rateLimitKind) {
                invalidateAutomaticDecisions();
                return;
            }
            if (!refreshConfig())
                return;
            const requestState = getCurrentRequestRateLimitState();
            if (!requestState)
                return;
            if (rateLimitKind === "fixed-window-quota") {
                const currentTime = now();
                const authoritativeReset = parseFixedWindowQuotaReset(message.errorMessage ?? "", currentTime);
                const blockedUntil = authoritativeReset ?? currentTime + getCooldownMs(config);
                const exhaustedName = config.keys[requestState.decision.target.keyIndex]?.name
                    || `key-${requestState.decision.target.keyIndex + 1}`;
                if (requestState.responseHandled) {
                    const persisted = mutateSharedConfig((freshConfig) => {
                        // The handled response may upgrade the reset of its own credential, but never
                        // of whatever credential now occupies that index.
                        if (!matchesUsageTarget(freshConfig, requestState.decision.target))
                            return false;
                        if (authoritativeReset === undefined) {
                            setQuotaBlock(freshConfig, requestState.decision.target.keyIndex, blockedUntil, currentTime);
                        }
                        else {
                            freshConfig.quotaBlockedUntil[requestState.decision.target.keyIndex] = authoritativeReset;
                        }
                        return true;
                    });
                    if (persisted !== true && configError)
                        ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                    invalidateAutomaticDecisions();
                    return;
                }
                const operation = currentRotationOperation(currentTime);
                if (!operation || operation.selection.keyIndex !== requestState.decision.target.keyIndex)
                    return;
                const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
                    kind: "quota",
                    blockedUntil,
                    authoritative: authoritativeReset !== undefined,
                });
                if (outcome.kind === "cancelled")
                    return;
                if (outcome.kind === "unavailable") {
                    if (usageDecisionEpoch !== operation.epoch)
                        return;
                    reportQuotaExhausted(ctx, exhaustedName, currentTime);
                    return;
                }
                if (!isCompletionCurrent(outcome))
                    return;
                if (outcome.kind === "none") {
                    reportQuotaExhausted(ctx, exhaustedName, currentTime);
                    return;
                }
                invalidateAutomaticDecisions();
                const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime) ?? `key-${outcome.keyIndex + 1}`;
                ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
                return;
            }
            if (requestState.responseHandled) {
                invalidateAutomaticDecisions();
                return;
            }
            if (config.keys.length <= 1) {
                invalidateAutomaticDecisions();
                ctx.ui.notify("OpenCode: Rate limited — no other keys to rotate to.", "warning");
                return;
            }
            const currentTime = now();
            const operation = currentRotationOperation(currentTime);
            if (!operation || operation.selection.keyIndex !== requestState.decision.target.keyIndex)
                return;
            const outcome = await rotateWithRecovery(ctx, operation, currentTime, { kind: "cooldown" });
            if (outcome.kind === "cancelled")
                return;
            if (outcome.kind === "unavailable") {
                if (usageDecisionEpoch !== operation.epoch)
                    return;
                ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                return;
            }
            // Never finalize a decision that lost ownership while the rotation was in flight.
            if (!isCompletionCurrent(outcome))
                return;
            if (outcome.kind === "none") {
                invalidateAutomaticDecisions();
                ctx.ui.notify("OpenCode: Rate limited; all other keys are quota-blocked.", "warning");
                return;
            }
            invalidateAutomaticDecisions();
            const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
            ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${outcome.keyIndex + 1}`}`, "info");
        });
        pi.on("after_provider_response", async (event, ctx) => {
            if (ctx.model?.provider !== PROVIDER)
                return;
            watchdog?.response(event.status);
            if (event.status !== 429 && event.status !== 401)
                return;
            if (watchdogRequestTimedOut)
                return;
            if (!refreshConfig())
                return;
            const requestState = getCurrentRequestRateLimitState();
            if (!requestState)
                return;
            const decision = requestState.decision;
            const operation = currentRotationOperation(now());
            if (!operation || operation.selection.keyIndex !== decision.target.keyIndex)
                return;
            // Bookkeeping for this response is allowed only while it still owns the request state.
            const markHandledIfOwned = () => {
                if (requestRateLimitState === requestState)
                    markResponseRateLimitHandled(decision);
            };
            if (event.status === 401)
                requestRateLimitState = undefined;
            const usage = await fetchOpenCodeGoUsage(decision.target, fetchApi, options.timers);
            if (!refreshConfig())
                return;
            if (!isRotationOperationCurrent(operation, config, usageDecisionEpoch))
                return;
            const currentTime = now();
            const exhaustedName = config.keys[decision.target.keyIndex]?.name || `key-${decision.target.keyIndex + 1}`;
            if (usage.ok && hasRateLimitedUsageWindow(usage)) {
                const outcome = await rotateWithRecovery(ctx, operation, currentTime, {
                    kind: "quota",
                    blockedUntil: getRateLimitedUntil(usage.usage, currentTime, getCooldownMs(config)),
                    authoritative: false,
                });
                if (outcome.kind === "cancelled")
                    return;
                if (outcome.kind === "unavailable") {
                    if (usageDecisionEpoch !== operation.epoch)
                        return;
                    reportQuotaExhausted(ctx, exhaustedName, currentTime);
                }
                else if (!isCompletionCurrent(outcome)) {
                    return;
                }
                else if (outcome.kind === "rotated") {
                    invalidateAutomaticDecisions();
                    const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime) ?? `key-${outcome.keyIndex + 1}`;
                    ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
                }
                else {
                    reportQuotaExhausted(ctx, exhaustedName, currentTime);
                }
                if (event.status === 429)
                    markHandledIfOwned();
                ctx.ui.notify(formatUsageStatus(usage), "warning");
                return;
            }
            if (event.status === 401)
                return;
            if (config.keys.length <= 1) {
                markHandledIfOwned();
                return;
            }
            const outcome = await rotateWithRecovery(ctx, operation, currentTime, { kind: "cooldown" });
            if (outcome.kind === "cancelled")
                return;
            if (outcome.kind === "unavailable") {
                if (usageDecisionEpoch !== operation.epoch)
                    return;
                if (configError)
                    ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                else {
                    invalidateAutomaticDecisions();
                    markHandledIfOwned();
                    ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
                }
                return;
            }
            if (!isCompletionCurrent(outcome))
                return;
            if (outcome.kind === "none") {
                if (configError)
                    ctx.ui.notify(`OpenCode: ${configError}. Automatic rotation was skipped.`, "error");
                else {
                    invalidateAutomaticDecisions();
                    markHandledIfOwned();
                    ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
                }
                return;
            }
            invalidateAutomaticDecisions();
            markHandledIfOwned();
            const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
            ctx.ui.notify(`OpenCode: Proactive rate-limit detection (HTTP 429) → rotated to ${keyName ?? `key-${outcome.keyIndex + 1}`}`, "info");
        });
        pi.registerCommand("opencode", {
            description: "Manage OpenCode API key rotation",
            handler: async (args, ctx) => {
                if (!ensureConfig(ctx))
                    return;
                const parts = args.trim().split(/\s+/);
                const subcommand = parts[0] || "status";
                const indexArg = parseInt(parts[1] ?? "", 10);
                switch (subcommand) {
                    case "status":
                    case "list":
                    case "ls": {
                        const status = formatStatus(config, now());
                        ctx.ui.notify(status, "info");
                        break;
                    }
                    case "events":
                    case "timeouts": {
                        ctx.ui.notify(formatWatchdogEvents(watchdogEvents, now()), "info");
                        break;
                    }
                    case "usage":
                    case "quota": {
                        applySynchronizedActiveKey(ctx);
                        const usage = await fetchOpenCodeGoUsage(getActiveUsageTarget(config), fetchApi, options.timers);
                        ctx.ui.notify(formatUsageStatus(usage), usage.ok ? "info" : "warning");
                        break;
                    }
                    case "use": {
                        const targetIndex = indexArg - 1;
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= freshConfig.keys.length) {
                                return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
                            }
                            freshConfig.activeKeyIndex = targetIndex;
                            delete freshConfig.cooldowns[targetIndex];
                            delete freshConfig.quotaBlockedUntil[targetIndex];
                            return { index: targetIndex };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        const keyName = applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Switched to ${keyName}`, "info");
                        break;
                    }
                    case "next": {
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (freshConfig.keys.length === 0)
                                return { error: "No keys configured. Use /opencode add <name> <key>." };
                            freshConfig.activeKeyIndex = (freshConfig.activeKeyIndex + 1) % freshConfig.keys.length;
                            delete freshConfig.cooldowns[freshConfig.activeKeyIndex];
                            delete freshConfig.quotaBlockedUntil[freshConfig.activeKeyIndex];
                            return { index: freshConfig.activeKeyIndex };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        const keyName = applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Switched to ${keyName}`, "info");
                        break;
                    }
                    case "add": {
                        const name = parts[1];
                        const key = parts[2];
                        if (!name || !key) {
                            ctx.ui.notify("Usage: /opencode add <name> <key>", "warning");
                            return;
                        }
                        invalidateAutomaticDecisions();
                        const count = mutateSharedConfig((freshConfig) => {
                            freshConfig.keys.push({ name, key });
                            if (freshConfig.keys.length === 1)
                                freshConfig.activeKeyIndex = 0;
                            return freshConfig.keys.length;
                        });
                        if (count === undefined) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if (count === 1)
                            applyActiveKey(config, ctx.modelRegistry, now());
                        ctx.ui.notify(`Added "${name}" (${count} keys)`, "info");
                        break;
                    }
                    case "remove":
                    case "rm": {
                        const removeIndex = indexArg - 1;
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            if (isNaN(removeIndex) || removeIndex < 0 || removeIndex >= freshConfig.keys.length) {
                                return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
                            }
                            const removed = freshConfig.keys.splice(removeIndex, 1)[0];
                            freshConfig.cooldowns = reindexAfterRemoval(freshConfig.cooldowns, removeIndex);
                            freshConfig.quotaBlockedUntil = reindexAfterRemoval(freshConfig.quotaBlockedUntil, removeIndex);
                            if (freshConfig.activeKeyIndex >= freshConfig.keys.length)
                                freshConfig.activeKeyIndex = 0;
                            else if (removeIndex < freshConfig.activeKeyIndex)
                                freshConfig.activeKeyIndex--;
                            return { removedName: removed.name, count: freshConfig.keys.length };
                        });
                        if (!result) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        if ("error" in result && typeof result.error === "string") {
                            ctx.ui.notify(result.error, "warning");
                            return;
                        }
                        if (config.keys.length > 0)
                            applyActiveKey(config, ctx.modelRegistry, now());
                        else {
                            lastAppliedRuntimeKeys.delete(ctx.modelRegistry);
                            ignoreAsyncRefresh(getRuntimeKeyStore(ctx.modelRegistry).removeRuntimeApiKey(PROVIDER));
                        }
                        ctx.ui.notify(`Removed "${result.removedName}" (${result.count} left)`, "info");
                        break;
                    }
                    case "reset": {
                        invalidateAutomaticDecisions();
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.cooldowns = {};
                            freshConfig.quotaBlockedUntil = {};
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify("All cooldowns and quota blocks cleared", "info");
                        break;
                    }
                    case "cooldown": {
                        const minutes = parseInt(parts[1], 10);
                        if (isNaN(minutes) || minutes < 1) {
                            ctx.ui.notify(`Cooldown: ${config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES} min`, "info");
                            return;
                        }
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.cooldownMinutes = minutes;
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify(`Cooldown set to ${minutes} min`, "info");
                        break;
                    }
                    case "watchdog": {
                        const value = parts[1];
                        if (!value || value === "status") {
                            const events = formatWatchdogEvents(watchdogEvents, now());
                            ctx.ui.notify(`Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)\n${events}`, "info");
                            return;
                        }
                        if (value === "on" || value === "off") {
                            const enabled = value === "on";
                            const result = mutateSharedConfig((freshConfig) => {
                                freshConfig.watchdogEnabled = enabled;
                                return true;
                            });
                            if (result !== true) {
                                if (configError)
                                    ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                                return;
                            }
                            if (!enabled) {
                                stopWatchdog();
                                resetWatchdogAbortState();
                            }
                            ctx.ui.notify(enabled ? `Watchdog enabled (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)` : "Watchdog disabled", "info");
                            return;
                        }
                        const seconds = parseInt(value, 10);
                        if (isNaN(seconds) || seconds < 1) {
                            ctx.ui.notify("Usage: /opencode watchdog [status|on|off|<seconds>]", "warning");
                            return;
                        }
                        const result = mutateSharedConfig((freshConfig) => {
                            freshConfig.watchdogEnabled = true;
                            freshConfig.watchdogIdleMs = seconds * 1000;
                            return true;
                        });
                        if (result !== true) {
                            if (configError)
                                ctx.ui.notify(`OpenCode: ${configError}.`, "error");
                            return;
                        }
                        ctx.ui.notify(`Watchdog enabled (${seconds}s idle)`, "info");
                        break;
                    }
                    default:
                        ctx.ui.notify("Usage: /opencode [status|usage|quota|events|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|watchdog [status|on|off|<seconds>]]", "info");
                }
            },
        });
        function cleanupLifecycleState() {
            invalidateAutomaticDecisions();
            requestRateLimitState = undefined;
            stopWatchdog();
            resetWatchdogAbortState();
            clearWatchdogTimeoutGuard();
        }
        pi.on("agent_end", () => {
            cleanupLifecycleState();
        });
        pi.on("session_shutdown", () => {
            cleanupLifecycleState();
        });
    };
}
const extension = createOpencodeGoRotationExtension();
export default extension;
