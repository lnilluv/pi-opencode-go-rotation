import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { createEmptyConfig, ConfigLoadError, loadConfig, updateConfig, writeConfig } from "../src/config-store.ts";

function makeConfigPath(): { directory: string; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "opencode-rotation-store-test-"));
	return { directory, path: join(directory, "opencode-keys.json") };
}

function removeDirectory(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function runConcurrentUpdate(path: string, name: string): Promise<void> {
	const storePath = fileURLToPath(new URL("../src/config-store.ts", import.meta.url));
	const script = `
		import { updateConfig } from ${JSON.stringify(storePath)};
		const path = process.argv[1];
		const name = process.argv[2];
		updateConfig((config) => {
			config.keys.push({ name, key: "test-" + name });
			const end = Date.now() + 75;
			while (Date.now() < end) {}
		}, path);
	`;

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, path, name], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`child update failed (${code}): ${stderr}`));
		});
	});
}

test("updateConfig preserves concurrent mutations from separate processes", async () => {
	const { directory, path } = makeConfigPath();
	try {
		writeConfig(createEmptyConfig(), path);
		await Promise.all([
			runConcurrentUpdate(path, "alpha"),
			runConcurrentUpdate(path, "beta"),
		]);

		const config = loadConfig(path);
		assert.deepEqual(config.keys.map((entry) => entry.name).sort(), ["alpha", "beta"]);
	} finally {
		removeDirectory(directory);
	}
});

test("invalid JSON is reported without replacing the file with an empty config", () => {
	const { directory, path } = makeConfigPath();
	const invalidContent = "{ invalid json\n";
	try {
		writeFileSync(path, invalidContent, { mode: 0o600 });
		assert.throws(() => loadConfig(path), (error: unknown) => {
			assert.ok(error instanceof ConfigLoadError);
			return true;
		});
		assert.equal(readFileSync(path, "utf-8"), invalidContent);
		assert.equal(existsSync(`${path}.lock`), false);
	} finally {
		removeDirectory(directory);
	}
});
