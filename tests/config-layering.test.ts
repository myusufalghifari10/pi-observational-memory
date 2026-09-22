import { describe, expect, it } from "vitest";

import { DEFAULTS, mergeSettingsConfig } from "../src/config.js";

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
