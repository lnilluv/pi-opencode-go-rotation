import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const CONFIG_PATH_ENV = "PI_OPENCODE_ROTATION_CONFIG";
export const DEFAULT_COOLDOWN_MINUTES = 60;
export const DEFAULT_WATCHDOG_IDLE_MS = 90_000;

const CONFIG_FILE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

export interface KeyEntry {
	name: string;
	key: string;
}

export interface Config {
	keys: KeyEntry[];
	activeKeyIndex: number;
	cooldownMinutes: number;
	watchdogEnabled: boolean;
	watchdogIdleMs: number;
	/** Key index → epoch ms when cooldown started */
	cooldowns: Record<number, number>;
	quotaBlockedUntil: Record<number, number>;
}

export class ConfigLoadError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Invalid OpenCode rotation config at ${path}: ${reason}`);
		this.name = "ConfigLoadError";
		this.path = path;
	}
}

export function createEmptyConfig(): Config {
	return {
		keys: [],
		activeKeyIndex: 0,
		cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
		watchdogEnabled: true,
		watchdogIdleMs: DEFAULT_WATCHDOG_IDLE_MS,
		cooldowns: {},
		quotaBlockedUntil: {},
	};
}

export function getConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? join(homedir(), ".pi", "agent", "opencode-keys.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumberRecord(value: unknown, field: string, path: string): Record<number, number> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new ConfigLoadError(path, `${field} must be an object`);

	const result: Record<number, number> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!/^\d+$/.test(key) || typeof item !== "number" || !Number.isFinite(item)) {
			throw new ConfigLoadError(path, `${field} contains an invalid entry`);
		}
		result[Number(key)] = item;
	}
	return result;
}

function parseConfig(value: unknown, path: string): Config {
	if (!isRecord(value)) throw new ConfigLoadError(path, "root must be an object");
	if (!Array.isArray(value.keys)) throw new ConfigLoadError(path, "keys must be an array");

	const keys: KeyEntry[] = value.keys.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.key !== "string" || entry.key.length === 0) {
			throw new ConfigLoadError(path, `keys[${index}] is invalid`);
		}
		return { name: entry.name, key: entry.key };
	});

	const activeKeyIndexValue = value.activeKeyIndex;
	const activeKeyIndex = activeKeyIndexValue === undefined ? 0 : activeKeyIndexValue;
	if (typeof activeKeyIndex !== "number" || !Number.isInteger(activeKeyIndex) || activeKeyIndex < 0 || (keys.length > 0 && activeKeyIndex >= keys.length)) {
		throw new ConfigLoadError(path, "activeKeyIndex is invalid");
	}

	const cooldownMinutesValue = value.cooldownMinutes;
	const cooldownMinutes = cooldownMinutesValue === undefined ? DEFAULT_COOLDOWN_MINUTES : cooldownMinutesValue;
	if (typeof cooldownMinutes !== "number" || !Number.isFinite(cooldownMinutes) || cooldownMinutes < 1) {
		throw new ConfigLoadError(path, "cooldownMinutes is invalid");
	}

	const watchdogEnabled = value.watchdogEnabled ?? true;
	if (typeof watchdogEnabled !== "boolean") throw new ConfigLoadError(path, "watchdogEnabled is invalid");

	const watchdogIdleMsValue = value.watchdogIdleMs;
	const watchdogIdleMs = watchdogIdleMsValue === undefined ? DEFAULT_WATCHDOG_IDLE_MS : watchdogIdleMsValue;
	if (typeof watchdogIdleMs !== "number" || !Number.isFinite(watchdogIdleMs) || watchdogIdleMs < 1) {
		throw new ConfigLoadError(path, "watchdogIdleMs is invalid");
	}

	return {
		keys,
		activeKeyIndex,
		cooldownMinutes,
		watchdogEnabled,
		watchdogIdleMs,
		cooldowns: parseNumberRecord(value.cooldowns, "cooldowns", path),
		quotaBlockedUntil: parseNumberRecord(value.quotaBlockedUntil, "quotaBlockedUntil", path),
	};
}

function readConfigUnlocked(path: string): Config {
	if (!existsSync(path)) return createEmptyConfig();

	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parseConfig(value, path);
	} catch (error) {
		if (error instanceof ConfigLoadError) throw error;
		throw new ConfigLoadError(path, "JSON cannot be read");
	}
}

function sleepSync(milliseconds: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, milliseconds);
}

function acquireLock(path: string): string {
	const lockPath = `${path}.lock`;
	const startedAt = Date.now();
	mkdirSync(dirname(path), { recursive: true });

	while (true) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			return lockPath;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;

			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// The other process may have released the lock between stat and removal.
			}

			if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for OpenCode rotation config lock: ${lockPath}`);
			}
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

function withLock<T>(path: string, operation: () => T): T {
	const lockPath = acquireLock(path);
	try {
		return operation();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function writeConfigUnlocked(path: string, config: Config): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const serialized = `${JSON.stringify(config, null, 2)}\n`;
	let descriptor: number | undefined;

	try {
		descriptor = openSync(temporaryPath, "wx", CONFIG_FILE_MODE);
		writeSync(descriptor, serialized, undefined, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, CONFIG_FILE_MODE);
		renameSync(temporaryPath, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
	}
}

export function loadConfig(path = getConfigPath()): Config {
	return readConfigUnlocked(path);
}

export function updateConfig<T>(mutator: (config: Config) => T, path = getConfigPath()): { config: Config; result: T } {
	return withLock(path, () => {
		const config = readConfigUnlocked(path);
		const result = mutator(config);
		writeConfigUnlocked(path, config);
		return { config, result };
	});
}

export function writeConfig(config: Config, path = getConfigPath()): void {
	withLock(path, () => writeConfigUnlocked(path, config));
}
