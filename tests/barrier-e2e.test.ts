/**
 * S2/S3 end-to-end: the compaction barrier owns the ordering rule (observers settle → a due
 * consolidation runs STAGED → the render happens), and a failed consolidation leaves the live
 * memory untouched, the batch re-foldable, and no work generation behind.
 *
 * `spawnWorker` is mocked (no real `pi` subprocess is ever spawned), but the mock honours the
 * real contract it is handed: it writes into the worker's cwd (`staging.work`), which is exactly
 * what a consolidator does. That is what makes these assertions meaningful — the point is where
 * those writes become visible, and when.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_OBSERVATIONS_DROPPED } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

const h = vi.hoisted(() => ({ spawnWorker: vi.fn(), order: [] as string[] }));

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: h.spawnWorker };
});

type HookHandler = (event: unknown, ctx: unknown) => Promise<any>;
type SpawnOpts = { cwd: string; env: NodeJS.ProcessEnv };

/**
 * The hook's pi stub must behave like pi: `appendEntry` records the ledger entry AND makes it part
 * of the branch `getBranch()` returns. A stub that only records (without mutating the branch) can
 * never drain the pool, because the fold would keep seeing the pre-tombstone observations — which
 * makes the queue re-dispatch forever. That trap is pinned here so a regression cannot hide.
 */
function makeHandler(
	runtime: Runtime,
	branch: TestEntry[],
): { handler: HookHandler; appended: Array<{ type: string; data: any }> } {
	const handlers: Record<string, HookHandler> = {};
	const appended: Array<{ type: string; data: any }> = [];
	let seq = 0;
	const pi = {
		on: (name: string, fn: HookHandler) => (handlers[name] = fn),
		appendEntry: (type: string, data: unknown) => {
			appended.push({ type, data });
			seq += 1;
			branch.push({
				type: "custom",
				id: `appended-${seq}`,
				parentId: null,
				timestamp: "2026-05-02T10:05:00.000Z",
				customType: type,
				data,
			} as TestEntry);
		},
	};
	registerCompactionHook(pi as never, runtime);
	const handler = handlers["session_before_compact"];
	if (!handler) throw new Error("session_before_compact handler not registered");
	return { handler, appended };
}

/** Seed a project: `.pi/settings.json` (threshold) + a live memory root + a branch with a pool. */
function seed(cwd: string, consolidateAtPoolTokens: number): { memoryRoot: string; branch: TestEntry[] } {
	const memoryRoot = join(cwd, ".memory", "sess-1");
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(join(memoryRoot, "STATE.md"), "## Goal\nKeep memory executable\n## Open loops\n- finish S2\n");
	writeFileSync(join(memoryRoot, "JOURNEY.md"), "## 2026-05-02\nBarrier landed.\n");
	writeFileSync(
		join(memoryRoot, "topic.md"),
		"---\nid: topic\ntitle: Topic\nsummary: a topic\nupdated: 2026-05-02 10:00\n---\nBody.\n",
	);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ "observational-memory": { consolidateAtPoolTokens, poolTargetTokens: 10 } }),
	);
	const branch: TestEntry[] = [
		rawMessage("e1", "hello"),
		observationsRecordedEntry("e2", {
			observations: [
				observation("2026-05-02T10:00:01", {
					content: "fact one",
					tokenCount: 20,
					kind: "assertion",
					sourceEntryId: "e1",
				}),
				observation("2026-05-02T10:00:02", { content: "fact two", tokenCount: 20, kind: "event", sourceEntryId: "e1" }),
			],
			coversUpToId: "e1",
		}),
		rawMessage("e3", "tail one"),
		rawMessage("e4", "tail two"),
	];
	return { memoryRoot, branch };
}

/** Recursive content snapshot read THROUGH the live path (follows the generation symlink). */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(root)) return out;
	const walk = (dir: string, rel: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const next = rel ? `${rel}/${name}` : name;
			// statSync (not lstatSync): the point is what a reader of the LIVE path sees.
			if (statSync(full).isDirectory()) walk(full, next);
			else out[next] = readFileSync(full, "utf-8");
		}
	};
	walk(root, "");
	return out;
}

function generationDirs(memoryRoot: string): string[] {
	return readdirSync(dirname(memoryRoot)).filter((name) => name.startsWith("sess-1.g"));
}

function makeRuntime(cwd: string, memoryRoot: string): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.memoryRoot = memoryRoot;
	runtime.ensureConfig(cwd);
	return runtime;
}

function makeCtx(cwd: string, branch: TestEntry[]) {
	return {
		hasUI: false,
		cwd,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		getContextUsage: () => ({ tokens: null }),
	};
}

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-barrier-e2e-"));
	h.order.length = 0;
	h.spawnWorker.mockReset();
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("S2 barrier ordering (observer → consolidation → render)", () => {
	it("waits for in-flight observers, consolidates, promotes the staged writes, then renders", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		expect(runtime.config.consolidateAtPoolTokens).toBe(30); // project layer honoured

		const { handler, appended } = makeHandler(runtime, branch);

		let releaseObserver!: () => void;
		const observerTask = new Promise<void>((resolve) => {
			releaseObserver = () => {
				h.order.push("observer-settled");
				runtime.observersInFlight.delete("obs-1"); // production: dispatchObserver's finally
				resolve();
			};
		});
		runtime.trackObserverTask(observerTask);
		runtime.observersInFlight.set("obs-1", { controller: new AbortController(), coversUpToId: "e1" });

		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			if (h.spawnWorker.mock.calls.length > 5) {
				throw new Error("consolidation loop: spawnWorker re-dispatched more than 5 times");
			}
			h.order.push("consolidator-spawned");
			// A real consolidator writes into its sandbox root — pinned here so the promote assertions
			// below prove those writes only become live through the swap.
			writeFileSync(join(opts.cwd, "consolidated.md"), "staged write\n");
			expect(dirname(opts.cwd)).toBe(dirname(memoryRoot)); // ...in a generation, not in place
			return { code: 0, signal: null, stderr: "" };
		});

		const pending = handler({ preparation: { firstKeptEntryId: "e3", tokensBefore: 1234 } }, makeCtx(cwd, branch));
		await Promise.resolve();
		expect(h.order).toEqual([]); // nothing may run while an observer is in flight

		releaseObserver();
		const result = (await pending) as { compaction?: { summary?: string } };

		expect(h.order).toEqual(["observer-settled", "consolidator-spawned"]);
		expect(h.spawnWorker).toHaveBeenCalledTimes(1); // pool drained below the threshold → no re-dispatch
		expect(appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED)).toHaveLength(1);
		expect((result.compaction?.summary ?? "").length).toBeGreaterThan(0);

		// the staged write is live only after the promote
		expect(readFileSync(join(memoryRoot, "consolidated.md"), "utf-8")).toBe("staged write\n");
		expect(lstatSync(memoryRoot).isSymbolicLink()).toBe(true);
		expect(generationDirs(memoryRoot)).toHaveLength(1); // previous generation GC'd

		expect(runtime.lastPromote).toBe("promoted");
		expect(runtime.lastBarrier?.consolidationMs).toBeGreaterThanOrEqual(0);
		expect(runtime.compactionBarrier).toBe(false); // cleared by the hook's finally
	});

	it("does NOT force a consolidation when the pool is below the threshold", async () => {
		const { memoryRoot, branch } = seed(cwd, 10_000);
		const runtime = makeRuntime(cwd, memoryRoot);
		runtime.lastPromote = "promoted"; // an EARLIER run's outcome (audit N2: must not be reported here)
		h.spawnWorker.mockImplementation(async () => {
			h.order.push("consolidator-spawned");
			return { code: 0, signal: null, stderr: "" };
		});

		const { handler } = makeHandler(runtime, branch);
		const result = (await handler(
			{ preparation: { firstKeptEntryId: "e3", tokensBefore: 1234 } },
			makeCtx(cwd, branch),
		)) as { compaction?: { summary?: string } };

		expect(h.spawnWorker).not.toHaveBeenCalled();
		expect(h.order).toEqual([]);
		expect((result.compaction?.summary ?? "").length).toBeGreaterThan(0);
		expect(runtime.lastBarrier?.consolidationMs).toBeUndefined();
		// The stale field is untouched, but THIS barrier reports no promote outcome of its own.
		expect(runtime.lastPromote).toBe("promoted");
		expect(runtime.lastBarrier?.promote).toBeUndefined();
	});

	/**
	 * Requirement 4 of #10: a FAILED consolidation must never cost the user the compaction. The
	 * task settles even on failure, so the barrier stops waiting, re-snaps and renders — the hook
	 * must NOT return `cancel` (that would leave the context unsummarized for no reason) and the
	 * un-promoted batch must stay re-foldable.
	 */
	it("a FAILED consolidation inside the barrier still renders (no cancel) and keeps the batch", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		const before = snapshot(memoryRoot);
		const { handler, appended } = makeHandler(runtime, branch);

		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			writeFileSync(join(opts.cwd, "partial.md"), "half-written\n"); // the doomed run's writes
			return { code: 1, signal: null, stderr: "boom" };
		});

		const result = (await handler(
			{ preparation: { firstKeptEntryId: "e3", tokensBefore: 1234 } },
			makeCtx(cwd, branch),
		)) as { cancel?: boolean; compaction?: { summary?: string } };

		expect(result.cancel).toBeUndefined(); // the compaction is never cancelled by a worker failure
		expect((result.compaction?.summary ?? "").length).toBeGreaterThan(0);
		expect(appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED)).toHaveLength(0); // batch kept
		expect(snapshot(memoryRoot)).toEqual(before); // live memory byte-identical
		expect(existsSync(join(memoryRoot, "partial.md"))).toBe(false);
		expect(runtime.lastPromote).not.toBe("promoted");
		expect(runtime.compactionBarrier).toBe(false); // cleared by the hook's finally
	});
});

/**
 * #11 (owner decision): a consolidation that FAILED while a compaction was waiting earns exactly
 * ONE retry, and the render happens whatever the outcome — a worker failure must never cost the
 * user the compaction. The retry lives in the BARRIER only: a background failure neither retries
 * on this path nor triggers a compaction (its batch just stays re-foldable).
 */
describe("#11 a barrier-pending failure retries once, then folds anyway", () => {
	it("retry succeeds: two runs, one tombstone, and the staged writes go live", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		const { handler, appended } = makeHandler(runtime, branch);

		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			if (h.spawnWorker.mock.calls.length === 1) {
				writeFileSync(join(opts.cwd, "partial.md"), "half-written\n"); // the doomed first attempt
				return { code: 1, signal: null, stderr: "boom" };
			}
			writeFileSync(join(opts.cwd, "consolidated.md"), "staged write\n");
			return { code: 0, signal: null, stderr: "" };
		});

		const result = (await handler(
			{ preparation: { firstKeptEntryId: "e3", tokensBefore: 1234 } },
			makeCtx(cwd, branch),
		)) as { cancel?: boolean; compaction?: { summary?: string } };

		expect(h.spawnWorker).toHaveBeenCalledTimes(2); // the attempt + exactly ONE retry
		expect(result.cancel).toBeUndefined();
		expect((result.compaction?.summary ?? "").length).toBeGreaterThan(0);
		// The retry is what drained the pool, so the batch is tombstoned exactly once.
		expect(appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED)).toHaveLength(1);
		expect(readFileSync(join(memoryRoot, "consolidated.md"), "utf-8")).toBe("staged write\n");
		expect(existsSync(join(memoryRoot, "partial.md"))).toBe(false); // the failed attempt died with its generation
		expect(generationDirs(memoryRoot)).toHaveLength(1);
		expect(runtime.lastConsolidation?.ok).toBe(true);
		expect(runtime.lastBarrier?.promote).toBe("promoted"); // telemetry reports THIS barrier's outcome
		expect(runtime.compactionBarrier).toBe(false);
	});

	it("both attempts fail: two runs inside the barrier (never a loop), render still happens, batch kept", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		const before = snapshot(memoryRoot);
		const { handler, appended } = makeHandler(runtime, branch);

		// Only runs that happen WHILE the barrier is open count as the attempt + its retry: the
		// post-barrier re-dispatch (the N5 pump) is a different mechanism and must not be miscounted.
		let barrierSpawns = 0;
		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			if (runtime.compactionBarrier) barrierSpawns += 1;
			writeFileSync(join(opts.cwd, "partial.md"), "half-written\n");
			return { code: 1, signal: null, stderr: "boom" };
		});

		// A UI ctx, so the retry's own notice is observable: that notice is the user-visible proof the
		// hook took the retry branch (the outcome field itself is cleared by the retry's own dispatch).
		const notices: string[] = [];
		const result = (await handler(
			{ preparation: { firstKeptEntryId: "e3", tokensBefore: 1234 } },
			{ ...makeCtx(cwd, branch), hasUI: true, ui: { notify: (m: string) => notices.push(m) } },
		)) as { cancel?: boolean; compaction?: { summary?: string } };

		expect(barrierSpawns).toBe(2); // ONE retry — never a third attempt inside the barrier
		expect(notices.some((m) => m.includes("retrying once"))).toBe(true); // the retry branch was taken
		expect(result.cancel).toBeUndefined();
		expect((result.compaction?.summary ?? "").length).toBeGreaterThan(0);
		expect(appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED)).toHaveLength(0); // batch kept
		expect(snapshot(memoryRoot)).toEqual(before); // live memory byte-identical
		expect(existsSync(join(memoryRoot, "partial.md"))).toBe(false); // no failed write leaked into live
		expect(typeof runtime.lastBarrier?.consolidationMs).toBe("number"); // the barrier did consolidate
		expect(runtime.lastBarrier?.promote).not.toBe("promoted"); // telemetry tells the truth
		expect(runtime.compactionBarrier).toBe(false);
	});

	it("a BACKGROUND failure neither retries nor compacts (only the pre-existing pump loop runs)", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		const before = snapshot(memoryRoot);

		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			writeFileSync(join(opts.cwd, "partial.md"), "half-written\n");
			return { code: 1, signal: null, stderr: "boom" };
		});

		evaluateConsolidatorTrigger({ appendEntry: () => {}, on: () => {} } as never, runtime, makeCtx(cwd, branch));
		await runtime.whenConsolidatorIdle();

		// The #11 retry lives in the hook, so nothing here retries it: what remains is the pre-existing
		// pump re-dispatch, bounded by the circuit breaker — and no compaction is ever triggered.
		expect(runtime.lastBarrier).toBeUndefined();
		expect(runtime.lastConsolidation?.ok).toBe(false);
		expect(runtime.pipelinePaused).toBe(true);
		expect(h.spawnWorker.mock.calls.length).toBeLessThanOrEqual(3); // CIRCUIT_BREAKER_THRESHOLD
		expect(snapshot(memoryRoot)).toEqual(before);
	});
});

describe("S3 a failed consolidation is invisible and re-foldable", () => {
	let appended: Array<{ type: string; data: any }>;
	const fakePi = () => {
		appended = [];
		return {
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
			on: () => {},
		} as never;
	};
	const droppedEntries = (): number => appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED).length;

	it("worker exit ≠ 0: live memory byte-identical, work generation dropped, batch kept", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(cwd, memoryRoot);
		const before = snapshot(memoryRoot);

		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			writeFileSync(join(opts.cwd, "partial.md"), "half-written\n"); // the run's doomed writes
			return { code: 1, signal: null, stderr: "boom" };
		});

		evaluateConsolidatorTrigger(fakePi(), runtime, makeCtx(cwd, branch));
		await runtime.whenConsolidatorIdle();

		// A failed run cannot drain the pool, so the queue re-dispatches until the circuit breaker
		// pauses the pipeline (P0.4) — bounded, never a spin.
		expect(h.spawnWorker.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(runtime.pipelinePaused).toBe(true);
		expect(droppedEntries()).toBe(0); // batch stays active for the next re-fold
		expect(snapshot(memoryRoot)).toEqual(before); // ...and nothing leaked into live memory
		expect(existsSync(join(memoryRoot, "partial.md"))).toBe(false);
		expect(generationDirs(memoryRoot)).toHaveLength(1); // only the migrated original remains
		expect(runtime.lastPromote).toBeUndefined();
		expect(runtime.lastWorkerError).toContain("exited with code 1");
		expect(runtime.consolidatorInFlight).toBe(false);
		expect(runtime.staging).toBeUndefined();
	});
});
