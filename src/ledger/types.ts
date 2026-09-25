/**
 * Ledger custom-type vocabulary for observational memory (v1, minimal schema).
 *
 * Trimmed from OM V3: the reflections tier, the `relevance` field, `sourceEntryIds`,
 * content-hash ids, and the usage tier are all gone. An observation is the minimal
 * `{ timestamp, content, tokenCount }`; the precise event-`timestamp` doubles as the id
 * (the orchestrator guarantees uniqueness at commit — see ../ids.ts).
 */

/** Observer output committed by the orchestrator; the buffer tier. */
export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
/** Promotion tombstones written by the orchestrator after a consolidator run (Phase B). */
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** Compaction details type stamped into the compaction entry's `details`. */
export const OM_FOLDED = "om.folded";
/** Per-session on/off gate state (default OFF). See src/index.ts. */
export const OM_ENABLED = "om.enabled";
/**
 * Per-worker cost record (one per finished worker run). The orchestrator appends these from
 * pi's built-in `usage.cost.total`, reported back by the worker extension via the cost file.
 * Summed across the WHOLE session (every branch), so spend never rolls back under /tree.
 */
export const OM_COST = "om.cost";
/**
 * Synthetic continuation message used to resume the agent loop after a mid-run compaction
 * (a `turn_end` that was NOT the run's terminal turn). Carried as a `role: "custom"` message
 * with `display: false` so it is hidden from the human TUI; pi still surfaces it to the model
 * as a user-role turn (convertToLlm rewrites custom → user). See hooks/compaction-trigger.ts.
 */
export const OM_RESUME = "om.resume";
/**
 * Supersession pairs written by the orchestrator at commit when the deterministic lexical
 * detector (src/ledger/supersede.ts, P1.3) finds a newer fact that overtakes an older one.
 * Corrections are never deletions (L4): both members stay in the buffer and render adjacent.
 */
export const OM_OBSERVATIONS_SUPERSEDED = "om.observations.superseded";
/**
 * Chunk-coverage gap markers (§2.4, P3.1) — the no-silent-holes contract (L5):
 * - `attempts: 0`: a clean zero-observation chunk — semantically "acknowledged, nothing to
 *   record" (the validator forbids empty `recorded` entries). Silent in render.
 * - `attempts: 2`: the give-up marker after the bounded retry budget (L9); renders as an
 *   `⚠ UNOBSERVED WINDOW` line.
 * Either way a gap IS an ack for the flush-ack gate (P3.2): its `coversUpToId` covers the
 * chunk range `[afterEntryId .. coversUpToId]`.
 */
export const OM_OBSERVATIONS_GAP = "om.observations.gap";

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

/**
 * Minimal observation unit (decision 9 / L5, extended v2 in P1.1).
 * - `timestamp`: the orchestrator-assigned precise, unique id-timestamp
 *   ("YYYY-MM-DDTHH:MM:SS" with an optional ".NN" disambiguator). Doubles as the id.
 * - `content`: single-line plain prose.
 * - `tokenCount`: computed in code (never by the model).
 * - `kind`: v2 semantic type (optional; v1 entries have none and read as "event" — C5).
 * - `sourceEntryId`: v2 provenance anchor assigned at commit by deriveProvenance (L1).
 */
export const OBSERVATION_KINDS = [
	"assertion",
	"decision",
	"completion",
	"preference",
	"event",
	"question",
	"rejected",
	"strat",
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Where an observation's content came from, derived at the extension boundary from the
 * bounding source entry's role (L1) — never labeled by an LLM.
 */
export type ProvenanceClass = "user-asserted" | "tool-derived" | "model-distilled";

export type Observation = {
	timestamp: string;
	content: string;
	tokenCount: number;
	kind?: ObservationKind;
	sourceEntryId?: string;
};

export function isObservationKind(value: unknown): value is ObservationKind {
	return typeof value === "string" && (OBSERVATION_KINDS as readonly string[]).includes(value);
}

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
	observationTimestamps: string[];
	coversUpToId: string;
};

/** One `believed X → now Y` correction (L4: the losing fact is preserved, never rewritten). */
export type SupersessionPair = {
	oldTimestamp: string;
	newTimestamp: string;
	reason: "lexical-supersession";
};

export type ObservationsSupersededEntryData = {
	pairs: SupersessionPair[];
	coversUpToId: string;
};

export type ObservationsGapEntryData = {
	/** Chunk start (previous coverage marker). Absent for the very first chunk. */
	afterEntryId?: string;
	/** Chunk end — the coverage marker (inclusive), same semantics as recorded entries. */
	coversUpToId: string;
	/** 0 = clean empty chunk (silent ack); 2 = retry budget exhausted (give-up). */
	attempts: number;
	lastError?: string;
};

/** §2.3 render input alias — `gaps: Gap[]` (fold exposes these in branch order). */
export type Gap = ObservationsGapEntryData;

export type CostEntryData = {
	costUsd: number;
	role: "observer" | "consolidator";
	runId: string;
};

/** Stamped into the compaction entry's `details` so a future visible projection can read it back. */
export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	observations: Observation[];
};

export type MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED
	| typeof OM_OBSERVATIONS_GAP;

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	// Optional v2 fields validate strictly WHEN PRESENT (invalid ⇒ whole record rejected);
	// absent fields keep v1 entries valid (C5 backward compat).
	if (value.kind !== undefined && !isObservationKind(value.kind)) return false;
	if (value.sourceEntryId !== undefined && !isNonEmptyString(value.sourceEntryId)) return false;
	return (
		isNonEmptyString(value.timestamp) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationTimestamps) && isNonEmptyString(value.coversUpToId);
}

export function isSupersessionPair(value: unknown): value is SupersessionPair {
	if (!isPlainRecord(value)) return false;
	return (
		isNonEmptyString(value.oldTimestamp) &&
		isNonEmptyString(value.newTimestamp) &&
		value.reason === "lexical-supersession"
	);
}

export function isObservationsSupersededData(value: unknown): value is ObservationsSupersededEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.pairs) &&
		value.pairs.length > 0 &&
		value.pairs.every(isSupersessionPair) &&
		isNonEmptyString(value.coversUpToId)
	);
}

/** Strict-when-present, lenient-when-absent (C5): optional fields validate only if given. */
export function isObservationsGapData(value: unknown): value is ObservationsGapEntryData {
	if (!isPlainRecord(value)) return false;
	if (value.afterEntryId !== undefined && !isNonEmptyString(value.afterEntryId)) return false;
	if (value.lastError !== undefined && typeof value.lastError !== "string") return false;
	return (
		isNonEmptyString(value.coversUpToId) &&
		typeof value.attempts === "number" &&
		Number.isInteger(value.attempts) &&
		value.attempts >= 0
	);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation)
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isCostEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_COST;
	data: CostEntryData;
} {
	if (entry.type !== "custom" || entry.customType !== OM_COST) return false;
	const data = entry.data as Record<string, unknown> | undefined;
	return !!data && typeof data.costUsd === "number" && Number.isFinite(data.costUsd as number) && (data.costUsd as number) >= 0;
}

/**
 * Sum every `om.cost` entry across the WHOLE session. Callers MUST pass all entries
 * (`getEntries()`), NOT a single branch (`getBranch()`): counting every branch is what makes
 * real spend monotonic — it never decreases when /tree navigates onto another branch.
 */
export function sumSessionCost(allEntries: Entry[]): { costUsd: number; runs: number } {
	let costUsd = 0;
	let runs = 0;
	for (const entry of allEntries) {
		if (isCostEntry(entry)) {
			costUsd += (entry.data as CostEntryData).costUsd;
			runs += 1;
		}
	}
	return { costUsd, runs };
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function isObservationsSupersededEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_SUPERSEDED;
	data: ObservationsSupersededEntryData;
} {
	return (
		entry.type === "custom" &&
		entry.customType === OM_OBSERVATIONS_SUPERSEDED &&
		isObservationsSupersededData(entry.data)
	);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observations, coversUpToId };
}

export function buildObservationsDroppedData(
	observationTimestamps: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationTimestamps.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationTimestamps, coversUpToId };
}

export function buildObservationsSupersededData(
	pairs: SupersessionPair[],
	coversUpToId: string,
): ObservationsSupersededEntryData | undefined {
	if (pairs.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { pairs, coversUpToId };
}
