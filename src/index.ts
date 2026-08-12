import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PROVIDER = "opencode-go";
const CONFIG_PATH_ENV = "PI_OPENCODE_ROTATION_CONFIG";
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_WATCHDOG_IDLE_MS = 90_000;
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USAGE_TIMEOUT_MS = 10_000;
const FIXED_WINDOW_QUOTA_RE = /\b(?:5[- ]hour|weekly|monthly)\b[\s\S]*\b(?:usage\s+)?(?:quota|limit)\b|\b(?:usage|plan)\s+allocated\s+quota\s+exceeded\b|\b(?:quota|limit)\b[\s\S]*\b(?:will\s+reset|resets?\s+at|fixed[- ]window)\b/i;
const TRANSIENT_RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;


interface KeyEntry {
	name: string;
	key: string;
}

interface Config {
	keys: KeyEntry[];
	activeKeyIndex: number;
	cooldownMinutes: number;
	watchdogEnabled: boolean;
	watchdogIdleMs: number;
	/** Key index → epoch ms when cooldown started */
	cooldowns: Record<number, number>;
	quotaBlockedUntil: Record<number, number>;
}

const EMPTY_CONFIG: Config = {
	keys: [],
	activeKeyIndex: 0,
	cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
	watchdogEnabled: true,
	watchdogIdleMs: DEFAULT_WATCHDOG_IDLE_MS,
	cooldowns: {},
	quotaBlockedUntil: {},
};

function getConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? join(homedir(), ".pi", "agent", "opencode-keys.json");
}


function loadConfig(): Config {
	const path = getConfigPath();
	if (!existsSync(path)) return { ...EMPTY_CONFIG, cooldowns: {}, quotaBlockedUntil: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return {
			...EMPTY_CONFIG,
			...parsed,
			cooldowns: parsed.cooldowns ?? {},
			quotaBlockedUntil: parsed.quotaBlockedUntil ?? {},
		};
	} catch {
		return { ...EMPTY_CONFIG, cooldowns: {}, quotaBlockedUntil: {} };
	}
}

function saveConfig(config: Config): void {
	const path = getConfigPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function getCooldownMs(config: Config): number {
	return (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60_000;
}

function getWatchdogIdleMs(config: Config): number {
	return config.watchdogIdleMs > 0 ? config.watchdogIdleMs : DEFAULT_WATCHDOG_IDLE_MS;
}

export function shouldWatchProvider(provider: string | undefined): boolean {
	return provider === PROVIDER;
}

export type RateLimitKind = "transient" | "fixed-window-quota";

export function classifyRateLimitError(message: string): RateLimitKind | undefined {
	if (FIXED_WINDOW_QUOTA_RE.test(message)) return "fixed-window-quota";
	if (TRANSIENT_RATE_LIMIT_RE.test(message)) return "transient";
	return undefined;
}

export interface TimerApi {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

interface RotateOptions {
	now?: number;
}


export type ProviderActivityPhase = "waiting-for-response" | "waiting-for-stream" | "streaming";

export interface ProviderTimeoutInfo {
	phase: ProviderActivityPhase;
	idleMs: number;
	elapsedMs: number;
	idleForMs: number;
	lastStatus?: number;
}

export function shouldRotateAfterWatchdogTimeout(timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): boolean {
	return timeoutInfo.lastStatus !== 429 || !rateLimitAlreadyRotated;
}


export interface ClockApi {
	now(): number;
}

export interface FetchResponseApi {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export type FetchApi = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseApi>;

export interface ExtensionOptions {
	timers?: TimerApi;
	clock?: ClockApi;
	fetch?: FetchApi;
}

export type OpenCodeGoUsageWindowStatus = "active" | "rate-limited" | "unknown";

export interface OpenCodeGoUsageWindow {
	name?: string;
	status: OpenCodeGoUsageWindowStatus;
	usagePercent?: number;
	resetInSec?: number;
	used?: number;
	limit?: number;
	remaining?: number;
	resetAt?: string;
	startAt?: string;
	endAt?: string;
}

export interface OpenCodeGoUsageResponse {
	windows: OpenCodeGoUsageWindow[];
}

type UsageFetchResult = {
	ok: true;
	keyName: string;
	usage: OpenCodeGoUsageResponse;
} | {
	ok: false;
	keyName?: string;
	message: string;
};

interface UsageLookupTarget {
	readonly keyIndex: number;
	readonly keyName: string;
	readonly bearerToken: string;
}

interface UsageDecisionIdentity {
	readonly epoch: number;
	readonly target: UsageLookupTarget;
}

interface RequestRateLimitState {
	readonly decision: UsageDecisionIdentity;
	readonly responseHandled: boolean;
}


export class ProviderIdleWatchdog {
	private timer: unknown | undefined;
	private active = false;
	private timedOut = false;
	private phase: ProviderActivityPhase = "waiting-for-response";
	private startedAt = 0;
	private lastActivityAt = 0;
	private lastStatus: number | undefined;
	private timeoutInfo: ProviderTimeoutInfo | undefined;
	private readonly options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
		clock?: ClockApi;
	};

	constructor(options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
		clock?: ClockApi;
	}) {
		this.options = options;
	}

	start(): void {
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

	response(status: number): void {
		if (!this.active || this.timedOut) return;
		this.phase = "waiting-for-stream";
		this.lastStatus = status;
		this.markActivity();
	}

	streamActivity(): void {
		if (!this.active || this.timedOut) return;
		this.phase = "streaming";
		this.markActivity();
	}

	activity(): void {
		if (!this.active || this.timedOut) return;
		this.markActivity();
	}

	stop(): void {
		this.active = false;
		this.clear();
	}


	consumeTimeoutInfo(): ProviderTimeoutInfo | undefined {
		const result = this.timeoutInfo;
		this.timeoutInfo = undefined;
		this.timedOut = false;
		return result;
	}

	currentTimeoutInfo(): ProviderTimeoutInfo | undefined {
		return this.timeoutInfo;
	}

	private markActivity(): void {
		this.lastActivityAt = this.now();
		this.schedule();
	}

	private now(): number {
		return this.options.clock?.now() ?? Date.now();
	}

	private getTimers(): TimerApi {
		return this.options.timers ?? {
			setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
			clearTimeout: (timer) => globalThis.clearTimeout(timer as Parameters<typeof globalThis.clearTimeout>[0]),
		};
	}

	private schedule(): void {
		this.clear();
		const timers = this.getTimers();
		this.timer = timers.setTimeout(() => {
			if (!this.active || this.timedOut) return;
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

	private clear(): void {
		if (this.timer === undefined) return;
		const timers = this.getTimers();
		timers.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function getQuotaBlockedUntil(config: Config, keyIndex: number, now: number): number | undefined {
	const blockedUntil = config.quotaBlockedUntil[keyIndex];
	return typeof blockedUntil === "number" && Number.isFinite(blockedUntil) && blockedUntil > now
		? blockedUntil
		: undefined;
}

function pickAvailableKeyIndex(config: Config, now = Date.now()): number | undefined {
	const cdMs = getCooldownMs(config);
	for (let i = 0; i < config.keys.length; i++) {
		const idx = (config.activeKeyIndex + i) % config.keys.length;
		if (getQuotaBlockedUntil(config, idx, now) !== undefined) continue;
		const cooldownStart = config.cooldowns[idx];
		if (cooldownStart === undefined || now - cooldownStart >= cdMs) return idx;
	}
	return undefined;
}

function rotateToNextKey(config: Config, options: RotateOptions = {}): number | undefined {
	if (config.keys.length === 0) return undefined;
	const now = options.now ?? Date.now();
	config.cooldowns[config.activeKeyIndex] = now;
	const next = pickAvailableKeyIndex(config, now);
	if (next !== undefined) {
		config.activeKeyIndex = next;
		saveConfig(config);
		return next;
	}
	for (let offset = 1; offset <= config.keys.length; offset++) {
		const candidate = (config.activeKeyIndex + offset) % config.keys.length;
		if (getQuotaBlockedUntil(config, candidate, now) !== undefined) continue;
		config.activeKeyIndex = candidate;
		delete config.cooldowns[candidate];
		saveConfig(config);
		return candidate;
	}
	saveConfig(config);
	return undefined;
}


interface RuntimeKeyStore {
	setRuntimeApiKey(provider: string, key: string): void | Promise<void>;
	removeRuntimeApiKey(provider: string): void | Promise<void>;
}

function getRuntimeKeyStore(modelRegistry: { authStorage?: RuntimeKeyStore; runtime?: RuntimeKeyStore }): RuntimeKeyStore {
	const store = modelRegistry.authStorage ?? modelRegistry.runtime;
	if (!store) throw new Error("Model registry does not expose runtime API key storage");
	return store;
}

function ignoreAsyncRefresh(result: void | Promise<void>): void {
	void result?.catch(() => {});
}

/** Set the active key as runtime override (highest priority in auth chain). */
function applyActiveKey(config: Config, modelRegistry: { authStorage?: RuntimeKeyStore; runtime?: RuntimeKeyStore }, now = Date.now()): string | undefined {
	const idx = pickAvailableKeyIndex(config, now);
	if (idx === undefined) return undefined;
	if (config.activeKeyIndex !== idx) {
		config.activeKeyIndex = idx;
		saveConfig(config);
	}
	ignoreAsyncRefresh(getRuntimeKeyStore(modelRegistry).setRuntimeApiKey(PROVIDER, config.keys[idx].key));
	return config.keys[idx].name || `key-${idx + 1}`;
}

function getActiveUsageTarget(config: Config): UsageLookupTarget | undefined {
	const entry = config.keys[config.activeKeyIndex];
	if (!entry) return undefined;
	return {
		keyIndex: config.activeKeyIndex,
		keyName: entry.name || `key-${config.activeKeyIndex + 1}`,
		bearerToken: entry.key,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function parseOpenCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const status: OpenCodeGoUsageWindowStatus = value.status === "ok" || value.status === "active"
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

export function parseOpenCodeGoUsage(value: unknown): OpenCodeGoUsageResponse | undefined {
	if (!isRecord(value)) return undefined;
	const windows: OpenCodeGoUsageWindow[] = [];
	if (Array.isArray(value.windows)) {
		for (const window of value.windows) {
			const parsed = parseOpenCodeGoUsageWindow(window);
			if (!parsed) return undefined;
			windows.push(parsed);
		}
		return { windows };
	}
	if (!isRecord(value.usage)) return undefined;
	for (const [name, window] of Object.entries(value.usage)) {
		const parsed = parseOpenCodeGoUsageWindow(window);
		if (!parsed) return undefined;
		windows.push(parsed.name === undefined ? { ...parsed, name } : parsed);
	}
	return { windows };
}

async function fetchOpenCodeGoUsage(target: UsageLookupTarget | undefined, fetchApi: FetchApi, timers?: TimerApi): Promise<UsageFetchResult> {
	if (!target) return { ok: false, message: "No OpenCode keys configured." };
	const controller = new AbortController();
	const timeoutFailure: UsageFetchResult = { ok: false, keyName: target.keyName, message: "Usage request timed out after 10s." };
	const timerApi = timers ?? {
		setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
		clearTimeout: (timer) => globalThis.clearTimeout(timer as Parameters<typeof globalThis.clearTimeout>[0]),
	};
	let didTimeout = false;
	let timeout: unknown;
	const request = (async (): Promise<UsageFetchResult> => {
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
			if (!usage) return { ok: false, keyName: target.keyName, message: "Usage response did not match the expected OpenCode Go shape." };
			return { ok: true, keyName: target.keyName, usage };
		} catch {
			if (didTimeout) return timeoutFailure;
			return { ok: false, keyName: target.keyName, message: "Usage request failed." };
		}
	})();
	const timedOut = new Promise<UsageFetchResult>((resolve) => {
		timeout = timerApi.setTimeout(() => {
			didTimeout = true;
			controller.abort();
			resolve(timeoutFailure);
		}, OPENCODE_GO_USAGE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([request, timedOut]);
	} finally {
		timerApi.clearTimeout(timeout);
	}
}

function captureUsageDecision(config: Config, epoch: number): UsageDecisionIdentity | undefined {
	const target = getActiveUsageTarget(config);
	return target ? { epoch, target } : undefined;
}

function isValidUsageDecisionTarget(decision: UsageDecisionIdentity, config: Config, epoch: number): boolean {
	const entry = config.keys[decision.target.keyIndex];
	return epoch === decision.epoch
		&& entry !== undefined
		&& (entry.name || `key-${decision.target.keyIndex + 1}`) === decision.target.keyName
		&& entry.key === decision.target.bearerToken;
}

function isCurrentUsageDecision(decision: UsageDecisionIdentity, config: Config, epoch: number): boolean {
	return config.activeKeyIndex === decision.target.keyIndex
		&& isValidUsageDecisionTarget(decision, config, epoch);
}

function hasRateLimitedUsageWindow(result: UsageFetchResult): boolean {
	return result.ok && result.usage.windows.some((window) => window.status === "rate-limited");
}

function getRateLimitedUntil(usage: OpenCodeGoUsageResponse, now: number, fallbackMs: number): number {
	let blockedUntil = now;
	for (const window of usage.windows) {
		if (window.status !== "rate-limited") continue;
		const resetTimes: number[] = [];
		if (window.resetInSec !== undefined) {
			const reset = now + window.resetInSec * 1000;
			if (Number.isFinite(reset) && reset > now) resetTimes.push(reset);
		}
		for (const timestamp of [window.resetAt, window.endAt]) {
			if (!timestamp) continue;
			const parsed = Date.parse(timestamp);
			if (Number.isFinite(parsed) && parsed > now) resetTimes.push(parsed);
		}
		blockedUntil = Math.max(
			blockedUntil,
			resetTimes.length > 0 ? Math.max(...resetTimes) : now + fallbackMs,
		);
	}
	return blockedUntil > now ? blockedUntil : now + fallbackMs;
}

function parseFixedWindowQuotaReset(message: string, now: number): number | undefined {
	const resetText = message.match(/\b(?:will\s+)?resets?(?:\s+at|\s+on)?\s+([^.;\n]+)/i)?.[1];
	if (resetText) {
		const parsed = Date.parse(resetText.trim());
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	return undefined;
}

function getEarliestQuotaReset(config: Config, now: number): number | undefined {
	const resets = Object.values(config.quotaBlockedUntil).filter(
		(reset) => typeof reset === "number" && Number.isFinite(reset) && reset > now,
	);
	return resets.length > 0 ? Math.min(...resets) : undefined;
}

function setQuotaBlock(config: Config, keyIndex: number, blockedUntil: number, now: number): void {
	config.quotaBlockedUntil[keyIndex] = Math.max(
		getQuotaBlockedUntil(config, keyIndex, now) ?? 0,
		blockedUntil,
	);
}

function blockQuotaAndSelectNext(config: Config, keyIndex: number, blockedUntil: number, now: number, isAuthoritative = false): number | undefined {
	if (isAuthoritative) {
		config.quotaBlockedUntil[keyIndex] = blockedUntil;
	} else {
		setQuotaBlock(config, keyIndex, blockedUntil, now);
	}
	let next = pickAvailableKeyIndex(config, now);
	if (next === undefined) {
		for (let offset = 1; offset <= config.keys.length; offset++) {
			const candidate = (keyIndex + offset) % config.keys.length;
			if (getQuotaBlockedUntil(config, candidate, now) !== undefined) continue;
			next = candidate;
			delete config.cooldowns[candidate];
			break;
		}
	}
	if (next !== undefined) config.activeKeyIndex = next;
	saveConfig(config);
	return next;
}

function reindexAfterRemoval(record: Record<number, number>, removedIndex: number): Record<number, number> {
	const shifted: Record<number, number> = {};
	for (const [key, value] of Object.entries(record)) {
		const index = Number(key);
		if (index === removedIndex) continue;
		shifted[index > removedIndex ? index - 1 : index] = value;
	}
	return shifted;
}

function formatUsageAmount(value: number | undefined): string | undefined {
	return value === undefined ? undefined : value.toLocaleString("en-US");
}

export function formatResetIn(seconds: number): string {
	if (seconds <= 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.ceil((seconds % 3_600) / 60);
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return minutes > 0 ? `${minutes}m` : "less than 1m";
}

function formatUsageWindow(window: OpenCodeGoUsageWindow, index: number): string {
	const label = window.name ?? `window ${index + 1}`;
	const details = [`${label}: ${window.status}`];
	const used = formatUsageAmount(window.used);
	const limit = formatUsageAmount(window.limit);
	const remaining = formatUsageAmount(window.remaining);
	if (window.usagePercent !== undefined) details.push(`${Math.round(window.usagePercent)}% used`);
	if (used !== undefined && limit !== undefined) details.push(`${used}/${limit} used`);
	else if (used !== undefined) details.push(`${used} used`);
	if (remaining !== undefined) details.push(`${remaining} remaining`);
	if (window.resetInSec !== undefined) details.push(`resets in ${formatResetIn(window.resetInSec)}`);
	else if (window.resetAt) details.push(`resets ${window.resetAt}`);
	else if (window.endAt) details.push(`ends ${window.endAt}`);
	return details.join("; ");
}

export function formatUsageStatus(result: UsageFetchResult): string {
	if (!result.ok) {
		return `OpenCode usage unavailable${result.keyName ? ` for ${result.keyName}` : ""}: ${result.message}`;
	}
	if (result.usage.windows.length === 0) return `OpenCode usage for ${result.keyName}: no usage windows returned.`;
	return [`OpenCode usage for ${result.keyName}:`, ...result.usage.windows.map(formatUsageWindow)].join("\n");
}

function formatStatus(config: Config, now = Date.now()): string {
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
		} else if (cooldownStart !== undefined) {
			const remaining = cdMs - (now - cooldownStart);
			if (remaining > 0) tag = ` [cooldown ${Math.ceil(remaining / 60_000)}m]`;
		}
		return `${marker} ${i + 1}. ${key.name}${tag}`;
	}).join("\n")}\n${watchdogStatus}`;
}

interface WatchdogEvent {
	time: number;
	keyName?: string;
	rotatedTo?: string;
	activeKey?: string;
	phase: ProviderActivityPhase;
	idleMs: number;
	elapsedMs: number;
	idleForMs: number;
	lastStatus?: number;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatTimeoutInfo(info: ProviderTimeoutInfo): string {
	const status = info.lastStatus === undefined ? "" : `, last HTTP ${info.lastStatus}`;
	return `${info.phase.replaceAll("-", " ")} stalled after ${formatDuration(info.elapsedMs)} (${formatDuration(info.idleForMs)} idle${status})`;
}

function formatWatchdogEvents(events: WatchdogEvent[], now = Date.now()): string {
	if (events.length === 0) return "No OpenCode Go watchdog timeouts recorded this session.";
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

export function createOpencodeGoRotationExtension(options: ExtensionOptions = {}) {
	return function opencodeGoRotationExtension(pi: ExtensionAPI) {
		let config = loadConfig();
		let watchdog: ProviderIdleWatchdog | undefined;
		let watchdogAbortPending = false;
		let watchdogAbortMessage: string | undefined;
		let watchdogTimeoutInfo: ProviderTimeoutInfo | undefined;
		let watchdogRequestTimedOut = false;
		let usageDecisionEpoch = 0;
		let requestRateLimitState: RequestRateLimitState | undefined;
		const watchdogEvents: WatchdogEvent[] = [];

		const now = (): number => options.clock?.now() ?? Date.now();
		const fetchApi: FetchApi = options.fetch ?? globalThis.fetch.bind(globalThis);

		function invalidateAutomaticDecisions(): void {
			usageDecisionEpoch++;
		}

		function beginProviderRequest(): void {
			invalidateAutomaticDecisions();
			config = loadConfig();
			const decision = captureUsageDecision(config, usageDecisionEpoch);
			requestRateLimitState = decision ? { decision, responseHandled: false } : undefined;
		}

		function getCurrentRequestRateLimitState(): RequestRateLimitState | undefined {
			if (!requestRateLimitState) return undefined;
			return isValidUsageDecisionTarget(requestRateLimitState.decision, config, usageDecisionEpoch)
				? requestRateLimitState
				: undefined;
		}

		function markResponseRateLimitHandled(decision: UsageDecisionIdentity): void {
			requestRateLimitState = {
				decision: { ...decision, epoch: usageDecisionEpoch },
				responseHandled: true,
			};
		}

		function rotateForQuotaExhaustion(
			ctx: Pick<ExtensionContext, "modelRegistry" | "ui">,
			keyIndex: number,
			blockedUntil: number,
			currentTime: number,
			isAuthoritative = false,
		): void {
			const exhaustedName = config.keys[keyIndex]?.name || `key-${keyIndex + 1}`;
			const nextIndex = blockQuotaAndSelectNext(config, keyIndex, blockedUntil, currentTime, isAuthoritative);
			if (nextIndex === undefined) {
				invalidateAutomaticDecisions();
				const earliestReset = getEarliestQuotaReset(config, currentTime);
				const reset = earliestReset === undefined
					? "an unknown reset time"
					: formatResetIn(Math.ceil((earliestReset - currentTime) / 1000));
				ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota; all configured keys are quota-blocked. Earliest reset in ${reset}.`, "warning");
				return;
			}
			invalidateAutomaticDecisions();
			const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime) ?? `key-${nextIndex + 1}`;
			ctx.ui.notify(`OpenCode: ${exhaustedName} reached its plan quota → rotated to ${keyName}`, "info");
		}

		function stopWatchdog(): ProviderTimeoutInfo | undefined {
			const timeoutInfo = watchdog?.consumeTimeoutInfo();
			watchdog?.stop();
			watchdog = undefined;
			return timeoutInfo;
		}

		function resetWatchdogAbortState(): void {
			watchdogAbortPending = false;
			watchdogAbortMessage = undefined;
			watchdogTimeoutInfo = undefined;
		}

		function clearWatchdogTimeoutGuard(): void {
			watchdogRequestTimedOut = false;
		}

		function recordWatchdogEvent(event: WatchdogEvent): void {
			watchdogEvents.push(event);
			while (watchdogEvents.length > 10) watchdogEvents.shift();
		}

		function rotateForWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">, timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): { keyName?: string; rotated: boolean } {
			config = loadConfig();
			const currentTime = now();
			if (config.keys.length <= 1) return { rotated: false };
			if (shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated)) {
				const previousIndex = config.activeKeyIndex;
				const nextIndex = rotateToNextKey(config, { now: currentTime });
				if (nextIndex === undefined) return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
				const rotated = nextIndex !== previousIndex;
				if (rotated) invalidateAutomaticDecisions();
				return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated };
			}
			return { keyName: applyActiveKey(config, ctx.modelRegistry, currentTime), rotated: false };
		}

		function startWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui" | "abort">): void {
			config = loadConfig();
			stopWatchdog();
			resetWatchdogAbortState();
			clearWatchdogTimeoutGuard();
			if (!config.watchdogEnabled) return;
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

		async function autoImportFromAuth(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): Promise<boolean> {
			const authKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
			if (!authKey) return false;
			// Skip if key already exists in rotation list
			if (config.keys.some((k) => k.key === authKey)) return false;
			config.keys.push({ name: "auth", key: authKey });
			saveConfig(config);
			return true;
		}

		pi.on("session_start", async (event, ctx) => {
			invalidateAutomaticDecisions();
			requestRateLimitState = undefined;
			config = loadConfig();
			clearWatchdogTimeoutGuard();
			// On reload: re-apply active key, skip auto-import
			if (event.reason === "reload") {
				const keyName = applyActiveKey(config, ctx.modelRegistry, now());
				if (keyName) ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
				return;
			}
			if (config.keys.length === 0) {
				if (await autoImportFromAuth(ctx)) {
					ctx.ui.notify(`OpenCode: Imported key from auth.json → ${applyActiveKey(config, ctx.modelRegistry, now())}`, "info");
				} else {
					ctx.ui.notify("OpenCode: No keys configured. Use /opencode add <name> <key>", "warning");
					return;
				}
			}
			const keyName = applyActiveKey(config, ctx.modelRegistry, now());
			if (keyName) ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
		});

		pi.on("before_provider_request", (_event, ctx) => {
			if (!shouldWatchProvider(ctx.model?.provider)) {
				invalidateAutomaticDecisions();
				requestRateLimitState = undefined;
				stopWatchdog();
				resetWatchdogAbortState();
				clearWatchdogTimeoutGuard();
				return;
			}
			beginProviderRequest();
			startWatchdog(ctx);
		});

		pi.on("message_update", (event) => {
			const message = event.message;
			if (message.role !== "assistant" || !shouldWatchProvider(message.provider)) return;
			watchdog?.streamActivity();
		});

		pi.on("message_end", async (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== PROVIDER) return;

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
			config = loadConfig();
			const requestState = getCurrentRequestRateLimitState();
			if (!requestState) return;
			if (rateLimitKind === "fixed-window-quota") {
				const currentTime = now();
				const authoritativeReset = parseFixedWindowQuotaReset(message.errorMessage ?? "", currentTime);
				const blockedUntil = authoritativeReset ?? currentTime + getCooldownMs(config);
				if (requestState.responseHandled) {
					if (authoritativeReset === undefined) {
						setQuotaBlock(config, requestState.decision.target.keyIndex, blockedUntil, currentTime);
					} else {
						config.quotaBlockedUntil[requestState.decision.target.keyIndex] = authoritativeReset;
					}
					saveConfig(config);
					invalidateAutomaticDecisions();
					return;
				}
				rotateForQuotaExhaustion(
					ctx,
					requestState.decision.target.keyIndex,
					blockedUntil,
					currentTime,
					authoritativeReset !== undefined,
				);
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
			const newIndex = rotateToNextKey(config, { now: currentTime });
			if (newIndex === undefined) {
				invalidateAutomaticDecisions();
				ctx.ui.notify("OpenCode: Rate limited; all other keys are quota-blocked.", "warning");
				return;
			}
			invalidateAutomaticDecisions();
			const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
			ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
		});

		pi.on("after_provider_response", async (event, ctx) => {
			if (ctx.model?.provider !== PROVIDER) return;
			watchdog?.response(event.status);
			if (event.status !== 429) return;
			if (watchdogRequestTimedOut) return;
			config = loadConfig();
			const decision = getCurrentRequestRateLimitState()?.decision;
			if (!decision) return;
			const usage = await fetchOpenCodeGoUsage(decision.target, fetchApi, options.timers);
			config = loadConfig();
			if (!isCurrentUsageDecision(decision, config, usageDecisionEpoch)) return;
			if (usage.ok && hasRateLimitedUsageWindow(usage)) {
				const currentTime = now();
				rotateForQuotaExhaustion(
					ctx,
					decision.target.keyIndex,
					getRateLimitedUntil(usage.usage, currentTime, getCooldownMs(config)),
					currentTime,
				);
				markResponseRateLimitHandled(decision);
				ctx.ui.notify(formatUsageStatus(usage), "warning");
				return;
			}
			if (config.keys.length <= 1) {
				markResponseRateLimitHandled(decision);
				return;
			}

			const currentTime = now();
			const newIndex = rotateToNextKey(config, { now: currentTime });
			if (newIndex === undefined) {
				invalidateAutomaticDecisions();
				markResponseRateLimitHandled(decision);
				ctx.ui.notify("OpenCode: HTTP 429; all other keys are quota-blocked.", "warning");
				return;
			}
			invalidateAutomaticDecisions();
			markResponseRateLimitHandled(decision);
			const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
			ctx.ui.notify(`OpenCode: Proactive rate-limit detection (HTTP 429) → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
		});

		pi.registerCommand("opencode", {
			description: "Manage OpenCode API key rotation",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/);
				const subcommand = parts[0] || "status";
				const indexArg = parseInt(parts[1], 10);

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
						config = loadConfig();
						const usage = await fetchOpenCodeGoUsage(getActiveUsageTarget(config), fetchApi, options.timers);
						ctx.ui.notify(formatUsageStatus(usage), usage.ok ? "info" : "warning");
						break;
					}

					case "use": {
						const targetIndex = indexArg - 1;
						if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= config.keys.length) {
							ctx.ui.notify(`Invalid index. Use 1-${config.keys.length}.`, "warning");
							return;
						}
						invalidateAutomaticDecisions();
						config.activeKeyIndex = targetIndex;
						delete config.cooldowns[targetIndex];
						delete config.quotaBlockedUntil[targetIndex];
						saveConfig(config);
						const keyName = applyActiveKey(config, ctx.modelRegistry, now());
						ctx.ui.notify(`Switched to ${keyName}`, "info");
						break;
					}

					case "next": {
						if (config.keys.length === 0) {
							ctx.ui.notify("No keys configured. Use /opencode add <name> <key>.", "warning");
							return;
						}
						invalidateAutomaticDecisions();
						config.activeKeyIndex = (config.activeKeyIndex + 1) % config.keys.length;
						delete config.cooldowns[config.activeKeyIndex];
						delete config.quotaBlockedUntil[config.activeKeyIndex];
						saveConfig(config);
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
						config.keys.push({ name, key });
						saveConfig(config);
						if (config.keys.length === 1) {
							config.activeKeyIndex = 0;
							applyActiveKey(config, ctx.modelRegistry, now());
						}
						ctx.ui.notify(`Added "${name}" (${config.keys.length} keys)`, "info");
						break;
					}

					case "remove":
					case "rm": {
						const removeIndex = indexArg - 1;
						if (isNaN(removeIndex) || removeIndex < 0 || removeIndex >= config.keys.length) {
							ctx.ui.notify(`Invalid index. Use 1-${config.keys.length}.`, "warning");
							return;
						}
						invalidateAutomaticDecisions();
						const removed = config.keys.splice(removeIndex, 1)[0];
						config.cooldowns = reindexAfterRemoval(config.cooldowns, removeIndex);
						config.quotaBlockedUntil = reindexAfterRemoval(config.quotaBlockedUntil, removeIndex);
						if (config.activeKeyIndex >= config.keys.length) {
							config.activeKeyIndex = 0;
						} else if (removeIndex < config.activeKeyIndex) {
							config.activeKeyIndex--;
						}
						saveConfig(config);
						if (config.keys.length > 0) {
							applyActiveKey(config, ctx.modelRegistry, now());
						} else {
							ignoreAsyncRefresh(getRuntimeKeyStore(ctx.modelRegistry).removeRuntimeApiKey(PROVIDER));
						}
						ctx.ui.notify(`Removed "${removed.name}" (${config.keys.length} left)`, "info");
						break;
					}

					case "reset":
						invalidateAutomaticDecisions();
						config.cooldowns = {};
						config.quotaBlockedUntil = {};
						saveConfig(config);
						ctx.ui.notify("All cooldowns and quota blocks cleared", "info");
						break;

					case "cooldown": {
						const minutes = parseInt(parts[1], 10);
						if (isNaN(minutes) || minutes < 1) {
							ctx.ui.notify(`Cooldown: ${config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES} min`, "info");
							return;
						}
						config.cooldownMinutes = minutes;
						saveConfig(config);
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
						if (value === "on") {
							config.watchdogEnabled = true;
							saveConfig(config);
							ctx.ui.notify(`Watchdog enabled (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`, "info");
							return;
						}
						if (value === "off") {
							config.watchdogEnabled = false;
							saveConfig(config);
							stopWatchdog();
							resetWatchdogAbortState();
							ctx.ui.notify("Watchdog disabled", "info");
							return;
						}
						const seconds = parseInt(value, 10);
						if (isNaN(seconds) || seconds < 1) {
							ctx.ui.notify("Usage: /opencode watchdog [status|on|off|<seconds>]", "warning");
							return;
						}
						config.watchdogEnabled = true;
						config.watchdogIdleMs = seconds * 1000;
						saveConfig(config);
						ctx.ui.notify(`Watchdog enabled (${seconds}s idle)`, "info");
						break;
					}

					default:
						ctx.ui.notify(
							"Usage: /opencode [status|usage|quota|events|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|watchdog [status|on|off|<seconds>]]",
							"info",
						);
				}
			},
		});

		function cleanupLifecycleState(): void {
			invalidateAutomaticDecisions();
			requestRateLimitState = undefined;
			stopWatchdog();
			resetWatchdogAbortState();
			clearWatchdogTimeoutGuard();
		}

		pi.on("agent_end", () => {
			cleanupLifecycleState();
		});

		pi.on("session_shutdown", async () => {
			cleanupLifecycleState();
			saveConfig(config);
		});
	};
}

const extension = createOpencodeGoRotationExtension();
export default extension;
