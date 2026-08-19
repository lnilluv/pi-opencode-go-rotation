import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { FetchApi, OpenCodeGoUsageWindow } from "../src/index.ts";
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
} {
	return JSON.parse(readFileSync(path, "utf-8"));
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

function createHarness(registryShape: "authStorage" | "runtime" = "authStorage", fetch: FetchApi = async () => ({ ok: false, status: 404, json: async () => ({}) })): { pi: FakePi; ctx: ExtensionContext; state: FakeContextState; timers: FakeTimers; clock: FakeClock } {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const pi = new FakePi();
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

test("config writes restore private file permissions", async () => {
	await withTempConfig(async (configPath) => {
		chmodSync(configPath, 0o644);
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "reset", ctx);

		assert.equal(statSync(configPath).mode & 0o777, 0o600);
	});
});
