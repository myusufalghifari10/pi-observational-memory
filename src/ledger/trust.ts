/**
 * P2.1/P2.2 — trust model: per-line trust scoring and budget packing for the
 * renderSummaryV2 "RELEVANT MEMORY" knapsack (plan §2.2). PURE module: zero pi
 * imports, zero IO, zero clock — fully deterministic and unit-testable.
 *
 * scoreLine(meta) =
 *   (KIND_W[kind] * PROV_W[provenance] * max(0.2, 1 - ageCompactions*0.15) * 0.85^supersessionCount)
 *   / max(1, tokenCount)
 *
 * All metadata is DERIVED from the folded ledger at call time (zero persisted state):
 * - supersessionCount: how many times a line appears as the LOSING side of a pair.
 * - ageCompactions: compaction entries newer than the line's covering entry.
 */

import type { FoldedLedger } from "./fold.js";
import type { Observation, ObservationKind, ProvenanceClass } from "./types.js";

/** Kind weight (plan §2.2) — the kind that the observer assigned to the observation. */
export const KIND_W: Record<ObservationKind, number> = {
	assertion: 1.0,
	decision: 1.0,
	preference: 1.0,
	completion: 0.9,
	strat: 0.8,
	rejected: 0.7,
	question: 0.6,
	event: 0.5,
};

/** Provenance weight (plan §2.2) — derived at the extension boundary (L1), never self-graded. */
export const PROV_W: Record<ProvenanceClass, number> = {
	"user-asserted": 1.2,
	"model-distilled": 1.0,
	"tool-derived": 0.8,
};

/** Staleness decay per compaction and its floor (plan §2.2). */
export const STALENESS_DECAY = 0.15;
export const STALENESS_FLOOR = 0.2;
/** Supersession compounding (plan §2.2). */
export const SUPERSESSION_DECAY = 0.85;

export type LineMeta = {
	kind: ObservationKind;
	provenance: ProvenanceClass;
	/** Times this line is the losing side of a supersession pair. */
	supersessionCount: number;
	/** Compaction entries newer than the line's covering entry. */
	ageCompactions: number;
	tokenCount: number;
};

export type KnapsackLine = {
	timestamp: string;
	meta: LineMeta;
};

export type KnapsackResult = {
	packed: KnapsackLine[];
	evicted: KnapsackLine[];
};

/** §2.2 trust formula. Deterministic; every factor is a pure function of LineMeta. */
export function scoreLine(meta: LineMeta): number {
	const kindWeight = KIND_W[meta.kind] ?? KIND_W.event;
	const provWeight = PROV_W[meta.provenance] ?? PROV_W["model-distilled"];
	const staleness = Math.max(STALENESS_FLOOR, 1 - meta.ageCompactions * STALENESS_DECAY);
	const compounding = Math.pow(SUPERSESSION_DECAY, meta.supersessionCount);
	return (kindWeight * provWeight * staleness * compounding) / Math.max(1, meta.tokenCount);
}

/**
 * A score/tokens-ranked line — the input shape of the SINGLE admission loop.
 * `timestamp` doubles as the deterministic tie-break (oldest first); callers keep
 * any payload on the object (the generic passes it through).
 */
export type RankedLine = {
	timestamp: string;
	score: number;
	tokens: number;
};

/**
 * Greedy admission: rank score desc, ties chronologically (oldest first — on equal
 * trust the longer-lived fact claims the last slot), then admit while the budget
 * allows (a line that does not fit is skipped; a later, smaller line may still fit).
 * Never exceeds the budget. Every admission decision in the system flows through
 * THIS function — [5] relevance, [6] belief units and packKnapsack all delegate here
 * (single drift-free logic).
 */
export function packRanked<T extends RankedLine>(
	lines: readonly T[],
	budget: number,
): { ranked: T[]; admitted: boolean[] } {
	const ranked = [...lines].sort((a, b) => {
		const delta = b.score - a.score;
		if (delta !== 0 && !Number.isNaN(delta)) return delta;
		return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
	});
	const admitted: boolean[] = [];
	let used = 0;
	for (const line of ranked) {
		const cost = Math.max(0, line.tokens);
		if (used + cost <= budget) {
			used += cost;
			admitted.push(true);
		} else {
			admitted.push(false);
		}
	}
	return { ranked, admitted };
}

/**
 * Greedy knapsack over scoreLine (the §2.2 trust score) — thin wrapper over the
 * single admission loop in `packRanked`. Output semantics unchanged: `packed` and
 * `evicted` each preserve ranked order, so every input line lands in exactly one.
 */
export function packKnapsack(lines: KnapsackLine[], budget: number): KnapsackResult {
	const { ranked, admitted } = packRanked(
		lines.map((line) => ({
			timestamp: line.timestamp,
			score: scoreLine(line.meta),
			tokens: line.meta.tokenCount,
			source: line,
		})),
		budget,
	);
	return {
		packed: ranked.filter((_, index) => admitted[index]).map((entry) => entry.source),
		evicted: ranked.filter((_, index) => !admitted[index]).map((entry) => entry.source),
	};
}

/**
 * P2.2 — build a LineMeta from the folded ledger with zero persisted state.
 * `provenance` is caller-derived at the extension boundary (L1; role mapping in
 * deriveProvenance). kind defaults to 'event' for v1 observations (C5).
 */
export function buildLineMeta(
	folded: FoldedLedger,
	observation: Observation,
	provenance: ProvenanceClass,
): LineMeta {
	let supersessionCount = 0;
	for (const oldTimestamp of folded.supersessions.keys()) {
		if (oldTimestamp === observation.timestamp) supersessionCount++;
	}
	return {
		kind: observation.kind ?? "event",
		provenance,
		supersessionCount,
		ageCompactions: folded.observationAgeCompactions.get(observation.timestamp) ?? 0,
		tokenCount: observation.tokenCount,
	};
}
