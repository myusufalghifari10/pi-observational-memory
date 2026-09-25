import { estimateEntryTokens } from "../tokens.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_GAP,
	OM_OBSERVATIONS_RECORDED,
	type Entry,
	type MemoryCustomType,
	type ObservationsGapEntryData,
	type ProvenanceClass,
	isObservationsDroppedEntry,
	isObservationsGapData,
	isObservationsRecordedEntry,
	isObservationsSupersededEntry,
} from "./types.js";

const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

export function isSourceEntry(entry: Entry): boolean {
	return SOURCE_ENTRY_TYPES.has(entry.type);
}

/**
 * A source entry is a valid chunk/compaction boundary only if it can legitimately START a
 * chunk — i.e. it is not a tool-result message. In pi a tool call (an assistant message) and
 * its result(s) are SEPARATE source entries; a boundary placed between them would split a
 * tool call from its result across two chunks. Anchoring boundaries to non-tool-result entries
 * keeps every tool call together with its result in the same chunk (and the same verbatim tail
 * at compaction). Shared by `selectSourceSlice` (chunk cutting) and the compaction snapper.
 */
export function isValidCutPoint(entry: Entry): boolean {
	if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
	if (entry.type === "message") {
		const role = (entry.message as { role?: string } | undefined)?.role;
		return role === "user" || role === "assistant";
	}
	return false;
}

/** Id of the last source entry on the branch (the tip). Tombstone `coversUpToId` anchor. */
export function lastSourceEntryId(entries: Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isSourceEntry(entries[i])) return entries[i].id;
	}
	return undefined;
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

/**
 * Local minute key ("YYYY-MM-DDTHH:MM") for any parseable timestamp — entry instants and
 * naive-local id timestamps land in the same coordinate space, so comparisons are
 * timezone-safe without any Date arithmetic across offsets.
 */
function localMinuteKey(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return undefined;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Role → provenance class (L1). Anything message-like and not user/assistant is a tool result. */
function provenanceOf(entry: Entry): ProvenanceClass {
	if (entry.type === "custom_message") return "user-asserted";
	if (entry.type === "message") {
		const role = (entry.message as { role?: string } | undefined)?.role;
		if (role === "user") return "user-asserted";
		if (role === "assistant") return "model-distilled";
		return "tool-derived";
	}
	return "model-distilled"; // branch_summary (model-generated) and anything else
}

/**
 * L1 — provenance is derived at the extension boundary, never labeled by an LLM.
 *
 * The bounding source entry is the LAST source entry of the slice whose minute is at or
 * before the observation's minute-resolution base time; when the observation is after every
 * entry (chunk fallback anchor) the slice's last source entry bounds it. Minute bucketing (not
 * second) matters: the observer copies source minutes verbatim ("[User @ … 14:30]"), so the
 * true source entry usually carries seconds INSIDE the observation's minute and must still win.
 *
 * Deterministic, pure, no I/O — safe on the render and commit paths alike.
 */
export function deriveProvenance(
	slice: Entry[],
	obsTimestamp: string,
): { sourceEntryId: string; provenance: ProvenanceClass } {
	const sourceEntries = slice.filter(isSourceEntry);
	const last = sourceEntries[sourceEntries.length - 1];
	const obsMinute = localMinuteKey(obsTimestamp);

	let bounding: Entry | undefined;
	if (obsMinute !== undefined) {
		for (const entry of sourceEntries) {
			const entryMinute = localMinuteKey(entry.timestamp);
			if (entryMinute === undefined || entryMinute > obsMinute) continue;
			bounding = entry;
		}
	}
	bounding = bounding ?? last ?? slice[slice.length - 1];
	if (!bounding) return { sourceEntryId: "", provenance: "model-distilled" };
	return { sourceEntryId: bounding.id, provenance: provenanceOf(bounding) };
}

export function entryIndexById(entries: Entry[]): Map<string, number> {
	const idToIndex = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) idToIndex.set(entries[i].id, i);
	return idToIndex;
}

export function entryIndexForId(entries: Entry[], entryId: string | undefined): number {
	if (!entryId) return -1;
	const idx = entryIndexById(entries).get(entryId);
	return idx ?? -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0;
}

function isValidCoverageEntry(entry: Entry, customType: MemoryCustomType): entry is Entry & { data: { coversUpToId: string } } {
	if (entry.type !== "custom" || entry.customType !== customType) return false;
	if (!isObject(entry.data) || typeof entry.data.coversUpToId !== "string") return false;

	if (customType === OM_OBSERVATIONS_RECORDED) return isNonEmptyArray(entry.data.observations);
	return isNonEmptyArray(entry.data.observationTimestamps);
}

export function latestCoverageIndex(entries: Entry[], customType: MemoryCustomType): number {
	const idToIndex = entryIndexById(entries);
	let latest = -1;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latest) latest = coveredIndex;
	}

	return latest;
}

export function latestCoverageMarkerId(entries: Entry[], customType: MemoryCustomType): string | undefined {
	const idToIndex = entryIndexById(entries);
	let latestIndex = -1;
	let latestMarkerId: string | undefined;

	for (const entry of entries) {
		if (!isValidCoverageEntry(entry, customType)) continue;
		const coveredIndex = idToIndex.get(entry.data.coversUpToId);
		if (coveredIndex === undefined) continue;
		if (coveredIndex > latestIndex) {
			latestIndex = coveredIndex;
			latestMarkerId = entry.data.coversUpToId;
		}
	}

	return latestMarkerId;
}

export function earlierCoverageMarkerId(
	entries: Entry[],
	firstId: string | undefined,
	secondId: string | undefined,
): string | undefined {
	if (!firstId) return secondId;
	if (!secondId) return firstId;

	const idToIndex = entryIndexById(entries);
	const firstIndex = idToIndex.get(firstId);
	const secondIndex = idToIndex.get(secondId);
	if (firstIndex === undefined) return secondIndex === undefined ? undefined : secondId;
	if (secondIndex === undefined) return firstId;
	return firstIndex <= secondIndex ? firstId : secondId;
}

export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}

export function rawTokensSinceCoverage(entries: Entry[], customType: MemoryCustomType): number {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}

export function rawTokensSinceObservationCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_RECORDED);
}

export function rawTokensSinceDropCoverage(entries: Entry[]): number {
	return rawTokensSinceCoverage(entries, OM_OBSERVATIONS_DROPPED);
}

function isGapEntry(entry: Entry): entry is Entry & { data: ObservationsGapEntryData } {
	return (
		entry.type === "custom" && entry.customType === OM_OBSERVATIONS_GAP && isObservationsGapData(entry.data)
	);
}

/** All coverage-bearing om.* entries (recorded/dropped/superseded/gap): boundary CANDIDATES. */
function coverageCoversUpToId(entry: Entry): string | undefined {
	if (isGapEntry(entry)) return entry.data.coversUpToId;
	if (isObservationsRecordedEntry(entry) || isObservationsDroppedEntry(entry) || isObservationsSupersededEntry(entry)) {
		return entry.data.coversUpToId;
	}
	return undefined;
}

/** Flush evidence: an om.observations.recorded or om.observations.gap commit (§2.4). */
function isFlushAckSource(entry: Entry): boolean {
	return isObservationsRecordedEntry(entry) || isGapEntry(entry);
}

/**
 * P3.2 flush-ack gate (§2.4) — eligible snap boundaries, ascending.
 *
 * Candidates = branch-resolved coversUpToId of EVERY coverage-bearing om.* entry, then
 * filtered: a boundary is eligible only when flush-acked by an om.observations.recorded
 * or om.observations.gap entry covering EXACTLY it. Dropped/superseded coverage is the
 * consolidator's watermark — bookkeeping, never flush evidence — and any future
 * coverage source is gated by construction: compaction can never snap (and thereby
 * evict) a chunk the observers never committed or acknowledged.
 */
export function ackedChunkBoundaryIndices(entries: Entry[]): number[] {
	const indexes = entryIndexById(entries);
	const candidates = new Set<number>();
	const acked = new Set<number>();
	for (const entry of entries) {
		const covers = coverageCoversUpToId(entry);
		if (covers === undefined) continue;
		const idx = indexes.get(covers);
		if (idx === undefined) continue;
		candidates.add(idx);
		if (isFlushAckSource(entry)) acked.add(idx);
	}
	return Array.from(candidates)
		.filter((idx) => acked.has(idx))
		.sort((a, b) => a - b);
}

export function findLastCompactionIndex(entries: Entry[]): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") return i;
	}
	return -1;
}

export function rawTokensSinceLastCompaction(entries: Entry[]): number {
	const compactionIndex = findLastCompactionIndex(entries);
	if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);

	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);

	if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex);
	return rawTokensAfterIndex(entries, firstKeptIndex - 1);
}

export type SourceSlice = {
	entries: Entry[];
	/** Id of the last source entry in the slice → the chunk's `coversUpToId` watermark. */
	coversUpToId: string | undefined;
	tokens: number;
};

/**
 * Select the next observation chunk: the source entries strictly after `afterEntryId`
 * (the latest covered watermark), accumulated until adding the next entry would exceed
 * `chunkTokens`. Always includes at least one source entry so progress never stalls on a
 * single oversized entry. Non-source entries (ledger records, compaction) are skipped.
 *
 * The cut only lands on a valid boundary (`isValidCutPoint`): a chunk never ends with a tool
 * call whose result is a separate, later entry. When the token budget is reached but the next
 * entry is a tool result, the slice keeps extending past the budget until it reaches an entry
 * that may legitimately start the next chunk — so tool calls and their results always stay in
 * the same chunk.
 */
export function selectSourceSlice(entries: Entry[], afterEntryId: string | undefined, chunkTokens: number): SourceSlice {
	const startIndex = afterEntryId ? entryIndexForId(entries, afterEntryId) : -1;
	const slice: Entry[] = [];
	let tokens = 0;
	let coversUpToId: string | undefined;

	for (let i = Math.max(0, startIndex + 1); i < entries.length; i++) {
		const entry = entries[i];
		if (!isSourceEntry(entry)) continue;
		const entryTokens = estimateEntryTokens(entry);
		// Break only when over budget AND `entry` could legitimately start the next chunk.
		// If `entry` is a tool result, breaking here would orphan it from its tool call in the
		// previous chunk, so keep extending instead.
		if (slice.length > 0 && tokens + entryTokens > chunkTokens && isValidCutPoint(entry)) break;
		slice.push(entry);
		tokens += entryTokens;
		coversUpToId = entry.id;
	}

	return { entries: slice, coversUpToId, tokens };
}
