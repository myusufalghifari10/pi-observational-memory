import type { Observation } from "./types.js";

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
// renderSummaryV2 — the §2.3 block layout (P1.5: CHRONOLOGICAL packing mode).
//
// Seams left for later phases by the P1.5 contract:
//   [5] RELEVANT MEMORY — P2.5 packs lexical candidates here (section omitted now).
//   [6] packing          — P2.3 replaces chronological order with the knapsack and
//                          changes this function's return to { summary, packExplain }
//                          (TODO(P2.3)).
//   [8] UNOBSERVED WINDOW markers — P3.1 appends them from `om.observations.gap`
//                          entries (attempts >= 2); render NOTHING for gaps now
//                          (TODO(P3.1)).
//
// C3 still holds: every input below is durable state handed in by the caller — no
// clock, no randomness, no I/O — so identical input yields byte-identical output.
// ─────────────────────────────────────────────────────────────────────────────

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
	// [5] TODO(P2.5): candidates + budget for RELEVANT MEMORY.
	/** [6] Active observations, rendered in today's chronological order. */
	observations: Observation[];
	/** fold.supersessions — losing ts → winning ts; renders believed/now pairs (L4). */
	supersessions?: Map<string, string>;
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
 * Section [6] in chronological order, with corrections rendered adjacent (L4: every losing
 * fact is preserved, never deleted).
 *
 * Corrections form CHAINS across batches — the detector intentionally lets a prior winner be
 * superseded again (`a→b→c`, the plan's PostgreSQL→MySQL→SQLite scenario), and one winner can
 * absorb several losers (`a→c, b→c`). This renderer therefore groups each connected component:
 * every observation is walked along its present-in-both edges to its terminal winner, and the
 * whole group is emitted at its earliest member's chronological slot — all members labelled
 * `believed:` except the terminal winner, which gets `now:`. Every fact appears exactly once.
 *
 * Degradations (both deterministic, both loss-free):
 * - groups of one — no in-projection edge, including a loser whose winner sits outside the
 *   projection (e.g. in the verbatim tail) — render as a plain chronological line;
 * - malformed cycles (impossible in practice: each correction's winner is the newer batch)
 *   render every reachable member as a plain line — no fact is lost, no loop can spin.
 */
function renderObservationLines(sorted: Observation[], supersessions?: Map<string, string>): string[] {
	if (!supersessions || supersessions.size === 0) return sorted.map(observationToLine);
	const present = new Set(sorted.map((o) => o.timestamp));
	// Chain edges restricted to pairs whose BOTH ends are in the rendered set (a winner
	// outside the projection must degrade its loser to a plain line, not strand it).
	const nextOf = new Map<string, string>();
	for (const [oldTimestamp, newTimestamp] of supersessions) {
		if (present.has(oldTimestamp) && present.has(newTimestamp)) nextOf.set(oldTimestamp, newTimestamp);
	}
	if (nextOf.size === 0) return sorted.map(observationToLine);

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

	// Group members by terminal winner, in chronological order (iterate `sorted`).
	const groups = new Map<string, string[]>();
	for (const observation of sorted) {
		const terminal = terminalOf.get(observation.timestamp);
		if (terminal === undefined) continue;
		const group = groups.get(terminal) ?? [];
		group.push(observation.timestamp);
		groups.set(terminal, group);
	}

	const byTimestamp = new Map(sorted.map((o) => [o.timestamp, o]));
	const lines: string[] = [];
	const emitted = new Set<string>();
	for (const observation of sorted) {
		const ts = observation.timestamp;
		if (emitted.has(ts)) continue;
		const terminal = terminalOf.get(ts);
		const group = terminal === undefined ? undefined : groups.get(terminal);
		if (!group || group.length === 1) {
			// Singleton (no in-projection edge) or cycle member: plain chronological line.
			lines.push(observationToLine(observation));
			emitted.add(ts);
			continue;
		}
		// Whole belief group, chronological: every member `believed:` except the winner.
		for (const memberTs of group) {
			const member = byTimestamp.get(memberTs);
			if (!member) continue; // defensive: groups are built from `sorted`
			lines.push(
				memberTs === terminal
					? `${member.timestamp}  now: ${member.content}`
					: `${member.timestamp}  believed: ${member.content}`,
			);
			emitted.add(memberTs);
		}
	}
	return lines;
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
 *   [6] OBSERVATIONS (chronological at P1.5; supersession pairs adjacent)
 *   [7] STRATS (omitted when empty)
 *   [8] OPEN LOOPS — the recency anchor, always the LAST section (P3.1 gap markers append here)
 *
 * Every section except [1] is omitted wholesale when empty, so an all-empty input returns ""
 * (delegating to pi's native summarizer, as v1 did).
 */
export function renderSummaryV2(input: RenderSummaryV2Input): string {
	const observations = input.observations ?? [];
	const sorted = sortObservations(observations);
	const strats = input.strats ?? [];
	const stateBody = input.state?.body.trim();
	const journeyText = input.journey?.trim();
	const mapText = input.map?.trim();
	const openLoops = input.openLoops?.trim();

	if (!stateBody && !journeyText && !mapText && strats.length === 0 && sorted.length === 0) return "";

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
	// [5] TODO(P2.5): RELEVANT MEMORY — lexical top-k candidates against the last user
	// instruction; section omitted at P1.5 by contract.
	// [6] OBSERVATIONS — chronological at P1.5; knapsack from P2.3.
	if (sorted.length > 0) {
		parts.push(`## Observations\n${renderObservationLines(sorted, input.supersessions).join("\n")}`);
	}
	// [7] STRATS — omitted when the registry is empty.
	if (strats.length > 0) parts.push(`## Strats\n${renderStratLines(strats).join("\n")}`);
	// [8] OPEN LOOPS — recency anchor: must be the block's final section.
	// TODO(P3.1): append `⚠ UNOBSERVED WINDOW [idA..idB]` markers from om.observations.gap
	// entries (attempts >= 2) right after this section; render nothing for gaps until then.
	if (openLoops) parts.push(`## Open loops\n${openLoops}`);

	return parts.join("\n\n");
}
