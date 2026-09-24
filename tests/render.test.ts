import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	extractOpenLoops,
	observationToLine,
	RENDER_BUDGET_TOKENS,
	renderSummary,
	renderSummaryV2,
	sortObservations,
	type LineMeta,
	type Observation,
} from "../src/ledger/index.js";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage } from "./fixtures/session.js";

describe("renderSummary (Phase A — observations only)", () => {
	it("renders a chronological observations section", () => {
		const observations = [
			observation("2026-05-02T10:05:00", { content: "second event" }),
			observation("2026-05-02T10:00:01", { content: "first event" }),
		];

		const block = renderSummary(undefined, undefined, observations);
		expect(block).toContain("## Observations");
		const obsSection = block.split("## Observations\n")[1];
		expect(obsSection).toBe("2026-05-02T10:00:01  first event\n2026-05-02T10:05:00  second event");
	});

	it("returns an empty string when there is nothing to render", () => {
		expect(renderSummary(undefined, undefined, [])).toBe("");
	});

	it("includes the map section when provided", () => {
		const block = renderSummary(undefined, "## Memory map\nauth.md · auth stuff", [observation("2026-05-02T10:00:01")]);
		expect(block).toContain("## Memory map");
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders the journey first, before map and observations", () => {
		const block = renderSummary("## 2026-05-01\nStarted the project.", "## Memory map\nauth.md · auth", [
			observation("2026-05-02T10:00:01"),
		]);
		expect(block).toContain("## Journey");
		expect(block.indexOf("## Journey")).toBeLessThan(block.indexOf("## Memory map"));
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders a journey-only block when there are no observations or map", () => {
		const block = renderSummary("## 2026-05-01\nStarted the project.", undefined, []);
		expect(block).toContain("## Journey");
		expect(block).toContain("Started the project.");
	});

	it("tells the reader it can query older memory via knowledge_search", () => {
		const block = renderSummary(undefined, undefined, [observation("2026-05-02T10:00:01")]);
		expect(block).toContain("knowledge_search");
		expect(block.indexOf("knowledge_search")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("formats a single observation line as 'timestamp  content'", () => {
		expect(observationToLine(observation("2026-05-02T10:00:01", { content: "hi" }))).toBe("2026-05-02T10:00:01  hi");
	});

	it("sorts disambiguated same-minute ids in suffix order", () => {
		const sorted = sortObservations([
			observation("2026-05-02T10:00:00.02"),
			observation("2026-05-02T10:00:00"),
			observation("2026-05-02T10:00:00.01"),
		]);
		expect(sorted.map((o) => o.timestamp)).toEqual([
			"2026-05-02T10:00:00",
			"2026-05-02T10:00:00.01",
			"2026-05-02T10:00:00.02",
		]);
	});
});

describe("renderSummaryV2 (P1.5 — §2.3 block layout)", () => {
	const fullInput = {
		state: {
			body: "## Goal\nShip v4\n## Open loops\n- finish P2\n- wire tests\n## Done\n- P0",
			updated: "2026-09-25 10:00",
		},
		journey: "## 2026-09-24\nThe campaign began.",
		map: "## Memory map\n- `.memory/s/auth.md` — auth topic",
		observations: [
			observation("2026-05-02T10:00:01", { content: "first event" }),
			observation("2026-05-02T11:00:01", { content: "second event" }),
		],
		strats: [{ filename: "deploy.md", path: ".memory/s/strats/deploy.md", cue: "deploy", summary: "ship it" }],
		openLoops: "- finish P2\n- wire tests",
	};

	it("renders every present section in §2.3 relative order with Open loops last", () => {
		const { summary: block } = renderSummaryV2(fullInput);
		// "## Open loops" occurs TWICE: inside STATE's body (source) and as section [8]
		// (the repeat). Section [8] is the block's last occurrence by definition.
		const positionOf = (mark: string) => (mark === "## Open loops" ? block.lastIndexOf(mark) : block.indexOf(mark));
		const marks = [
			"condensed memories", // [1] instructions
			"## State (as of 2026-09-25 10:00)", // [2]
			"## Journey", // [3]
			"## Memory map", // [4]
			"## Observations", // [6]
			"## Strats", // [7]
			"## Open loops", // [8]
		];
		const positions = marks.map(positionOf);
		for (const position of positions) expect(position).toBeGreaterThan(-1);
		const ascending = [...positions].sort((a, b) => a - b);
		expect(positions).toEqual(ascending);
		// Open loops is the block's FINAL section (recency anchor), not just ordered last.
		const headings = [...block.matchAll(/^## .*/gm)].map((m) => m[0]);
		expect(headings.at(-1)).toBe("## Open loops");
	});

	it("repeats STATE's Open-loops body verbatim at the end of the block", () => {
		const { summary: block } = renderSummaryV2(fullInput);
		const anchor = "## Open loops\n";
		const section = block.slice(block.lastIndexOf(anchor) + anchor.length);
		expect(section).toBe("- finish P2\n- wire tests");
		// Both STATE (source) and [8] (repeat) contain the loops.
		expect(block).toContain("## State (as of 2026-09-25 10:00)\n" + fullInput.state.body);
		expect(block.lastIndexOf(anchor)).toBeGreaterThan(block.indexOf("## State (as of"));
	});

	it("extractOpenLoops returns the section body up to the next heading", () => {
		expect(extractOpenLoops("## Goal\nDo X\n## Open loops\n- a\n- b\n## Done\n- c")).toBe("- a\n- b");
		expect(extractOpenLoops("## Goal\nno loops here")).toBeUndefined();
		expect(extractOpenLoops("## Open loops\n")).toBeUndefined();
	});

	it("renders a supersession pair adjacent: believed line immediately followed by now line", () => {
		const loser = observation("2026-05-02T10:00:01", { content: "User prefers SWR" });
		const winner = observation("2026-05-02T11:00:01", { content: "User will use React Query (switching from SWR)" });
		const { summary: block } = renderSummaryV2({
			observations: [winner, loser],
			supersessions: new Map([[loser.timestamp, winner.timestamp]]),
		});
		const lines = block.split("## Observations\n")[1].split("\n");
		expect(lines[0]).toBe(`${loser.timestamp}  believed: User prefers SWR`);
		expect(lines[1]).toBe(`${winner.timestamp}  now: User will use React Query (switching from SWR)`);
		expect(lines).toHaveLength(2); // nothing sits between the pair (L4: adjacent, preserved)
	});

	it("renders a loser whose winner is outside the projection as a plain line (L4-safe)", () => {
		const loser = observation("2026-05-02T10:00:01", { content: "old fact" });
		const { summary: block } = renderSummaryV2({
			observations: [loser],
			supersessions: new Map([[loser.timestamp, "2026-05-03T09:00:00"]]),
		});
		const section = block.split("## Observations\n")[1];
		expect(section).toBe(observationToLine(loser));
		expect(section).not.toContain("believed:");
	});

	it("omits empty sections wholesale (no STATE / no strats / nothing at all)", () => {
		const { summary: noState } = renderSummaryV2({
			observations: [observation("2026-05-02T10:00:01")],
		});
		expect(noState).not.toContain("## State");
		expect(noState).not.toContain("## Strats");
		expect(noState).not.toContain("## Open loops");
		expect(noState).toContain("## Observations");
		expect(renderSummaryV2({ observations: [] }).summary).toBe("");
	});

	it("renders a supersession CHAIN a→b→c with ALL THREE facts adjacent (L4: none stranded)", () => {
		// The plan's own PostgreSQL→MySQL→SQLite scenario: two corrections of the same
		// assertion across two observer batches produce {a→b, b→c}. The old single-pair
		// renderer silently dropped `a` — every fact must appear exactly once.
		const a = observation("2026-05-02T10:00:01", { content: "User chose PostgreSQL" });
		const b = observation("2026-05-02T11:00:01", { content: "User switched to MySQL" });
		const c = observation("2026-05-02T12:00:01", { content: "User switched to SQLite" });
		const { summary: block } = renderSummaryV2({
			observations: [a, b, c],
			supersessions: new Map([
				[a.timestamp, b.timestamp],
				[b.timestamp, c.timestamp],
			]),
		});
		const lines = block.split("## Observations\n")[1].split("\n");
		expect(lines).toEqual([
			`${a.timestamp}  believed: User chose PostgreSQL`,
			`${b.timestamp}  believed: User switched to MySQL`,
			`${c.timestamp}  now: User switched to SQLite`,
		]);
		// Every fact exactly once — nothing dropped, nothing duplicated.
		for (const fact of ["PostgreSQL", "MySQL", "SQLite"]) {
			expect(lines.filter((line) => line.includes(fact))).toHaveLength(1);
		}
	});

	it("renders a V-merge (two losers superseded by one winner) as believed, believed, now", () => {
		const a = observation("2026-05-02T10:00:01", { content: "cache via Redis" });
		const b = observation("2026-05-02T11:00:01", { content: "cache via Memcached" });
		const c = observation("2026-05-02T12:00:01", { content: "cache via SQLite" });
		const { summary: block } = renderSummaryV2({
			observations: [a, b, c],
			supersessions: new Map([
				[a.timestamp, c.timestamp],
				[b.timestamp, c.timestamp],
			]),
		});
		const lines = block.split("## Observations\n")[1].split("\n");
		expect(lines).toEqual([
			`${a.timestamp}  believed: cache via Redis`,
			`${b.timestamp}  believed: cache via Memcached`,
			`${c.timestamp}  now: cache via SQLite`,
		]);
	});

	it("degrades a malformed supersession cycle to plain lines (no loss, no loop)", () => {
		const a = observation("2026-05-02T10:00:01", { content: "fact a" });
		const b = observation("2026-05-02T11:00:01", { content: "fact b" });
		const { summary: block } = renderSummaryV2({
			observations: [a, b],
			supersessions: new Map([
				[a.timestamp, b.timestamp],
				[b.timestamp, a.timestamp],
			]),
		});
		const lines = block.split("## Observations\n")[1].split("\n");
		expect(lines).toEqual([observationToLine(a), observationToLine(b)]);
	});

	it("is byte-identical across double renders of identical input (C3)", () => {
		const once = renderSummaryV2(fullInput);
		const twice = renderSummaryV2(fullInput);
		expect(twice).toEqual(once); // C3 covers summary AND packExplain
		expect(once.summary.length).toBeGreaterThan(0);
	});
});

describe("renderSummaryV2 (P2.3 — knapsack, L6 fallback, PackExplain)", () => {
	const meta = (overrides: Partial<LineMeta> = {}): LineMeta => ({
		kind: "assertion",
		provenance: "model-distilled",
		supersessionCount: 0,
		ageCompactions: 0,
		tokenCount: 10,
		...overrides,
	});

	const metaMapFor = (observations: Observation[], overrides: Partial<LineMeta> = {}): Map<string, LineMeta> =>
		new Map(observations.map((o) => [o.timestamp, meta({ tokenCount: o.tokenCount, ...overrides })]));

	const at = (second: number) => `2026-05-02T10:00:${String(second).padStart(2, "0")}`;

	it("pins RENDER_BUDGET_TOKENS = 18_000 (§2.3) as the default [5]+[6] pack budget", () => {
		expect(RENDER_BUDGET_TOKENS).toBe(18_000);
	});

	it("(a) never exceeds the pack budget — admitted group tokens sum ≤ budget", () => {
		const observations = [1, 2, 3, 4].map((n) =>
			observation(at(n), { content: `fact ${n}`, tokenCount: 10, kind: "assertion", sourceEntryId: "e1" }),
		);
		const observationMeta = metaMapFor(observations);
		const { summary, packExplain } = renderSummaryV2({ observations, observationMeta, budget: 25 });
		expect(packExplain.fallback).toBe(false);
		const admitted = packExplain.lines.filter((line) => line.admitted);
		const evicted = packExplain.lines.filter((line) => !line.admitted);
		const admittedTokens = admitted.reduce((sum, line) => sum + (observationMeta.get(line.id)?.tokenCount ?? 0), 0);
		expect(admittedTokens).toBeLessThanOrEqual(25);
		expect(admitted).toHaveLength(2); // 10+10 ≤ 25; a third 10-token line never fits
		expect(evicted).toHaveLength(2);
		for (const line of packExplain.lines) expect(summary.includes(line.id)).toBe(line.admitted);
	});

	it("(b) evicts a stale low-trust line before a fresh user-asserted one", () => {
		const stale = observation(at(1), {
			content: "stale model-derived claim",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const fresh = observation(at(2), {
			content: "fresh user-asserted claim",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e2",
		});
		const observationMeta = new Map<string, LineMeta>([
			[stale.timestamp, meta({ ageCompactions: 3, provenance: "model-distilled" })], // 1.0·1.0·0.55/10 = 0.055
			[fresh.timestamp, meta({ ageCompactions: 0, provenance: "user-asserted" })], // 1.0·1.2·1.00/10 = 0.12
		]);
		const { summary, packExplain } = renderSummaryV2({ observations: [stale, fresh], observationMeta, budget: 10 });
		expect(summary).toContain("fresh user-asserted claim");
		expect(summary).not.toContain("stale model-derived claim");
		const byId = new Map(packExplain.lines.map((line) => [line.id, line]));
		expect(byId.get(fresh.timestamp)).toMatchObject({ admitted: true, reason: "packed" });
		expect(byId.get(stale.timestamp)).toMatchObject({ admitted: false, reason: "evicted-budget" });
	});

	it("(c) absent metadata ⇒ L6 whole-pack fallback, byte-identical to the P1 output", () => {
		const observations = [1, 2, 3].map((n) =>
			observation(at(n), { content: `fact ${n}`, tokenCount: 10, kind: "assertion", sourceEntryId: "e1" }),
		);
		const { summary, packExplain } = renderSummaryV2({ observations });
		expect(packExplain.fallback).toBe(true);
		expect(summary).toBe(renderSummary(undefined, undefined, observations));
		expect(packExplain.lines.every((line) => line.admitted && line.reason === "fallback-chronological")).toBe(true);
	});

	it("(c) partial metadata still falls back for the WHOLE pack — never a half-packed hybrid", () => {
		const a = observation(at(1), { content: "fact a", tokenCount: 10, kind: "assertion", sourceEntryId: "e1" });
		const b = observation(at(2), { content: "fact b", tokenCount: 10, kind: "assertion", sourceEntryId: "e1" });
		const partial = renderSummaryV2({ observations: [a, b], observationMeta: new Map([[a.timestamp, meta()]]) });
		const absent = renderSummaryV2({ observations: [a, b] });
		expect(partial.packExplain.fallback).toBe(true);
		expect(partial.summary).toBe(absent.summary);
	});

	it("(c) all-equal metadata ⇒ packed output byte-identical to chronological (tie order)", () => {
		const observations = [1, 2, 3].map((n) =>
			observation(at(n), { content: `fact ${n}`, tokenCount: 10, kind: "assertion", sourceEntryId: "e1" }),
		);
		const packed = renderSummaryV2({ observations, observationMeta: metaMapFor(observations) });
		expect(packed.packExplain.fallback).toBe(false);
		expect(packed.summary).toBe(renderSummary(undefined, undefined, observations));
	});

	it("(d) PackExplain matches admissions line-for-line, ordered by descending admission score", () => {
		const specs: Array<[number, Partial<LineMeta>]> = [
			[1, { kind: "assertion", provenance: "user-asserted" }], // 0.12
			[2, { kind: "event" }], // 0.05
			[3, { kind: "question" }], // 0.06
			[4, { kind: "decision", ageCompactions: 2 }], // 0.07
			[5, { kind: "completion" }], // 0.09
		];
		const observations = specs.map(([n]) => observation(at(n), { content: `fact ${n}`, tokenCount: 10 }));
		const observationMeta = new Map(specs.map(([n, overrides]) => [at(n), meta(overrides)]));
		const { summary, packExplain } = renderSummaryV2({ observations, observationMeta, budget: 25 });
		expect(packExplain.fallback).toBe(false);
		expect(packExplain.lines).toHaveLength(observations.length);
		for (const line of packExplain.lines) {
			expect(summary.includes(line.id)).toBe(line.admitted);
			expect(line.reason).toBe(line.admitted ? "packed" : "evicted-budget");
		}
		for (let i = 1; i < packExplain.lines.length; i++) {
			expect(packExplain.lines[i].score).toBeLessThanOrEqual(packExplain.lines[i - 1].score);
		}
		// 0.12, 0.09 fit (20 ≤ 25); 0.07 would reach 30 → budget evicts the rest.
		expect(packExplain.lines.filter((line) => line.admitted).map((line) => line.id)).toEqual([at(1), at(5)]);
	});

	it("L7: reserved sections render in full even when the pack budget evicts everything", () => {
		const observations = [
			observation(at(1), { content: "packed away", tokenCount: 10, kind: "assertion", sourceEntryId: "e1" }),
		];
		const { summary, packExplain } = renderSummaryV2({
			state: { body: "## Goal\nShip v4" },
			journey: "## 2026-09-24\nArc.",
			observations,
			observationMeta: metaMapFor(observations),
			budget: 0,
		});
		expect(packExplain.lines.every((line) => !line.admitted && line.reason === "evicted-budget")).toBe(true);
		expect(summary).not.toContain("packed away");
		expect(summary).toContain("## State");
		expect(summary).toContain("## Journey");
	});

	it("packs a supersession belief group as a UNIT — the budget never splits a pair", () => {
		const loser = observation(at(1), {
			content: "prefers SWR",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const winner = observation(at(2), {
			content: "switched to React Query",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e2",
		});
		const supersessions = new Map([[loser.timestamp, winner.timestamp]]);
		const observationMeta = metaMapFor([loser, winner]);

		const split = renderSummaryV2({ observations: [loser, winner], supersessions, observationMeta, budget: 15 });
		expect(split.packExplain.fallback).toBe(false);
		expect(split.summary).not.toContain("prefers SWR");
		expect(split.summary).not.toContain("React Query");
		expect(split.packExplain.lines.filter((line) => line.admitted)).toHaveLength(0);

		const whole = renderSummaryV2({ observations: [loser, winner], supersessions, observationMeta, budget: 20 });
		const lines = whole.summary.split("## Observations\n")[1].split("\n");
		expect(lines).toEqual([
			`${loser.timestamp}  believed: prefers SWR`,
			`${winner.timestamp}  now: switched to React Query`,
		]);
	});
});

describe("compaction hook wiring (P1.5 acceptance: §2.3 block actually emitted)", () => {
	it("session_before_compact returns the V2 block with §2.3 sections in order, Open loops last", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "om-hook-"));
		try {
			const memoryRoot = join(cwd, ".memory", "test-session");
			mkdirSync(memoryRoot, { recursive: true });
			writeFileSync(join(memoryRoot, "STATE.md"), "## Goal\nShip v4\n## Open loops\n- finish P2\n## Done\n- P0\n");
			writeFileSync(join(memoryRoot, "JOURNEY.md"), "## 2026-09-24\nThe campaign began.\n");
			writeFileSync(
				join(memoryRoot, "auth.md"),
				"---\nid: auth\ntitle: Auth\nsummary: auth topic\nupdated: 2026-09-25 10:00\n---\nBody.\n",
			);

			const runtime = new Runtime();
			runtime.enabled = true;
			runtime.memoryRoot = memoryRoot;

			// Capture the REAL registered handler — this tests the hook's wiring path,
			// not just renderSummaryV2 units (reviewer Note 10).
			const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
			const pi = {
				on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
					handlers[name] = handler;
				},
			};
			registerCompactionHook(pi as never, runtime);
			expect(handlers["session_before_compact"]).toBeDefined();

			// Full v2 metadata (kind + sourceEntryId) so the hook takes the PACKED path —
			// buildPackMeta must produce a complete map for this single observation.
			const observed = observation("2026-05-02T10:00:01", {
				content: "first committed event",
				kind: "event",
				sourceEntryId: "e1",
			});
			const branch = [
				rawMessage("e1", "opening message"),
				observationsRecordedEntry("e2", { observations: [observed], coversUpToId: "e1" }),
				rawMessage("e3", "cut starts here"),
				rawMessage("e4", "verbatim tail"),
			];
			const ctx = {
				hasUI: false,
				cwd,
				sessionManager: { getBranch: () => branch, getEntries: () => branch },
			};
			const result = (await handlers["session_before_compact"](
				{ preparation: { firstKeptEntryId: "e3", tokensBefore: 1000 } },
				ctx,
			)) as {
				compaction?: { summary?: string; firstKeptEntryId?: string };
			} | void;

			const summary = result?.compaction?.summary ?? "";
			expect(summary.length).toBeGreaterThan(0);
			// §2.3 relative order of the BLOCK-LEVEL sections this fixture makes present.
			// STATE renders verbatim in [2] (§2.3), so its own "## Open loops" heading also
			// occurs nested inside the State section — index the recency-anchor occurrence
			// separately (lastIndexOf) instead of mistaking the nested one for section [8].
			const marks = ["condensed memories", "## State", "## Journey", "## Memory map", "## Observations"];
			const positions = marks.map((mark) => summary.indexOf(mark));
			for (const position of positions) expect(position).toBeGreaterThan(-1);
			// The recency anchor (last "## Open loops") must come after Observations…
			const openLoopsAnchor = summary.lastIndexOf("## Open loops");
			expect(openLoopsAnchor).toBeGreaterThan(summary.indexOf("## Observations"));
			positions.push(openLoopsAnchor);
			expect([...positions].sort((a, b) => a - b)).toEqual(positions);
			// …and STATE's nested heading proves [2] really renders the file verbatim.
			const stateStart = summary.indexOf("## State");
			expect(summary.indexOf("## Open loops")).toBeGreaterThan(stateStart);
			expect(summary.indexOf("## Open loops")).toBeLessThan(summary.indexOf("## Journey"));
			// Recency anchor: Open loops is the block's FINAL heading.
			const headings = [...summary.matchAll(/^## .*/gm)].map((match) => match[0]);
			expect(headings.at(-1)).toBe("## Open loops");
			// The committed observation made it through projection + cutoff snap.
			expect(summary).toContain("first committed event");
			// Snap chose the chunk boundary (e2's covers → first kept = e3), not the proposal
			// by accident of fallback: e3 IS pi's proposal too, so assert presence explicitly.
			expect(result?.compaction?.firstKeptEntryId).toBe("e3");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
