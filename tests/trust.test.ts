import { describe, expect, it } from "vitest";

import { foldLedger } from "../src/ledger/index.js";
import {
	KIND_W,
	PROV_W,
	buildLineMeta,
	packKnapsack,
	scoreLine,
	type KnapsackLine,
	type LineMeta,
} from "../src/ledger/trust.js";
import {
	compactionEntry,
	observation,
	observationsRecordedEntry,
	observationsSupersededEntry,
	textCustomMessage,
} from "./fixtures/session.js";

/** §2.2 formula reference: (KIND_W * PROV_W * max(0.2, 1 - age*0.15) * 0.85^ss) / max(1, tokens). */
function meta(overrides: Partial<LineMeta> = {}): LineMeta {
	return {
		kind: "assertion",
		provenance: "model-distilled",
		supersessionCount: 0,
		ageCompactions: 0,
		tokenCount: 10,
		...overrides,
	};
}

describe("P2.1 scoreLine — §2.2 constants and formula (numeric)", () => {
	it("KIND_W and PROV_W match the plan §2.2 verbatim", () => {
		expect(KIND_W).toEqual({
			assertion: 1.0,
			decision: 1.0,
			preference: 1.0,
			completion: 0.9,
			strat: 0.8,
			rejected: 0.7,
			question: 0.6,
			event: 0.5,
		});
		expect(PROV_W).toEqual({
			"user-asserted": 1.2,
			"model-distilled": 1.0,
			"tool-derived": 0.8,
		});
	});

	it("applies each kind weight exactly (provenance 1.0, 10 tokens → weight/10)", () => {
		const expected: Record<string, number> = {
			assertion: 1.0,
			decision: 1.0,
			preference: 1.0,
			completion: 0.9,
			strat: 0.8,
			rejected: 0.7,
			question: 0.6,
			event: 0.5,
		};
		for (const [kind, weight] of Object.entries(expected)) {
			const score = scoreLine(meta({ kind: kind as LineMeta["kind"] }));
			expect(score).toBeCloseTo(weight / 10, 10);
		}
	});

	it("applies each provenance weight exactly (kind assertion, 10 tokens)", () => {
		expect(scoreLine(meta({ provenance: "user-asserted" }))).toBeCloseTo(1.2 / 10, 10);
		expect(scoreLine(meta({ provenance: "model-distilled" }))).toBeCloseTo(1.0 / 10, 10);
		expect(scoreLine(meta({ provenance: "tool-derived" }))).toBeCloseTo(0.8 / 10, 10);
	});

	it("decays 0.15 per compaction and floors staleness at 0.2", () => {
		// age 0 → 1.0; age 1 → 0.85; age 6 → 0.1 → floored to 0.2; age 10 → floor.
		expect(scoreLine(meta({ ageCompactions: 0 }))).toBeCloseTo(1.0 / 10, 10);
		expect(scoreLine(meta({ ageCompactions: 1 }))).toBeCloseTo(0.85 / 10, 10);
		expect(scoreLine(meta({ ageCompactions: 6 }))).toBeCloseTo(0.2 / 10, 10);
		expect(scoreLine(meta({ ageCompactions: 10 }))).toBeCloseTo(0.2 / 10, 10);
	});

	it("compounds supersessionCount as 0.85^n", () => {
		expect(scoreLine(meta({ supersessionCount: 0 }))).toBeCloseTo(1 / 10, 10);
		expect(scoreLine(meta({ supersessionCount: 1 }))).toBeCloseTo(0.85 / 10, 10);
		expect(scoreLine(meta({ supersessionCount: 2 }))).toBeCloseTo(0.7225 / 10, 10);
		expect(scoreLine(meta({ supersessionCount: 3 }))).toBeCloseTo(0.614125 / 10, 10);
	});

	it("divides by tokenCount, with a floor of 1 (zero-token lines do not explode)", () => {
		const base = meta({ kind: "question", provenance: "user-asserted", tokenCount: 72 });
		// 0.6 * 1.2 = 0.72
		expect(scoreLine(base)).toBeCloseTo(0.72 / 72, 12);
		expect(scoreLine({ ...base, tokenCount: 0 })).toBeCloseTo(0.72 / 1, 12);
		expect(scoreLine({ ...base, tokenCount: 1 })).toBeCloseTo(0.72 / 1, 12);
	});

	it("multiplies all four factors together (composite case)", () => {
		const composite = meta({
			kind: "preference",
			provenance: "tool-derived",
			ageCompactions: 3, // 1 - 0.45 = 0.55
			supersessionCount: 1, // 0.85
			tokenCount: 100,
		});
		// 1.0 * 0.8 * 0.55 * 0.85 = 0.374 → /100
		expect(scoreLine(composite)).toBeCloseTo(0.374 / 100, 10);
	});
});

describe("P2.1 packKnapsack — greedy, budget-bounded, deterministic", () => {
	function line(id: string, kind: LineMeta["kind"], tokens: number): KnapsackLine {
		return { timestamp: id, meta: meta({ kind, tokenCount: tokens }) };
	}

	it("never exceeds the budget and partitions every input line exactly once", () => {
		const lines = [
			line("2026-05-02T10:00:01", "assertion", 40),
			line("2026-05-02T10:00:02", "event", 40),
			line("2026-05-02T10:00:03", "decision", 40),
			line("2026-05-02T10:00:04", "event", 40),
		];
		const { packed, evicted } = packKnapsack(lines, 100);

		const packedTokens = packed.reduce((sum: number, l: KnapsackLine) => sum + l.meta.tokenCount, 0);
		expect(packedTokens).toBeLessThanOrEqual(100);
		expect(packedTokens).toBe(80); // two assertion/decision-tier lines fit, events do not

		// Every input line appears exactly once across packed + evicted.
		const allIds = [...packed, ...evicted].map((l) => l.timestamp).sort();
		expect(allIds).toEqual(lines.map((l) => l.timestamp).sort());
		expect(new Set(allIds).size).toBe(lines.length);
	});

	it("packs in descending score order (higher trust first)", () => {
		const lines = [
			line("2026-05-02T10:00:01", "event", 10),
			line("2026-05-02T10:00:02", "assertion", 10),
			line("2026-05-02T10:00:03", "question", 10),
		];
		const { packed, evicted } = packKnapsack(lines, 20);
		expect(packed.map((l) => l.timestamp)).toEqual([
			"2026-05-02T10:00:02", // assertion 0.1
			"2026-05-02T10:00:03", // question 0.06
		]);
		expect(evicted.map((l) => l.timestamp)).toEqual(["2026-05-02T10:00:01"]); // event 0.05
	});

	it("breaks equal-score ties chronologically — the OLDEST claims the last slot", () => {
		const older = line("2026-05-02T09:00:00", "event", 10);
		const newer = line("2026-05-02T11:00:00", "event", 10); // identical score
		const { packed, evicted } = packKnapsack([newer, older], 10);
		expect(packed.map((l) => l.timestamp)).toEqual(["2026-05-02T09:00:00"]);
		expect(evicted.map((l) => l.timestamp)).toEqual(["2026-05-02T11:00:00"]);
	});

	it("produces identical output for any input order (determinism)", () => {
		const lines = [
			line("2026-05-02T10:00:01", "assertion", 30),
			line("2026-05-02T10:00:02", "event", 30),
			line("2026-05-02T10:00:03", "decision", 30),
			line("2026-05-02T10:00:04", "completion", 30),
		];
		const baseline = packKnapsack(lines, 60);
		const shuffled = packKnapsack([...lines].reverse(), 60);
		expect(shuffled.packed.map((l) => l.timestamp)).toEqual(baseline.packed.map((l) => l.timestamp));
		expect(shuffled.evicted.map((l) => l.timestamp)).toEqual(baseline.evicted.map((l) => l.timestamp));
	});

	it("evicts rather than overruns: zero budget and oversized single lines", () => {
		const zero = packKnapsack([line("2026-05-02T10:00:01", "assertion", 10)], 0);
		expect(zero.packed).toEqual([]);
		expect(zero.evicted).toHaveLength(1);

		const oversized = packKnapsack([line("2026-05-02T10:00:01", "assertion", 50)], 5);
		expect(oversized.packed).toEqual([]);
		expect(oversized.evicted).toHaveLength(1);
	});
});

describe("P2.2 buildLineMeta — metadata derived from the fold, zero persisted state", () => {
	const tsA = "2026-05-02T10:00:01";
	const tsB = "2026-05-02T11:00:01";

	function fixtureEntries() {
		const obsA = observation(tsA, { kind: "assertion", tokenCount: 12 });
		const obsB = observation(tsB, { kind: "decision", tokenCount: 24 });
		return [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obsA], coversUpToId: "raw-1" }), // idx 1
			compactionEntry("cp-1"), // idx 2
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [obsB], coversUpToId: "raw-2" }), // idx 4
			compactionEntry("cp-2"), // idx 5
			observationsSupersededEntry("om-s-1", {
				pairs: [{ oldTimestamp: tsA, newTimestamp: tsB, reason: "lexical-supersession" }],
				coversUpToId: "raw-2",
			}), // idx 6
		];
	}

	it("builds a full LineMeta: kind, provenance, counts, tokenCount", () => {
		const folded = foldLedger(fixtureEntries());
		const obsA = folded.observationsByTimestamp.get(tsA)!;

		const built = buildLineMeta(folded, obsA, "user-asserted");
		expect(built).toEqual({
			kind: "assertion",
			provenance: "user-asserted",
			supersessionCount: 1, // losing side of exactly one pair
			ageCompactions: 2, // compactions at idx 2 and idx 5, both newer than covering idx 1
			tokenCount: 12,
		});

		const obsB = folded.observationsByTimestamp.get(tsB)!;
		const builtB = buildLineMeta(folded, obsB, "model-distilled");
		expect(builtB.supersessionCount).toBe(0); // never a losing side
		expect(builtB.ageCompactions).toBe(1); // only cp-2 (idx 5) is newer than covering idx 4
	});

	it("defaults kind to 'event' for v1 observations without kind (C5)", () => {
		const obs = observation(tsA); // no kind
		const folded = foldLedger([
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs], coversUpToId: "raw-1" }),
		]);
		const built = buildLineMeta(folded, folded.observationsByTimestamp.get(tsA)!, "tool-derived");
		expect(built.kind).toBe("event");
		expect(built.provenance).toBe("tool-derived");
		expect(built.supersessionCount).toBe(0);
		expect(built.ageCompactions).toBe(0);
		expect(built.tokenCount).toBe(obs.tokenCount);
	});
});
