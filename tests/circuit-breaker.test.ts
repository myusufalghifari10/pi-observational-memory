/**
 * P0.4 — worker circuit breaker.
 *
 * Three consecutive worker failures (observer or consolidator, shared streak) pause the
 * pipeline: both triggers stop dispatching, one error toast fires, /om:status shows the
 * state. Any worker success (or `/om off`→`on`) clears the streak and unpauses.
 */
import { describe, expect, it, vi } from "vitest";

import {
	CIRCUIT_BREAKER_THRESHOLD,
	clearWorkerFailures,
	evaluateObserverTriggers,
	noteWorkerFailure,
} from "../src/hooks/observer-trigger.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { Runtime } from "../src/runtime.js";

function makeRuntime(): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	return runtime;
}

function makeCtx() {
	return {
		hasUI: false,
		sessionManager: {
			getBranch: vi.fn(() => []),
			getEntries: vi.fn(() => []),
		},
		getContextUsage: () => ({ tokens: null }),
	} as any;
}

describe("noteWorkerFailure / clearWorkerFailures", () => {
	it("stays active below the threshold and pauses at exactly 3 consecutive failures", () => {
		const runtime = makeRuntime();
		const notify = vi.fn();

		noteWorkerFailure(runtime, notify);
		noteWorkerFailure(runtime, notify);
		expect(runtime.pipelinePaused).toBe(false);
		expect(runtime.workerFailureStreak).toBe(2);
		expect(notify).not.toHaveBeenCalled();

		noteWorkerFailure(runtime, notify);
		expect(runtime.pipelinePaused).toBe(true);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			`om: pipeline paused (${CIRCUIT_BREAKER_THRESHOLD} consecutive worker failures)`,
			"error",
		);
	});

	it("fires the pause toast only once for subsequent failures", () => {
		const runtime = makeRuntime();
		const notify = vi.fn();
		for (let i = 0; i < 5; i++) noteWorkerFailure(runtime, notify);
		expect(runtime.pipelinePaused).toBe(true);
		expect(runtime.workerFailureStreak).toBe(5);
		expect(notify).toHaveBeenCalledTimes(1); // no toast spam while paused
	});

	it("clearWorkerFailures resets the streak and unpauses (recovery)", () => {
		const runtime = makeRuntime();
		for (let i = 0; i < 4; i++) noteWorkerFailure(runtime);
		expect(runtime.pipelinePaused).toBe(true);

		clearWorkerFailures(runtime); // any-success path / `/om off`→`on`
		expect(runtime.workerFailureStreak).toBe(0);
		expect(runtime.pipelinePaused).toBe(false);
	});
});

describe("paused pipeline gates both triggers", () => {
	it("evaluateObserverTriggers never touches the session while paused", () => {
		const runtime = makeRuntime();
		runtime.pipelinePaused = true;
		const ctx = makeCtx();
		evaluateObserverTriggers({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
	});

	it("evaluateConsolidatorTrigger never touches the session while paused", () => {
		const runtime = makeRuntime();
		runtime.pipelinePaused = true;
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
	});

	it("after clearing, the observer trigger evaluates again (recovery — no backlog, no dispatch)", () => {
		const runtime = makeRuntime();
		runtime.pipelinePaused = true;
		clearWorkerFailures(runtime);
		const ctx = makeCtx();
		evaluateObserverTriggers({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalled();
		expect(runtime.observersInFlight.size).toBe(0); // empty branch → nothing to dispatch
	});

	it("after clearing, the consolidator trigger evaluates again (recovery — pool below threshold)", () => {
		const runtime = makeRuntime();
		runtime.pipelinePaused = true;
		clearWorkerFailures(runtime);
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalled();
		expect(runtime.consolidatorInFlight).toBe(false); // empty pool → no dispatch
	});
});

describe("status visibility (P0.4)", () => {
	it("formatPipelineLine reports PAUSED with the streak, else active", async () => {
		const { formatPipelineLine } = await import("../src/commands/status.js");
		const runtime = makeRuntime();
		expect(formatPipelineLine(runtime)).toBe("pipeline: active");

		for (let i = 0; i < 3; i++) noteWorkerFailure(runtime);
		expect(formatPipelineLine(runtime)).toBe("pipeline: PAUSED (3 consecutive worker failures)");
	});
});
