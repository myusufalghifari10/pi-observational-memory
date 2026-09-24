import { describe, expect, it } from "vitest";

import { detectSupersessions, excludeAlreadySuperseded, identifierTokens } from "../src/ledger/supersede.js";
import { foldLedger } from "../src/ledger/fold.js";
import {
	observation,
	observationsRecordedEntry,
	observationsSupersededEntry,
	textCustomMessage,
	type TestObservation,
} from "./fixtures/session.js";

/**
 * P1.3 — deterministic lexical supersession (plan §2.2 / L2 / L4).
 * ≥6 cases: overlap, no-overlap, one-pair-only, old-entries, stop-words, kind gating,
 * plus identifier tokenization and fold exposure of pairs.
 */
function obs(
	timestamp: string,
	content: string,
	kind?: TestObservation["kind"],
): TestObservation {
	return { ...observation(timestamp, { content, tokenCount: 20 }), ...(kind ? { kind } : {}) };
}

describe("P1.3 supersession detector", () => {
	it("CASE1 overlap: two shared identifier tokens produce a pair", () => {
		const older = [obs("2026-05-02T10:00:00", "User chose JWT auth middleware for src/auth", "assertion")];
		const incoming = [obs("2026-05-02T11:00:00", "User chose session auth middleware for src/auth", "assertion")];
		const pairs = detectSupersessions(incoming, older);
		expect(pairs).toEqual([
			{ oldTimestamp: "2026-05-02T10:00:00", newTimestamp: "2026-05-02T11:00:00", reason: "lexical-supersession" },
		]);
	});

	it("CASE2 no-overlap: fewer than 2 shared identifier tokens produce nothing", () => {
		const older = [obs("2026-05-02T10:00:00", "User chose JWT auth middleware", "assertion")];
		const incoming = [obs("2026-05-02T11:00:00", "User installed zod package via pnpm", "assertion")];
		expect(detectSupersessions(incoming, older)).toEqual([]);
	});

	it("CASE3 one-pair-only: an older fact is paired at most once (newest incoming wins)", () => {
		const older = [obs("2026-05-02T10:00:00", "Project uses PostgreSQL database for storage", "assertion")];
		const incoming = [
			obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", "assertion"),
			obs("2026-05-02T12:00:00", "Project uses SQLite database for storage", "assertion"),
		];
		const pairs = detectSupersessions(incoming, older);
		expect(pairs).toHaveLength(1);
		// Newest incoming wins the single older slot.
		expect(pairs[0].newTimestamp).toBe("2026-05-02T12:00:00");
	});

	it("CASE4 old-entries: v1 observations without kind never act as the older side", () => {
		const older = [observation("2026-05-02T10:00:00", { content: "Project uses PostgreSQL database for storage", tokenCount: 20 })];
		const incoming = [obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", "assertion")];
		expect(detectSupersessions(incoming, older)).toEqual([]);
	});

	it("CASE5 stop-words: shared glue words never count toward the ≥2 overlap", () => {
		const older = [obs("2026-05-02T10:00:00", "The user said that the project can use the same one for this", "assertion")];
		const incoming = [obs("2026-05-02T11:00:00", "The user said that the project can use the same one for that", "assertion")];
		expect(detectSupersessions(incoming, older)).toEqual([]);
	});

	it("CASE6 kind gating: newer must be assertion|decision; older must be assertion|decision|preference", () => {
		const older = [obs("2026-05-02T10:00:00", "Project uses PostgreSQL database for storage", "assertion")];
		// newer as event/question/rejected/completion → no pair despite overlap
		for (const kind of ["event", "question", "completion", "strat", "rejected"] as const) {
			const incoming = [obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", kind)];
			expect(detectSupersessions(incoming, older), `newer=${kind}`).toEqual([]);
		}
		// older as event/completion → not eligible even with an assertion incoming
		const olderNotEligible = [obs("2026-05-02T10:00:00", "Project uses PostgreSQL database for storage", "event")];
		const incoming = [obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", "assertion")];
		expect(detectSupersessions(incoming, olderNotEligible)).toEqual([]);
		// older as preference IS eligible
		const olderPref = [obs("2026-05-02T10:00:00", "User prefers PostgreSQL database for storage", "preference")];
		expect(detectSupersessions(incoming, olderPref)).toHaveLength(1);
	});

	it("identifierTokens: path and camelCase/snake_case segments split, stop-words dropped", () => {
		const tokens = identifierTokens("handleAuthMiddleware uses auth_handler in src/auth.ts");
		// §2.2 keeps tokens length ≥3: "src" is THREE chars and a non-stop-word path segment
		// (the plan uses `src/auth.ts` itself as the example of path tokens that DO count),
		// while "ts" (length 2) stays out — asserted next line.
		expect(tokens.has("src")).toBe(true);
		expect(tokens.has("auth")).toBe(true);
		expect(tokens.has("handle")).toBe(true);
		expect(tokens.has("middleware")).toBe(true);
		expect(tokens.has("handler")).toBe(true);
		expect(tokens.has("ts")).toBe(false);
		expect(tokens.has("uses")).toBe(true); // len 4, not in the stop list
		expect(tokens.has("the")).toBe(false);
	});

	it("§2.2 one-to-one: a fact that already lost a pair never enters another (call-site pre-filter)", () => {
		const loser = obs("2026-05-02T10:00:00", "Project uses PostgreSQL database for storage", "assertion");
		const winner = obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", "assertion");
		const newest = obs("2026-05-02T12:00:00", "Project uses SQLite database for storage", "assertion");
		const supersessions = new Map([["2026-05-02T10:00:00", "2026-05-02T11:00:00"]]);

		const eligible = excludeAlreadySuperseded([loser, winner, newest], supersessions);
		expect(eligible.map((o) => o.timestamp)).not.toContain("2026-05-02T10:00:00");

		// Without the filter the detector would re-pair `loser` with `newest`, and fold's
		// first-valid-wins would drop that pair — rendering the STALE "now: winner" while the
		// newest truth floats unpaired. With it, the chain extends through the previous winner.
		const pairs = detectSupersessions([newest], eligible);
		expect(pairs).toEqual([
			{ oldTimestamp: "2026-05-02T11:00:00", newTimestamp: "2026-05-02T12:00:00", reason: "lexical-supersession" },
		]);
	});

	it("fold exposes supersessions (first-valid-wins on the losing side)", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [obs("2026-05-02T10:00:00", "old fact", "assertion")],
				coversUpToId: "raw-1",
			}),
			observationsSupersededEntry("om-s-1", {
				pairs: [
					{ oldTimestamp: "2026-05-02T10:00:00", newTimestamp: "2026-05-02T11:00:00", reason: "lexical-supersession" },
				],
				coversUpToId: "raw-1",
			}),
			// Duplicate losing side later in the branch → first record wins.
			observationsSupersededEntry("om-s-2", {
				pairs: [
					{ oldTimestamp: "2026-05-02T10:00:00", newTimestamp: "2026-05-02T12:00:00", reason: "lexical-supersession" },
				],
				coversUpToId: "raw-1",
			}),
		];
		const folded = foldLedger(entries as never);
		expect(folded.supersessions.get("2026-05-02T10:00:00")).toBe("2026-05-02T11:00:00");
		// Losing fact still present (L4: corrections are never deletions).
		expect(folded.observations.map((o) => o.timestamp)).toContain("2026-05-02T10:00:00");
	});

	it("is deterministic: same inputs, same output regardless of incoming order", () => {
		const older = [
			obs("2026-05-02T10:00:00", "Project uses PostgreSQL database for storage", "assertion"),
			obs("2026-05-02T10:05:00", "User prefers React Query over SWR state", "preference"),
		];
		const a = obs("2026-05-02T11:00:00", "Project uses MySQL database for storage", "assertion");
		const b = obs("2026-05-02T12:00:00", "User prefers TanStack Query over SWR state", "decision");
		expect(detectSupersessions([a, b], older)).toEqual(detectSupersessions([b, a], older));
	});
});
