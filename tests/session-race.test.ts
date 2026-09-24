/**
 * P0.1 — stale-session commit race.
 *
 * A worker dispatched for session N may complete AFTER the session was replaced (session
 * shutdown / switch). Its completion path must then discard everything silently: no
 * appendEntry (observations or cost), no error bookkeeping, no retry, no queue pump.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/spawn/launch.js")>();
	return { ...actual, spawnWorker: vi.fn() };
});

import { pumpWorkerQueue, evaluateObserverTriggers, recordWorkerCost } from "../src/hooks/observer-trigger.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { runCostPath, writeWorkerCost } from "../src/spawn/runs.js";
import { OM_COST } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage } from "./fixtures/session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedSpawn = vi.mocked(spawnWorker);

const BRANCH = [rawMessage("e1", "hello world this is a test message for the observer clock")];

function makeCtx(extra: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		sessionManager: {
			getBranch: vi.fn(() => BRANCH),
			getEntries: vi.fn(() => BRANCH),
		},
		getContextUsage: () => ({ tokens: null }),
		...extra,
	} as any;
}

function makeRuntime(): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.config.chunkTokens = 1; // one small message always clears the clock
	return runtime;
}

/** Flush queued microtasks + one macrotask turn (the pump is queueMicrotask-based). */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	mockedSpawn.mockReset();
});

describe("P0.1 stale-session commit race", () => {
	it("discards a SUCCESS result silently when the generation changed mid-flight (no appendEntry, no retry, no pump)", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();

		let resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
		mockedSpawn.mockReturnValueOnce(new Promise((r) => (resolveExit = r)));

		evaluateObserverTriggers(pi, runtime, ctx);
		expect(mockedSpawn).toHaveBeenCalledTimes(1); // dispatched for generation 0

		// Session replacement while the worker is in flight.
		runtime.generation += 1;
		resolveExit({ code: 0, signal: null, stderr: "" });
		await flush();

		expect(pi.appendEntry).not.toHaveBeenCalled(); // no observations, no cost
		expect(runtime.lastWorkerError).toBeUndefined(); // no error toast bookkeeping
		expect(runtime.failedSlices).toHaveLength(0); // no retry queued (silent discard)
		expect(mockedSpawn).toHaveBeenCalledTimes(1); // pump did not dispatch a follow-up
	});

	it("discards a FAILURE result silently when the generation changed mid-flight", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();

		mockedSpawn.mockResolvedValueOnce({ code: 1, signal: null, stderr: "boom" });
		evaluateObserverTriggers(pi, runtime, ctx);
		runtime.generation += 1; // replace the session before the worker settles
		await flush();

		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.lastWorkerError).toBeUndefined();
		expect(runtime.failedSlices).toHaveLength(0); // silent: no retry
		expect(mockedSpawn).toHaveBeenCalledTimes(1); // no pump dispatch
	});

	it("control: a CURRENT-session failure still records the slice failure and pumps the queue", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();

		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: "boom" });
		evaluateObserverTriggers(pi, runtime, ctx);
		await vi.waitFor(() => {
			// First dispatch failed → pump re-evaluated → the retry slice dispatched too.
			expect(mockedSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
		await flush();

		expect(runtime.lastWorkerError).toContain("observer exited with code 1");
		// 2nd failure hits the give-up cap → the range is dropped, not queued again.
		expect(runtime.failedSlices).toHaveLength(0);
		expect(runtime.sliceAttemptCounts.get(BRANCH[0].id)).toBe(2);
	});

	it("pumpWorkerQueue skips its re-evaluation when the generation changed in the async gap", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();

		pumpWorkerQueue(pi, runtime, ctx); // binds to generation 0
		runtime.generation += 1; // session replaced before the microtask runs
		await flush();

		expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled(); // no trigger re-evaluation
	});

	it("pumpWorkerQueue control: same-session pump re-evaluates the triggers", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();
		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: "boom" });

		pumpWorkerQueue(pi, runtime, ctx);
		await flush();

		expect(ctx.sessionManager.getBranch).toHaveBeenCalled(); // triggers ran
		await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalled());
	});

	it("recordWorkerCost refuses to append cost when the generation changed (stale spend never lands)", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const ctx = makeCtx();
		const root = mkdtempSync(join(tmpdir(), "om-p01-"));
		try {
			runtime.memoryRoot = root;
			writeWorkerCost(runCostPath(root, "run-x"), { costUsd: 0.5 });

			recordWorkerCost(pi, runtime, ctx, "observer", "run-x", runtime.generation + 1);
			expect(pi.appendEntry).not.toHaveBeenCalled(); // stale generation

			recordWorkerCost(pi, runtime, ctx, "observer", "run-x", runtime.generation);
			expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			expect(pi.appendEntry.mock.calls[0][0]).toBe(OM_COST);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
