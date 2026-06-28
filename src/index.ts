import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PROVIDER = "opencode-go";
const CONFIG_PATH_ENV = "PI_OPENCODE_ROTATION_CONFIG";
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_WATCHDOG_IDLE_MS = 90_000;
const QUOTA_ERROR_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;
const ROTATION_DEDUP_MS = 5_000;


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
}

const EMPTY_CONFIG: Config = {
	keys: [],
	activeKeyIndex: 0,
	cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
	watchdogEnabled: true,
	watchdogIdleMs: DEFAULT_WATCHDOG_IDLE_MS,
	cooldowns: {},
};

function getConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? join(homedir(), ".pi", "agent", "opencode-keys.json");
}


function loadConfig(): Config {
	const path = getConfigPath();
	if (!existsSync(path)) return { ...EMPTY_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return { ...EMPTY_CONFIG, ...parsed, cooldowns: parsed.cooldowns ?? {} };
	} catch {
		return { ...EMPTY_CONFIG };
	}
}

function saveConfig(config: Config): void {
	const path = getConfigPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
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

export interface ExtensionOptions {
	timers?: TimerApi;
	clock?: ClockApi;
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

/** Return index of first key not on cooldown, starting from `config.activeKeyIndex`. */
function pickAvailableKeyIndex(config: Config, now = Date.now()): number | undefined {
	const cdMs = getCooldownMs(config);
	for (let i = 0; i < config.keys.length; i++) {
		const idx = (config.activeKeyIndex + i) % config.keys.length;
		const cooldownStart = config.cooldowns[idx];
		if (cooldownStart === undefined || now - cooldownStart >= cdMs) return idx;
	}
	return undefined;
}

/** Mark current key on cooldown, advance to next available. Returns new index. */
function rotateToNextKey(config: Config, options: RotateOptions = {}): number {
	const now = options.now ?? Date.now();
	config.cooldowns[config.activeKeyIndex] = now;
	const next = pickAvailableKeyIndex(config, now);
	if (next !== undefined) {
		config.activeKeyIndex = next;
		saveConfig(config);
		return next;
	}
	// All keys on cooldown — force-advance and clear next key's cooldown
	config.activeKeyIndex = (config.activeKeyIndex + 1) % config.keys.length;
	delete config.cooldowns[config.activeKeyIndex];
	saveConfig(config);
	return config.activeKeyIndex;
}


/** Set the active key as runtime override (highest priority in auth chain). */
function applyActiveKey(config: Config, modelRegistry: { authStorage: { setRuntimeApiKey: (provider: string, key: string) => void } }, now = Date.now()): string | undefined {
	const idx = pickAvailableKeyIndex(config, now);
	if (idx === undefined) return undefined;
	if (config.activeKeyIndex !== idx) {
		config.activeKeyIndex = idx;
		saveConfig(config);
	}
	modelRegistry.authStorage.setRuntimeApiKey(PROVIDER, config.keys[idx].key);
	return config.keys[idx].name || `key-${idx + 1}`;
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
		if (cooldownStart !== undefined) {
			const remaining = cdMs - (now - cooldownStart);
			if (remaining > 0) tag = ` [cooldown ${Math.ceil(remaining / 60_000)}m]`;
		}
		return `${marker} ${i + 1}. ${key.name} (${key.key.slice(0, 8)}...)${tag}`;
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
		let watchdogRateLimitRotated = false;
		/** Timestamp of the last surfaced-error key rotation for this extension instance. */
		let lastRotationTime = Number.NEGATIVE_INFINITY;
		const watchdogEvents: WatchdogEvent[] = [];

		const now = (): number => options.clock?.now() ?? Date.now();



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
		watchdogRateLimitRotated = false;
	}

	function recordWatchdogEvent(event: WatchdogEvent): void {
		watchdogEvents.push(event);
		while (watchdogEvents.length > 10) watchdogEvents.shift();
	}

	function rotateForWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">, timeoutInfo: ProviderTimeoutInfo, rateLimitAlreadyRotated: boolean): { keyName?: string; rotated: boolean } {
		config = loadConfig();
		if (config.keys.length <= 1) return { rotated: false };
		if (shouldRotateAfterWatchdogTimeout(timeoutInfo, rateLimitAlreadyRotated)) {
			rotateToNextKey(config, { now: now() });
			return { keyName: applyActiveKey(config, ctx.modelRegistry, now()), rotated: true };
		}
		return { keyName: applyActiveKey(config, ctx.modelRegistry, now()), rotated: false };
	}

	function startWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui" | "abort">): void {
		config = loadConfig();
		if (!config.watchdogEnabled) return;
		stopWatchdog();
		resetWatchdogAbortState();
		const idleMs = getWatchdogIdleMs(config);
		watchdog = new ProviderIdleWatchdog({
			idleMs,
			onTimeout: () => {
				const timeoutInfo = watchdog?.currentTimeoutInfo() ?? {
					phase: "waiting-for-response",
					idleMs,
					elapsedMs: idleMs,
					idleForMs: idleMs,
				};
				const previousKey = config.keys[config.activeKeyIndex]?.name;
				const rotation = rotateForWatchdog(ctx, timeoutInfo, watchdogRateLimitRotated);
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
		config = loadConfig();
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
			stopWatchdog();
			resetWatchdogAbortState();
			return;
		}
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

		if (message.stopReason !== "error") return;
		if (!QUOTA_ERROR_RE.test(message.errorMessage ?? "")) return;

		config = loadConfig();
		if (config.keys.length <= 1) {
			ctx.ui.notify("OpenCode: Rate limited — no other keys to rotate to.", "warning");
			return;
		}

		// Deduplicate with after_provider_response handler
		const currentTime = now();
		if (currentTime - lastRotationTime < ROTATION_DEDUP_MS) return;
		lastRotationTime = currentTime;

		const newIndex = rotateToNextKey(config, { now: currentTime });
		const keyName = applyActiveKey(config, ctx.modelRegistry, currentTime);
		ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
	});

	// Proactive rate-limit detection via HTTP status — fires before stream consumption.
	// This is faster than waiting for message_end error parsing.
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		watchdog?.response(event.status);
		if (event.status !== 429) return;
		config = loadConfig();
		if (config.keys.length <= 1) return; // nothing to rotate to

		// Deduplicate with message_end handler. If this returns, leave
		// watchdogRateLimitRotated false so a later 429-body hang can still rotate.
		const currentTime = now();
		if (currentTime - lastRotationTime < ROTATION_DEDUP_MS) return;
		lastRotationTime = currentTime;

		const newIndex = rotateToNextKey(config, { now: currentTime });
		watchdogRateLimitRotated = true;
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
					if (config.keys.length === 0) {
						ctx.ui.notify(`${status}\nUsing auth.json key (no rotation). Add keys with /opencode add.`, "info");
					} else {
						ctx.ui.notify(status, "info");
					}
					break;
				}

				case "events":
				case "timeouts": {
					ctx.ui.notify(formatWatchdogEvents(watchdogEvents, now()), "info");
					break;
				}

				case "use": {
					const targetIndex = indexArg - 1;
					if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= config.keys.length) {
						ctx.ui.notify(`Invalid index. Use 1-${config.keys.length}.`, "warning");
						return;
					}
					config.activeKeyIndex = targetIndex;
					delete config.cooldowns[targetIndex];
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
					config.activeKeyIndex = (config.activeKeyIndex + 1) % config.keys.length;
					delete config.cooldowns[config.activeKeyIndex];
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
					const removed = config.keys.splice(removeIndex, 1)[0];
					delete config.cooldowns[removeIndex];
					// Reindex cooldowns after removal
					const shiftedCooldowns: Record<number, number> = {};
					for (const [key, value] of Object.entries(config.cooldowns)) {
						const numericKey = parseInt(key, 10);
						shiftedCooldowns[numericKey > removeIndex ? numericKey - 1 : numericKey] = value;
					}
					config.cooldowns = shiftedCooldowns;
					if (config.activeKeyIndex >= config.keys.length) {
						config.activeKeyIndex = 0;
					} else if (removeIndex < config.activeKeyIndex) {
						config.activeKeyIndex--;
					}
					saveConfig(config);
					if (config.keys.length > 0) {
						applyActiveKey(config, ctx.modelRegistry, now());
					} else {
						ctx.modelRegistry.authStorage.removeRuntimeApiKey(PROVIDER);
					}
					ctx.ui.notify(`Removed "${removed.name}" (${config.keys.length} left)`, "info");
					break;
				}

				case "reset":
					config.cooldowns = {};
					saveConfig(config);
					ctx.ui.notify("All cooldowns cleared", "info");
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
						"Usage: /opencode [status|events|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|watchdog [status|on|off|<seconds>]]",
						"info",
					);
			}
		},
	});

	pi.on("agent_end", () => {
		stopWatchdog();
		resetWatchdogAbortState();
	});

	pi.on("session_shutdown", async () => {
		stopWatchdog();
		resetWatchdogAbortState();
		saveConfig(config);
	});
	};
}

const extension = createOpencodeGoRotationExtension();
export default extension;