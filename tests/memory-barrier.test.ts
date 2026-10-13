/**
 * S2/S6 — compaction barrier + staged consolidation wiring.
 *
 * The pipeline is sequential-only, so the barrier owns the whole ordering rule:
 * observers settle → (if the pool is due) the consolidator runs → the render happens.
 * These tests pin the in-process contracts that make that ordering safe: the anti-starvation
 * gate, the "settled observers first" guard, the worker-idle wait, and the promote outcomes
 * (a failed promote must never look like a committed one).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { formatBarrierLine } from "../src/commands/status.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { evaluateObserverTriggers, isCurrentSession } from "../src/hooks/observer-trigger.js";
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

describe("S2 anti-starvation: no observer may start inside a barrier", () => {
	it("evaluateObserverTriggers never touches the session while the barrier is open", () => {
		const runtime = makeRuntime();
		runtime.compactionBarrier = true;
		const ctx = makeCtx();
		evaluateObserverTriggers({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(runtime.observersInFlight.size).toBe(0);
	});

	it("after the barrier closes, the observer clock evaluates again", () => {
		const runtime = makeRuntime();
		runtime.compactionBarrier = true;
		const ctx = makeCtx();
		evaluateObserverTriggers({} as any, runtime, ctx);
		runtime.compactionBarrier = false;
		evaluateObserverTriggers({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalled();
	});
});

describe("S2: consolidation starts only from a settled observer state", () => {
	it("refuses to even look at the branch while an observer is in flight", () => {
		const runtime = makeRuntime();
		runtime.observersInFlight.set("obs-1", { controller: new AbortController(), coversUpToId: "raw-1" });
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
		expect(runtime.consolidatorInFlight).toBe(false);
		expect(runtime.consolidatorTask).toBeUndefined();
	});

	it("evaluates normally once the observer slot is clear", () => {
		const runtime = makeRuntime();
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).toHaveBeenCalled();
		expect(runtime.consolidatorInFlight).toBe(false); // empty pool → nothing due
	});
});

describe("S2 (audit N1): only the barrier may dispatch inside a barrier", () => {
	it("a background pump stands down while the barrier is open", () => {
		const runtime = makeRuntime();
		runtime.compactionBarrier = true;
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx);
		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled(); // not even the pool clock runs
		expect(runtime.consolidatorTask).toBeUndefined();
	});

	it("the barrier's own dispatch (allowDuringBarrier) is honoured", () => {
		const runtime = makeRuntime();
		runtime.compactionBarrier = true;
		const ctx = makeCtx();
		evaluateConsolidatorTrigger({} as any, runtime, ctx, { allowDuringBarrier: true });
		expect(ctx.sessionManager.getBranch).toHaveBeenCalled();
		expect(runtime.consolidatorTask).toBeUndefined(); // empty pool → still nothing due
	});
});

describe("S2 (audit N4): teardown is a session boundary", () => {
	it("invalidates in-flight workers BEFORE aborting them", () => {
		const runtime = makeRuntime();
		const gen = runtime.generation;
		const controller = new AbortController();
		runtime.observersInFlight.set("obs-1", { controller, coversUpToId: "raw-1" });

		runtime.shutdown();

		// The generation bump is what makes a completion landing during teardown a silent discard
		// instead of a burned circuit-breaker slice (and a notify through a dead ctx).
		expect(runtime.generation).toBe(gen + 1);
		expect(isCurrentSession(runtime, gen)).toBe(false);
		expect(controller.signal.aborted).toBe(true);
		expect(runtime.observersInFlight.size).toBe(0);
	});
});

describe("S2 whenWorkersIdle: observers first, then the consolidator", () => {
	it("resolves only after both workers settle, in order", async () => {
		const runtime = new Runtime();
		const order: string[] = [];
		let releaseObserver!: () => void;
		let releaseConsolidator!: () => void;
		const observerTask = new Promise<void>((resolve) => {
			releaseObserver = () => {
				order.push("observer");
				resolve();
			};
		});
		const consolidatorTask = new Promise<void>((resolve) => {
			releaseConsolidator = () => {
				order.push("consolidator");
				resolve();
			};
		});
		runtime.trackObserverTask(observerTask);
		runtime.trackConsolidatorTask(consolidatorTask);

		const idle = runtime.whenWorkersIdle().then(() => order.push("idle"));
		await Promise.resolve();
		expect(order).toEqual([]); // neither worker has settled yet

		releaseObserver();
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["observer"]); // waited for the consolidator before resolving

		releaseConsolidator();
		await idle;
		expect(order).toEqual(["observer", "consolidator", "idle"]);
	});

	it("tracks the consolidator task and clears it on settle (a waiter can never spin)", async () => {
		const runtime = new Runtime();
		let release!: () => void;
		const task = new Promise<void>((resolve) => {
			release = resolve;
		});
		runtime.trackConsolidatorTask(task);
		expect(runtime.consolidatorTask).toBe(task);

		const waiter = runtime.whenConsolidatorIdle();
		release();
		await waiter;
		expect(runtime.consolidatorTask).toBeUndefined();
	});
});

describe("S6 promote outcomes (Runtime.commitStaging)", () => {
	it("reports in-place when staging was unavailable and deletes nothing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-promote-"));
		try {
			const live = join(cwd, ".memory", "sess-1");
			mkdirSync(live, { recursive: true });
			writeFileSync(join(live, "topic.md"), "live");
			const runtime = new Runtime();
			runtime.staging = { live, work: live, staged: false };
			expect(runtime.commitStaging()).toBe("in-place");
			expect(runtime.staging).toBeUndefined();
			expect(existsSync(join(live, "topic.md"))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reports failed and discards the work generation when the swap cannot happen", () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-promote-fail-"));
		try {
			// `live` sits under a parent that does not exist, so creating the swap symlink fails.
			const live = join(cwd, "missing-parent", "sess-1");
			const work = join(cwd, "sess-1.g2");
			mkdirSync(work, { recursive: true });
			writeFileSync(join(work, "topic.md"), "staged");
			const runtime = new Runtime();
			runtime.staging = { live, work, staged: true };

			expect(runtime.commitStaging()).toBe("failed");
			expect(runtime.staging).toBeUndefined();
			// The half-written generation must not linger: the crash-recovery branch of
			// ensureGenerationalRoot adopts the NEWEST `.g<N>` sibling, so a leaked failed run
			// could otherwise be promoted into live memory later.
			expect(existsSync(work)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("S6 barrier telemetry", () => {
	it("reports n/a before any barrier ran", () => {
		expect(formatBarrierLine(new Runtime())).toBe("last barrier: n/a");
	});

	it("reports observer wait, consolidation time and promote outcome", () => {
		const runtime = new Runtime();
		runtime.lastBarrier = { at: 1, observerWaitMs: 1200, consolidationMs: 34_500, promote: "promoted" };
		expect(formatBarrierLine(runtime)).toBe(
			"last barrier: observer wait 1.2s · consolidation 34.5s · promote promoted",
		);

		runtime.lastBarrier = { at: 1, observerWaitMs: 300, consolidationMs: undefined, promote: undefined };
		expect(formatBarrierLine(runtime)).toBe("last barrier: observer wait 0.3s · consolidation none · promote n/a");
	});
});
