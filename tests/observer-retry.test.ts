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
	isCurrentSession,
	isStaleCtxError,
	isToolCallGlitch,
	recordSliceFailure,
	registerObserverTrigger,
	takeRetrySlice,
} from "../src/hooks/observer-trigger.js";
import { CONSOLIDATOR_SYSTEM } from "../agent/consolidator/prompt.js";
import { OBSERVER_SYSTEM } from "../agent/observer/prompt.js";
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

// ─── P0.11 — malformed model tool-call glitch (live provider 400 evidence) ───

/** The provider body observed live (2026-09-25, mimo-v2.6-flash observer run). */
const PROVIDER_400 =
	`400: {"code":"400","message":"Param Incorrect","param":"messages[2].tool_calls[0] is missing a function name","type":""}`;
/** How the failure surfaces in the orchestrator (dispatchObserver wraps stderr). */
const WRAPPED_LIVE_ERROR = `observer exited with code 1: ${PROVIDER_400}`;

describe("P0.11 tool-call glitch classifier", () => {
	it("matches the exact live provider 400 error", () => {
		expect(isToolCallGlitch(WRAPPED_LIVE_ERROR)).toBe(true);
		expect(isToolCallGlitch(PROVIDER_400)).toBe(true);
	});

	it("rejects unrelated failures — not every provider error is this class", () => {
		expect(isToolCallGlitch(`400: {"code":"400","message":"context length exceeded","type":""}`)).toBe(false);
		expect(isToolCallGlitch("observer exited with code 1: ENOENT: no such file or directory")).toBe(false);
		expect(isToolCallGlitch("rate limited, retry after 5s")).toBe(false);
		expect(isToolCallGlitch("")).toBe(false);
	});
});

describe("P0.11 glitch-class dispatch (bounded retry + operator label)", () => {
	const BRANCH = [rawMessage("e1", "hello world this is a test message for the observer clock")];

	beforeEach(() => mockedSpawn.mockReset());

	function makeCtxWithUI(notify: ReturnType<typeof vi.fn>): Record<string, unknown> {
		return {
			hasUI: true,
			ui: { notify },
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
		runtime.config.chunkTokens = 1;
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-p011-"));
		return runtime;
	}

	/** Flush queued microtasks + one macrotask (the pump is queueMicrotask-based). */
	function flush(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("a glitch failure consumes EXACTLY the normal 2-attempt budget, then gives up with one gap", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const notify = vi.fn();
		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: PROVIDER_400 });

		try {
			evaluateObserverTriggers(pi, runtime, makeCtxWithUI(notify) as never);
			// Attempt 1 fails → retry queued → microtask pump re-dispatches → attempt 2 → give up.
			await flush();
			await flush();

			// (b) no new retry budget: original dispatch + ONE retry, then stop.
			expect(mockedSpawn).toHaveBeenCalledTimes(2);
			const gaps = pi.appendEntry.mock.calls.filter((call: unknown[]) => call[0] === OM_OBSERVATIONS_GAP);
			expect(gaps).toHaveLength(1);
			const gap = gaps[0]?.[1] as Record<string, unknown>;
			expect(gap.attempts).toBe(2);
			expect(String(gap.lastError)).toContain("missing a function name");
			// The give-up gap keeps the RAW message (P3.1 semantics), not the operator label.
			expect(String(gap.lastError)).not.toContain("tool-call glitch");
			expect(runtime.failedSlices).toEqual([]);
			// The slice is never re-dispatched after the cap: no third spawn.
			await flush();
			expect(mockedSpawn).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("labels toasts and lastWorkerError as the glitch in both phases (retrying → failed)", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const notify = vi.fn();
		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: PROVIDER_400 });

		try {
			evaluateObserverTriggers(pi, runtime, makeCtxWithUI(notify) as never);
			await flush();
			await flush();

			// (c) the operator can tell it apart from a real failure, in both phases.
			const labels = notify.mock.calls.map((call) => String(call[0]));
			expect(labels.some((line) => line.includes("om: observer failed: model tool-call glitch (retrying)"))).toBe(true);
			expect(labels.some((line) => line.includes("om: observer failed: model tool-call glitch (failed)"))).toBe(true);
			expect(runtime.lastWorkerError).toContain("model tool-call glitch (failed)");
			expect(runtime.lastWorkerError).toContain("missing a function name");
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("a NON-glitch failure keeps the original unlabelled toast (no false positives)", async () => {
		const runtime = makeRuntime();
		const pi = { appendEntry: vi.fn() } as any;
		const notify = vi.fn();
		mockedSpawn.mockResolvedValue({ code: 1, signal: null, stderr: "context length exceeded" });

		try {
			evaluateObserverTriggers(pi, runtime, makeCtxWithUI(notify) as never);
			await flush();
			await flush();

			const labels = notify.mock.calls.map((call) => String(call[0]));
			expect(labels.some((line) => line.includes("om: observer failed:"))).toBe(true);
			expect(labels.some((line) => line.includes("tool-call glitch"))).toBe(false);
			expect(runtime.lastWorkerError).not.toContain("tool-call glitch");
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});
});

describe("P0.11 prompt hardening (standard function-call only)", () => {
	it("OBSERVER_SYSTEM instructs the standard function-call mechanism, never XML <parameter>", () => {
		expect(OBSERVER_SYSTEM).toContain("standard mechanism only");
		expect(OBSERVER_SYSTEM).toContain("function-call mechanism");
		expect(OBSERVER_SYSTEM).toContain("<parameter>");
		expect(OBSERVER_SYSTEM).toContain("carries the function name");
	});

	it("CONSOLIDATOR_SYSTEM instructs the standard function-call mechanism, never XML <parameter>", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain("standard mechanism only");
		expect(CONSOLIDATOR_SYSTEM).toContain("function-call mechanism");
		expect(CONSOLIDATOR_SYSTEM).toContain("<parameter>");
		expect(CONSOLIDATOR_SYSTEM).toContain("carries the function name");
	});
});

// ─── P0.11 stale-ctx teardown guard (live crash regression, 2026-09-25) ───

describe("P0.11 stale-ctx teardown guard (appendEntry throws after session replacement)", () => {
	const BRANCH = [rawMessage("e1", "hello world this is a test message for the observer clock")];

	beforeEach(() => mockedSpawn.mockReset());

	function makeRuntime(): Runtime {
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.config.chunkTokens = 1;
		runtime.memoryRoot = mkdtempSync(join(tmpdir(), "om-stale-"));
		return runtime;
	}

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

	function flush(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("a stale-ctx throw from pi.appendEntry is a graceful no-op: no crash, no retry, no slice failure", async () => {
		const runtime = makeRuntime();
		// The exact live error class: pi invalidates its extension ctx after session
		// replacement or reload, and appendEntry throws regardless of OM's generation counters.
		const staleError = new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
		);
		const pi = {
			appendEntry: vi.fn(() => {
				throw staleError;
			}),
		} as any;
		mockedSpawn.mockImplementation(async (opts?: { env: NodeJS.ProcessEnv }) => {
			const resultPath = opts?.env.OM_RESULT_PATH;
			if (!resultPath) return { code: 1, signal: null, stderr: "no result path" };
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(
				resultPath,
				JSON.stringify({ observations: [{ timestamp: "2026-05-02T10:00:01", content: "stale ctx fact", tokenCount: 4 }] }),
			);
			return { code: 0, signal: null, stderr: "" };
		});

		try {
			evaluateObserverTriggers(pi, runtime, makeCtx() as never);
			await flush();
			await flush();
			// Reaching this line without an unhandled rejection proves no crash (pre-fix the
			// escape from the catch block killed a whole process). The teardown artifact is
			// NOT a slice failure: exactly one spawn (no retry), no failure bookkeeping.
			expect(pi.appendEntry).toHaveBeenCalled(); // the stale throw really fired
			expect(mockedSpawn).toHaveBeenCalledTimes(1);
			expect(runtime.failedSlices).toEqual([]);
			// The pipeline is dead from the first stale throw on (loop-kill, review Note C/D).
			expect(runtime.ctxStale).toBe(true);
			expect(isCurrentSession(runtime, runtime.generation)).toBe(false);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("isStaleCtxError matches the live wording but not unrelated errors", () => {
		expect(isStaleCtxError(new Error("This extension ctx is stale after session replacement or reload."))).toBe(true);
		expect(isStaleCtxError("ctx is stale")).toBe(true);
		expect(isStaleCtxError(new Error("observer exited with code 1: 400 Param Incorrect"))).toBe(false);
		expect(isStaleCtxError(new Error("ENOENT: no such file"))).toBe(false);
	});

	it("multi-chunk case pins the loop-kill: swallowed commits never re-dispatch (no infinite spawn)", async () => {
		const runtime = makeRuntime();
		const twoBranch = [
			rawMessage("e1", "first chunk body for the observer clock to slice"),
			rawMessage("e2", "second chunk body for the observer clock to slice"),
		];
		const ctx = {
			hasUI: false,
			sessionManager: {
				getBranch: vi.fn(() => twoBranch),
				getEntries: vi.fn(() => twoBranch),
			},
			getContextUsage: () => ({ tokens: null }),
		};
		const pi = {
			appendEntry: vi.fn(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			}),
		} as any;
		mockedSpawn.mockImplementation(async (opts?: { env: NodeJS.ProcessEnv }) => {
			const resultPath = opts?.env.OM_RESULT_PATH;
			if (!resultPath) return { code: 1, signal: null, stderr: "no result path" };
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(
				resultPath,
				JSON.stringify({ observations: [{ timestamp: "2026-05-02T10:00:01", content: "stale ctx fact", tokenCount: 4 }] }),
			);
			return { code: 0, signal: null, stderr: "" };
		});

		try {
			evaluateObserverTriggers(pi, runtime, ctx as never);
			await flush();
			await flush();
			await flush();
			// Two chunks ⇒ exactly two dispatches; both commits swallowed, ctxStale kills every
			// pump afterwards. Pre-fix, an unlanded commit re-selected the same slices forever.
			expect(mockedSpawn).toHaveBeenCalledTimes(2);
			expect(runtime.ctxStale).toBe(true);
			expect(runtime.failedSlices).toEqual([]);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("a stale throw from OUTSIDE the append sites (ctx accessor) burns no retry (review Note B)", async () => {
		const runtime = makeRuntime();
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = handler;
			},
			appendEntry: vi.fn(),
		} as any;
		registerObserverTrigger(pi as never, runtime);
		const ctx = {
			hasUI: false,
			sessionManager: {
				getBranch: vi.fn(() => BRANCH),
				getEntries: vi.fn(() => BRANCH),
			},
			// The stale throw originates from a non-append ctx accessor (used both at the
			// sync tail and the async completion — either way it must be a teardown no-op).
			getContextUsage: vi.fn(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			}),
		};
		mockedSpawn.mockImplementation(async (opts?: { env: NodeJS.ProcessEnv }) => {
			const resultPath = opts?.env.OM_RESULT_PATH;
			if (!resultPath) return { code: 1, signal: null, stderr: "no result path" };
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(resultPath, JSON.stringify({ observations: [] }));
			return { code: 0, signal: null, stderr: "" };
		});

		try {
			expect(() => handlers.turn_end(undefined, ctx)).not.toThrow();
			await flush();
			await flush();
			// Teardown artifact: exactly one spawn (dispatch already happened), no retry,
			// no failure bookkeeping, pipeline killed.
			expect(mockedSpawn).toHaveBeenCalledTimes(1);
			expect(runtime.failedSlices).toEqual([]);
			expect(runtime.ctxStale).toBe(true);
		} finally {
			rmSync(runtime.memoryRoot, { recursive: true, force: true });
		}
	});

	it("the registered handler swallows a stale throw from the SYNC dispatch body (no escape into pi's event pipeline)", () => {
		const runtime = makeRuntime();
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[name] = handler;
			},
			appendEntry: vi.fn(),
		} as any;
		registerObserverTrigger(pi as never, runtime);
		expect(handlers.turn_end).toBeDefined();

		const ctx = {
			hasUI: false,
			sessionManager: {
				getBranch: vi.fn(() => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}),
				getEntries: vi.fn(() => []),
			},
			getContextUsage: () => ({ tokens: null }),
		};
		// Must NOT throw: pre-fix this escaped synchronously into pi's event handler.
		expect(() => handlers.turn_end(undefined, ctx)).not.toThrow();
		expect(runtime.ctxStale).toBe(true);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});
});
