import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AnthropicOptions, Context, Usage } from "@mariozechner/pi-ai";
import { getModel, streamAnthropic } from "@mariozechner/pi-ai";
import type { FetchApi, OpenCodeGoUsageWindow } from "../src/index.ts";
import { updateConfig, type Config } from "../src/config-store.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeGoRotationExtension, parseOpenCodeGoUsage } from "../src/index.ts";

interface FakeTimerEntry {
	callback: () => void;
	ms: number;
}

class FakeTimers {
	private nextId = 1;
	private readonly timers: Record<number, FakeTimerEntry> = {};

	setTimeout = (callback: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers[id] = { callback, ms };
		return id;
	};

	clearTimeout = (timer: unknown): void => {
		if (typeof timer !== "number") return;
		delete this.timers[timer];
	};

	fireAll(): void {
		const pending = Object.entries(this.timers);
		for (const [id, entry] of pending) {
			delete this.timers[Number(id)];
			entry.callback();
		}
	}

	fireByDelay(ms: number): void {
		const pending = Object.entries(this.timers).filter(([, entry]) => entry.ms === ms);
		for (const [id, entry] of pending) {
			delete this.timers[Number(id)];
			entry.callback();
		}
	}
}

class FakeClock {
	time = 0;

	now = (): number => this.time;

	advance(ms: number): void {
		this.time += ms;
	}
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface CommandRegistration {
	description: string;
	handler: CommandHandler;
}

class FakePi {
	readonly handlers: Record<string, EventHandler> = {};
	readonly commands: Record<string, CommandRegistration> = {};
	readonly providerRegistrations: Array<{ provider: string; apiKey: string | undefined }> = [];
	readonly providerUnregistrations: string[] = [];
	readonly registerProvider: ((provider: string, config: { apiKey?: string }) => void) | undefined;
	readonly unregisterProvider: ((provider: string) => void) | undefined;

	constructor(providerRegistration = true) {
		if (providerRegistration) {
			this.registerProvider = (provider, config) => {
				this.providerRegistrations.push({ provider, apiKey: config.apiKey });
			};
			this.unregisterProvider = (provider) => {
				this.providerUnregistrations.push(provider);
			};
		}
	}

	on(event: string, handler: EventHandler): void {
		this.handlers[event] = handler;
	}

	registerCommand(name: string, command: CommandRegistration): void {
		this.commands[name] = command;
	}

	async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		const handler = this.handlers[event];
		assert.ok(handler, `missing handler ${event}`);
		return await handler(payload, ctx);
	}

	async runCommand(name: string, args: string, ctx: ExtensionContext): Promise<unknown> {
		const command = this.commands[name];
		assert.ok(command, `missing command ${name}`);
		return await command.handler(args, ctx);
	}
}

interface FakeContextState {
	readonly runtimeKeys: string[];
	readonly notifications: string[];
	aborts: number;
}

function createContext(state: FakeContextState, registryShape: "authStorage" | "runtime" = "authStorage"): ExtensionContext {
	const keyStore = {
		setRuntimeApiKey: (_provider: string, key: string) => {
			state.runtimeKeys.push(key);
		},
		removeRuntimeApiKey: (_provider: string) => {
			state.runtimeKeys.push("removed");
		},
	};
	const context = {
		model: { provider: "opencode-go", baseUrl: "https://example.test/opencode" },
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			[registryShape]: keyStore,
		},
		ui: {
			notify: (message: string) => {
				state.notifications.push(message);
			},
		},
		abort: () => {
			state.aborts++;
		},
	};
	// Test double: this object implements only the ExtensionContext fields used by this extension.
	return context as unknown as ExtensionContext;
}

function writeConfig(path: string): void {
	writeFileSync(path, JSON.stringify({
		keys: [
			{ name: "one", key: "sk-one" },
			{ name: "two", key: "sk-two" },
			{ name: "three", key: "sk-three" },
		],
		activeKeyIndex: 0,
		cooldownMinutes: 60,
		watchdogEnabled: true,
		watchdogIdleMs: 90_000,
		cooldowns: {},
	}), { mode: 0o600 });
}

function readConfig(path: string): {
	activeKeyIndex: number;
	cooldowns: Record<string, number>;
	quotaBlockedUntil?: Record<string, number>;
	keys: Array<{ name: string; key: string }>;
} {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function patchConfig(path: string, patch: Record<string, unknown>): void {
	const persisted = JSON.parse(readFileSync(path, "utf-8"));
	writeFileSync(path, JSON.stringify({ ...persisted, ...patch }), { mode: 0o600 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const activeUsage = (name = "weekly") => usageResponse([{ name, status: "active" }]);

function usageResponse(windows: OpenCodeGoUsageWindow[]): Awaited<ReturnType<FetchApi>> {
	return { ok: true, status: 200, json: async () => ({ windows }) };
}


let tempConfigQueue = Promise.resolve();

async function withTempConfig(run: (configPath: string) => Promise<void>): Promise<void> {
	const previous = tempConfigQueue;
	let release: () => void = () => {};
	tempConfigQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;

	const dir = mkdtempSync(join(tmpdir(), "opencode-rotation-test-"));
	const configPath = join(dir, "opencode-keys.json");
	const previousConfigPath = process.env.PI_OPENCODE_ROTATION_CONFIG;
	process.env.PI_OPENCODE_ROTATION_CONFIG = configPath;
	writeConfig(configPath);
	try {
		await run(configPath);
	} finally {
		if (previousConfigPath === undefined) {
			delete process.env.PI_OPENCODE_ROTATION_CONFIG;
		} else {
			process.env.PI_OPENCODE_ROTATION_CONFIG = previousConfigPath;
		}
		rmSync(dir, { recursive: true, force: true });
		release();
	}
}

function createHarness(
	registryShape: "authStorage" | "runtime" = "authStorage",
	fetch: FetchApi = async () => ({ ok: false, status: 404, json: async () => ({}) }),
	providerRegistration = true,
): { pi: FakePi; ctx: ExtensionContext; state: FakeContextState; timers: FakeTimers; clock: FakeClock } {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const pi = new FakePi(providerRegistration);
	const state: FakeContextState = { runtimeKeys: [], notifications: [], aborts: 0 };
	const ctx = createContext(state, registryShape);
	const extension = createOpencodeGoRotationExtension({ timers, clock, fetch });
	extension(pi as unknown as ExtensionAPI);
	return { pi, ctx, state, timers, clock };
}

test("usage helpers parse the upstream response shape", () => {
	const rollingWindow = {
		name: "rolling",
		status: "active",
		usagePercent: 12,
		resetAt: "2026-08-13T00:00:00Z",
	} satisfies OpenCodeGoUsageWindow;
	assert.deepEqual(parseOpenCodeGoUsage({
		usage: {
			rolling: { status: "ok", percent: 12, resetsAt: "2026-08-13T00:00:00Z" },
			weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-19T00:00:00Z" },
		},
	}), {
		windows: [
			rollingWindow,
			{ name: "weekly", status: "rate-limited", usagePercent: 100, resetAt: "2026-08-19T00:00:00Z" },
		],
	});
	assert.deepEqual(parseOpenCodeGoUsage({
		plan: "lite",
		useBalance: true,
		windows: [{ name: "5-hour", status: "ok", usagePercent: 70, resetInSec: 8_100, used: 8.4, limit: 12 }],
	}), {
		windows: [{ name: "5-hour", status: "active", usagePercent: 70, resetInSec: 8_100, used: 8.4, limit: 12 }],
	});
	assert.deepEqual(parseOpenCodeGoUsage({ windows: [{ name: "5-hour", status: "bad" }] }), { windows: [{ name: "5-hour", status: "unknown" }] });
});

test("session start supports the current model registry runtime store", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness("runtime");

		await pi.emit("session_start", { reason: "start" }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-one");
	});
});

test("factory advertises the active key before startup model selection", async () => {
	await withTempConfig(async () => {
		const { pi, state } = createHarness();

		assert.deepEqual(pi.providerRegistrations, [{ provider: "opencode-go", apiKey: "sk-one" }]);
		assert.deepEqual(state.runtimeKeys, []);
	});
});

test("config mutations re-advertise the provider", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "next", ctx);

		assert.deepEqual(pi.providerRegistrations.map((entry) => entry.apiKey), ["sk-one", "sk-two"]);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
	});
});

test("removing the last key clears the registered provider", async () => {
	await withTempConfig(async (configPath) => {
		writeFileSync(configPath, JSON.stringify({ keys: [{ name: "one", key: "sk-one" }] }), { mode: 0o600 });
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "remove 1", ctx);

		assert.deepEqual(pi.providerRegistrations.map((entry) => entry.apiKey), ["sk-one"]);
		assert.deepEqual(pi.providerUnregistrations, ["opencode-go"]);
	});
});

test("factory advertises an available key when the active key is quota-blocked", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { quotaBlockedUntil: { 0: 4_102_444_800_000 } });
		const { pi } = createHarness();

		assert.deepEqual(pi.providerRegistrations, [{ provider: "opencode-go", apiKey: "sk-two" }]);
	});
});

test("older Pi versions without pi.registerProvider keep loading and rotating", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness("authStorage", undefined, false);

		await pi.emit("session_start", { reason: "start" }, ctx);

		assert.deepEqual(pi.providerRegistrations, []);
		assert.equal(state.runtimeKeys.at(-1), "sk-one");
	});
});

test("runtime registry supports resume, reload, and final-key removal", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness("runtime");
		await pi.emit("session_start", { reason: "resume" }, ctx);
		await pi.emit("session_start", { reason: "reload" }, ctx);
		assert.deepEqual(state.runtimeKeys, ["sk-one", "sk-one"]);
		await pi.runCommand("opencode", "remove 3", ctx);
		await pi.runCommand("opencode", "remove 2", ctx);
		await pi.runCommand("opencode", "remove 1", ctx);
		assert.equal(state.runtimeKeys.at(-1), "removed");
	});
});

test("hook replay aborts a no-response hang and rotates", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		clock.advance(90_000);
		timers.fireAll();
		const result = await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "abort", errorMessage: "" },
		}, ctx);

		assert.equal(state.aborts, 1);
		assert.deepEqual(state.runtimeKeys.at(-1), "sk-two");
		assert.match(JSON.stringify(result), /waiting for response stalled/);
		assert.match(JSON.stringify(result), /rotated to two/);
	});
});

test("late 429 after a watchdog rotation does not rotate a second key", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		clock.advance(90_000);
		timers.fireAll();
		assert.equal(state.runtimeKeys.at(-1), "sk-two");

		clock.advance(6_000);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
	});
});

test("disabling the watchdog clears a stale timeout guard", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		clock.advance(90_000);
		timers.fireAll();
		assert.equal(state.runtimeKeys.at(-1), "sk-two");

		await pi.runCommand("opencode", "watchdog off", ctx);
		await pi.emit("before_provider_request", {}, ctx);
		clock.advance(6_000);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-three");
	});
});

test("hook replay reuses the 429-rotated key when the 429 body hangs", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		clock.advance(90_000);
		timers.fireAll();
		const result = await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "abort", errorMessage: "" },
		}, ctx);
		await pi.runCommand("opencode", "events", ctx);

		assert.equal(state.aborts, 1);
		assert.deepEqual(state.runtimeKeys.at(-1), "sk-two");
		assert.match(JSON.stringify(result), /last HTTP 429/);
		assert.match(JSON.stringify(result), /using two/);
		assert.match(state.notifications.join("\n"), /using=two/);
	});
});

test("hook replay keeps the rapid-retry rotation when the second 429 hangs", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "429 rate limit" },
		}, ctx);
		assert.deepEqual(state.runtimeKeys.at(-1), "sk-two");

		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		clock.advance(90_000);
		timers.fireAll();
		const result = await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "abort", errorMessage: "" },
		}, ctx);

		assert.equal(state.aborts, 1);
		assert.deepEqual(state.runtimeKeys.at(-1), "sk-three");
		assert.match(JSON.stringify(result), /last HTTP 429/);
		assert.match(JSON.stringify(result), /using three/);
	});
});

test("a rapid retry can rotate again in a new request", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");

		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-three");
	});
});

test("fixed-window quota errors block the failed key and rotate automatically", async () => {
	await withTempConfig(async (configPath) => {
		const { pi, ctx, state } = createHarness();
		const quotaError = "You have exceeded the 5-hour usage quota. It will reset at 2026-08-01T12:00:00Z";

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: quotaError },
		}, ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], Date.parse("2026-08-01T12:00:00Z"));
	});
});

test("fixed-window quota errors fall back to the cooldown when no reset is parseable", async () => {
	await withTempConfig(async (configPath) => {
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the 5-hour usage quota.",
			},
		}, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 3_600_000);
	});
});

test("response quota rotation and message_end cannot rotate twice", async () => {
	await withTempConfig(async (configPath) => {
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "weekly", status: "rate-limited", resetInSec: 3_600 }] }),
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the weekly usage quota. It will reset at 2026-08-01T12:00:00Z",
			},
		}, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "0": Date.parse("2026-08-01T12:00:00Z") });
	});
});

test("one transient 429 request cannot rotate twice after the old dedup window", async () => {
	await withTempConfig(async () => {
		const fetch: FetchApi = async () => ({ ok: false, status: 503, json: async () => ({}) });
		const { pi, ctx, state, clock } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		clock.advance(6_000);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "429 rate limit" },
		}, ctx);

		assert.deepEqual(state.runtimeKeys, ["sk-one", "sk-two"]);
	});
});

test("a fixed-window message upgrades a transient response rotation without rotating again", async () => {
	await withTempConfig(async (configPath) => {
		const fetch: FetchApi = async () => ({ ok: false, status: 503, json: async () => ({}) });
		const { pi, ctx, state } = createHarness("authStorage", fetch);
		const reset = Date.parse("2026-08-01T12:00:00Z");

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the weekly usage quota. It will reset at 2026-08-01T12:00:00Z",
			},
		}, ctx);

		assert.deepEqual(state.runtimeKeys, ["sk-one", "sk-two"]);
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], reset);
	});
});

test("an authoritative message reset replaces a longer usage fallback", async () => {
	await withTempConfig(async (configPath) => {
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "weekly", status: "rate-limited" }] }),
		});
		const { pi, ctx } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 3_600_000);

		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the weekly usage quota. It will reset at 1970-01-01T00:30:00Z",
			},
		}, ctx);

		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 1_800_000);
	});
});

test("an unmatched 429 response cannot rotate after another provider request starts", async () => {
	await withTempConfig(async (configPath) => {
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		Object.assign(ctx, { model: { provider: "deepseek", baseUrl: "https://api.deepseek.com" } });
		await pi.emit("before_provider_request", {}, ctx);
		Object.assign(ctx, { model: { provider: "opencode-go", baseUrl: "https://example.test/opencode" } });
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.deepEqual(state.runtimeKeys, ["sk-one"]);
		assert.deepEqual(readConfig(configPath).cooldowns, {});
	});
});

test("sequential quota failures try each key once and then stop", async () => {
	await withTempConfig(async (configPath) => {
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "weekly", status: "rate-limited", resetInSec: 3_600 }] }),
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		for (const expectedKey of ["sk-two", "sk-three", "sk-three"]) {
			await pi.emit("before_provider_request", {}, ctx);
			await pi.emit("after_provider_response", { status: 429 }, ctx);
			assert.equal(state.runtimeKeys.at(-1), expectedKey);
		}
		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the weekly usage quota. It will reset at 2026-08-01T12:00:00Z",
			},
		}, ctx);

		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, {
			"0": 3_600_000,
			"1": 3_600_000,
			"2": Date.parse("2026-08-01T12:00:00Z"),
		});
		assert.match(state.notifications.join("\n"), /all configured keys.*quota-blocked/i);
		assert.equal(state.notifications.filter((message) => /all configured keys.*quota-blocked/i.test(message)).length, 1);
	});
});

test("transient all-cooldown fallback skips active quota blocks", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			cooldowns: { 1: 0, 2: 0 },
			quotaBlockedUntil: { 1: 3_600_000 },
		}), { mode: 0o600 });
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "429 rate limit" },
		}, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-three");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "1": 3_600_000 });
	});
});

test("quota exhaustion falls back to a cooling key instead of keeping the blocked key active", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			cooldowns: { 1: 0, 2: 0 },
		}), { mode: 0o600 });
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "weekly", status: "rate-limited", resetInSec: 3_600 }] }),
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "0": 3_600_000 });
		assert.deepEqual(readConfig(configPath).cooldowns, { "2": 0 });
	});
});

test("usage command fetches active key usage without exposing key material", async () => {
	await withTempConfig(async () => {
		const calls: Array<{ url: string; authorization?: string }> = [];
		const fetch: FetchApi = async (url, init) => {
			calls.push({ url, authorization: init.headers.Authorization });
			return {
				ok: true,
				status: 200,
				json: async () => ({
					plan: "lite",
					useBalance: false,
					windows: [{ name: "5-hour", status: "active", usagePercent: 70, resetInSec: 8_100, used: 8.4, limit: 12, remaining: 3.6 }],
				}),
			};
		};
		const { pi, ctx, state } = createHarness("authStorage", fetch);
		Object.assign(ctx, { model: { provider: "deepseek", baseUrl: "https://api.deepseek.com" } });

		await pi.runCommand("opencode", "usage", ctx);

		assert.deepEqual(calls, [{ url: "https://opencode.ai/zen/go/v1/usage", authorization: "Bearer sk-one" }]);
		const notification = state.notifications.at(-1) ?? "";
		assert.match(notification, /OpenCode usage for one/);
		assert.match(notification, /5-hour: active; 70% used; 8\.4\/12 used; 3\.6 remaining; resets in 2h 15m/);
		assert.doesNotMatch(notification, /sk-one/);
	});
});

test("usage command times out and aborts an unresponsive usage request", async () => {
	await withTempConfig(async () => {
		let usageSignal: AbortSignal | undefined;
		const fetch: FetchApi = async (_url, init) => {
			usageSignal = init.signal;
			return await new Promise(() => {});
		};
		const { pi, ctx, state, timers } = createHarness("authStorage", fetch);

		const command = pi.runCommand("opencode", "usage", ctx);
		timers.fireByDelay(10_000);
		const completed = await Promise.race([
			command.then(() => true),
			new Promise<false>((resolve) => globalThis.setTimeout(() => resolve(false), 25)),
		]);

		assert.equal(completed, true);
		assert.equal(usageSignal?.aborted, true);
		assert.match(state.notifications.at(-1) ?? "", /timed out after 10s/);
	});
});

test("usage timeout keeps the timeout result when fetch rejects on abort", async () => {
	await withTempConfig(async () => {
		const fetch: FetchApi = async (_url, init) => await new Promise((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		const { pi, ctx, state, timers } = createHarness("authStorage", fetch);

		const command = pi.runCommand("opencode", "usage", ctx);
		timers.fireByDelay(10_000);
		await command;

		assert.match(state.notifications.at(-1) ?? "", /timed out after 10s/);
	});
});

test("removing the fetched key invalidates a late quota result for its replacement index", async () => {
	await withTempConfig(async (configPath) => {
		let resolveUsage: ((response: Awaited<ReturnType<FetchApi>>) => void) | undefined;
		const fetch: FetchApi = async () => await new Promise((resolve) => {
			resolveUsage = resolve;
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const responseHook = pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.runCommand("opencode", "rm 1", ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");

		assert.ok(resolveUsage);
		resolveUsage({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "5-hour", status: "rate-limited", usagePercent: 100 }] }),
		});
		await responseHook;

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, {});
		assert.doesNotMatch(state.notifications.join("\n"), /automatic key rotation paused|OpenCode usage/);
	});
});

test("a new request invalidates a late quota result for the same key", async () => {
	await withTempConfig(async (configPath) => {
		let resolveUsage: ((response: Awaited<ReturnType<FetchApi>>) => void) | undefined;
		const fetch: FetchApi = async () => await new Promise((resolve) => {
			resolveUsage = resolve;
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const responseHook = pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.emit("before_provider_request", {}, ctx);

		assert.ok(resolveUsage);
		resolveUsage({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "5-hour", status: "rate-limited", usagePercent: 100 }] }),
		});
		await responseHook;

		assert.equal(state.runtimeKeys.at(-1), "sk-one");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil ?? {}, {});
		assert.doesNotMatch(state.notifications.join("\n"), /automatic key rotation paused|OpenCode usage/);
	});
});

test("session reload invalidates a pending quota decision", async () => {
	await withTempConfig(async (configPath) => {
		let resolveUsage: ((response: Awaited<ReturnType<FetchApi>>) => void) | undefined;
		const fetch: FetchApi = async () => await new Promise((resolve) => {
			resolveUsage = resolve;
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const responseHook = pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.emit("session_start", { reason: "reload" }, ctx);

		assert.ok(resolveUsage);
		resolveUsage({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "weekly", status: "rate-limited", resetInSec: 3_600 }] }),
		});
		await responseHook;

		assert.equal(state.runtimeKeys.at(-1), "sk-one");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil ?? {}, {});
	});
});

test("late quota usage after watchdog rotation cannot pause the new key", async () => {
	await withTempConfig(async (configPath) => {
		let resolveUsage: ((response: Awaited<ReturnType<FetchApi>>) => void) | undefined;
		const fetch: FetchApi = async () => await new Promise((resolve) => {
			resolveUsage = resolve;
		});
		const { pi, ctx, state, timers, clock } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const responseHook = pi.emit("after_provider_response", { status: 429 }, ctx);
		clock.advance(90_000);
		timers.fireByDelay(90_000);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");

		assert.ok(resolveUsage);
		resolveUsage({
			ok: true,
			status: 200,
			json: async () => ({ windows: [{ name: "5-hour", status: "rate-limited", usagePercent: 100 }] }),
		});
		await responseHook;

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil ?? {}, {});
		assert.doesNotMatch(state.notifications.join("\n"), /automatic key rotation paused/);
	});
});

test("unknown command help lists the quota alias", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "unknown", ctx);

		assert.match(state.notifications.at(-1) ?? "", /usage\|quota/);
	});
});

test("http 429 rotates and persists the latest authoritative usage reset", async () => {
	await withTempConfig(async (configPath) => {
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				plan: "lite",
				useBalance: false,
				windows: [
					{ name: "5-hour", status: "rate-limited", usagePercent: 100, resetInSec: 3_600 },
					{ name: "weekly", status: "rate-limited", usagePercent: 100, resetInSec: 86_400, used: 30, limit: 30 },
				],
			}),
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 86_400_000);
		assert.match(state.notifications.join("\n"), /weekly: rate-limited; 100% used/);
	});
});

test("http 401 verifies monthly quota and rotates once before retry", async () => {
	await withTempConfig(async (configPath) => {
		const reset = "2026-09-01T00:00:00Z";
		const fetch: FetchApi = async () => ({
			ok: true, status: 200,
			json: async () => ({ usage: { monthly: { status: "rate-limited", percent: 100, resetsAt: reset } } }),
		});
		const { pi, ctx, state } = createHarness("runtime", fetch);
		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 401 }, ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.equal(readConfig(configPath).activeKeyIndex, 1);
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], Date.parse(reset));
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "401 Insufficient balance" },
		}, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		assert.deepEqual(state.runtimeKeys, ["sk-one", "sk-two"]);
	});
});

test("http 401 quota rotation survives a stalled response body without rotating again", async () => {
	await withTempConfig(async (configPath) => {
		const { pi, ctx, state, clock, timers } = createHarness("runtime", async () => ({
			ok: true, status: 200,
			json: async () => ({ usage: { monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-01T00:00:00Z" } } }),
		}));
		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 401 }, ctx);
		clock.advance(90_000);
		timers.fireAll();
		assert.equal(state.aborts, 1);
		assert.deepEqual(state.runtimeKeys, ["sk-one", "sk-two"]);
		assert.equal(readConfig(configPath).activeKeyIndex, 1);
	});
});

for (const usageResponse of [
	{ ok: false, status: 401, json: async () => ({}) },
	{ ok: false, status: 503, json: async () => ({}) },
	{ ok: true, status: 200, json: async () => ({ usage: { monthly: { status: "ok", percent: 10 } } }) },
]) {
	test(`http 401 does not rotate without confirmed quota (${usageResponse.status}, ${usageResponse.ok})`, async () => {
		await withTempConfig(async (configPath) => {
			const { pi, ctx, state } = createHarness("runtime", async () => usageResponse);
			await pi.emit("session_start", { reason: "start" }, ctx);
			await pi.emit("before_provider_request", {}, ctx);
			await pi.emit("after_provider_response", { status: 401 }, ctx);
			await pi.emit("message_end", {
				message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "401 Unauthorized: authentication limit reached; monthly quota" },
			}, ctx);
			assert.deepEqual(state.runtimeKeys, ["sk-one"]);
			assert.equal(readConfig(configPath).activeKeyIndex, 0);
			assert.deepEqual(readConfig(configPath).quotaBlockedUntil ?? {}, {});
		});
	});
}

test("http 429 preserves transient rotation when usage endpoint is unavailable", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, clock } = createHarness("authStorage", async () => ({ ok: false, status: 404, json: async () => ({}) }));

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		clock.advance(6_000);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
	});
});

test("expired quota blocks become eligible again", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			quotaBlockedUntil: { 0: 1_000, 1: 5_000, 2: 5_000 },
		}), { mode: 0o600 });
		const { pi, ctx, state, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		assert.equal(state.runtimeKeys.length, 0);

		clock.advance(1_001);
		await pi.emit("session_start", { reason: "reload" }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-one");
	});
});

test("manual use, next, and reset clear their intended quota blocks", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			cooldowns: { 0: 10, 1: 20, 2: 30 },
			quotaBlockedUntil: { 0: 3_600_000, 1: 3_600_000, 2: 3_600_000 },
		}), { mode: 0o600 });
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "use 2", ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).cooldowns, { "0": 10, "2": 30 });
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "0": 3_600_000, "2": 3_600_000 });

		await pi.runCommand("opencode", "next", ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-three");
		assert.deepEqual(readConfig(configPath).cooldowns, { "0": 10 });
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "0": 3_600_000 });

		await pi.runCommand("opencode", "reset", ctx);
		assert.deepEqual(readConfig(configPath).cooldowns, {});
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, {});
	});
});

test("removing a key reindexes cooldown and quota maps", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			cooldowns: { 0: 10, 1: 20, 2: 30 },
			quotaBlockedUntil: { 0: 100, 1: 200, 2: 300 },
		}), { mode: 0o600 });
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "rm 2", ctx);

		assert.deepEqual(readConfig(configPath).cooldowns, { "0": 10, "1": 30 });
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, { "0": 100, "1": 300 });
	});
});

test("status shows key names without exposing key material", async () => {
	await withTempConfig(async (configPath) => {
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		writeFileSync(configPath, JSON.stringify({
			...persisted,
			quotaBlockedUntil: { 1: 120_000 },
		}), { mode: 0o600 });
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "status", ctx);

		const status = state.notifications.at(-1) ?? "";
		assert.match(status, /one/);
		assert.match(status, /two/);
		assert.match(status, /two \[quota-blocked 2m\]/);
		assert.doesNotMatch(status, /sk-one|sk-two|sk-three/);
	});
});

test("missing quota block config loads as empty", async () => {
	await withTempConfig(async (configPath) => {
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "use 2", ctx);

		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, {});
	});
});

test("status does not claim an auth key when none is configured", async () => {
	await withTempConfig(async (configPath) => {
		writeFileSync(configPath, JSON.stringify({ keys: [] }), { mode: 0o600 });
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "status", ctx);

		const status = state.notifications.at(-1) ?? "";
		assert.match(status, /No keys configured/);
		assert.doesNotMatch(status, /Using auth\.json key/);
	});
});

test("a stale session shutdown cannot erase a key added by another session", async () => {
	await withTempConfig(async (configPath) => {
		const first = createHarness();
		const second = createHarness();

		await first.pi.emit("session_start", { reason: "start" }, first.ctx);
		await second.pi.emit("session_start", { reason: "start" }, second.ctx);
		await first.pi.runCommand("opencode", "add fresh sk-fresh", first.ctx);
		await second.pi.emit("session_shutdown", { reason: "quit" }, second.ctx);

		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		assert.deepEqual(persisted.keys.map((entry: { name: string }) => entry.name), ["one", "two", "three", "fresh"]);
	});
});

test("status reloads mutations made by another live session", async () => {
	await withTempConfig(async () => {
		const first = createHarness();
		const second = createHarness();

		await first.pi.emit("session_start", { reason: "start" }, first.ctx);
		await second.pi.emit("session_start", { reason: "start" }, second.ctx);
		await first.pi.runCommand("opencode", "add fresh sk-fresh", first.ctx);
		await second.pi.runCommand("opencode", "status", second.ctx);

		assert.match(second.state.notifications.at(-1) ?? "", /fresh/);
	});
});

test("usage reset deadlines start when the delayed response arrives", async () => {
	await withTempConfig(async (configPath) => {
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx, clock } = createHarness("authStorage", async () => usage.promise);
		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("after_provider_response", { status: 429 }, ctx);
		clock.advance(5_000);
		usage.resolve(usageResponse([{ status: "rate-limited", resetInSec: 600 }]));
		await pending;
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 605_000);
	});
});

test("a shared key selection cancels the old fast-path runtime application", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();
		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: "429 Too Many Requests" },
		}, ctx);
		updateConfig((config) => { config.activeKeyIndex = 2; });
		await pending;
		assert.deepEqual(state.runtimeKeys, ["sk-one"]);
		assert.equal(state.notifications.some((message) => /Rate-limited → rotated/.test(message)), false);
	});
});

test("config writes restore private file permissions", async () => {
	await withTempConfig(async (configPath) => {
		chmodSync(configPath, 0o644);
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "reset", ctx);

		assert.equal(statSync(configPath).mode & 0o777, 0o600);
	});
});

// ---------------------------------------------------------------------------
// Caller-bound reasoning projection (Chat Completions, Responses, Anthropic)
// ---------------------------------------------------------------------------

const toolMessage = { role: "tool", tool_call_id: "done", content: "Saved" };
const responsesToolResult = { type: "function_call_output", call_id: "done", output: "Saved" };
const nestedReasoningEntry = [{ signature: "nested" }];
const emptyReasoningEntry: unknown[] = [];

for (const { name, payload, expected } of [
	{
		name: "keeps Chat Completions reasoning shape without caller-bound entries",
		payload: {
			messages: [
				{
					role: "assistant",
					content: "Visible",
					tool_calls: [{ id: "done", type: "function", function: { name: "write", arguments: "{}" } }],
					reasoning_details: [
						{ type: "reasoning.encrypted", data: "opaque" },
						{ type: "reasoning.text", text: "Thought", signature: "caller-bound" },
						nestedReasoningEntry,
						emptyReasoningEntry,
						7,
						true,
					],
				},
				toolMessage,
			],
		},
		expected: {
			messages: [
				{
					role: "assistant",
					content: "Visible",
					tool_calls: [{ id: "done", type: "function", function: { name: "write", arguments: "{}" } }],
					reasoning_details: [{ type: "reasoning.text", text: "Thought" }, nestedReasoningEntry, emptyReasoningEntry, 7, true],
				},
				toolMessage,
			],
		},
	},
	{
		name: "strips only the reasoning_details key when every entry is opaque",
		payload: { messages: [{ role: "assistant", content: "Kept", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] }] },
		expected: { messages: [{ role: "assistant", content: "Kept" }] },
	},
	{
		name: "drops Responses reasoning items before function call output",
		payload: { input: [{ type: "reasoning", encrypted_content: "opaque" }, responsesToolResult] },
		expected: { input: [responsesToolResult] },
	},
	{
		name: "projects Anthropic thinking to visible text and drops opaque reasoning",
		payload: {
			messages: [{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Visible thought", signature: "caller-bound-signature" },
					{ type: "redacted_thinking", data: "caller-bound-ciphertext" },
					{ type: "text", text: "Visible answer" },
					{ type: "tool_use", id: "done", name: "write", input: {} },
				],
			}],
		},
		expected: {
			messages: [{
				role: "assistant",
				content: [
					{ type: "text", text: "Visible thought" },
					{ type: "text", text: "Visible answer" },
					{ type: "tool_use", id: "done", name: "write", input: {} },
				],
			}],
		},
	},
	{
		name: "omits only assistant messages emptied by the Anthropic projection",
		payload: {
			messages: [
				{ role: "user", content: "Go" },
				{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "   ", signature: "sig" }] },
				{ role: "assistant", content: [] },
				{ role: "assistant", content: "Kept" },
			],
		},
		expected: {
			messages: [
				{ role: "user", content: "Go" },
				{ role: "assistant", content: [] },
				{ role: "assistant", content: "Kept" },
			],
		},
	},
]) {
	test(`before_provider_request ${name}`, async () => {
		await withTempConfig(async () => {
			const { pi, ctx, state } = createHarness();
			const original = structuredClone(payload);

			const output = await pi.emit("before_provider_request", { payload }, ctx);

			assert.deepEqual(output, expected);
			assert.deepEqual(payload, original);
			Object.assign(ctx, { model: { provider: "deepseek", baseUrl: "https://api.deepseek.com" } });
			assert.equal(await pi.emit("before_provider_request", { payload }, ctx), undefined);
			assert.equal(state.runtimeKeys.length, 1);
		});
	});
}

test("chat and responses projection preserves element identity and other blocks", async () => {
	await withTempConfig(async () => {
		const { pi, ctx } = createHarness();
		const tool = { role: "tool", tool_call_id: "done", content: "Saved" };
		const assistant = {
			role: "assistant",
			content: "Visible",
			tool_calls: [{ id: "done", type: "function", function: { name: "write", arguments: "{}" } }],
			reasoning_details: [
				{ type: "reasoning.encrypted", data: "opaque" },
				{ type: "reasoning.text", text: "Thought", signature: "sig" },
				nestedReasoningEntry,
				emptyReasoningEntry,
				7,
				true,
			],
		};
		const payload = { messages: [assistant, tool] };

		// The hook returns the replacement payload as `unknown`; this test inspects its identity.
		const output = await pi.emit("before_provider_request", { payload }, ctx) as {
			messages: Array<{ reasoning_details: unknown[]; tool_calls: unknown }>;
		};

		assert.equal(output.messages[0].reasoning_details[1], nestedReasoningEntry);
		assert.equal(output.messages[0].reasoning_details[2], emptyReasoningEntry);
		assert.equal(output.messages[0].tool_calls, assistant.tool_calls);
		assert.equal(output.messages[1], tool);
	});
});

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function serializeAnthropicTurn(history: Context): Promise<unknown> {
	const model = getModel("opencode-go", "minimax-m2.7");
	assert.equal(model.api, "anthropic-messages");
	const { pi, ctx } = createHarness();
	Object.assign(ctx, { model });
	await pi.emit("session_start", { reason: "start" }, ctx);
	await pi.runCommand("opencode", "use 2", ctx);
	let outgoing: unknown;
	await streamAnthropic(model, history, {
		// Test double: stops before the Anthropic client can be used, so no network call happens.
		client: { messages: { create: () => { throw new Error("network must not be reached"); } } } as unknown as AnthropicOptions["client"],
		cacheRetention: "none",
		onPayload: async (payload) => {
			outgoing = await pi.emit("before_provider_request", { payload }, ctx);
			throw new Error("stop after real serialization");
		},
	}).result();
	return outgoing;
}

test("real Anthropic serialization drops caller-bound reasoning before any network call", async () => {
	await withTempConfig(async () => {
		const model = getModel("opencode-go", "minimax-m2.7");
		const history: Context = {
			messages: [
				{ role: "user", content: "Finish", timestamp: 0 },
				{
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					stopReason: "toolUse", usage: zeroUsage, timestamp: 0,
					content: [
						{ type: "thinking", thinking: "Visible thought", thinkingSignature: "caller-bound-signature" },
						{ type: "thinking", thinking: "", thinkingSignature: "caller-bound-ciphertext", redacted: true },
						{ type: "text", text: "Visible answer" },
						{ type: "toolCall", id: "done", name: "write", arguments: {} },
					],
				},
				{ role: "toolResult", toolCallId: "done", toolName: "write", content: [{ type: "text", text: "Saved" }], isError: false, timestamp: 1 },
			],
		};
		const original = structuredClone(history);

		const outgoing = await serializeAnthropicTurn(history);

		// The hook returns the replacement payload as `unknown`; this test inspects its concrete messages.
		const serialized = outgoing as { messages: unknown[] };
		assert.deepEqual(serialized.messages, [
			{ role: "user", content: "Finish" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Visible thought" },
					{ type: "text", text: "Visible answer" },
					{ type: "tool_use", id: "done", name: "write", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "done", content: "Saved", is_error: false }] },
		]);
		assert.deepEqual(history, original);
	});
});

test("real Anthropic serialization omits an assistant turn emptied by the projection", async () => {
	await withTempConfig(async () => {
		const model = getModel("opencode-go", "minimax-m2.7");
		const history: Context = {
			messages: [
				{ role: "user", content: "Go", timestamp: 0 },
				{
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					stopReason: "stop", usage: zeroUsage, timestamp: 0,
					content: [{ type: "thinking", thinking: "", thinkingSignature: "caller-bound-ciphertext", redacted: true }],
				},
				{
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					stopReason: "stop", usage: zeroUsage, timestamp: 1,
					content: [{ type: "text", text: "Kept" }],
				},
			],
		};
		const original = structuredClone(history);

		const outgoing = await serializeAnthropicTurn(history);

		const serialized = outgoing as { messages: unknown[] };
		assert.deepEqual(serialized.messages, [
			{ role: "user", content: "Go" },
			{ role: "assistant", content: [{ type: "text", text: "Kept" }] },
		]);
		assert.deepEqual(history, original);
	});
});

// ---------------------------------------------------------------------------
// Guarded quota recovery and late-continuation invalidation
// ---------------------------------------------------------------------------

const twoKeys = [{ name: "one", key: "sk-one" }, { name: "two", key: "sk-two" }];
const fixedWindowError = "You have exceeded the 5-hour usage quota.";
const transientError = "429 Too Many Requests";
const assistantError = (errorMessage: string) => ({
	message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage },
});

test("recovery clears a blocked key with confirmed headroom and rotates to it", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, quotaBlockedUntil: { 1: 9_999_999 } });
		const { pi, ctx, state } = createHarness("authStorage", async () => activeUsage());

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("message_end", assistantError(transientError), ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.deepEqual(readConfig(configPath).quotaBlockedUntil, {});
		assert.match(state.notifications.join("\n"), /two has headroom again/);
	});
});

test("late transient recovery cannot override a manual key selection", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, quotaBlockedUntil: { 1: 9_999_999 } });
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx, state } = createHarness("authStorage", async () => usage.promise);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("message_end", assistantError(transientError), ctx);
		await pi.runCommand("opencode", "use 1", ctx);
		usage.resolve(activeUsage());
		await pending;

		assert.equal(readConfig(configPath).activeKeyIndex, 0);
		assert.deepEqual(state.runtimeKeys, ["sk-one"]);
	});
});

test("late after-response recovery cannot override a manual key selection", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, quotaBlockedUntil: { 1: 9_999_999 } });
		const recovery = deferred<Awaited<ReturnType<FetchApi>>>();
		let probeStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => { probeStarted = resolve; });
		let calls = 0;
		const { pi, ctx, state } = createHarness("authStorage", async () => {
			calls++;
			if (calls === 1) return activeUsage();
			probeStarted();
			return await recovery.promise;
		});

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("after_provider_response", { status: 429 }, ctx);
		await started;
		await pi.runCommand("opencode", "use 1", ctx);
		recovery.resolve(activeUsage());
		await pending;

		assert.equal(readConfig(configPath).activeKeyIndex, 0);
		assert.deepEqual(state.runtimeKeys, ["sk-one"]);
	});
});

test("late recovery cannot quota-block a replacement for a removed failed key", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, activeKeyIndex: 1, quotaBlockedUntil: { 0: 9_999_999 } });
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx } = createHarness("authStorage", async () => usage.promise);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("message_end", assistantError(fixedWindowError), ctx);
		await pi.runCommand("opencode", "rm 2", ctx);
		await pi.runCommand("opencode", "add replacement synthetic-replacement", ctx);
		usage.resolve(activeUsage());
		await pending;

		const config = readConfig(configPath);
		assert.equal(config.keys[1].key, "synthetic-replacement");
		assert.equal(config.quotaBlockedUntil?.["1"], undefined);
	});
});

test("stale after-response bookkeeping cannot suppress the next request rotation", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, quotaBlockedUntil: { 1: 9_999_999 } });
		const recovery = deferred<Awaited<ReturnType<FetchApi>>>();
		let probeStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => { probeStarted = resolve; });
		let calls = 0;
		const { pi, ctx, state } = createHarness("authStorage", async () => {
			calls++;
			if (calls === 1) return activeUsage();
			probeStarted();
			return await recovery.promise;
		});

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("after_provider_response", { status: 429 }, ctx);
		await started;
		await pi.emit("before_provider_request", {}, ctx);
		recovery.resolve(activeUsage());
		await pending;

		assert.equal(state.runtimeKeys.at(-1), "sk-one", "a superseded response must not rotate or mark itself handled");
		await pi.emit("message_end", assistantError(transientError), ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
		assert.match(state.notifications.join("\n"), /Rate-limited → rotated to two/);
	});
});

test("a stale startup recovery cannot override a manual key selection", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { quotaBlockedUntil: { 0: 9_999_999 } });
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx } = createHarness("authStorage", async () => usage.promise);

		const startup = pi.emit("session_start", { reason: "start" }, ctx);
		await pi.runCommand("opencode", "use 3", ctx);
		usage.resolve(activeUsage());
		await startup;

		assert.equal(readConfig(configPath).activeKeyIndex, 2);
		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 9_999_999);
	});
});

const snapshotMutations = [
	{ name: "quota deadline", mutate: (config: Config) => { config.quotaBlockedUntil[0] = 19_999_999; } },
	{ name: "cooldown", mutate: (config: Config) => { config.cooldowns[0] = 500_000; } },
	{ name: "active selection", mutate: (config: Config) => { config.activeKeyIndex = 1; } },
	{ name: "credential", mutate: (config: Config) => { config.keys[0].key = "sk-replaced"; } },
] satisfies Array<{ name: string; mutate: (config: Config) => void }>;

for (const { name, mutate } of snapshotMutations) {
	test(`a changed shared ${name} cancels pending startup recovery`, async () => {
		await withTempConfig(async (configPath) => {
			patchConfig(configPath, { quotaBlockedUntil: { 0: 9_999_999 } });
			const usage = deferred<Awaited<ReturnType<FetchApi>>>();
			const { pi, ctx } = createHarness("authStorage", async () => usage.promise);

			const startup = pi.emit("session_start", { reason: "start" }, ctx);
			updateConfig((config) => mutate(config));
			const afterMutation = readConfig(configPath);
			usage.resolve(activeUsage());
			await startup;

			assert.deepEqual(readConfig(configPath), afterMutation);
		});
	});
}

for (const { name, response, cleared } of [
	{ name: "an empty window list", response: usageResponse([]), cleared: false },
	{ name: "mixed active and unknown windows", response: usageResponse([{ name: "rolling", status: "active" }, { name: "monthly", status: "unknown" }]), cleared: false },
	{ name: "a rate-limited window", response: usageResponse([{ status: "rate-limited" }]), cleared: false },
	{ name: "a malformed usage body", response: { ok: true, status: 200, json: async () => ({ windows: [42] }) }, cleared: false },
	{ name: "a failed usage request", response: { ok: false, status: 503, json: async () => ({}) }, cleared: false },
	{ name: "all windows active", response: usageResponse([{ name: "rolling", status: "active" }, { name: "weekly", status: "active" }]), cleared: true },
]) {
	test(`startup recovery treats ${name} as ${cleared ? "confirmed headroom" : "uncertain"}`, async () => {
		await withTempConfig(async (configPath) => {
			patchConfig(configPath, { quotaBlockedUntil: { 0: 9_999_999 } });
			const { pi, ctx, state } = createHarness("authStorage", async () => response);

			await pi.emit("session_start", { reason: "start" }, ctx);

			assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], cleared ? undefined : 9_999_999);
			// Recovery never replaces the startup fallback: an uncertain reading leaves the
			// healthy key active rather than leaving the session with no key.
			assert.equal(state.runtimeKeys.at(-1), cleared ? "sk-one" : "sk-two");
		});
	});
}

test("a late headroom snapshot cannot erase a newer shared-session quota block", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { quotaBlockedUntil: { 0: 9_999_999 } });
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx } = createHarness("authStorage", async () => usage.promise);

		const startup = pi.emit("session_start", { reason: "start" }, ctx);
		updateConfig((config) => { config.quotaBlockedUntil[0] = 19_999_999; });
		usage.resolve(activeUsage());
		await startup;

		assert.equal(readConfig(configPath).quotaBlockedUntil?.["0"], 19_999_999);
	});
});

test("a superseded response cannot rotate or finalize after a newer request starts", async () => {
	await withTempConfig(async () => {
		const fetch: FetchApi = async () => ({ ok: false, status: 404, json: async () => ({}) });
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("after_provider_response", { status: 429 }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pending;

		assert.doesNotMatch(state.notifications.join("\n"), /Proactive rate-limit detection/);
		await pi.emit("message_end", assistantError(transientError), ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two", "the newer request must still rotate exactly once");
	});
});

test("a fast-path message_end rotation cannot notify after a newer request starts", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("message_end", assistantError(transientError), ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pending;

		assert.doesNotMatch(state.notifications.join("\n"), /rotated to two/, "a superseded message_end must not report its old rotation");
	});
});

test("a stale uncertain recovery cannot report exhaustion for a superseded decision", async () => {
	await withTempConfig(async (configPath) => {
		patchConfig(configPath, { keys: twoKeys, quotaBlockedUntil: { 1: 9_999_999 } });
		const usage = deferred<Awaited<ReturnType<FetchApi>>>();
		const { pi, ctx, state } = createHarness("authStorage", async () => usage.promise);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const pending = pi.emit("message_end", assistantError(transientError), ctx);
		await pi.runCommand("opencode", "use 1", ctx);
		usage.resolve(usageResponse([]));
		await pending;

		assert.doesNotMatch(state.notifications.join("\n"), /all other keys are quota-blocked/);
	});
});
