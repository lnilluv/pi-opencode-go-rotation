import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { FetchApi, OpenCodeGoUsageWindowStatus } from "../src/index.ts";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeGoRotationExtension, getOpenCodeGoUsageUrl, parseOpenCodeGoUsage } from "../src/index.ts";

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

function withTempConfig(run: (configPath: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "opencode-rotation-test-"));
	const configPath = join(dir, "opencode-keys.json");
	const previous = process.env.PI_OPENCODE_ROTATION_CONFIG;
	process.env.PI_OPENCODE_ROTATION_CONFIG = configPath;
	writeConfig(configPath);
	return run(configPath).finally(() => {
		if (previous === undefined) {
			delete process.env.PI_OPENCODE_ROTATION_CONFIG;
		} else {
			process.env.PI_OPENCODE_ROTATION_CONFIG = previous;
		}
		rmSync(dir, { recursive: true, force: true });
	});
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
	const activeStatus: OpenCodeGoUsageWindowStatus = "active";
	assert.equal(activeStatus, "active");
	assert.equal(getOpenCodeGoUsageUrl("https://opencode.ai/zen/go/v1/"), "https://opencode.ai/zen/go/v1/usage");
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

test("hook replay rotates on a dedup-suppressed second 429 hang", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, timers, clock } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
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
		assert.match(JSON.stringify(result), /rotated to three/);
	});
});

test("fixed-window quota errors pause automatic rotation until manual selection", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();
		const quotaError = "You have exceeded the 5-hour usage quota. It will reset at 2026-08-01T12:00:00Z";

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "error", errorMessage: quotaError },
		}, ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-one");
		assert.match(state.notifications.join("\n"), /automatic key rotation paused/);

		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-one");

		await pi.runCommand("opencode", "next", ctx);
		assert.equal(state.runtimeKeys.at(-1), "sk-two");
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
			return await new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
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

test("late quota usage after watchdog rotation cannot pause the new key", async () => {
	await withTempConfig(async () => {
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

test("http 429 pauses rotation when usage endpoint reports a rate-limited window", async () => {
	await withTempConfig(async () => {
		const fetch: FetchApi = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				plan: "lite",
				useBalance: false,
				windows: [{ name: "weekly", status: "rate-limited", usagePercent: 100, resetInSec: 86_400, used: 30, limit: 30 }],
			}),
		});
		const { pi, ctx, state } = createHarness("authStorage", fetch);

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-one");
		assert.match(state.notifications.join("\n"), /automatic key rotation paused/);
		assert.match(state.notifications.join("\n"), /weekly: rate-limited; 100% used/);
	});
});

test("http 429 preserves transient rotation when usage endpoint is unavailable", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state, clock } = createHarness("authStorage", async () => ({ ok: false, status: 404, json: async () => ({}) }));

		await pi.emit("session_start", { reason: "start" }, ctx);
		clock.advance(6_000);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
	});
});

test("a successful provider message resumes automatic rotation after a quota hold", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.emit("session_start", { reason: "start" }, ctx);
		await pi.emit("message_end", {
			message: {
				role: "assistant",
				provider: "opencode-go",
				stopReason: "error",
				errorMessage: "You have exceeded the 5-hour usage quota. It will reset at 2026-08-01T12:00:00Z",
			},
		}, ctx);
		await pi.emit("message_end", {
			message: { role: "assistant", provider: "opencode-go", stopReason: "stop", errorMessage: "" },
		}, ctx);

		await pi.emit("before_provider_request", {}, ctx);
		await pi.emit("after_provider_response", { status: 429 }, ctx);

		assert.equal(state.runtimeKeys.at(-1), "sk-two");
	});
});

test("status shows key names without exposing key material", async () => {
	await withTempConfig(async () => {
		const { pi, ctx, state } = createHarness();

		await pi.runCommand("opencode", "status", ctx);

		const status = state.notifications.at(-1) ?? "";
		assert.match(status, /one/);
		assert.match(status, /two/);
		assert.doesNotMatch(status, /sk-one|sk-two|sk-three/);
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

test("config writes restore private file permissions", async () => {
	await withTempConfig(async (configPath) => {
		chmodSync(configPath, 0o644);
		const { pi, ctx } = createHarness();

		await pi.runCommand("opencode", "reset", ctx);

		assert.equal(statSync(configPath).mode & 0o777, 0o600);
	});
});
