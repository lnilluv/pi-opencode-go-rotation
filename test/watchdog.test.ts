import test from "node:test";
import assert from "node:assert/strict";
import { ProviderIdleWatchdog, shouldWatchProvider } from "../src/index.ts";

class FakeTimers {
	private nextId = 1;
	private timers = new Map<number, () => void>();

	setTimeout = (callback: () => void, _ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, callback);
		return id;
	};

	clearTimeout = (id: number): void => {
		this.timers.delete(id);
	};

	fireAll(): void {
		const callbacks = [...this.timers.values()];
		this.timers.clear();
		for (const callback of callbacks) callback();
	}

	get size(): number {
		return this.timers.size;
	}
}

test("shouldWatchProvider only enables the watchdog for opencode-go", () => {
	assert.equal(shouldWatchProvider("opencode-go"), true);
	assert.equal(shouldWatchProvider("anthropic"), false);
	assert.equal(shouldWatchProvider(undefined), false);
});

test("ProviderIdleWatchdog fires once after an idle provider request", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	timers.fireAll();
	timers.fireAll();

	assert.equal(timeouts, 1);
	assert.equal(watchdog.consumeTimedOut(), true);
	assert.equal(watchdog.consumeTimedOut(), false);
});

test("ProviderIdleWatchdog resets the idle timer when activity is observed", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	assert.equal(timers.size, 1);
	watchdog.activity();
	assert.equal(timers.size, 1);

	timers.fireAll();

	assert.equal(timeouts, 1);
});

test("ProviderIdleWatchdog stop prevents timeout", () => {
	const timers = new FakeTimers();
	let timeouts = 0;
	const watchdog = new ProviderIdleWatchdog({
		idleMs: 90_000,
		onTimeout: () => timeouts++,
		timers,
	});

	watchdog.start();
	watchdog.stop();
	timers.fireAll();

	assert.equal(timeouts, 0);
	assert.equal(watchdog.consumeTimedOut(), false);
});
