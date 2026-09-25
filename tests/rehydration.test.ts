import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { OM_OBSERVATIONS_GAP } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import {
	toolResultMessage,
	observation,
	observationsRecordedEntry,
	observationsSupersededEntry,
	rawMessage,
} from "./fixtures/session.js";
import type { TestEntry } from "./fixtures/session.js";

/**
 * P3.3 — Restart rehydration regression (plan §3).
 *
 * The compaction block must depend ONLY on durable state: the session ledger (branch)
 * plus the on-disk `.memory/<session>/` files. A crashed process restarting into the
 * same directory must therefore reproduce the byte-identical block — "crash recovery =
 * normal compaction path". These tests run the REAL registered `session_before_compact`
 * handler (mirroring the wiring pattern in tests/render.test.ts) rather than the render
 * units, so the whole read path (STATE/JOURNEY/topics/strats → fold → snap → render) is
 * what gets pinned.
 */

type HookResult = {
	compaction?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number };
} | void;

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** A "restarted process": fresh Runtime + freshly registered handler, same durable state. */
function makeHandler(memoryRoot: string): HookHandler {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.memoryRoot = memoryRoot;
	const handlers: Record<string, HookHandler> = {};
	const pi = {
		on: (name: string, handler: HookHandler) => {
			handlers[name] = handler;
		},
	};
	registerCompactionHook(pi as never, runtime);
	const handler = handlers["session_before_compact"];
	if (!handler) throw new Error("session_before_compact handler not registered");
	return handler;
}

/** Seed durable state: .memory files + a branch carrying one committed observation. */
function seedSession(cwd: string): { memoryRoot: string; branch: TestEntry[] } {
	const memoryRoot = join(cwd, ".memory", "rehydrate-session");
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(
		join(memoryRoot, "STATE.md"),
		"## Goal\nShip OM v4 rehydration\n## Open loops\n- finish P3\n## Plan\n- P3c then P4\n## Done\n- P0..P3b\n",
	);
	writeFileSync(join(memoryRoot, "JOURNEY.md"), "## 2026-09-25\nCampaign reached P3c.\n");
	writeFileSync(
		join(memoryRoot, "auth.md"),
		"---\nid: auth\ntitle: Auth\nsummary: auth topic\nupdated: 2026-09-25 10:00\n---\nBody.\n",
	);
	const observed = observation("2026-05-02T10:00:01", {
		content: "user prefers deterministic memory",
		kind: "assertion",
		sourceEntryId: "e1",
	});
	const branch: TestEntry[] = [
		rawMessage("e1", "we need durable memory"),
		observationsRecordedEntry("e2", { observations: [observed], coversUpToId: "e1" }),
		rawMessage("e3", "cut starts here"),
		rawMessage("e4", "verbatim tail"),
	];
	return { memoryRoot, branch };
}

async function compact(
	handler: HookHandler,
	cwd: string,
	branch: TestEntry[],
	preparation: { firstKeptEntryId: string; tokensBefore: number },
): Promise<HookResult> {
	const ctx = {
		hasUI: false,
		cwd,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	};
	return (await handler({ preparation }, ctx)) as HookResult;
}

describe("P3.3 restart rehydration (crash recovery = normal compaction path)", () => {
	it("byte-identical block after a full rebuild from the same durable state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-rehydrate-"));
		try {
			const { memoryRoot, branch } = seedSession(cwd);
			const preparation = { firstKeptEntryId: "e3", tokensBefore: 1234 };

			// Run 1: as the process would emit it right before a crash.
			const runA = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction;
			// Run 2: everything in-memory is thrown away; only durable state survives.
			const runB = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction;

			expect((runA?.summary ?? "").length).toBeGreaterThan(0);
			// Byte-identical (toBe on strings), not merely "similar".
			expect(runB?.summary).toBe(runA?.summary);
			expect(runB?.firstKeptEntryId).toBe(runA?.firstKeptEntryId);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("non-durable inputs are inert: varying pi's tokensBefore and proposed cutoff leaves the block byte-identical", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-rehydrate-inert-"));
		try {
			const { memoryRoot, branch } = seedSession(cwd);
			const handler = makeHandler(memoryRoot);

			// tokensBefore is echoed in the result but must not shape the block.
			const runA = (await compact(handler, cwd, branch, { firstKeptEntryId: "e3", tokensBefore: 1234 }))
				?.compaction;
			const runB = (await compact(handler, cwd, branch, { firstKeptEntryId: "e3", tokensBefore: 999_999 }))
				?.compaction;
			expect(runB?.summary).toBe(runA?.summary);

			// pi's proposed cutoff is a non-durable hint: with one acked chunk boundary
			// (the recorded entry covering e1), both proposals snap to the SAME boundary.
			const runC = (await compact(handler, cwd, branch, { firstKeptEntryId: "e4", tokensBefore: 1234 }))
				?.compaction;
			expect(runC?.summary).toBe(runA?.summary);
			expect(runA?.firstKeptEntryId).toBe("e3");
			expect(runC?.firstKeptEntryId).toBe("e3");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("durable inputs DO drive the block: rewriting STATE.md changes the output; the ledger observation renders", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-rehydrate-durable-"));
		try {
			const { memoryRoot, branch } = seedSession(cwd);
			const preparation = { firstKeptEntryId: "e3", tokensBefore: 1234 };

			const runA = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction ?? {};
			// Content sources: durable STATE + the folded ledger.
			expect(runA.summary).toContain("Ship OM v4 rehydration");
			expect(runA.summary).toContain("user prefers deterministic memory");

			// Mutate durable state → the block must follow (proves the source of truth).
			writeFileSync(
				join(memoryRoot, "STATE.md"),
				"## Goal\nREHYDRATED GOAL v2\n## Open loops\n- finish P3\n## Plan\n- P3c then P4\n## Done\n- P0..P3b\n",
			);
			const runB = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction ?? {};
			expect(runB.summary).toContain("REHYDRATED GOAL v2");
			expect(runB.summary).not.toBe(runA.summary);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("§2.4-sanctioned fallback probe: no acked boundary (dispatched-but-uncommitted chunk) ⇒ pi's proposal is used verbatim", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-rehydrate-fallback-"));
		try {
			const { memoryRoot } = seedSession(cwd);
			// Fresh session: raw messages only. A dispatched-but-uncommitted observer
			// chunk leaves NO recorded/gap entry, so there is zero acked boundary.
			const branch: TestEntry[] = [
				rawMessage("e1", "fresh session line 1"),
				rawMessage("e2", "fresh session line 2"),
				rawMessage("e3", "pi proposes this as first kept"),
				rawMessage("e4", "verbatim tail"),
			];

			const result = (await compact(makeHandler(memoryRoot), cwd, branch, {
				firstKeptEntryId: "e3",
				tokensBefore: 5000,
			}))?.compaction;

			// Pinned behavior: the gate falls back to pi's proposal when nothing qualifies
			// (§2.4: "falls back to pi's proposed cutoff ONLY if no acked boundary qualifies").
			// This is the SANCTIONED residual risk from the P3b review (Note 3): the
			// proposal is trusted unchecked and could theoretically land inside an
			// unflushed region — documented here as a regression probe, not a defect.
			expect(result?.firstKeptEntryId).toBe("e3");
			expect((result?.summary ?? "").length).toBeGreaterThan(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── P5.1 — Rehydration probes: the long-horizon proof suite (plan §3) ───
//
// Three fixture sessions that differ meaningfully, all driven through the REAL
// `session_before_compact` handler (durable files + ledger in → block out):
//   A. STATE-heavy with a supersession pair  → probes (a)(b)(c)(d)(f) + rebuild identity
//   B. gaps + DEATHS.md + strats             → probe (e) + fixture-differentiating renders
//   C. minimal legacy v1 ledger, no STATE    → C5: old entries still render (L6 fallback)
// Probe → assertion mapping is documented next to each fixture below.

/** Local gap-entry builder (P3.1 ledger record; fixtures file is not this task's authority). */
function gapEntry(id: string, data: Record<string, unknown>): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-09-25T10:00:00",
		customType: OM_OBSERVATIONS_GAP,
		data,
	};
}

/** Lines of a `## <heading>` section inside a STATE body (stops at the next `## `). */
function stateSection(state: string, heading: string): string[] {
	const lines = state.split("\n");
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start < 0) return [];
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		if (line.startsWith("## ")) break;
		if (line.trim()) out.push(line);
	}
	return out;
}

/** Fixture A — STATE-heavy session with an authored supersession pair (§2.1 convention). */
const STATE_A = [
	"## Goal",
	"Ship the OM v4 rehydration probes",
	"## Constraints",
	"- never auto-delete durable memory",
	"- compaction must stay model-free",
	"## Plan",
	"- finish P5 probes then hand to the tester",
	"## Done",
	"- P0 foundation fixes",
	"- P3 lossless rehydration",
	"## Blocked",
	"- none",
	"## Next",
	"- run the final tester",
	"## Open loops",
	"- finish P5.1 probes",
	"- wire the final tester",
].join("\n");

const OBS_A_TS = "2026-05-02T10:00:01";
const OBS_B_TS = "2026-05-02T10:00:02";
const OBS_A_TEXT = "the old estimate was 5k tokens";
const OBS_B_TEXT = "the corrected estimate is 50k tokens";

function seedFixtureA(cwd: string): { memoryRoot: string; branch: TestEntry[] } {
	const memoryRoot = join(cwd, ".memory", "p51-fixture-a");
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(join(memoryRoot, "STATE.md"), `${STATE_A}\n`);
	writeFileSync(join(memoryRoot, "JOURNEY.md"), "## 2026-09-25\nThe campaign reached P5.\n");
	writeFileSync(
		join(memoryRoot, "auth.md"),
		"---\nid: auth\ntitle: Auth\nsummary: auth topic\nupdated: 2026-09-25 10:00\n---\nBody.\n",
	);
	const obsA = observation(OBS_A_TS, { content: OBS_A_TEXT, kind: "assertion", sourceEntryId: "e1" });
	const obsB = observation(OBS_B_TS, { content: OBS_B_TEXT, kind: "assertion", sourceEntryId: "e2" });
	// e2 is a TOOL-RESULT message: not a valid cut point (src/ledger/progress.ts
	// isValidCutPoint — a boundary may never split a tool call from its result), so the
	// boundary after g1 is disqualified and the ONLY acked boundary that qualifies is
	// g2's → cutoff lands on e3 → both recorded observations AND the supersession pair
	// sit inside the projection.
	const branch: TestEntry[] = [
		rawMessage("e1", "we need durable memory"),
		observationsRecordedEntry("g1", { observations: [obsA], coversUpToId: "e1" }),
		toolResultMessage("e2", "estimator output"),
		observationsRecordedEntry("g2", { observations: [obsB], coversUpToId: "e2" }),
		observationsSupersededEntry("s1", {
			pairs: [{ oldTimestamp: OBS_A_TS, newTimestamp: OBS_B_TS, reason: "lexical-supersession" }],
			coversUpToId: "e2",
		}),
		rawMessage("e3", "cut starts here"),
		rawMessage("e4", "verbatim tail"),
	];
	return { memoryRoot, branch };
}

describe("P5.1 rehydration probes — long-horizon resume facts are provably in the block", () => {
	it("fixture A probes (a)+(b): STATE goal present and EVERY Done item present", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-a-"));
		try {
			const { memoryRoot, branch } = seedFixtureA(cwd);
			const result = (await compact(makeHandler(memoryRoot), cwd, branch, {
				firstKeptEntryId: "e3",
				tokensBefore: 4242,
			}))?.compaction;
			const summary = result?.summary ?? "";
			expect(summary.length).toBeGreaterThan(0);

			// (a) STATE content present in the block.
			expect(summary).toContain("Ship the OM v4 rehydration probes");
			// (b) every Done item present — parsed from STATE, not hand-copied, so the
			// probe tracks the fixture rather than a stale literal.
			const doneItems = stateSection(STATE_A, "## Done");
			expect(doneItems.length).toBeGreaterThanOrEqual(2);
			for (const item of doneItems) expect(summary).toContain(item);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture A probe (c): every open loop present at the block END (recency anchor)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-c-"));
		try {
			const { memoryRoot, branch } = seedFixtureA(cwd);
			const summary =
				(await compact(makeHandler(memoryRoot), cwd, branch, { firstKeptEntryId: "e3", tokensBefore: 4242 }))
					?.compaction?.summary ?? "";

			const anchor = summary.lastIndexOf("## Open loops");
			expect(anchor).toBeGreaterThan(-1);
			// The anchor is the FINAL section: it lands after Observations (§2.3 [8]).
			expect(anchor).toBeGreaterThan(summary.indexOf("## Observations"));
			const tail = summary.slice(anchor);
			const loops = stateSection(STATE_A, "## Open loops");
			expect(loops.length).toBeGreaterThanOrEqual(2);
			for (const loop of loops) expect(tail).toContain(loop);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture A probe (d): the supersession pair renders ADJACENT — believed: then now:", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-d-"));
		try {
			const { memoryRoot, branch } = seedFixtureA(cwd);
			const summary =
				(await compact(makeHandler(memoryRoot), cwd, branch, { firstKeptEntryId: "e3", tokensBefore: 4242 }))
					?.compaction?.summary ?? "";

			// Exactly the §2.3 [6] pair shape, on consecutive lines (L4: losing fact kept).
			expect(summary).toMatch(
				new RegExp(
					`2026-05-02T10:00:01\\s+believed: ${OBS_A_TEXT}\\n2026-05-02T10:00:02\\s+now: ${OBS_B_TEXT}`,
				),
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture A probe (f): the Constraints section comes first (before Plan/Done/Journey/Observations)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-f-"));
		try {
			const { memoryRoot, branch } = seedFixtureA(cwd);
			const summary =
				(await compact(makeHandler(memoryRoot), cwd, branch, { firstKeptEntryId: "e3", tokensBefore: 4242 }))
					?.compaction?.summary ?? "";

			const constraints = summary.indexOf("## Constraints");
			expect(constraints).toBeGreaterThan(-1);
			// §2.1 order + §2.3 section order: authoritative constraints sit early in the
			// attention-vantaged region — before the rest of STATE and before every
			// later section.
			expect(constraints).toBeLessThan(summary.indexOf("## Plan"));
			expect(constraints).toBeLessThan(summary.indexOf("## Done"));
			expect(constraints).toBeLessThan(summary.indexOf("## Journey"));
			expect(constraints).toBeLessThan(summary.indexOf("## Observations"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture A: full rebuild from durable state alone is byte-identical (C3)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-identity-"));
		try {
			const { memoryRoot, branch } = seedFixtureA(cwd);
			const preparation = { firstKeptEntryId: "e3", tokensBefore: 4242 };
			const runA = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction;
			const runB = (await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction;
			expect((runA?.summary ?? "").length).toBeGreaterThan(0);
			expect(runB?.summary).toBe(runA?.summary);
			expect(runB?.firstKeptEntryId).toBe(runA?.firstKeptEntryId);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture B probe (e): attempts:2 gap renders ⚠ UNOBSERVED WINDOW; attempts:0 gap stays silent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-e-"));
		try {
			const memoryRoot = join(cwd, ".memory", "p51-fixture-b");
			mkdirSync(memoryRoot, { recursive: true });
			writeFileSync(
				join(memoryRoot, "STATE.md"),
				"## Goal\nShip gap-marker probes\n## Open loops\n- close the give-up gap\n",
			);
			const branch: TestEntry[] = [
				rawMessage("e1", "chunk one content"),
				gapEntry("gap-silent", {
					coversUpToId: "e1",
					attempts: 0,
					lastError: "no observations extracted",
				}),
				rawMessage("e2", "chunk two content"),
				gapEntry("gap-lost", {
					afterEntryId: "e2",
					coversUpToId: "e3",
					attempts: 2,
					lastError: "observer exited with code 1",
				}),
				rawMessage("e3", "cut starts here"),
				rawMessage("e4", "verbatim tail"),
			];
			const result = (await compact(makeHandler(memoryRoot), cwd, branch, {
				firstKeptEntryId: "e3",
				tokensBefore: 4242,
			}))?.compaction;
			const summary = result?.summary ?? "";

			// attempts:2 → exactly one marker, with the gap's own [after..covers] window.
			expect(summary).toContain("⚠ UNOBSERVED WINDOW [e2..e3]");
			expect(summary.match(/⚠ UNOBSERVED WINDOW/g) ?? []).toHaveLength(1);
			// attempts:0 is the silent ack (§2.4) — its window must never surface.
			expect(summary).not.toContain("[start..e1]");
			// Probe (a)+(c) on this fixture too: durable STATE drives the block, and the
			// open loop lands at the end region.
			expect(summary).toContain("Ship gap-marker probes");
			expect(summary.slice(summary.lastIndexOf("## Open loops"))).toContain("- close the give-up gap");
			expect(summary.lastIndexOf("## Open loops")).toBeGreaterThan(summary.indexOf("## Observations"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture B: DEATHS stubs (authoritative + possibly-revived) and the Strats registry render", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-b2-"));
		try {
			const memoryRoot = join(cwd, ".memory", "p51-fixture-b2");
			mkdirSync(join(memoryRoot, "strats"), { recursive: true });
			writeFileSync(join(memoryRoot, "STATE.md"), "## Goal\nProbe deaths and strats\n");
			writeFileSync(
				join(memoryRoot, "DEATHS.md"),
				[
					"- rejected: regex-based parsing because it broke on multiline input",
					"- rejected: premature caching layer because the bottleneck moved (verify: src/nowhere.ts)",
					"",
				].join("\n"),
			);
			writeFileSync(
				join(memoryRoot, "strats", "focus.md"),
				[
					"---",
					"id: focus",
					"title: Focus strat",
					"summary: enter flow state before hard tasks",
					"updated: 2026-09-25 10:00",
					"cue: focus",
					"---",
					"Body instructions.",
					"",
				].join("\n"),
			);
			const branch: TestEntry[] = [
				rawMessage("e1", "first content"),
				rawMessage("e2", "cut starts here"),
				rawMessage("e3", "verbatim tail"),
			];
			const summary = (
				await compact(makeHandler(memoryRoot), cwd, branch, { firstKeptEntryId: "e2", tokensBefore: 1000 })
			)?.compaction?.summary ?? "";

			// Death without (verify:) stays authoritative (L11: revocable, never permanent).
			expect(summary).toContain("- rejected: regex-based parsing — because it broke on multiline input");
			// Death whose (verify:) target is missing renders as the revoked stub instead.
			expect(summary).toContain("possibly-revived: premature caching layer");
			expect(summary).toContain("re-verify before retrying");
			// Section [7]: strats registry with the cue name and summary line.
			expect(summary).toContain("## Strats");
			expect(summary).toContain("focus");
			expect(summary).toContain("enter flow state before hard tasks");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fixture C (legacy v1): no STATE section; a kind-less observation still renders via the L6 fallback; rebuild is byte-identical", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-p51-c-fix-"));
		try {
			const memoryRoot = join(cwd, ".memory", "p51-fixture-c");
			mkdirSync(memoryRoot, { recursive: true });
			writeFileSync(join(memoryRoot, "JOURNEY.md"), "## 2026-05-01\nThe early days.\n");
			// v1 observation: NO kind, NO sourceEntryId → buildPackMeta skips it →
			// L6 forces the whole pack onto the chronological fallback (P2.3 contract).
			const legacy = observation("2026-05-01T09:00:00", {
				content: "legacy observation about caching",
				tokenCount: 5,
			});
			const branch: TestEntry[] = [
				rawMessage("e1", "legacy session line"),
				observationsRecordedEntry("g1", { observations: [legacy], coversUpToId: "e1" }),
				rawMessage("e2", "cut starts here"),
				rawMessage("e3", "verbatim tail"),
			];
			const preparation = { firstKeptEntryId: "e2", tokensBefore: 777 };

			const summary =
				(await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction?.summary ?? "";
			// C5: the old ledger entry renders (backward compat), journey too…
			expect(summary).toContain("legacy observation about caching");
			expect(summary).toContain("The early days.");
			// …and there is no STATE section for a session that never had STATE.md.
			expect(summary).not.toContain("## State");
			// Pair labels must not appear in the OBSERVATIONS section — the instructions
			// preamble legitimately quotes 'believed: X' / 'now: Y' as format docs, so the
			// assertion is scoped to the section body (probe intent: no pair labels without
			// supersession metadata).
			const observationsSection = summary.split("## Observations")[1] ?? "";
			expect(observationsSection).toContain("legacy observation about caching");
			expect(observationsSection).not.toContain("believed:");
			expect(observationsSection).not.toContain("now:");

			const rebuilt =
				(await compact(makeHandler(memoryRoot), cwd, branch, preparation))?.compaction?.summary ?? "";
			expect(rebuilt).toBe(summary);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
