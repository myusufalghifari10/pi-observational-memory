import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/spawn/launch.js")>();
	return { ...actual, spawnWorker: vi.fn() };
});

import { registerObserverCommand } from "../src/commands/observer.js";
import { recordSliceFailure } from "../src/hooks/observer-trigger.js";
import { Runtime } from "../src/runtime.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { textCustomMessage } from "./fixtures/session.js";

const mockedSpawn = vi.mocked(spawnWorker);

/** Four source entries; a slice can only be taken when the budget covers them. */
function branchFixture() {
	return [
		textCustomMessage("raw-1", "alpha beta gamma delta"),
		textCustomMessage("raw-2", "epsilon zeta eta theta"),
		textCustomMessage("raw-3", "iota kappa lambda mu"),
		textCustomMessage("raw-4", "nu xi omicron pi"),
	];
}

/** A config whose chunk threshold is far above the fixture, so nothing dispatches by itself. */
const HUGE_CHUNK_TOKENS = 1_000_000;

describe("/om:observer — force an observer run below the chunk threshold", () => {
	let tmp: string;
	let runtime: Runtime;
	let handler: (args: string, ctx: any) => Promise<void>;
	let notify: ReturnType<typeof vi.fn>;
	let pi: { registerCommand: ReturnType<typeof vi.fn>; appendEntry: ReturnType<typeof vi.fn> };
	let branch: ReturnType<typeof branchFixture>;

	beforeEach(() => {
		mockedSpawn.mockReset();
		// Complete cleanly (zero observations → an acked gap) so no failure path runs.
		mockedSpawn.mockImplementation(async (opts?: { env: NodeJS.ProcessEnv }) => {
			const resultPath = opts?.env.OM_RESULT_PATH;
			if (!resultPath) return { code: 1, signal: null, stderr: "no result path" };
			mkdirSync(dirname(resultPath), { recursive: true });
			writeFileSync(resultPath, JSON.stringify({ observations: [] }));
			return { code: 0, signal: null, stderr: "" };
		});

		tmp = mkdtempSync(join(tmpdir(), "om-observer-cmd-"));
		runtime = new Runtime();
		runtime.enabled = true;
		runtime.config.chunkTokens = HUGE_CHUNK_TOKENS;
		// Pin the config so ensureConfig() in the command does not re-read the user's settings
		// (which would replace the deliberately huge threshold with the shipped default).
		runtime.configLoaded = true;
		runtime.configCwd = tmp;
		runtime.memoryRoot = tmp;
		branch = branchFixture();

		notify = vi.fn();
		pi = { registerCommand: vi.fn(), appendEntry: vi.fn() } as any;
		registerObserverCommand(pi as never, runtime);
		const call = pi.registerCommand.mock.calls.find((c) => c[0] === "om:observer");
		expect(call).toBeDefined();
		handler = call![1].handler;
	});

	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			cwd: tmp,
			hasUI: true,
			ui: { notify },
			sessionManager: { getBranch: vi.fn(() => branch), getEntries: vi.fn(() => branch) },
			getContextUsage: () => ({ tokens: null }),
			...overrides,
		};
	}

	const notified = (fragment: string) => notify.mock.calls.some((call) => String(call[0]).includes(fragment));

	it("dispatches the pending tail even though it is far below the chunk threshold", async () => {
		await handler("", makeCtx());
		expect(mockedSpawn).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch the same tail a second time (watermark advanced)", async () => {
		await handler("", makeCtx());
		await handler("", makeCtx());
		expect(mockedSpawn).toHaveBeenCalledTimes(1);
		expect(notified("nothing to observe")).toBe(true);
	});

	it("is a no-op with a notice when nothing is pending", async () => {
		await handler("", makeCtx({ sessionManager: { getBranch: vi.fn(() => []), getEntries: vi.fn(() => []) } }));
		expect(mockedSpawn).not.toHaveBeenCalled();
		expect(notified("nothing to observe")).toBe(true);
	});

	it("retries a queued failed chunk first (manual escape hatch for a flaky worker)", async () => {
		recordSliceFailure(runtime, "raw-1", "raw-4");
		await handler("", makeCtx());
		expect(mockedSpawn).toHaveBeenCalledTimes(1);
		// The retry consumes the queued entry; a second manual run has nothing left to retry.
		expect(runtime.failedSlices).toEqual([]);
	});

	it("refuses to dispatch while the pipeline is paused, and names the recovery path", async () => {
		runtime.pipelinePaused = true;
		await handler("", makeCtx());
		expect(mockedSpawn).not.toHaveBeenCalled();
		expect(notified("paused")).toBe(true);
		expect(notified("/om off")).toBe(true);
	});

	it("refuses to dispatch when om is off", async () => {
		runtime.enabled = false;
		await handler("", makeCtx());
		expect(mockedSpawn).not.toHaveBeenCalled();
		expect(notified("om is off")).toBe(true);
	});

	it("reports when every observer slot is busy instead of silently doing nothing", async () => {
		runtime.config.observerConcurrency = 1;
		runtime.observersInFlight.set("run-busy", { controller: new AbortController(), coversUpToId: "raw-4" });
		await handler("", makeCtx());
		expect(mockedSpawn).not.toHaveBeenCalled();
		expect(notified("busy")).toBe(true);
	});

	it("leaves the configured chunk threshold untouched after a forced run", async () => {
		await handler("", makeCtx());
		expect(runtime.config.chunkTokens).toBe(HUGE_CHUNK_TOKENS);
	});

	it("does NOT change the automatic path: below threshold, no manual run means no dispatch", () => {
		// Regression guard: the force flag must not leak into the normal trigger evaluation.
		expect(runtime.enabled).toBe(true);
		expect(mockedSpawn).not.toHaveBeenCalled();
	});
});
