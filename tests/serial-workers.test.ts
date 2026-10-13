import { describe, expect, it } from "vitest";

import { DEFAULTS, normalizeSettingsConfig } from "../src/config.js";
import { shouldYieldToConsolidator } from "../src/hooks/observer-trigger.js";
import { Runtime } from "../src/runtime.js";

function runtimeWith(overrides: { serialWorkers?: boolean } = {}): Runtime {
	const runtime = new Runtime();
	runtime.config = { ...DEFAULTS, ...overrides };
	return runtime;
}

describe("serialWorkers slot math (Runtime.observerSlotsAvailable)", () => {
	it("serial + idle: exactly one observer slot regardless of observerConcurrency", () => {
		const runtime = runtimeWith({ serialWorkers: true });
		expect(runtime.observerSlotsAvailable).toBe(1);
	});

	it("serial + observer in flight: no slots", () => {
		const runtime = runtimeWith({ serialWorkers: true });
		runtime.observersInFlight.set("r1", { controller: new AbortController(), coversUpToId: "raw-1" });
		expect(runtime.observerSlotsAvailable).toBe(0);
	});

	it("serial + consolidator in flight: no slots (no observer/consolidator overlap)", () => {
		const runtime = runtimeWith({ serialWorkers: true });
		runtime.consolidatorInFlight = true;
		expect(runtime.observerSlotsAvailable).toBe(0);
	});

	it("workerBusy covers both roles", () => {
		const runtime = runtimeWith({ serialWorkers: true });
		expect(runtime.workerBusy).toBe(false);
		runtime.consolidatorInFlight = true;
		expect(runtime.workerBusy).toBe(true);
		runtime.consolidatorInFlight = false;
		runtime.observersInFlight.set("r1", { controller: new AbortController(), coversUpToId: "raw-1" });
		expect(runtime.workerBusy).toBe(true);
	});

	it("non-serial slot math still exists as a defensive branch (unreachable via settings)", () => {
		// `serialWorkers: false` can no longer come from settings.json (normalize forces true),
		// but the parallel branch is kept in Runtime as a defensive code path — so it stays tested.
		const runtime = runtimeWith({ serialWorkers: false });
		expect(runtime.observerSlotsAvailable).toBe(runtime.config.observerConcurrency);
		runtime.observersInFlight.set("r1", { controller: new AbortController(), coversUpToId: "raw-1" });
		expect(runtime.observerSlotsAvailable).toBe(runtime.config.observerConcurrency - 1);
		runtime.consolidatorInFlight = true;
		expect(runtime.observerSlotsAvailable).toBe(runtime.config.observerConcurrency - 1);
		expect(runtime.workerBusy).toBe(true);
	});
});

describe("shouldYieldToConsolidator (serial priority rule)", () => {
	it("yields when the pool is at/over the consolidation threshold", () => {
		expect(shouldYieldToConsolidator(15_000, 15_000)).toBe(true);
		expect(shouldYieldToConsolidator(16_000, 15_000)).toBe(true);
	});

	it("does not yield below the threshold", () => {
		expect(shouldYieldToConsolidator(14_999, 15_000)).toBe(false);
	});
});

describe("serialWorkers config normalization", () => {
	it("forces true: a settings.json `false` can no longer re-enable parallel observers", () => {
		expect(normalizeSettingsConfig({ serialWorkers: true }, DEFAULTS).serialWorkers).toBe(true);
		expect(normalizeSettingsConfig({ serialWorkers: false }, DEFAULTS).serialWorkers).toBe(true);
	});

	it("DEFAULTS itself is sequential", () => {
		expect(DEFAULTS.serialWorkers).toBe(true);
	});

	it("leaves the key unset when absent and ignores non-boolean garbage", () => {
		expect(normalizeSettingsConfig({}, DEFAULTS).serialWorkers).toBeUndefined();
		expect(normalizeSettingsConfig({ serialWorkers: "yes" }, DEFAULTS).serialWorkers).toBeUndefined();
		expect(normalizeSettingsConfig({ serialWorkers: 1 }, DEFAULTS).serialWorkers).toBeUndefined();
	});
});
