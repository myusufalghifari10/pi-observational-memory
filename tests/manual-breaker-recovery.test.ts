/**
 * #10 — recovery from a paused pipeline (P0.4 circuit breaker).
 *
 * The breaker stops AUTOMATIC dispatch after three consecutive worker failures. A manual command
 * is an EXPLICIT user intent, so `/om:consolidate` and `/om:observer` must reset the breaker and
 * actually run — otherwise a tripped breaker leaves the operator with no recovery but
 * `/om off` → `/om on`, and the command silently did nothing. Automatic triggers must stay gated
 * AND must never reset the breaker on their own (that is what the breaker is for).
 *
 * `spawnWorker` is mocked: no real `pi` subprocess runs, and the mock honours the contract it is
 * handed (the observer writes its result file; the consolidator just exits 0). The `pi` stub
 * records ledger entries AND appends them to the branch, like pi does — without that the fold
 * would keep seeing the pre-tombstone observations and the queue would re-dispatch forever.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ spawnWorker: vi.fn() }));

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: h.spawnWorker };
});

import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { CIRCUIT_BREAKER_THRESHOLD, evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { Runtime } from "../src/runtime.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

type CmdHandler = (args: string, ctx: any) => Promise<void>;
type SpawnOpts = { cwd: string; env: NodeJS.ProcessEnv };

/**
 * A project whose pool (40 tok) is above `poolTargetTokens` (10) — so consolidation has work —
 * and whose raw tail is far below the (deliberately huge) chunk threshold, so nothing dispatches
 * by itself. Thresholds come from the project settings file, exercising the real config path.
 *
 * `consolidateAtPoolTokens` matters per command: `/om:consolidate` forces its own trigger, while
 * `/om:observer` must NOT be handed a pool that is already due — in sequential mode an observer
 * yields the single worker slot to the consolidator in that case (consolidator priority).
 */
function seed(cwd: string, consolidateAtPoolTokens: number, poolTargetTokens = 10): { memoryRoot: string; branch: TestEntry[] } {
	const memoryRoot = join(cwd, ".memory", "sess-1");
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(
		join(memoryRoot, "topic.md"),
		"---\nid: topic\ntitle: Topic\nsummary: a topic\nupdated: 2026-05-02 10:00\n---\nBody.\n",
	);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			"observational-memory": { chunkTokens: 1_000_000, consolidateAtPoolTokens, poolTargetTokens },
		}),
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
		textCustomMessage("e3", "unobserved tail one"),
		textCustomMessage("e4", "unobserved tail two"),
	];
	return { memoryRoot, branch };
}

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-manual-recovery-"));
	h.spawnWorker.mockReset();
	// Clean exit for both roles: the observer writes its (empty) result file, the consolidator
	// writes nothing and just exits 0 — exactly the shape each role's completion path expects.
	h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
		const resultPath = opts.env.OM_RESULT_PATH;
		if (resultPath) {
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(resultPath, JSON.stringify({ observations: [] }));
		}
		return { code: 0, signal: null, stderr: "" };
	});
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function makeRuntime(memoryRoot: string): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.memoryRoot = memoryRoot;
	runtime.ensureConfig(cwd);
	return runtime;
}

/** A paused runtime at the breaker threshold (the state the user gets after 3 failures). */
function paused(runtime: Runtime): void {
	runtime.workerFailureStreak = CIRCUIT_BREAKER_THRESHOLD;
	runtime.pipelinePaused = true;
}

/**
 * A `pi` stub that behaves like pi for the parts these commands touch: it records commands,
 * appends ledger entries AND makes them part of the branch the fold reads.
 */
function makePi(branch: TestEntry[]): {
	pi: { registerCommand: (n: string, c: { handler: CmdHandler }) => void; appendEntry: (t: string, d: unknown) => void };
	handlerFor: (name: string) => CmdHandler;
	appended: Array<{ type: string; data: unknown }>;
} {
	const calls: Array<[string, { handler: CmdHandler }]> = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	let seq = 0;
	const pi = {
		registerCommand: (n: string, c: { handler: CmdHandler }) => calls.push([n, c]),
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
		on: () => {},
	};
	const handlerFor = (name: string): CmdHandler => {
		const found = calls.find(([n]) => n === name);
		if (!found) throw new Error(`${name} was not registered`);
		return found[1].handler;
	};
	return { pi, handlerFor, appended };
}

function makeCtx(branch: TestEntry[], notify: ReturnType<typeof vi.fn>): any {
	return {
		hasUI: true,
		cwd,
		ui: { notify },
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		getContextUsage: () => ({ tokens: null }),
	};
}

describe("manual recovery from a paused pipeline", () => {
	it("resets a paused pipeline on the consolidation command (the recovery hatch)", async () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(memoryRoot);
		const notify = vi.fn();
		paused(runtime);
		const { pi, handlerFor } = makePi(branch);

		registerConsolidateCommand(pi as never, runtime);
		await handlerFor("om:consolidate")("", makeCtx(branch, notify));
		await runtime.whenConsolidatorIdle();

		expect(runtime.pipelinePaused).toBe(false);
		expect(runtime.workerFailureStreak).toBe(0);
		expect(h.spawnWorker).toHaveBeenCalledTimes(1); // the reset actually let it dispatch
		expect(notify.mock.calls.some((c) => String(c[0]).includes(`pipeline paused (${CIRCUIT_BREAKER_THRESHOLD}`))).toBe(
			true,
		);
		expect(notify.mock.calls.some((c) => String(c[0]).includes("breaker reset"))).toBe(true);
	});

	it("never clears an unpaused breaker (and says so by staying silent about a reset)", async () => {
		// The pool is BELOW `poolTargetTokens`, so the command takes its "nothing to consolidate"
		// early return and no worker runs — isolating the command's own breaker handling from the
		// success path (a successful worker legitimately clears the streak on its own, P0.4).
		const { memoryRoot, branch } = seed(cwd, 30, 1_000);
		const runtime = makeRuntime(memoryRoot);
		const notify = vi.fn();
		runtime.workerFailureStreak = 1; // one past failure, pipeline still running
		const { pi, handlerFor } = makePi(branch);

		registerConsolidateCommand(pi as never, runtime);
		await handlerFor("om:consolidate")("", makeCtx(branch, notify));

		expect(h.spawnWorker).not.toHaveBeenCalled();
		expect(runtime.workerFailureStreak).toBe(1); // untouched: only a PAUSED breaker is cleared
		expect(runtime.pipelinePaused).toBe(false);
		expect(notify.mock.calls.some((c) => String(c[0]).includes("breaker reset"))).toBe(false);
		expect(notify.mock.calls.some((c) => String(c[0]).includes("nothing to consolidate"))).toBe(true);
	});

	it("automatic triggers stay gated while paused and never reset the breaker themselves", () => {
		const { memoryRoot, branch } = seed(cwd, 30);
		const runtime = makeRuntime(memoryRoot);
		paused(runtime);
		const { pi } = makePi(branch);
		const ctx = makeCtx(branch, vi.fn());

		evaluateObserverTriggers(pi as never, runtime, ctx);
		evaluateConsolidatorTrigger(pi as never, runtime, ctx);

		expect(runtime.pipelinePaused).toBe(true); // still paused — automatic dispatch stays off
		expect(runtime.workerFailureStreak).toBe(CIRCUIT_BREAKER_THRESHOLD);
		expect(h.spawnWorker).not.toHaveBeenCalled();
	});
});
