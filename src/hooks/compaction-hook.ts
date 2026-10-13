import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logIfEnabled } from "../debug-log.js";
import { renderMemoryMap } from "../memory/index-render.js";
import { checkAnergy } from "../memory/anergy.js";
import { listStrats, listTopics, parseDeaths, readDeaths, readJourney, readState } from "../memory/paths.js";
import { resolve } from "node:path";
import type { Runtime } from "../runtime.js";
import {
	ackedChunkBoundaryIndices,
	buildCompactionProjection,
	buildLineMeta,
	deriveProvenance,
	entryIndexById,
	extractOpenLoops,
	foldLedger,
	isSourceEntry,
	isValidCutPoint,
	poolTokens,
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
import { evaluateConsolidatorTrigger } from "./consolidator-trigger.js";
import { pumpWorkerQueue } from "./observer-trigger.js";

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to a FLUSH-ACKED observation chunk boundary so
 * the verbatim tail starts exactly where an acknowledged chunk ends — no chunk straddles
 * the cutoff, and (P3.2 gate, §2.4) no unflushed chunk can be evicted: boundaries without
 * a recorded/gap commit covering them are ineligible. Among eligible boundaries whose next
 * entry is a valid cut point, pick the one whose resulting tail is closest to `tailTokens`.
 * Falls back to pi's proposed cutoff ONLY when no acked boundary qualifies.
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	const boundaries = ackedChunkBoundaryIndices(branch);
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
		// S2: the barrier spans this whole hook — observers settle, then (if the pool is due) the
		// consolidator runs, then the render. Observer dispatch yields for its whole duration.
		runtime.compactionBarrier = true;
		const barrierAt = Date.now();
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
			// (its chunk lands in the verbatim tail and the snap is stable) — but NEVER while a
			// consolidation is in flight: its staged generation has not been promoted yet, so the
			// durable files this render reads are still mid-update. Otherwise wait for the workers to
			// settle, then re-read the branch and recompute the snap so just-committed
			// `om.observations.recorded` entries are folded (pi's `event.branchEntries` is stale).
			const skip =
				!runtime.consolidatorInFlight &&
				canSkipObserverWait(branch, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
			runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
			if (!skip) {
				if (hasUI) {
					ctx.ui.notify(
						runtime.consolidatorInFlight
							? "om: waiting for in-flight observers and the running consolidation before folding…"
							: "om: waiting for in-flight observers before folding…",
						"info",
					);
				}
				await runtime.whenWorkersIdle();
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens);
			}

			// S2: the barrier DRIVES the consolidator — waiting alone would deadlock, because the
			// dispatcher runs on turn_end/agent_start and pi is blocked in this hook until it returns.
			// The pool clock alone decides whether one is due (a manual /om:compact still gets settled
			// observers, just without forcing a consolidation).
			const observerWaitMs = Date.now() - barrierAt;
			let consolidationMs: number | undefined;
			const poolIsDue = (): boolean =>
				poolTokens(foldLedger(branch).activeObservations) >= runtime.config.consolidateAtPoolTokens;
			// A consolidation rewrote the durable files (and drained the pool): re-read the branch so the
			// snap + projection render the post-consolidation state.
			const resnap = (): void => {
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens);
			};
			if (poolIsDue()) {
				const consolidationAt = Date.now();
				// `allowDuringBarrier`: this hook IS the barrier and owns the ordering; background pumps
				// (which honour the barrier) must never start a second staged run in the await gap below.
				evaluateConsolidatorTrigger(pi, runtime, ctx, { allowDuringBarrier: true });
				await runtime.whenConsolidatorIdle();
				resnap();

				// #11 (owner decision): a consolidation that FAILED while this barrier was pending earns
				// exactly ONE retry, and the render happens whatever the outcome — a worker failure must
				// never cost the user the compaction that is already in flight. A failure on the BACKGROUND
				// path is the opposite: no retry, no compaction (the batch just stays re-foldable).
				// Bounded by construction: a single `if` — never a loop — and skipped entirely while the
				// pipeline is paused, because the trigger would no-op and the notice would lie
				// (manual recovery lives in /om:consolidate and /om:observer).
				if (!runtime.pipelinePaused && runtime.lastConsolidation?.ok === false && poolIsDue()) {
					if (hasUI) ctx.ui.notify("om: consolidation failed — retrying once before folding…", "warning");
					runtime.lastConsolidation = undefined; // the retry's own outcome is what the reads below see
					evaluateConsolidatorTrigger(pi, runtime, ctx, { allowDuringBarrier: true });
					await runtime.whenConsolidatorIdle();
					resnap();
				}
				consolidationMs = Date.now() - consolidationAt;
			}
			runtime.lastBarrier = {
				at: barrierAt,
				observerWaitMs,
				consolidationMs,
				// S6 (audit N2): only a consolidation of THIS barrier has a promote outcome to report —
				// otherwise /om:status would show the result of some earlier run.
				promote: consolidationMs === undefined ? undefined : runtime.lastPromote,
			};
			logIfEnabled(runtime.config.debugLog, "compaction.barrier", {
				observerWaitMs,
				consolidationMs: consolidationMs ?? null,
				promote: runtime.lastPromote ?? null,
			});

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
			const projectCwd = resolve(runtime.memoryRoot, "..", "..");
			const anergy = checkAnergy(topics, projectCwd, projection.observations);
			// P4.1: DEATHS.md lines join section [4]; `(verify:)` failures demote to a
			// possibly-revived stub (L11 — render never touches the file itself).
			const deathBody = readDeaths(runtime.memoryRoot);
			const deaths = deathBody ? { entries: parseDeaths(deathBody), projectCwd } : undefined;
			const map = renderMemoryMap(topics, anergy, deaths);
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
				// P3.1: gap entries feed the [8] UNOBSERVED WINDOW markers (attempts:2)
				// and stay silent for attempts:0 (§2.4). End-to-end wiring — without this
				// line the markers are unreachable from the production render path.
				gaps: folded.gaps,
				observationMeta,
				strats: listStrats(runtime.memoryRoot),
				openLoops: state ? extractOpenLoops(state.body) : undefined,
			});
			// P5.2: derive the pack counts once — the debugLog event AND the details.render
			// stamp read the same numbers (the stamp is what /om:status surfaces later).
			const packedCount = packExplain.lines.filter((line) => line.admitted).length;
			const evictedCount = packExplain.lines.length - packedCount;
			logIfEnabled(runtime.config.debugLog, "render.pack", {
				fallback: packExplain.fallback,
				admitted: packedCount,
				evicted: evictedCount,
				lines: packExplain.lines,
			});

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					// P5.2 stamp: packed/evicted ride into the compaction entry's details so
					// /om:status can read them from durable state (no new persistence).
					details: {
						...projection.details,
						render: { packed: packedCount, evicted: evictedCount },
					},
				},
			};
		} finally {
			runtime.compactionBarrier = false;
			runtime.compactHookInFlight = false;
			// S2 (audit N5): observers yielded for the whole barrier. Re-drive the queue now that it is
			// closed instead of leaving the backlog to wait for the next turn_end/agent_start.
			pumpWorkerQueue(pi, runtime, ctx);
		}
	});
}
