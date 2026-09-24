import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logIfEnabled } from "../debug-log.js";
import { renderMemoryMap } from "../memory/index-render.js";
import { checkAnergy } from "../memory/anergy.js";
import { listStrats, listTopics, readJourney, readState } from "../memory/paths.js";
import { resolve } from "node:path";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	buildLineMeta,
	deriveProvenance,
	entryIndexById,
	extractOpenLoops,
	foldLedger,
	isObservationsRecordedEntry,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
	renderSummaryV2,
	type Entry,
	type FoldedLedger,
	type LineMeta,
	type ScoredLine,
	type StateDoc,
} from "../ledger/index.js";
import { estimateStringTokens } from "../tokens.js";
import type { Topic } from "../memory/paths.js";

/** Distinct, branch-resolved coversUpToId indices of committed observation chunks, ascending. */
function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to an observation chunk boundary so the verbatim tail
 * starts exactly where a chunk ends — no chunk straddles the cutoff, so nothing is both
 * rendered into the summary and kept verbatim (and nothing is lost). Among boundaries whose
 * next entry is a valid cut point, pick the one whose resulting tail is closest to
 * `tailTokens`. Falls back to pi's proposal when no boundary qualifies (`tail` undefined).
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	const boundaries = chunkBoundaryIndices(branch);
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function snapFirstKeptEntryId(branch: Entry[], proposedFirstKeptId: string, tailTokens: number): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens).firstKeptId;
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)` — see `buildCompactionProjection`'s `beforeEntry` boundary). Observers
 * working a chunk in the verbatim tail are excluded regardless, so waiting for them is dead time.
 *
 * Two conditions must hold for a truly no-op skip (identical block AND identical cutoff):
 *  1. No in-flight observer has `coversUpToId` strictly before the cutoff entry (none can enter
 *     the projection). Unresolved ids are treated conservatively as "before" → wait.
 *  2. The snapped cutoff's tail is already `<= tailTokens`. Then committing the (tail-region)
 *     skipped observers can only produce SMALLER tails (further from target), so the snap is
 *     provably stable. If the tail is `> tailTokens` (nothing committed near the tip), a
 *     just-committed tail boundary could become a better snap target — so we wait, which also
 *     yields a tighter tail.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

/**
 * P2.3 — per-observation LineMeta for the section [6] knapsack, derived with zero
 * persisted state. An observation enters the map only when it carries full v2
 * metadata (kind + a sourceEntryId resolving in this branch); renderSummaryV2
 * treats ANY missing entry as the L6 trigger and renders the whole pack
 * chronologically — never a half-packed hybrid. Provenance is re-derived at the
 * boundary from the anchored source entry (L1): the class depends only on that
 * entry's role, so a one-entry slice is exact.
 */
export function buildPackMeta(branch: Entry[], folded: FoldedLedger): Map<string, LineMeta> {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const meta = new Map<string, LineMeta>();
	for (const observation of folded.observations) {
		if (!observation.kind || !observation.sourceEntryId) continue;
		const source = byId.get(observation.sourceEntryId);
		if (!source) continue;
		const { provenance } = deriveProvenance([source], observation.timestamp);
		meta.set(observation.timestamp, buildLineMeta(folded, observation, provenance));
	}
	return meta;
}

/**
 * P2.5 — §2.6 query cap: the last user instruction is bounded before it reaches the
 * renderer (a 200k-token pasted log must not become the query).
 */
export const QUERY_MAX_CHARS = 2_000;

function entryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/**
 * P2.5 — §2.6 query: the LAST user/custom_message content on the branch, newest
 * first so the freshest instruction wins. Hidden `om.*` synthetic messages (the
 * compaction resume prompt, bridges) are skipped — they are the system's own
 * voice, not the user's current ask. Bounded to `QUERY_MAX_CHARS`.
 */
export function lastUserQuery(branch: Entry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry) continue;
		if (entry.type === "custom_message") {
			if (typeof entry.customType === "string" && entry.customType.startsWith("om.")) continue;
			const text = entryText(entry.content);
			if (text.trim()) return text.slice(0, QUERY_MAX_CHARS);
			continue;
		}
		if (entry.type === "message" && entry.message) {
			const message = entry.message as { role?: string; content?: unknown };
			if (message.role !== "user") continue;
			const text = entryText(message.content);
			if (text.trim()) return text.slice(0, QUERY_MAX_CHARS);
		}
	}
	return undefined;
}

/**
 * P2.5 — §2.6 candidate pool: topic summaries + STATE lines, built HERE so the
 * renderer stays pure (all IO at the boundary). `meta.tokenCount` is the
 * code-computed estimate; the other LineMeta fields are informational defaults —
 * §2.6 relevance ignores them and scores purely lexically against the query.
 */
export function buildRelevantCandidates(state: StateDoc | undefined, topics: Topic[]): ScoredLine[] {
	const syntheticMeta = (text: string): LineMeta => ({
		kind: "event",
		provenance: "model-distilled",
		supersessionCount: 0,
		ageCompactions: 0,
		tokenCount: estimateStringTokens(text),
	});
	const candidates: ScoredLine[] = [];
	if (state) {
		state.body.split("\n").forEach((line, index) => {
			const text = line.trim();
			if (!text) return;
			candidates.push({ id: `state:${index}`, text, meta: syntheticMeta(text) });
		});
	}
	for (const topic of topics) {
		if (!topic.summary) continue;
		candidates.push({ id: `topic:${topic.path}`, text: topic.summary, meta: syntheticMeta(topic.summary) });
	}
	return candidates;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		const hasUI = ctx.hasUI;
		if (runtime.compactHookInFlight) {
			if (hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const tailTokens = runtime.config.tailTokens;
			const { firstKeptEntryId, tokensBefore } = event.preparation;

			// Compute the snap from the CURRENT (pre-wait) branch. The snap only reads committed
			// chunk boundaries (fixed at hook entry), so this is safe to do before any wait and lets
			// us decide whether the wait is needed at all.
			let branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			let snap = snapCutoff(branch, firstKeptEntryId, tailTokens);

			// R5 fast path: skip the wait when no in-flight observer can affect this compaction
			// (its chunk lands in the verbatim tail and the snap is stable). Otherwise wait for
			// observers to settle, then re-read the branch and recompute the snap so just-committed
			// `om.observations.recorded` entries are folded (pi's `event.branchEntries` is stale).
			const skip = canSkipObserverWait(branch, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
			runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
			if (!skip) {
				if (hasUI) ctx.ui.notify("om: waiting for in-flight observers before folding…", "info");
				await runtime.whenObserversIdle();
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens);
			}

			const snapped = snap.firstKeptId;
			logIfEnabled(runtime.config.debugLog, "compaction.snap", {
				firstKeptId: snapped,
				tail: snap.tail,
				observerWait: runtime.lastCompactionObserverWait,
				tokensBefore,
			});
			const projection = buildCompactionProjection(branch, snapped);
			// Phase B: render the long-term tier live from disk, regenerated each compaction
			// (throwaway projections — cannot decay). STATE is the forward-looking task state
			// (P1.5), JOURNEY the descriptive arc, the map the topic-file index.
			const state = readState(runtime.memoryRoot);
			const journey = readJourney(runtime.memoryRoot);
			// Anergy: model-free memory-vs-repo drift check, recomputed per render and never
			// persisted. On-disk topic files stay untouched — only this injected map flags drift.
			const topics = listTopics(runtime.memoryRoot);
			const anergy = checkAnergy(topics, resolve(runtime.memoryRoot, "..", ".."), projection.observations);
			const map = renderMemoryMap(topics, anergy);
			// §2.3 block layout via renderSummaryV2 (P2.3: knapsack-packed, L6 fallback).
			// Supersession pairs come from the FULL-branch fold: belief units only pair
			// entries that are both present in the projection, so a winner outside the
			// cutoff degrades the loser to a plain line instead of stranding it (L4-safe).
			// P2.5: §2.6 relevance — query + candidates captured here (render stays pure).
			const folded = foldLedger(branch);
			const observationMeta = buildPackMeta(branch, folded);
			const query = lastUserQuery(branch);
			const candidates = buildRelevantCandidates(state, topics);
			const { summary, packExplain } = renderSummaryV2({
				state,
				journey,
				map,
				query,
				candidates,
				observations: projection.observations,
				supersessions: folded.supersessions,
				observationMeta,
				strats: listStrats(runtime.memoryRoot),
				openLoops: state ? extractOpenLoops(state.body) : undefined,
			});
			logIfEnabled(runtime.config.debugLog, "render.pack", {
				fallback: packExplain.fallback,
				admitted: packExplain.lines.filter((line) => line.admitted).length,
				evicted: packExplain.lines.filter((line) => !line.admitted).length,
				lines: packExplain.lines,
			});

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
