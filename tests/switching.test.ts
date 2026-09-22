import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyOmMode, applyOmModelChange, writeSettingsAtomic } from "../src/commands/switching.js";

const SETTINGS_KEY = "observational-memory";

function baseSettings(): Record<string, unknown> {
	return {
		[SETTINGS_KEY]: {
			chunkTokens: 15000,
			serialWorkers: true,
			models: {
				observer: { provider: "llamacpp", id: "Local-Model", thinking: "low" },
			},
		},
		unrelated: { keep: 1 },
	};
}

describe("applyOmMode", () => {
	it("defaults to sequential on a fresh config (applyOmMode({}, false) creates serialWorkers=true)", () => {
		const next = applyOmMode({}, false);
		expect((next[SETTINGS_KEY] as { serialWorkers: boolean }).serialWorkers).toBe(true);
	});

	it("flips to parallel (parallel=true sets serialWorkers=false)", () => {
		const next = applyOmMode(baseSettings(), true);
		expect((next[SETTINGS_KEY] as { serialWorkers: boolean }).serialWorkers).toBe(false);
	});

	it("flips back to sequential (parallel=false sets serialWorkers=true)", () => {
		const parallel = applyOmMode(baseSettings(), true);
		const back = applyOmMode(parallel, false);
		expect((back[SETTINGS_KEY] as { serialWorkers: boolean }).serialWorkers).toBe(true);
	});

	it("creates the observational-memory key when absent", () => {
		const next = applyOmMode({}, true);
		expect((next[SETTINGS_KEY] as { serialWorkers: boolean }).serialWorkers).toBe(false);
	});

	it("preserves every other settings key", () => {
		const next = applyOmMode(baseSettings(), true);
		expect(next.unrelated).toEqual({ keep: 1 });
		expect((next[SETTINGS_KEY] as { chunkTokens: number }).chunkTokens).toBe(15000);
	});

	it("does not mutate the input object", () => {
		const settings = baseSettings();
		const snapshot = JSON.parse(JSON.stringify(settings));
		applyOmMode(settings, true);
		applyOmMode(settings, false);
		expect(settings).toEqual(snapshot);
	});
});

describe("applyOmModelChange", () => {
	it("changes a single role only", () => {
		const next = applyOmModelChange(baseSettings(), ["observer"], "openrouter/z-ai/glm-5.3", "medium");
		const models = (next[SETTINGS_KEY] as { models: Record<string, unknown> }).models;
		expect(models.observer).toEqual({ provider: "openrouter", id: "z-ai/glm-5.3", thinking: "medium" });
		expect(models.consolidator).toBeUndefined();
	});

	it("changes both roles when both are listed", () => {
		const next = applyOmModelChange(baseSettings(), ["observer", "consolidator"], "anthropic/claude-sonnet-4-6", "low");
		const models = (next[SETTINGS_KEY] as { models: Record<string, unknown> }).models;
		expect(models.observer).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6", thinking: "low" });
		expect(models.consolidator).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6", thinking: "low" });
	});

	it("leaves the other role untouched when only one role is listed", () => {
		const next = applyOmModelChange(baseSettings(), ["consolidator"], "zai/glm-5.3-flash", "high");
		const models = (next[SETTINGS_KEY] as { models: Record<string, unknown> }).models;
		expect(models.observer).toEqual({ provider: "llamacpp", id: "Local-Model", thinking: "low" });
		expect((models.consolidator as { id: string }).id).toBe("glm-5.3-flash");
	});

	it("preserves extra fields on an existing role override", () => {
		const settings = baseSettings();
		const om = settings[SETTINGS_KEY] as { models: { observer: Record<string, unknown> } };
		om.models.observer.extraField = "keep-me";
		const next = applyOmModelChange(settings, ["observer"], "openrouter/z-ai/glm-5.3", "medium");
		const observer = (next[SETTINGS_KEY] as { models: { observer: Record<string, unknown> } }).models.observer;
		expect(observer.extraField).toBe("keep-me");
		expect(observer.thinking).toBe("medium");
	});

	it("splits provider/id on the FIRST slash only, keeping inner slashes in the id", () => {
		const next = applyOmModelChange(baseSettings(), ["observer"], "openrouter/z-ai/glm-5.3", "low");
		const observer = (next[SETTINGS_KEY] as { models: { observer: Record<string, unknown> } }).models.observer;
		expect(observer.provider).toBe("openrouter");
		expect(observer.id).toBe("z-ai/glm-5.3");
	});

	it("creates missing keys (observational-memory / models / role)", () => {
		const next = applyOmModelChange({}, ["observer"], "zai/glm-5.3-flash", "low");
		const observer = (next[SETTINGS_KEY] as { models: { observer: Record<string, unknown> } }).models.observer;
		expect(observer).toEqual({ provider: "zai", id: "glm-5.3-flash", thinking: "low" });
	});

	it("does not mutate the input object", () => {
		const settings = baseSettings();
		const snapshot = JSON.parse(JSON.stringify(settings));
		applyOmModelChange(settings, ["observer", "consolidator"], "openrouter/z-ai/glm-5.3", "medium");
		expect(settings).toEqual(snapshot);
	});
});

describe("writeSettingsAtomic", () => {
	let dir: string;
	let target: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-switching-"));
		target = join(dir, "settings.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips settings to disk (tab-indented JSON plus newline)", () => {
		const settings = baseSettings();
		writeSettingsAtomic(settings, target);
		const raw = readFileSync(target, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toEqual(settings);
		expect(raw).toContain("\t");
	});

	it("creates a .bak copy of the previous file when overwriting", () => {
		writeFileSync(target, '{"previous": true}\n', "utf-8");
		writeSettingsAtomic(baseSettings(), target);
		expect(existsSync(`${target}.bak`)).toBe(true);
		expect(readFileSync(`${target}.bak`, "utf-8")).toBe('{"previous": true}\n');
		expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual(baseSettings());
	});

	it("does not create a .bak when the target did not exist", () => {
		writeSettingsAtomic(baseSettings(), target);
		expect(existsSync(`${target}.bak`)).toBe(false);
		expect(existsSync(target)).toBe(true);
	});
});
