import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/spawn/launch.js")>();
	return { ...actual, spawnWorker: vi.fn() };
});

import {
	clearSliceFailure,
	evaluateObserverTriggers,
	recordSliceFailure,
	takeRetrySlice,
} from "../src/hooks/observer-trigger.js";
import { OM_OBSERVATIONS_GAP, OM_OBSERVATIONS_RECORDED } from "../src/ledger/index.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage, textCustomMessage } from "./fixtures/session.js";

const mockedSpawn = vi.mocked(spawnWorker);

/** Four source entries so a slice's range is observable. */
function branchFixture() {
	return [
		textCustomMessage("raw-1", "abcd"),
		textCustomMessage("raw-2", "efgh"),
		textCustomMessage("raw-3", "ijkl"),
		textCustomMessage("raw-4", "mnop"),
	];
}

/** Budget large enough that the whole range after a watermark fits in one slice. */
const BIG_BUDGET = 100_000;

describe("observer-failure retry state (Runtime.failedSlices)", () => {
	it("a fresh Runtime starts with an empty failedSlices array", () => {
		const runtime = new Runtime();
		expect(Array.isArray(runtime.failedSlices)).toBe(true);
		expect(runtime.failedSlices).toEqual([]);
	});

	it("record + take returns the same range (recomputed via selectSourceSlice)", () => {
		const runtime = new Runtime();
		const branch = branchFixture();
		recordSliceFailure(runtime, "raw-1", "raw-4");
		expect(runtime.failedSlices).toHaveLength(1);
		expect(runtime.failedSlices[0]?.attempts).toBe(1);

		const taken = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(taken).toBeDefined();
		expect(taken?.afterEntryId).toBe("raw-1");
		expect(taken?.slice.coversUpToId).toBe("raw-4");
		expect(taken?.slice.entries.map((entry) => entry.id)).toEqual(["raw-2", "raw-3", "raw-4"]);
	});

	it("record accepts an undefined afterEntryId (retry of the very first chunk)", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, undefined, "raw-2");
		const taken = takeRetrySlice(branchFixture(), runtime, BIG_BUDGET);
		expect(taken?.afterEntryId).toBeUndefined();
		expect(taken?.slice.coversUpToId).toBe("raw-2");
		expect(taken?.slice.entries.map((entry) => entry.id)).toEqual(["raw-1", "raw-2"]);
	});

	it("clear then take returns undefined; clearing an unknown id is a no-op", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		clearSliceFailure(runtime, "raw-2");
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();

		expect(() => clearSliceFailure(runtime, "no-such-id")).not.toThrow();
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});

	it("a coversUpToId failing twice is discarded (give up after 2 total attempts)", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		expect(runtime.failedSlices).toHaveLength(1);
		// same coversUpToId upserts and increments attempts to 2 → entry dropped
		recordSliceFailure(runtime, "raw-1", "raw-2");
		expect(runtime.failedSlices).toEqual([]);
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});

	it("two failed entries retry oldest-first (insertion order)", () => {
		const runtime = new Runtime();
		const branch = branchFixture();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		recordSliceFailure(runtime, "raw-2", "raw-4");

		const first = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(first?.slice.coversUpToId).toBe("raw-2");
		clearSliceFailure(runtime, "raw-2");

		const second = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(second?.afterEntryId).toBe("raw-2");
		expect(second?.slice.coversUpToId).toBe("raw-4");
	});

	it("takeRetrySlice on empty failedSlices returns undefined", () => {
		const runtime = new Runtime();
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});

	it("reports the give-up transition exactly once: false → true → false (P3.1 gap gate)", () => {
		const runtime = new Runtime();
		// Attempt 1: retry queued → NO give-up gap committed by the caller.
		expect(recordSliceFailure(runtime, "raw-1", "raw-2")).toBe(false);
		// Attempt 2: cap reached → the caller commits om.observations.gap (attempts: 2) ONCE.
		expect(recordSliceFailure(runtime, "raw-1", "raw-2")).toBe(true);
		// A hypothetical further call for the same range is a no-op (idempotent).
		expect(recordSliceFailure(runtime, "raw-1", "raw-2")).toBe(false);
		expect(runtime.failedSlices).toEqual([]);
	});
});

// ─── P3.1 (§2.4) — gap entries committed by the observer commit/failure paths ───

describe("P3.1 gap entries (om.observations.gap)", () => {
	const BRANCH = [rawMessage("e1", "hello world this is a test message for the observer clock")];

	beforeEach(() => mockedSpawn.mockReset());

	function makeCtx(): Record<string, unknown> {
		return {
			hasUI: false,
			sessionManager: {
				getBranch: vi.fn(() => BRANCH),
				getEntries: vi.fn(() => BRANCH),
			},
			getContextUsage: () => ({ tokens: null }),
		};
	}

	function makeRuntime(): Runtime {
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.config.chunkTokens = 1; // the single small message always clears the observer clock
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-p3a3-"));
		return runtime;
	}

	/** Flush queued microtasks + one macrotask (the pump is queueMicrotask-based). */
	function flush(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	function gapCalls(pi: { appendEntry: ReturnType<typeof vi.fn> }): unknown[][] {
		return pi.appendEntry.mock.calls.filter((call: unknown[]) => call[0] === OM_OBSERVATIONS_GAP);
	}

	it("a clean zero-observation chunk commits an attempts:0 gap (acked, nothing to record) and no recorded entry", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		mockedSpawn.mockImplementation(async (opts?: { env: NodeJS.ProcessEnv }) => {
			// Vitest's cleanup machinery can poke the mock with no args (observed
		// empirically — both production call sites always pass an object).
			const resultPath = opts?.env.OM_RESULT_PATH;
			if (!resultPath) return { code: 1, signal: null, stderr: "no result path" };
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(resultPath, JSON.stringify({ observations: [] }));
			return { code: 0, signal: null, stderr: "" };
		});

		try {
			evaluateObserverTriggers(pi, runtime, makeCtx() as never);
			expect(mockedSpawn).toHaveBeenCalledTimes(1);
			await flush();

			const gaps = gapCalls(pi);
			expect(gaps).toHaveLength(1);
			expect(gaps[0]?.[1]).toEqual({
				coversUpToId: "e1",
				attempts: 0,
				lastError: "no observations extracted",
			});
			// Nothing else commits for this chunk: the recorded validator forbids empty arrays.
			const recorded = pi.appendEntry.mock.calls.filter((call: unknown[]) => call[0] === OM_OBSERVATIONS_RECORDED);
			expect(recorded).toHaveLength(0);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("a slice that exhausts its retry budget commits exactly one attempts:2 gap with the last error", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: "boom" });

		try {
			evaluateObserverTriggers(pi, runtime, makeCtx() as never);
			// Attempt 1 fails → retry queued → microtask pump re-dispatches → attempt 2 fails → give up.
			await flush();
			await flush();

			const gaps = gapCalls(pi);
			expect(gaps).toHaveLength(1);
			const data = gaps[0]?.[1] as Record<string, unknown>;
			expect(data.attempts).toBe(2);
			expect(data.coversUpToId).toBe("e1");
			expect(data.lastError).toContain("observer exited with code 1");
			expect(data.afterEntryId).toBeUndefined(); // first chunk: no start id
			// The broken range is dropped — never re-dispatched, never a second gap.
			expect(runtime.failedSlices).toEqual([]);
			expect(mockedSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});
});
