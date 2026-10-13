/**
 * S2 (audit N5): the compaction hook re-drives the worker queue once the barrier closes.
 *
 * Observers yield for the WHOLE barrier (anti-starvation in observer-trigger.ts), so without a
 * pump on the way out the backlog would sit idle until the next turn_end/agent_start — a silent
 * latency tax on every compaction. The pump must run AFTER the barrier flag is cleared, or
 * `evaluateObserverTriggers` early-returns and the pump would be a no-op.
 *
 * `pumpWorkerQueue` is intercepted with a partial mock: consolidator-trigger imports every other
 * name from that module for real, so only the pump is replaced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";

const h = vi.hoisted(() => ({ pumpWorkerQueue: vi.fn(), barrierAtCall: [] as boolean[] }));

vi.mock("../src/hooks/observer-trigger.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, pumpWorkerQueue: h.pumpWorkerQueue };
});

type HookHandler = (event: unknown, ctx: unknown) => Promise<any>;

/** Register the real compaction hook and hand back its `session_before_compact` handler. */
function makeHandler(runtime: Runtime): HookHandler {
	const handlers: Record<string, HookHandler> = {};
	const pi = { on: (name: string, fn: HookHandler) => (handlers[name] = fn) };
	registerCompactionHook(pi as never, runtime);
	const handler = handlers["session_before_compact"];
	if (!handler) throw new Error("session_before_compact handler not registered");
	return handler;
}

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-barrier-pump-"));
	h.pumpWorkerQueue.mockReset();
	h.barrierAtCall.length = 0;
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("S2 (audit N5): the hook re-drives the queue after the barrier closes", () => {
	it("pumps exactly once, with the barrier already cleared", async () => {
		const memoryRoot = join(cwd, ".memory", "sess-1");
		mkdirSync(memoryRoot, { recursive: true });
		writeFileSync(join(memoryRoot, "STATE.md"), "## Goal\nx\n## Open loops\n- y\n");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// A threshold far above the (empty) pool: the barrier must not force a consolidation here,
		// so the only thing under test is the pump on the way out.
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ "observational-memory": { consolidateAtPoolTokens: 10_000 } }),
		);

		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.memoryRoot = memoryRoot;
		runtime.ensureConfig(cwd);

		const branch: TestEntry[] = [rawMessage("e1", "hello"), rawMessage("e2", "tail")];
		const handler = makeHandler(runtime);
		const ctx = {
			hasUI: false,
			cwd,
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
			getContextUsage: () => ({ tokens: null }),
		};

		h.pumpWorkerQueue.mockImplementation(() => h.barrierAtCall.push(runtime.compactionBarrier));

		await handler({ preparation: { firstKeptEntryId: "e1", tokensBefore: 100 } }, ctx);

		expect(h.pumpWorkerQueue).toHaveBeenCalledTimes(1);
		expect(h.barrierAtCall).toEqual([false]); // closed before the pump — else it is a no-op
		expect(runtime.compactionBarrier).toBe(false);
	});
});
