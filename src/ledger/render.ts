import { identifierTokens } from "./supersede.js";
import { packRanked, scoreLine, type LineMeta, type RankedLine } from "./trust.js";
import type { Gap, Observation } from "./types.js";

/** §2.3 token budget shared by sections [5]+[6]; reserved sections are exempt (L7). */
export const RENDER_BUDGET_TOKENS = 18_000;

/** §2.6 top-k for section [5] — at most this many RELEVANT MEMORY lines render. */
export const RELEVANT_TOP_K = 5;

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Journey: a short, purely descriptive history of how this work reached its current state — for orientation only. It is not an instruction or a plan; do not read intent or next steps into it.
- Observations: timestamped events from the conversation history, selected for trust and recency (ordered by trust score; chronological only for legacy metadata).
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
//   [8] UNOBSERVED WINDOW markers — implemented in P3.1: `⚠ UNOBSERVED WINDOW
//                          [after..covers]` lines for gaps with attempts >= 2,
//                          appended after Open loops; attempts:0 gaps render nothing.
//   [5] RELEVANT MEMORY renders §2.6 lexical top-k from P2.5 on (see selectRelevant).
//
// C3 still holds: every input below is durable state handed in by the caller — no
// clock, no randomness, no I/O — so identical input yields byte-identical output.
// ─────────────────────────────────────────────────────────────────────────────

/** P2.5 candidate line for section [5]: id + display text + budget tokens (hook-built). */
export type ScoredLine = {
	id: string;
	text: string;
	meta: LineMeta;
};

function sharedWith(queryTokens: ReadonlySet<string>, text: string): number {
	let shared = 0;
	for (const token of identifierTokens(text)) if (queryTokens.has(token)) shared++;
	return shared;
}

/**
 * §2.6 pure lexical relevance — the shared-identifier count between query and text,
 * using the SAME tokenizer as §2.2 (`supersede.identifierTokens`; never duplicated).
 * No embeddings, no clock: deterministic by construction (C3).
 */
export function relevanceScore(query: string, text: string): number {
	const queryTokens = identifierTokens(query);
	return queryTokens.size === 0 ? 0 : sharedWith(queryTokens, text);
}

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
	// [5] RELEVANT MEMORY — lexical top-k vs `query` (§2.6, P2.5); candidates are
	// hook-built topic summaries + STATE lines; typed observations join the pool here.
	candidates?: ScoredLine[];
	/** [5] §2.6 query — the last user/custom_message content, bounded to 2,000 chars by the caller. */
	query?: string;
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
	/**
	 * [8] fold.gaps — UNOBSERVED WINDOW markers (P3.1, §2.4). `attempts >= 2` renders
	 * `⚠ UNOBSERVED WINDOW [after..covers]`; `attempts: 0` ("acked, nothing to record")
	 * renders nothing. Order = input order (= fold's branch order, deterministic).
	 */
	gaps?: Gap[];
};

/**
 * One packable section-[5] entry: relevance-ranked, rendered as one or more lines
 * (a belief unit renders its whole `believed:`/`now:` group — Fix B, L4 partner adjacency).
 */
type RelevantEntry = RankedLine & { lines: string[] };

/** Score hook-built topic/STATE candidates ([5]-only) against the query's identifiers. */
function scoreTopicEntries(queryTokens: ReadonlySet<string>, candidates: ScoredLine[]): RelevantEntry[] {
	const entries: RelevantEntry[] = [];
	for (const candidate of candidates) {
		const score = sharedWith(queryTokens, candidate.text);
		if (score <= 0) continue;
		entries.push({
			timestamp: candidate.id,
			score,
			tokens: Math.max(1, candidate.meta.tokenCount),
			lines: [candidate.text],
		});
	}
	return entries;
}

/**
 * §2.6 section-[5] teasers: belief units section [6] did NOT admit, scored against the
 * query. Fix B — a multi-member unit enters as ONE entry rendering its whole group
 * (`believed:`/`now:` partners adjacent, never a bare member). A unit admitted to [6] is
 * excluded (dedup: a line must never render twice in one block). Pure, same tokenizer.
 */
function scoreTeaserEntries(
	queryTokens: ReadonlySet<string>,
	units: BeliefUnit[],
	admittedObservationIds: ReadonlySet<string>,
	metaByTimestamp: Map<string, LineMeta> | undefined,
): RelevantEntry[] {
	const entries: RelevantEntry[] = [];
	for (const unit of units) {
		const first = unit.members[0];
		if (!first || admittedObservationIds.has(first.timestamp)) continue; // in [6] ⇒ dedup
		const text = unit.members.map((member) => member.content).join(" ");
		const score = sharedWith(queryTokens, text);
		if (score <= 0) continue;
		const tokens = unit.members.reduce(
			(sum, member) => sum + Math.max(1, metaByTimestamp?.get(member.timestamp)?.tokenCount ?? member.tokenCount),
			0,
		);
		entries.push({ timestamp: first.timestamp, score, tokens, lines: unitLines(unit) });
	}
	return entries;
}

/** Greedy pick: rank-score desc / id asc, admit while within `budget` and `maxLines`. */
function admitRelevant(entries: RelevantEntry[], budget: number, maxLines: number): RelevantEntry[] {
	const { ranked, admitted } = packRanked(entries, budget);
	const picked: RelevantEntry[] = [];
	let lines = 0;
	for (let i = 0; i < ranked.length; i++) {
		if (!admitted[i]) continue;
		const entry = ranked[i];
		if (lines + entry.lines.length > maxLines) continue;
		picked.push(entry);
		lines += entry.lines.length;
	}
	return picked;
}

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
 *   [5] RELEVANT MEMORY (§2.6 lexical top-k vs `query`; omitted when nothing scores)
 *   [6] OBSERVATIONS (knapsack-packed belief units under RENDER_BUDGET_TOKENS;
 *       L6 fallback ⇒ chronological; supersession pairs adjacent)
 *   [7] STRATS (omitted when empty)
 *   [8] OPEN LOOPS — the recency anchor, always the LAST ## section (P3.1 gap markers
 *       are headingless warnings that trail it)
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
	// [8] UNOBSERVED WINDOW markers (P3.1, §2.4): attempts >= 2 only — attempts:0 gaps
	// render nothing (silent ack). Headingless warning lines trail the final section;
	// the §2.4 tail 're-read ledger lines X..Y' is omitted (line refs are unknowable
	// to this pure renderer). Computed early: a give-up warning is load-bearing (L5 —
	// "no silent holes"), so its presence alone defeats the all-empty early return.
	const unobserved = (input.gaps ?? [])
		.filter((gap) => gap.attempts >= 2)
		.map((gap) => `⚠ UNOBSERVED WINDOW [${gap.afterEntryId ?? "start"}..${gap.coversUpToId}]`);

	if (
		!stateBody &&
		!journeyText &&
		!mapText &&
		strats.length === 0 &&
		sorted.length === 0 &&
		unobserved.length === 0
	) {
		return { summary: "", packExplain: { fallback: false, lines: [] } };
	}

	const units = buildBeliefUnits(sorted, input.supersessions);
	const metaByTimestamp = input.observationMeta;
	// L6: absent or PARTIAL metadata ⇒ the WHOLE section renders in chronological order,
	// byte-identical to the P1 output — an upgrade can never regress old data.
	const fallback = sorted.some((observation) => !metaByTimestamp?.has(observation.timestamp));
	const budget = input.budget ?? RENDER_BUDGET_TOKENS;

	// §2.6 two-phase section [5] (Fix A exclude-then-cap): TOPIC/STATE candidates are [5]-only
	// and reserve budget FIRST — preserving P2b's "[5] counts first" priority (test (d)).
	// Observations are NOT reserved here: each renders once, either in [6] or as a [5] teaser
	// after [6] packs — so a deduped line never double-reserves budget (Fix A, second clause).
	const queryTokens =
		input.query && input.query.trim().length > 0 && identifierTokens(input.query).size > 0
			? identifierTokens(input.query)
			: undefined;
	const topicEntries = queryTokens ? scoreTopicEntries(queryTokens, input.candidates ?? []) : [];
	const reservedTopics = admitRelevant(topicEntries, budget, RELEVANT_TOP_K);
	const topicTokens = reservedTopics.reduce((sum, entry) => sum + entry.tokens, 0);

	let observationLines: string[];
	let packExplain: PackExplain;
	let admittedObservationIds: Set<string>;
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
		// The chronological fallback shows every observation ⇒ nothing may teaser-repeat in [5].
		admittedObservationIds = new Set(sorted.map((observation) => observation.timestamp));
	} else {
		// Complete metadata: greedy pack over belief UNITS — score desc (§2.2 score of the
		// unit's terminal winner), tie → earliest member timestamp asc (chronological). A
		// unit's cost is the SUM of its members' tokens, so a correction pair can never be
		// split by the budget (L4). The unit pass runs through packRanked — the SINGLE
		// admission loop shared with packKnapsack and section [5] (no drift, P2b Note 2).
		const meta = metaByTimestamp as Map<string, LineMeta>; // fallback===false ⇒ present & complete
		const rankedUnits = units.map((unit) => {
			const winner =
				unit.members.find((member) => member.timestamp === unit.terminal) ?? unit.members[unit.members.length - 1];
			return {
				timestamp: unit.members[0].timestamp, // tie-break: the unit's earliest member
				score: scoreLine(meta.get(winner.timestamp)!),
				tokens: unit.members.reduce((sum, member) => sum + (meta.get(member.timestamp)?.tokenCount ?? 0), 0),
				unit,
			};
		});
		// [6] packs against the budget the reserved topics left.
		const { ranked, admitted } = packRanked(rankedUnits, budget - topicTokens);
		observationLines = ranked.flatMap((entry, index) => (admitted[index] ? unitLines(entry.unit) : []));
		packExplain = {
			fallback: false,
			lines: ranked.flatMap((entry, index) =>
				entry.unit.members.map((member) => ({
					id: member.timestamp,
					score: entry.score, // the admission-determining score (unit's terminal winner)
					admitted: admitted[index],
					reason: (admitted[index] ? "packed" : "evicted-budget") as PackExplainReason,
				})),
			),
		};
		admittedObservationIds = new Set(
			ranked.flatMap((entry, index) =>
				admitted[index] ? entry.unit.members.map((member) => member.timestamp) : [],
			),
		);
	}

	// [5] teasers (§2.6 Option A): belief units [6] did NOT admit, scored against the query
	// and kept WHOLE (Fix B: believed:/now: partners adjacent, never a bare member).
	// TOKEN CHARGE: topics were already charged at reservation (they shrank [6] — test (d));
	// observation teasers are LINE-CAPPED ONLY (RELEVANT_TOP_K). Charging a teaser from the
	// leftover is the P3a defect — a unit evicted by [6] provably costs more than the leftover
	// it left, so [5] became structurally unreachable exactly when the budget was tight. The
	// parent-locked exemption keeps the exclude-then-cap order (Fix A): [6]-admitted units are
	// dropped at pool build (scoreTeaserEntries), then the COMBINED topics+teasers list is
	// ranked and line-capped here — a [6]-bound line never wastes a rank slot.
	const teaserEntries = queryTokens
		? scoreTeaserEntries(queryTokens, units, admittedObservationIds, metaByTimestamp)
		: [];
	const visibleRelevant = admitRelevant(
		[...reservedTopics, ...teaserEntries],
		Number.POSITIVE_INFINITY, // no token charge in this pass — the binding cap is the line cap
		RELEVANT_TOP_K,
	);

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
	// [5] RELEVANT MEMORY — §2.6 lexical top-k teaser (P2.5): lines that scored >0
	// against `query` and did NOT already make the [6] knapsack. Omitted when empty.
	if (visibleRelevant.length > 0) {
		parts.push(`## Relevant memory\n${visibleRelevant.flatMap((entry) => entry.lines).join("\n")}`);
	}
	// [6] OBSERVATIONS — knapsack-packed belief units (P2.3); L6 fallback ⇒ chronological.
	if (observationLines.length > 0) {
		parts.push(`## Observations\n${observationLines.join("\n")}`);
	}
	// [7] STRATS — omitted when the registry is empty.
	if (strats.length > 0) parts.push(`## Strats\n${renderStratLines(strats).join("\n")}`);
	// [8] OPEN LOOPS — recency anchor: the final ## section of the block.
	if (openLoops) parts.push(`## Open loops\n${openLoops}`);
	if (unobserved.length > 0) parts.push(unobserved.join("\n"));

	return { summary: parts.join("\n\n"), packExplain };
}
