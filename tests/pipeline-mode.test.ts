/**
 * S1 — the worker pipeline is SEQUENTIAL-ONLY, exposed through the command surface.
 *
 * `serialWorkers` forced-to-true normalization is already pinned in tests/serial-workers.test.ts;
 * what is pinned HERE is the user-facing half: `/om-parallel` no longer exists (no path back to
 * parallel observers), and `/om-sequential` is informational — it must never write settings, so a
 * stale muscle-memory invocation cannot mutate the persisted config.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as switching from "../src/commands/switching.js";
import { registerSwitchingCommands } from "../src/commands/switching.js";
import { Runtime } from "../src/runtime.js";

type CommandDef = { description?: string; handler: (args: string, ctx: any) => Promise<void> | void };

function registerCommands(): Map<string, CommandDef> {
	const commands = new Map<string, CommandDef>();
	const pi = {
		registerCommand: (name: string, def: CommandDef) => commands.set(name, def),
		on: () => {},
	} as never;
	registerSwitchingCommands(pi, new Runtime());
	return commands;
}

describe("S1 command surface: parallel mode is gone", () => {
	it("does not register /om-parallel", () => {
		expect(registerCommands().has("om-parallel")).toBe(false);
	});

	it("no longer exports the parallel/sequential mode flipper", () => {
		expect("applyOmMode" in switching).toBe(false);
		expect("registerModeCommand" in switching).toBe(false);
	});

	it("keeps /om-sequential registered (old muscle memory lands on an explanation)", () => {
		const commands = registerCommands();
		expect(commands.has("om-sequential")).toBe(true);
		// the model switcher is untouched by the sequential change
		expect(commands.has("om-change-model")).toBe(true);
	});
});

describe("S1 /om-sequential writes nothing", () => {
	it("only notifies; the persisted settings file keeps its exact content (no write, no sidecar)", async () => {
		// The handler's write path (writeSettingsAtomic) would leave a `.bak` and/or `.tmp` next to
		// the file. Comparing content AND sidecars pins "writes nothing" without depending on the
		// machine already having a settings file.
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		const read = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf-8") : undefined);
		const mainBefore = read(settingsPath);
		const bakBefore = read(`${settingsPath}.bak`);
		const tmpBefore = read(`${settingsPath}.tmp`);

		const commands = registerCommands();
		const handler = commands.get("om-sequential")?.handler;
		if (!handler) throw new Error("/om-sequential handler not registered");

		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			cwd: tmpdir(), // an unrelated cwd: ensureConfig only reads
			ui: { notify: (message: string) => notices.push(message) },
		};

		await handler("", ctx);

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("sequential");
		expect(read(settingsPath)).toBe(mainBefore);
		expect(read(`${settingsPath}.bak`)).toBe(bakBefore);
		expect(read(`${settingsPath}.tmp`)).toBe(tmpBefore);
	});

	it("stays silent when there is no UI (headless worker hosts)", async () => {
		const commands = registerCommands();
		const handler = commands.get("om-sequential")?.handler;
		if (!handler) throw new Error("/om-sequential handler not registered");

		let notified = 0;
		const ctx = { hasUI: false, cwd: homedir(), ui: { notify: () => notified++ } };
		await handler("", ctx);
		expect(notified).toBe(0);
	});
});
