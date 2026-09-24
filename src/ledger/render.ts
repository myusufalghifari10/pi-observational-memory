import { scoreLine, type LineMeta } from "./trust.js";
import type { Observation } from "./types.js";

/** §2.3 token budget shared by sections [5]+[6]; reserved sections are exempt (L7). */
export const RENDER_BUDGET_TOKENS = 18_000;

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Journey: a short, purely descriptive history of how this work reached its current state — for orientation only. It is not an instruction or a plan; do not read intent or next steps into it.
- Observations: timestamped events from the conversation history, in chronological order.
- Older memory: long-term memory beyond what is summarized here is indexed in pi-second-brain knowledge bases. When these summaries are not enough, query it with the knowledge_search tool.
- Corrections: corrections to earlier facts render as adjacent 'believed: X' / 'now: Y' pairs — trust the 'now:' line over the 'believed:' line.
- Before choosing any new implementation approach, grep .memory/DEATHS.md for rejected approaches and their reasons.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.`;

/** A single observation line: "YYYY-MM-DDTHH:MM:SS  content". The timestamp is the id. */
export function observationToLine(observation: Observation): string {
	return `${observation.timestamp}  ${observation.content}`;
}

/** Sort observations chronologically by their timestamp-id (lexicographic == chronological). */
export function sortObservations(observations: Observation[]): Observation[] {
	return [...observations].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

/**
 * Legacy v1 renderer (journey → map → observations). Kept exported for existing tests and as
 * the P2 fallback reference; the compaction hook renders via `renderSummaryV2` (§2.3).
 */
export function renderSummary(journey: string | undefined, map: string | undefined, observations: Observation[]): string {
	const sorted = sortObservations(observations);
	const journeyText = journey?.trim();
	if (!journeyText && !map && sorted.length === 0) return "";

	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (journeyText) parts.push(`## Journey\n${journeyText}`);
	if (map && map.trim().length > 0) parts.push(map);
	if (sorted.length > 0) {
		parts.push(`## Observations\n${sorted.map(observationToLine).join("\n")}`);
	}
	return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// renderSummaryV2 — the §2.3 block layout (P1.5 chronological seam; P2.3 packing).
//
// Seams left for later phases:
//   [5] RELEVANT MEMORY — candidates/budget inputs are accepted from P2.3, but the
//                          section still renders nothing until P2.5 (TODO(P2.5)).
//   [8] UNOBSERVED WINDOW markers — P3.1 appends them from `om.observations.gap`
//                          entries (attempts >= 2); render NOTHING for gaps now
//                          (TODO(P3.1)).
//
// C3 still holds: every input below is durable state handed in by the caller — no
// clock, no randomness, no I/O — so identical input yields byte-identical output.
// ─────────────────────────────────────────────────────────────────────────────

/** P2.5 candidate line for section [5] (accepted here; rendered from P2.5 on). */
export type ScoredLine = {
	id: string;
	text: string;
	meta: LineMeta;
};

/** Why a line landed where it did — the ContextPipe EXPLAIN ANALYZE analog (§2.2). */
export type PackExplainReason = "packed" | "evicted-budget" | "fallback-chronological";

export type PackExplainLine = {
	/** The observation's timestamp id. */
	id: string;
	/** The admission-determining score: a belief group's terminal winner score (§2.2). */
	score: number;
	admitted: boolean;
	reason: PackExplainReason;
};

export type PackExplain = {
	/** true ⇒ L6 fired: the WHOLE section rendered in chronological order. */
	fallback: boolean;
	lines: PackExplainLine[];
};

/** STATE.md as read from disk: opaque body + optional `as of` stamp (see paths.readState). */
export type StateDoc = {
	body: string;
	updated?: string;
};

/** One line of the STRATS registry — structurally satisfied by `paths.listStrats`. */
export type StratLine = {
	filename: string;
	/** Project-relative path, e.g. ".memory/<sid>/strats/deploy.md". */
	path: string;
	cue?: string;
	summary?: string;
};

export type RenderSummaryV2Input = {
	/** Defaults to the shared context-policy instructions (which carry the two §2.3 lines). */
	instructions?: string;
	/** [2] STATE.md body + stamp. Omitted ⇒ section omitted. */
	state?: StateDoc;
	/** [3] JOURNEY.md body, verbatim. Omitted ⇒ section omitted. */
	journey?: string;
	/** [4] Pre-rendered memory map (renderMemoryMap output, already heading-owning). */
	map?: string;
	// [5] RELEVANT MEMORY — candidates + budget accepted (P2.3); section still omitted
	// until P2.5 renders lexical top-k here (TODO(P2.5)).
	candidates?: ScoredLine[];
	/** [6] Active observations. */
	observations: Observation[];
	/** fold.supersessions — losing ts → winning ts; renders believed/now pairs (L4). */
	supersessions?: Map<string, string>;
	/**
	 * [6] Per-observation metadata for packing. Missing ANY entry for a rendered
	 * observation ⇒ L6 whole-pack chronological fallback (never a half-packed hybrid);
	 * an absent map with observations present takes the same fallback.
	 */
	observationMeta?: Map<string, LineMeta>;
	/** [5]+[6] shared token budget (default RENDER_BUDGET_TOKENS; reserved sections exempt). */
	budget?: number;
	/** [7] Strat entries; empty ⇒ section omitted. */
	strats?: StratLine[];
	/** [8] STATE's Open-loops body, already extracted (see `extractOpenLoops`). */
	openLoops?: string;
};

/**
 * Extract the body of STATE.md's "## Open loops" section — everything from that heading to
 * the next `## ` heading (or end of file). Undefined when absent or empty. Line-based so the
 * section convention (§2.1) is honored without a markdown dependency.
 */
export function extractOpenLoops(stateBody: string): string | undefined {
	const lines = stateBody.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trimStart().startsWith("## Open loops")) {
			start = i + 1;
			break;
		}
	}
	if (start < 0) return undefined;
	const body: string[] = [];
	for (let i = start; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) break;
		body.push(lines[i]);
	}
	const joined = body.join("\n").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * One packable belief unit: a chronological member list plus its terminal winner.
 * Singletons (no in-projection correction edge) pack/emit as plain lines; groups of
 * two or more are the `believed:`/`now:` belief clusters that must never be split.
 */
type BeliefUnit = {
	members: Observation[];
	/** Terminal winner timestamp — the `now:` label and the packing score source. */
	terminal: string;
};

/**
 * Group `sorted` observations into belief units, preserving the P1.5 emission order:
 * each unit is visited at its EARLIEST member's chronological slot (first-encounter
 * walk over `sorted`). Chain/V-merge/cycle degradations are exactly the P1.5 ones:
 * - a member whose correction edge leaves the projection (winner outside) or a cycle
 *   member degrades to a singleton unit — plain chronological line, no fact lost;
 * - a multi-member unit's terminal winner is the key the edges walked to.
 */
function buildBeliefUnits(sorted: Observation[], supersessions?: Map<string, string>): BeliefUnit[] {
	if (!supersessions || supersessions.size === 0) {
		return sorted.map((observation) => ({ members: [observation], terminal: observation.timestamp }));
	}
	const present = new Set(sorted.map((o) => o.timestamp));
	// Chain edges restricted to pairs whose BOTH ends are in the rendered set (a winner
	// outside the projection must degrade its loser to a plain line, not strand it).
	const nextOf = new Map<string, string>();
	for (const [oldTimestamp, newTimestamp] of supersessions) {
		if (present.has(oldTimestamp) && present.has(newTimestamp)) nextOf.set(oldTimestamp, newTimestamp);
	}
	if (nextOf.size === 0) {
		return sorted.map((observation) => ({ members: [observation], terminal: observation.timestamp }));
	}

	// Walk each member to its terminal winner; undefined = malformed cycle.
	const terminalOf = new Map<string, string | undefined>();
	for (const observation of sorted) {
		const seen = new Set<string>([observation.timestamp]);
		let current: string | undefined = observation.timestamp;
		while (current !== undefined && nextOf.has(current)) {
			const next: string = nextOf.get(current)!;
			if (seen.has(next)) {
				current = undefined; // cycle → plain-line degradation for every reachable member
				break;
			}
			seen.add(next);
			current = next;
		}
		terminalOf.set(observation.timestamp, current);
	}

	// Group members by terminal winner (cycle members keep terminalOf undefined → singletons).
	const groups = new Map<string, string[]>();
	for (const observation of sorted) {
		const terminal = terminalOf.get(observation.timestamp);
		if (terminal === undefined) continue;
		const group = groups.get(terminal) ?? [];
		group.push(observation.timestamp);
		groups.set(terminal, group);
	}

	const byTimestamp = new Map(sorted.map((o) => [o.timestamp, o]));
	const units: BeliefUnit[] = [];
	const emitted = new Set<string>();
	for (const observation of sorted) {
		const ts = observation.timestamp;
		if (emitted.has(ts)) continue;
		const terminal = terminalOf.get(ts);
		const group = terminal === undefined ? undefined : groups.get(terminal);
		if (terminal === undefined || !group || group.length === 1) {
			units.push({ members: [observation], terminal: ts });
			emitted.add(ts);
			continue;
		}
		const members = group.map((memberTs) => byTimestamp.get(memberTs)).filter((m): m is Observation => !!m);
		units.push({ members, terminal });
		for (const memberTs of group) emitted.add(memberTs);
	}
	return units;
}

/** Render one belief unit: plain line for a singleton, adjacent believed/now labels for a group. */
function unitLines(unit: BeliefUnit): string[] {
	if (unit.members.length === 1) return [observationToLine(unit.members[0])];
	return unit.members.map((member) =>
		member.timestamp === unit.terminal
			? `${member.timestamp}  now: ${member.content}`
			: `${member.timestamp}  believed: ${member.content}`,
	);
}

/** Section [7] one-liners: `<name> — <summary> `<path>`, name = cue || filename stem. */
function renderStratLines(strats: StratLine[]): string[] {
	return strats.map((strat) => {
		const name = (strat.cue ?? "").trim() || strat.filename.replace(/\.md$/, "");
		const summary = (strat.summary ?? "").trim();
		return `- ${name}${summary ? ` — ${summary}` : ""} \`${strat.path}\``;
	});
}

/**
 * Render the deterministic compaction block in the §2.3 layout (reading order):
 *   [1] instructions   [2] STATE (as of …)   [3] JOURNEY   [4] MEMORY MAP
 *   [5] RELEVANT MEMORY (P2.5 — omitted until then)
 *   [6] OBSERVATIONS (knapsack-packed belief units under RENDER_BUDGET_TOKENS;
 *       L6 fallback ⇒ chronological; supersession pairs adjacent)
 *   [7] STRATS (omitted when empty)
 *   [8] OPEN LOOPS — the recency anchor, always the LAST section (P3.1 gap markers append here)
 *
 * Every section except [1] is omitted wholesale when empty, so an all-empty input returns ""
 * (delegating to pi's native summarizer, as v1 did).
 */
export function renderSummaryV2(input: RenderSummaryV2Input): { summary: string; packExplain: PackExplain } {
	const observations = input.observations ?? [];
	const sorted = sortObservations(observations);
	const strats = input.strats ?? [];
	const stateBody = input.state?.body.trim();
	const journeyText = input.journey?.trim();
	const mapText = input.map?.trim();
	const openLoops = input.openLoops?.trim();

	if (!stateBody && !journeyText && !mapText && strats.length === 0 && sorted.length === 0) {
		return { summary: "", packExplain: { fallback: false, lines: [] } };
	}

	const units = buildBeliefUnits(sorted, input.supersessions);
	const metaByTimestamp = input.observationMeta;
	// L6: absent or PARTIAL metadata ⇒ the WHOLE section renders in chronological order,
	// byte-identical to the P1 output — an upgrade can never regress old data.
	const fallback = sorted.some((observation) => !metaByTimestamp?.has(observation.timestamp));
	let observationLines: string[];
	let packExplain: PackExplain;
	if (fallback) {
		observationLines = units.flatMap(unitLines);
		packExplain = {
			fallback: true,
			lines: sorted.map((observation) => {
				const meta = metaByTimestamp?.get(observation.timestamp);
				return {
					id: observation.timestamp,
					score: meta ? scoreLine(meta) : 0,
					admitted: true,
					reason: "fallback-chronological" as const,
				};
			}),
		};
	} else {
		// Complete metadata: greedy pack over belief UNITS — score desc (§2.2 score of the
		// unit's terminal winner), tie → earliest member timestamp asc (chronological). A
		// unit's cost is the SUM of its members' tokens, so a correction pair can never be
		// split by the budget (L4). NOTE: packKnapsack (trust) packs single lines whose score
		// derives from the same tokenCount it budgets — belief groups split score/tokens and
		// need this unit-aware pass; single-line packs ([5]) keep packKnapsack from P2.5 on.
		const meta = metaByTimestamp as Map<string, LineMeta>; // fallback===false ⇒ present & complete
		const ranked = units.map((unit) => {
			const winner =
				unit.members.find((member) => member.timestamp === unit.terminal) ?? unit.members[unit.members.length - 1];
			return {
				unit,
				score: scoreLine(meta.get(winner.timestamp)!),
				tokens: unit.members.reduce((sum, member) => sum + (meta.get(member.timestamp)?.tokenCount ?? 0), 0),
				earliest: unit.members[0].timestamp,
			};
		});
		ranked.sort((a, b) =>
			b.score !== a.score ? b.score - a.score : a.earliest < b.earliest ? -1 : a.earliest > b.earliest ? 1 : 0,
		);
		const budget = input.budget ?? RENDER_BUDGET_TOKENS;
		let used = 0;
		const admitted = ranked.map((rank) => {
			if (used + rank.tokens > budget) return false;
			used += rank.tokens;
			return true;
		});
		observationLines = ranked.flatMap((rank, index) => (admitted[index] ? unitLines(rank.unit) : []));
		packExplain = {
			fallback: false,
			lines: ranked.flatMap((rank, index) =>
				rank.unit.members.map((member) => ({
					id: member.timestamp,
					score: rank.score, // the admission-determining score (unit's terminal winner)
					admitted: admitted[index],
					reason: (admitted[index] ? "packed" : "evicted-budget") as PackExplainReason,
				})),
			),
		};
	}

	const parts: string[] = [input.instructions ?? CONTEXT_USAGE_INSTRUCTIONS];

	// [2] STATE — verbatim body under a stamped heading.
	if (stateBody) {
		const heading = input.state?.updated ? `## State (as of ${input.state.updated})` : "## State";
		parts.push(`${heading}\n${stateBody}`);
	}
	// [3] JOURNEY — verbatim.
	if (journeyText) parts.push(`## Journey\n${journeyText}`);
	// [4] MEMORY MAP — passed through (heading, anergy flags and death stubs are the
	// map renderer's business, not ours).
	if (mapText) parts.push(mapText);
	// [5] RELEVANT MEMORY — TODO(P2.5): pack `input.candidates` as lexical top-k here;
	// until then the section is omitted and [6] receives the whole budget.
	// [6] OBSERVATIONS — knapsack-packed belief units (P2.3); L6 fallback ⇒ chronological.
	if (observationLines.length > 0) {
		parts.push(`## Observations\n${observationLines.join("\n")}`);
	}
	// [7] STRATS — omitted when the registry is empty.
	if (strats.length > 0) parts.push(`## Strats\n${renderStratLines(strats).join("\n")}`);
	// [8] OPEN LOOPS — recency anchor: must be the block's final section.
	// TODO(P3.1): append `⚠ UNOBSERVED WINDOW [idA..idB]` markers from om.observations.gap
	// entries (attempts >= 2) right after this section; render nothing for gaps until then.
	if (openLoops) parts.push(`## Open loops\n${openLoops}`);

	return { summary: parts.join("\n\n"), packExplain };
}
