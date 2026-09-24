import { describe, expect, it } from "vitest";

import { DEFAULTS, mergeSettingsConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mergeSettingsConfig (global layer then project layer)", () => {
	it("keeps the global provider/id when the project layer sets only models.observer.thinking", () => {
		const merged = mergeSettingsConfig(
			{ models: { observer: { provider: "llamacpp", id: "Local-Model", thinking: "low" } } },
			{ models: { observer: { thinking: "high" } } },
		);
		expect(merged.models?.observer).toEqual({
			provider: "llamacpp",
			id: "Local-Model",
			thinking: "high",
		});
	});

	it("project chunkTokens overrides global chunkTokens; empty project keeps the global value", () => {
		expect(mergeSettingsConfig({ chunkTokens: 1234 }, { chunkTokens: 4321 }).chunkTokens).toBe(4321);
		expect(mergeSettingsConfig({ chunkTokens: 1234 }, {}).chunkTokens).toBe(1234);
	});

	it("a project observer-only override leaves the other role untouched", () => {
		const merged = mergeSettingsConfig(
			{ models: { consolidator: { provider: "openrouter", id: "z-ai/glm-5.3", thinking: "medium" } } },
			{ models: { observer: { thinking: "high" } } },
		);
		expect(merged.models?.consolidator).toEqual({
			provider: "openrouter",
			id: "z-ai/glm-5.3",
			thinking: "medium",
		});
		// observer set only by the project → provider/id fall back to DEFAULTS, thinking from project
		expect(merged.models?.observer).toEqual({ ...DEFAULTS.models.observer, thinking: "high" });
	});

	it("global booleans survive a project file that does not mention them", () => {
		const merged = mergeSettingsConfig({ serialWorkers: true, passive: false }, { chunkTokens: 999 });
		expect(merged.serialWorkers).toBe(true);
		expect(merged.passive).toBe(false);
		expect(merged.chunkTokens).toBe(999);
	});
});

describe("Runtime.ensureConfig per-cwd cache (P0.2)", () => {
	function projectDir(chunkTokens: number): string {
		const dir = mkdtempSync(join(tmpdir(), "om-p02-"));
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ "observational-memory": { chunkTokens } }));
		return dir;
	}

	it("reloads settings when the session cwd changes (two projects, one process)", () => {
		const dirA = projectDir(1111);
		const dirB = projectDir(2222);
		const runtime = new Runtime();
		try {
			runtime.ensureConfig(dirA);
			expect(runtime.config.chunkTokens).toBe(1111);
			expect(runtime.configCwd).toBe(dirA);

			// Second session starts in another project → its settings win, not the cached ones.
			runtime.ensureConfig(dirB);
			expect(runtime.config.chunkTokens).toBe(2222);
			expect(runtime.configCwd).toBe(dirB);

			// Same cwd again → still cached (single load per distinct cwd).
			runtime.ensureConfig(dirB);
			expect(runtime.config.chunkTokens).toBe(2222);

			// Back to the first project → reloads again.
			runtime.ensureConfig(dirA);
			expect(runtime.config.chunkTokens).toBe(1111);
		} finally {
			rmSync(dirA, { recursive: true, force: true });
			rmSync(dirB, { recursive: true, force: true });
		}
	});
});
