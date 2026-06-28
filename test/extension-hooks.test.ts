import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeGoRotationExtension } from "../src/index.ts";

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

function createContext(state: FakeContextState): ExtensionContext {
	const context = {
		model: { provider: "opencode-go" },
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			authStorage: {
				setRuntimeApiKey: (_provider: string, key: string) => {
					state.runtimeKeys.push(key);
				},
				removeRuntimeApiKey: (_provider: string) => {
					state.runtimeKeys.push("removed");
				},
			},
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

function createHarness(): { pi: FakePi; ctx: ExtensionContext; state: FakeContextState; timers: FakeTimers; clock: FakeClock } {
	const timers = new FakeTimers();
	const clock = new FakeClock();
	const pi = new FakePi();
	const state: FakeContextState = { runtimeKeys: [], notifications: [], aborts: 0 };
	const ctx = createContext(state);
	const extension = createOpencodeGoRotationExtension({ timers, clock });
	extension(pi as unknown as ExtensionAPI);
	return { pi, ctx, state, timers, clock };
}

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
