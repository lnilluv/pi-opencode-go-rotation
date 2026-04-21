declare module "@mariozechner/pi-coding-agent" {
	interface ModelRegistry {
		authStorage: {
			setRuntimeApiKey(provider: string, key: string): void;
			removeRuntimeApiKey(provider: string): void;
		};
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	}

	interface UI {
		notify(msg: string, type: string): void;
	}

	interface ExtensionContext {
		modelRegistry: ModelRegistry;
		ui: UI;
		model?: { provider?: string };
	}

	export interface ExtensionAPI {
		on(eventName: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void;
		registerCommand(
			name: string,
			config: { description: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> },
		): void;
	}
}

declare module "node:fs" {
	export function readFileSync(path: string, encoding: string): string;
	export function writeFileSync(path: string, data: string, options?: { mode?: number }): void;
	export function existsSync(path: string): boolean;
	export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}

declare module "node:os" {
	export function homedir(): string;
}
