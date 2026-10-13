/**
 * S3 — promote FAILURE is the one outcome that must never look like a commit.
 *
 * `promoteStaging` is the only mocked seam here (the unit-level swap failure is already covered in
 * tests/memory-barrier.test.ts); what this file pins is the ORCHESTRATOR's reaction: the batch must
 * stay un-tombstoned (so the observations are re-folded instead of vanishing), the live memory must
 * be byte-identical, and the work generation must be discarded rather than left as a higher-numbered
 * sibling that crash recovery could adopt as live memory.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_OBSERVATIONS_DROPPED } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

const h = vi.hoisted(() => ({ spawnWorker: vi.fn() }));

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, spawnWorker: h.spawnWorker };
});

vi.mock("../src/memory/paths.js", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, promoteStaging: () => "failed" };
});

type SpawnOpts = { cwd: string; env: NodeJS.ProcessEnv };

function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(root)) return out;
	const walk = (dir: string, rel: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const next = rel ? `${rel}/${name}` : name;
			if (statSync(full).isDirectory()) walk(full, next);
			else out[next] = readFileSync(full, "utf-8");
		}
	};
	walk(root, "");
	return out;
}

let cwd: string;
let memoryRoot: string;
let branch: TestEntry[];
let runtime: Runtime;
let appended: Array<{ type: string; data: any }>;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-promote-fail-"));
	memoryRoot = join(cwd, ".memory", "sess-1");
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(join(memoryRoot, "STATE.md"), "## Goal\nSurvive a failed promote\n## Open loops\n- S3\n");
	writeFileSync(join(memoryRoot, "topic.md"), "---\nid: topic\ntitle: T\nsummary: s\nupdated: 2026-05-02 10:00\n---\nBody.\n");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ "observational-memory": { consolidateAtPoolTokens: 20, poolTargetTokens: 10 } }),
	);
	branch = [
		rawMessage("e1", "hello"),
		observationsRecordedEntry("e2", {
			observations: [
				observation("2026-05-02T10:00:01", { content: "one", tokenCount: 20, kind: "assertion", sourceEntryId: "e1" }),
				observation("2026-05-02T10:00:02", { content: "two", tokenCount: 20, kind: "event", sourceEntryId: "e1" }),
			],
			coversUpToId: "e1",
		}),
		rawMessage("e3", "tail"),
	];
	runtime = new Runtime();
	runtime.enabled = true;
	runtime.memoryRoot = memoryRoot;
	runtime.ensureConfig(cwd);
	appended = [];
	h.spawnWorker.mockReset();
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("S3 promote failure (live memory unchanged, batch re-foldable)", () => {
	it("keeps the batch, discards the work generation, and reports the promote as failed", async () => {
		const before = snapshot(memoryRoot);
		h.spawnWorker.mockImplementation(async (opts: SpawnOpts) => {
			// A failed promote cannot drain the pool, so the queue re-dispatches until the P0.4 circuit
			// breaker pauses the pipeline. Guard the bound explicitly: if that breaker were ever removed,
			// this test must FAIL loudly instead of spinning forever.
			if (h.spawnWorker.mock.calls.length > 5) {
				throw new Error("consolidation loop: spawnWorker re-dispatched more than 5 times");
			}
			writeFileSync(join(opts.cwd, "staged.md"), "should never go live\n");
			return { code: 0, signal: null, stderr: "" }; // the WORKER succeeded; the SWAP did not
		});

		const pi = {
			appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
			on: () => {},
		} as never;
		const ctx = {
			hasUI: false,
			cwd,
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
			getContextUsage: () => ({ tokens: null }),
		};

		evaluateConsolidatorTrigger(pi, runtime, ctx);
		await runtime.whenConsolidatorIdle();

		expect(runtime.lastPromote).toBe("failed");
		expect(runtime.pipelinePaused).toBe(true); // bounded by the circuit breaker, never a spin
		expect(appended.filter((e) => e.type === OM_OBSERVATIONS_DROPPED)).toHaveLength(0);
		expect(runtime.lastWorkerError).toContain("promote failed");
		expect(snapshot(memoryRoot)).toEqual(before);
		expect(existsSync(join(memoryRoot, "staged.md"))).toBe(false);
		expect(readdirSync(dirname(memoryRoot)).filter((n) => n.startsWith("sess-1.g"))).toHaveLength(1);
		expect(runtime.staging).toBeUndefined();
		expect(runtime.consolidatorInFlight).toBe(false);
	});
});
