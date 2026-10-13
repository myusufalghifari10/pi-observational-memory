/**
 * Phase B consolidator clock. When the active observation pool crosses
 * `consolidateAtPoolTokens`, promote the oldest observations (above `poolTargetTokens`) into
 * durable `.memory/` topic files via a subprocess consolidator, then tombstone exactly the
 * timestamps it reports back.
 *
 * Runs in the BACKGROUND, mirroring the observer trigger (turn_end / agent_start), strictly one
 * at a time (design risk 4). Under the S2 barrier compaction DOES wait for it: the hook drains
 * observers first, then dispatches a due consolidation itself and waits for it before rendering.
 *
 * Tombstone safety (design risk 4): the orchestrator tombstones the batch it handed the
 * consolidator, intersected with what is STILL active at exit — never an observation an
 * observer committed during the run (those are not in the handed batch). The consolidator does
 * not report back: it must consolidate everything it was given (filing or discarding junk is a
 * valid outcome), so on clean exit we trust it and drop the whole batch. This guarantees the
 * buffer always drains; a flaked-out partial run is recoverable from the worker's global session
 * recording (the standing safety net for lossy rewrites) and is the critic tier's job to catch.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logIfEnabled } from "../debug-log.js";
import {
	OM_OBSERVATIONS_DROPPED,
	foldLedger,
	lastSourceEntryId,
	observationToLine,
	poolTokens,
	selectPromotionOverflow,
	sortObservations,
	type Entry,
	type Observation,
} from "../ledger/index.js";
import { nowTimestamp } from "../ledger/serialize.js";
import { renderIndexFile } from "../memory/index-render.js";
import { atomicWrite, indexPath, listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import {
	recordWorkerCost,
	pumpWorkerQueue,
	isCurrentSession,
	isStaleCtxError,
	safeAppendEntry,
	noteWorkerFailure,
	clearWorkerFailures,
} from "./observer-trigger.js";

type TriggerCtx = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[]; getEntries: () => Entry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cons-${stamp}-${process.pid}-${runCounter}`;
}

/**
 * Build the consolidator's `-p` prompt: current time + current index + current journey + the
 * overflow lines. The journey is included verbatim so the consolidator updates it in place
 * (append a segment for this batch; compress the old tail only if over `journeyTargetTokens`).
 */
function buildConsolidatorPrompt(memoryRoot: string, promote: Observation[], journeyTargetTokens: number): string {
	const indexText = renderIndexFile(listTopics(memoryRoot));
	const journeyText = readJourney(memoryRoot);
	const journeyWords = Math.round((journeyTargetTokens * 3) / 4);
	const obsLines = sortObservations(promote).map(observationToLine).join("\n");
	return (
		`Current local time: ${nowTimestamp()}\n\n` +
		"You are folding the observations below into the durable topic files under .memory/. " +
		"Use this exact time string in the `updated` front-matter of any file you write, and in any new JOURNEY.md entry.\n\n" +
		"===== CURRENT MEMORY INDEX (generated; do not edit INDEX.md) =====\n" +
		`${indexText}\n` +
		"===== END MEMORY INDEX =====\n\n" +
		"===== CURRENT JOURNEY (.memory/JOURNEY.md — the running descriptive project history) =====\n" +
		`${journeyText ?? "(empty — no journey yet; start one)"}\n` +
		"===== END JOURNEY =====\n\n" +
		"===== OBSERVATIONS TO CONSOLIDATE (each line is `<timestamp-id>  <content>`) =====\n" +
		`${obsLines}\n` +
		"===== END OBSERVATIONS =====\n\n" +
		"Fold every observation above into topic files (create/merge/rewrite as needed). Then update " +
		`.memory/JOURNEY.md per your instructions — keep it under ~${journeyTargetTokens} tokens (~${journeyWords} words), ` +
		"purely descriptive, no advice or next steps. Finish with a one-sentence confirmation."
	);
}

export function evaluateConsolidatorTrigger(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	opts: { allowDuringBarrier?: boolean } = {},
): void {
	if (!runtime.enabled || runtime.config.passive) return;
	// S2 (audit N1): inside a compaction barrier the HOOK owns the ordering and dispatches the
	// consolidator itself. Every background pump (i.e. a worker completion landing in the barrier's
	// await gap) must stand down, or a SECOND staged run could start while the barrier is mid-flight.
	if (runtime.compactionBarrier && !opts.allowDuringBarrier) return;
	// P0.4: circuit breaker — a paused pipeline never dispatches.
	if (runtime.pipelinePaused) return;
	if (runtime.consolidatorInFlight) return;
	// S2: consolidation starts only from a SETTLED observer state — unconditionally (the pipeline
	// is sequential-only). The compaction barrier relies on this so the batch it hands over is
	// complete up to the current watermark, and so a staged promote never races a running worker.
	if (runtime.observersInFlight.size > 0) return;

	const branch = ctx.sessionManager.getBranch();
	const active = foldLedger(branch).activeObservations;
	if (poolTokens(active) < runtime.config.consolidateAtPoolTokens) return;

	const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
	if (promote.length === 0) return;

	runtime.consolidatorInFlight = true;
	if (ctx.hasUI) {
		ctx.ui?.notify(`om: consolidator started (${promote.length} obs, ~${poolTokens(promote).toLocaleString()} tok)`, "info");
	}
	// Tracked as its OWN task (never in observerTasks: the compaction barrier waits for observers
	// first so their commits land, then for this one — see Runtime.whenWorkersIdle).
	runtime.trackConsolidatorTask(dispatchConsolidator(pi, runtime, ctx, promote));
}

async function dispatchConsolidator(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	promote: Observation[],
): Promise<void> {
	// P0.1: capture the session generation at dispatch — every commit-side effect below is
	// gated on it, so a session replacement mid-flight discards this worker's result.
	const gen = runtime.generation;
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.consolidatorController = controller;
	runtime.status.workerStart("consolidator", runId);

	try {
		// #11: cleared at dispatch so a reader (the compaction barrier) can never mistake an earlier
		// attempt's outcome for THIS run's — the field means "no outcome yet" until it settles.
		runtime.lastConsolidation = undefined;
		// S3: write into a fresh work generation (hardlink copy of the live memory) instead of the live
		// root — a crashed/hung run can then never leave a half-updated memory behind. `staged: false`
		// (work === live) is the in-place fallback when the tree cannot be prepared. Inside the try so
		// even a pathological failure here unwinds through the catch/finally (flags always reset).
		const staging = runtime.beginStaging();
		const prompt = buildConsolidatorPrompt(runtime.memoryRoot, promote, runtime.config.journeyTargetTokens);
		const argv = buildWorkerArgv({
			model: runtime.config.models.consolidator,
			sessionName: `om-consolidator-${runId}`,
			kickoffPrompt: prompt,
		});
		// Sandbox + cwd = the work generation; `.runs/` IPC stays on the LIVE root so the orchestrator
		// reads this run's cost through the path it always uses.
		const env = buildWorkerEnv("consolidator", { sandboxRoot: staging.work, ipcRoot: runtime.memoryRoot, runId });
		const exit = await spawnWorker({ argv, cwd: staging.work, env, signal: controller.signal });
		// P0.1: session replaced while the worker ran — discard silently (no cost, no tombstone,
		// no INDEX rewrite, no toasts).
		if (!isCurrentSession(runtime, gen)) {
			logIfEnabled(runtime.config.debugLog, "consolidator.stale-discard", { exitCode: exit.code }, runId);
			return;
		}
		// Capture cost before the exit-code check so a partial run's spend is still recorded.
		recordWorkerCost(pi, runtime, ctx, "consolidator", runId, gen);
		if (exit.code !== 0) {
			throw new Error(`consolidator exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		// Trust the consolidator: on clean exit it has folded (or discarded) everything we handed it.
		// Re-fold against the CURRENT branch so we never tombstone something already dropped or an
		// observation an observer committed during this run (those are not in the handed batch).
		const branch = ctx.sessionManager.getBranch();
		const stillActive = new Set(foldLedger(branch).activeObservations.map((o) => o.timestamp));
		const toDrop = promote.map((o) => o.timestamp).filter((t) => stillActive.has(t));

		// S3: the run wrote into the WORK generation, so re-render INDEX.md THERE (promote deletes the
		// previous generation, and an INDEX written through the live path would go with it) and then
		// swap the generation in with ONE atomic rename. The tombstone below MUST come after this:
		// a failed promote leaves the live memory unchanged, so the batch has to stay re-foldable.
		atomicWrite(indexPath(staging.work), renderIndexFile(listTopics(staging.work)));
		const promoteOutcome = runtime.commitStaging();
		runtime.lastPromote = promoteOutcome;
		if (promoteOutcome === "failed") {
			// commitStaging already discarded the work generation: the run's writes are not visible
			// through the live root ⇒ keep the batch un-tombstoned (thrown as a worker failure below).
			throw new Error("consolidator staging promote failed (live memory unchanged; batch kept for re-fold)");
		}

		if (toDrop.length > 0) {
			const coversUpToId = lastSourceEntryId(branch);
			if (coversUpToId) {
				// P0.11 (review Note A): stale-safe like every observer commit — a stale throw
				// here must mark ctxStale and skip the bookkeeping, not burn circuit-breaker state.
				safeAppendEntry(pi, runtime, gen, runId, OM_OBSERVATIONS_DROPPED, { observationTimestamps: toDrop, coversUpToId });
			}
		}

		// #11: the batch was drained into durable memory, so the barrier may render on top of this
		// without a retry. Recorded here (after the tombstone) rather than in the finally, because the
		// finally also runs for stale/aborted runs that produced no outcome at all.
		runtime.lastConsolidation = { ok: true, runId, at: Date.now() };
		logIfEnabled(runtime.config.debugLog, "consolidator.settle", { outcome: "ok", exitCode: exit.code, dropped: toDrop.length, handed: promote.length }, runId);
		runtime.status.workerDone(runId, toDrop.length);
		clearWorkerFailures(runtime); // P0.4: any success proves recovery
		runtime.refreshFooterGauges(ctx.sessionManager.getBranch(), ctx.getContextUsage?.()?.tokens ?? null);
		if (ctx.hasUI && ctx.ui) {
			runtime.queueToast(`om: consolidator promoted ${toDrop.length} obs`, "info", ctx.ui.notify.bind(ctx.ui));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// P0.11 (review Note A): stale-ctx throws (dead pi API after session replacement or
		// reload) are teardown artifacts — kill the pipeline, never burn breaker state, and
		// never reach ui.notify (which would throw on the dead ctx and escape as an
		// unhandled rejection — the original live crash class).
		if (isStaleCtxError(error)) {
			runtime.markCtxStale();
			logIfEnabled(runtime.config.debugLog, "consolidator.stale-discard", { phase: "catch", error: message }, runId);
			return;
		}
		// P0.1: stale session — discard without lastWorkerError, status, or toast.
		if (!isCurrentSession(runtime, gen)) {
			logIfEnabled(runtime.config.debugLog, "consolidator.stale-discard", { error: message }, runId);
			return;
		}
		runtime.lastWorkerError = message;
		// #11: a genuine failure — never a stale discard, which returns above — is what earns a barrier
		// its single retry. The background path ignores this field entirely.
		runtime.lastConsolidation = { ok: false, runId, at: Date.now() };
		noteWorkerFailure(runtime, ctx.hasUI && ctx.ui ? (m, l) => ctx.ui!.notify(m, l) : undefined); // P0.4
		logIfEnabled(runtime.config.debugLog, "consolidator.settle", { outcome: "error", error: message }, runId);
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: consolidator failed: ${message}`, "error");
	} finally {
		// No-op after a successful commit or an in-place run; drops the work generation otherwise, so
		// a failed/aborted/stale run can never leave a half-written generation behind.
		runtime.abortStaging();
		runtime.consolidatorController = undefined;
		runtime.consolidatorInFlight = false;
		// P0.1: never re-drive the queue from a completion that no longer belongs to this session.
		if (isCurrentSession(runtime, gen)) pumpWorkerQueue(pi, runtime, ctx);
	}
}

export function registerConsolidatorTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => {
		// P0.11: same sync-escape guard as the observer handler (stale ctx ⇒ graceful kill).
		try {
			evaluateConsolidatorTrigger(pi, runtime, ctx);
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
			runtime.markCtxStale();
			logIfEnabled(runtime.config.debugLog, "consolidator.stale-discard", { phase: "handler" });
		}
	};
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
