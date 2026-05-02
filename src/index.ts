import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROVIDER = "opencode-go";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "opencode-keys.json");
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_WATCHDOG_IDLE_MS = 90_000;
const QUOTA_ERROR_RE = /\b429\b|rate.?limit|too many requests|quota|usage limit|limit reached/i;
const ROTATION_DEDUP_MS = 5_000;

/** Timestamp of the last key rotation (shared between after_provider_response and message_end). */
let lastRotationTime = 0;

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

function loadConfig(): Config {
	if (!existsSync(CONFIG_PATH)) return { ...EMPTY_CONFIG };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return { ...EMPTY_CONFIG, ...parsed, cooldowns: parsed.cooldowns ?? {} };
	} catch {
		return { ...EMPTY_CONFIG };
	}
}

function saveConfig(config: Config): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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

interface TimerApi {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
}

export class ProviderIdleWatchdog {
	private timer: unknown | undefined;
	private active = false;
	private timedOut = false;
	private readonly options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
	};

	constructor(options: {
		idleMs: number;
		onTimeout: () => void;
		timers?: TimerApi;
	}) {
		this.options = options;
	}

	start(): void {
		this.active = true;
		this.timedOut = false;
		this.schedule();
	}

	activity(): void {
		if (!this.active || this.timedOut) return;
		this.schedule();
	}

	stop(): void {
		this.active = false;
		this.clear();
	}

	consumeTimedOut(): boolean {
		const result = this.timedOut;
		this.timedOut = false;
		return result;
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
function pickAvailableKeyIndex(config: Config): number | undefined {
	const now = Date.now();
	const cdMs = getCooldownMs(config);
	for (let i = 0; i < config.keys.length; i++) {
		const idx = (config.activeKeyIndex + i) % config.keys.length;
		const cooldownStart = config.cooldowns[idx];
		if (!cooldownStart || now - cooldownStart >= cdMs) return idx;
	}
	return undefined;
}

/** Mark current key on cooldown, advance to next available. Returns new index. */
function rotateToNextKey(config: Config): number {
	config.cooldowns[config.activeKeyIndex] = Date.now();
	const next = pickAvailableKeyIndex(config);
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
function applyActiveKey(config: Config, modelRegistry: { authStorage: { setRuntimeApiKey: (provider: string, key: string) => void } }): string | undefined {
	const idx = pickAvailableKeyIndex(config);
	if (idx === undefined) return undefined;
	if (config.activeKeyIndex !== idx) {
		config.activeKeyIndex = idx;
		saveConfig(config);
	}
	modelRegistry.authStorage.setRuntimeApiKey(PROVIDER, config.keys[idx].key);
	return config.keys[idx].name || `key-${idx + 1}`;
}

function formatStatus(config: Config): string {
	const watchdogStatus = `Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`;
	if (config.keys.length === 0) {
		return `No keys configured. Use /opencode add <name> <key>.\n${watchdogStatus}`;
	}
	const now = Date.now();
	const cdMs = getCooldownMs(config);
	return `${config.keys.map((key, i) => {
		const marker = i === config.activeKeyIndex ? "→" : " ";
		const cooldownStart = config.cooldowns[i];
		let tag = "";
		if (cooldownStart) {
			const remaining = cdMs - (now - cooldownStart);
			if (remaining > 0) tag = ` [cooldown ${Math.ceil(remaining / 60_000)}m]`;
		}
		return `${marker} ${i + 1}. ${key.name} (${key.key.slice(0, 8)}...)${tag}`;
	}).join("\n")}\n${watchdogStatus}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let watchdog: ProviderIdleWatchdog | undefined;
	let watchdogAbortPending = false;
	let watchdogAbortMessage: string | undefined;

	function stopWatchdog(): boolean {
		const timedOut = watchdog?.consumeTimedOut() ?? false;
		watchdog?.stop();
		watchdog = undefined;
		return timedOut;
	}

	function rotateForWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui">): string | undefined {
		config = loadConfig();
		if (config.keys.length <= 1) return undefined;
		const now = Date.now();
		if (now - lastRotationTime >= ROTATION_DEDUP_MS) {
			lastRotationTime = now;
			rotateToNextKey(config);
		}
		return applyActiveKey(config, ctx.modelRegistry);
	}

	function startWatchdog(ctx: Pick<ExtensionContext, "modelRegistry" | "ui" | "abort">): void {
		config = loadConfig();
		if (!config.watchdogEnabled) return;
		stopWatchdog();
		watchdogAbortPending = false;
		watchdogAbortMessage = undefined;
		const idleMs = getWatchdogIdleMs(config);
		watchdog = new ProviderIdleWatchdog({
			idleMs,
			onTimeout: () => {
				const keyName = rotateForWatchdog(ctx);
				watchdogAbortPending = true;
				watchdogAbortMessage = keyName
					? `OpenCode Go timeout: no provider activity for ${Math.ceil(idleMs / 1000)}s; rotated to ${keyName}; retrying.`
					: `OpenCode Go timeout: no provider activity for ${Math.ceil(idleMs / 1000)}s; no other key available.`;
				ctx.ui.notify(watchdogAbortMessage, keyName ? "info" : "warning");
				ctx.abort();
			},
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
			const keyName = applyActiveKey(config, ctx.modelRegistry);
			if (keyName) ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
			return;
		}
		if (config.keys.length === 0) {
			if (await autoImportFromAuth(ctx)) {
				ctx.ui.notify(`OpenCode: Imported key from auth.json → ${applyActiveKey(config, ctx.modelRegistry)}`, "info");
			} else {
				ctx.ui.notify("OpenCode: No keys configured. Use /opencode add <name> <key>", "warning");
				return;
			}
		}
		const keyName = applyActiveKey(config, ctx.modelRegistry);
		if (keyName) ctx.ui.notify(`OpenCode: Active key → ${keyName}`, "info");
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (!shouldWatchProvider(ctx.model?.provider)) {
			stopWatchdog();
			return;
		}
		startWatchdog(ctx);
	});

	pi.on("message_update", (event) => {
		const message = event.message;
		if (message.role !== "assistant" || !shouldWatchProvider(message.provider)) return;
		watchdog?.activity();
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== PROVIDER) return;

		const watchdogTimedOut = stopWatchdog();
		if (watchdogTimedOut || watchdogAbortPending) {
			const errorMessage = watchdogAbortMessage ?? "OpenCode Go timeout: no provider activity; retrying.";
			watchdogAbortPending = false;
			watchdogAbortMessage = undefined;
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
		const now = Date.now();
		if (now - lastRotationTime < ROTATION_DEDUP_MS) return;
		lastRotationTime = now;

		const newIndex = rotateToNextKey(config);
		const keyName = applyActiveKey(config, ctx.modelRegistry);
		ctx.ui.notify(`OpenCode: Rate-limited → rotated to ${keyName ?? `key-${newIndex + 1}`}`, "info");
	});

	// Proactive rate-limit detection via HTTP status — fires before stream consumption.
	// This is faster than waiting for message_end error parsing.
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		watchdog?.activity();
		if (event.status !== 429) return;

		config = loadConfig();
		if (config.keys.length <= 1) return; // nothing to rotate to

		// Deduplicate with message_end handler
		const now = Date.now();
		if (now - lastRotationTime < ROTATION_DEDUP_MS) return;
		lastRotationTime = now;

		const newIndex = rotateToNextKey(config);
		const keyName = applyActiveKey(config, ctx.modelRegistry);
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
					const status = formatStatus(config);
					if (config.keys.length === 0) {
						ctx.ui.notify(`${status}\nUsing auth.json key (no rotation). Add keys with /opencode add.`, "info");
					} else {
						ctx.ui.notify(status, "info");
					}
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
					const keyName = applyActiveKey(config, ctx.modelRegistry);
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
					const keyName = applyActiveKey(config, ctx.modelRegistry);
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
						applyActiveKey(config, ctx.modelRegistry);
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
						applyActiveKey(config, ctx.modelRegistry);
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
						ctx.ui.notify(`Watchdog: ${config.watchdogEnabled ? "on" : "off"} (${Math.ceil(getWatchdogIdleMs(config) / 1000)}s idle)`, "info");
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
						"Usage: /opencode [status|use <n>|next|add <name> <key>|rm <n>|reset|cooldown <min>|watchdog [status|on|off|<seconds>]]",
						"info",
					);
			}
		},
	});

	pi.on("agent_end", () => {
		stopWatchdog();
		watchdogAbortPending = false;
		watchdogAbortMessage = undefined;
	});

	pi.on("session_shutdown", async () => {
		stopWatchdog();
		saveConfig(config);
	});
}