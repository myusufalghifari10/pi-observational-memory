/**
 * P0.8 — /om:status journey over-size warning (visibility only, no enforcement).
 *
 * The user's decision: growth of JOURNEY.md on a long session is fine; only surface it when
 * the journey passes 2× its token target. Format helpers are extracted from the command so
 * they can be asserted without driving the TUI.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { collectMemoryHealth, formatHealthLines, formatJourneyLine } from "../src/commands/status.js";
import { foldLedger } from "../src/ledger/index.js";
import { checkAnergy } from "../src/memory/anergy.js";
import { listTopics, readDeaths } from "../src/memory/paths.js";
import { estimateStringTokens } from "../src/tokens.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsRecordedEntry,
	observationsSupersededEntry,
	rawMessage,
} from "./fixtures/session.js";

const TARGET = 1_000;
const estimate = estimateStringTokens;

describe("P0.8 journey over-size warn", () => {
	it("reports none yet when the journey is absent", () => {
		expect(formatJourneyLine(undefined, TARGET, estimate)).toBe("journey: none yet");
	});

	it("stays quiet within the target", () => {
		const journey = "word ".repeat(100); // well under 1000 tokens
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).toContain("journey: ~");
		expect(line).not.toContain("OVER TARGET");
	});

	it("stays quiet between target and 2× target (growth is fine)", () => {
		const journey = "x".repeat(1_500); // ~375 tokens: over target, under 2×
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).not.toContain("OVER TARGET");
	});

	it("flags OVER TARGET once past 2× the target", () => {
		const journey = "x".repeat(10_000); // ~2500 tokens > 2×1000
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).toContain("⚠ OVER TARGET");
		expect(line).toContain(`/ ${TARGET.toLocaleString()} tok`);
	});
});

/**
 * P5.2 — operator telemetry in /om:status. The health lines read EXISTING durable
 * sources only: last compaction entry (summary → block tokens, details.render →
 * pack counts), the folded ledger (gaps/supersessions), DEATHS.md, and a live
 * model-free anergy check. No new persistence anywhere.
 */
describe("P5.2 health lines: exact numbers from a fixture ledger + memory dir", () => {
	const tsA = "2026-05-02T10:00:01";
	const tsB = "2026-05-02T10:00:02";

	/** Local gap builder (fixtures/session.ts has no gap helper; mirrors ledger.fold.test). */
	function gapEntry(id: string, data: Record<string, unknown>) {
		return {
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-09-25T10:00:00",
			customType: "om.observations.gap",
			data,
		};
	}

	it("reports block size, pack counts, gaps, deaths, supersessions and anergy", () => {
		const obsA = observation(tsA, { content: "alpha fact", kind: "assertion", tokenCount: 8 });
		const obsB = observation(tsB, { content: "beta fact", kind: "assertion", tokenCount: 8 });
		const entries = [
			rawMessage("e1", "opening message"),
			observationsRecordedEntry("om-1", { observations: [obsA], coversUpToId: "e1" }),
			observationsRecordedEntry("om-2", { observations: [obsB], coversUpToId: "e1" }),
			observationsSupersededEntry("om-s-1", {
				pairs: [{ oldTimestamp: tsA, newTimestamp: tsB, reason: "lexical-supersession" }],
				coversUpToId: "e1",
			}),
			gapEntry("gap-1", { coversUpToId: "e1", attempts: 2, lastError: "observer exited with code 1" }),
			gapEntry("gap-2", { afterEntryId: "e1", coversUpToId: "e2", attempts: 0, lastError: "no observations extracted" }),
			rawMessage("e2", "cut starts here"),
			compactionEntry("cp-1", {
				firstKeptEntryId: "e2",
				// 400 chars → exactly 100 tokens under the len/4 estimator.
				summary: "x".repeat(400),
				details: {
					...(memoryDetails({}) as Record<string, unknown>),
					render: { packed: 2, evicted: 1 },
				},
			}),
		];

		const cwd = mkdtempSync(join(tmpdir(), "om-p52-"));
		try {
			const memoryRoot = join(cwd, ".memory", "test-session");
			mkdirSync(memoryRoot, { recursive: true });
			writeFileSync(
				join(memoryRoot, "DEATHS.md"),
				[
					"# Deaths",
					"- rejected: hand-rolled cache because freshness bugs (verify: src/cache.ts)",
					"- rejected: retries without backoff because thundering herd (verify: src/retry.ts)",
					"",
					"not a rejection line",
					"",
				].join("\n"),
			);
			// A topic asserting a file that does not exist → checkAnergy demotes it (1 flagged).
			writeFileSync(
				join(memoryRoot, "drift.md"),
				[
					"---",
					"id: drift",
					"title: Drift",
					"summary: drifting topic",
					"updated: 2026-09-25 10:00",
					"asserts: src/definitely-missing.ts",
					"---",
					"Body.",
					"",
				].join("\n"),
			);

			const folded = foldLedger(entries);
			const health = collectMemoryHealth({
				entries,
				folded,
				deathsBody: readDeaths(memoryRoot),
				anergyFlagged: checkAnergy(listTopics(memoryRoot), resolve(memoryRoot, "..", ".."), folded.activeObservations)
					.size,
			});

			// Exact numbers, not just labels:
			expect(health.blockTokens).toBe(100);
			expect(health.packed).toBe(2);
			expect(health.evicted).toBe(1);
			expect(health.gaps).toBe(2);
			expect(health.unobservedGaps).toBe(1);
			expect(health.deaths).toBe(2);
			expect(health.supersessions).toBe(1);
			expect(health.anergyFlagged).toBe(1);

			const text = formatHealthLines(health).join("\n");
			expect(text).toContain("last render: ~100 tok · packed 2 / evicted 1");
			expect(text).toContain("memory health: gaps 2 (1 unobserved) · deaths 2 · supersessions 1 · anergy 1");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("degrades honestly: n/a render line and zeros on an empty ledger (no memory dir)", () => {
		const folded = foldLedger([rawMessage("e1", "hi")]);
		const health = collectMemoryHealth({
			entries: [rawMessage("e1", "hi")],
			folded,
			deathsBody: undefined,
			anergyFlagged: 0,
		});
		expect(health.blockTokens).toBeUndefined();
		expect(health.packed).toBeUndefined();
		expect(formatHealthLines(health).join("\n")).toContain("last render: n/a");
		expect(formatHealthLines(health).join("\n")).toContain(
			"memory health: gaps 0 (0 unobserved) · deaths 0 · supersessions 0 · anergy 0",
		);
	});
});
