import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "./ledger/index.js";
import {
	beginStaging as beginStagingRoots,
	discardStaging,
	promoteStaging,
	type PromoteOutcome,
	type StagingRoots,
} from "./memory/paths.js";
import { StatusController } from "./ui/status-controller.js";

/** S6: timings of one compaction barrier (see `Runtime.lastBarrier`). */
export type BarrierTelemetry = {
	/** When the barrier started (epoch ms). */
	at: number;
	/** Time spent waiting for in-flight observers (plus the cutoff re-snap) before consolidating. */
	observerWaitMs: number;
	/** Time spent running the consolidator inside the barrier; undefined when none was due. */
	consolidationMs: number | undefined;
	/** Promote outcome of that consolidation; undefined when none ran. */
	promote: PromoteOutcome | undefined;
};

/**
 * In-process orchestrator state. Event-driven only — no daemon/timer beyond the status
 * spinner. Ephemeral: rebuilt on session_start, cleared on session_shutdown.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;
	/** The cwd `config` was loaded from (P0.2) — reloaded when a session in another project starts. */
	configCwd = "";

	/**
	 * Session generation counter (P0.1 stale-session commit race). Incremented on every
	 * session_start; async worker-completion paths capture the generation at dispatch and
	 * discard their results SILENTLY when it no longer matches — a worker started for a
	 * replaced session must never append entries (observations/cost), toast, or pump the
	 * queue of the session that replaced it.
	 */
	generation = 0;

	/**
	 * P0.11: pi invalidates its extension ctx after session replacement or reload — every
	 * later appendEntry throws. Once observed, the whole pipeline for this runtime is dead:
	 * no commits, no pumps, no dispatches (isCurrentSession gates on this flag). Permanent
	 * by design — pi never revives an invalidated ctx object.
	 */
	ctxStale = false;

	markCtxStale(): void {
		this.ctxStale = true;
	}

	/** The per-session on/off gate (default OFF). Outermost guard in every handler. */
	enabled = false;

	/**
	 * Absolute `.memory/<sessionId>/` root for this session's durable + transient memory. Set
	 * whenever the gate is enabled (session_start / `/om on`) via `ensureSessionMemory`; empty
	 * while disabled. All path helpers (listTopics/indexPath/readJourney/run*Path) take this root.
	 */
	memoryRoot = "";

	/**
	 * In-flight observer subprocesses, keyed by runId. `coversUpToId` is the source-entry id at
	 * the END of the observer's chunk — it lets compaction decide whether the observer can affect
	 * the rendered block (an observer whose chunk lands entirely in the verbatim tail is excluded
	 * from the projection regardless, so compaction need not wait for it).
	 */
	readonly observersInFlight = new Map<string, { controller: AbortController; coversUpToId: string }>();

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * Strictly one consolidator at a time (design risk 4). The flag is held from dispatch through
	 * tombstone-commit so the pool clock cannot fire a second overlapping run. Runs in the
	 * background — compaction does NOT wait for it (R5).
	 */
	consolidatorInFlight = false;
	consolidatorController: AbortController | undefined;

	/**
	 * S2: the in-flight consolidator TASK (the promise behind `consolidatorInFlight`), tracked so
	 * the compaction barrier can await a settled worker state via `whenConsolidatorIdle()`.
	 */
	consolidatorTask: Promise<void> | undefined;

	/**
	 * S2 anti-starvation: true for the whole compaction barrier (wait observers → run the
	 * consolidator → render). Observer dispatch yields while it is set, so chunks that keep
	 * arriving during the wait cannot prevent the barrier from ever seeing a settled state.
	 */
	compactionBarrier = false;

	/** S6: outcome of the most recent staged promote (merged into `lastBarrier` by the hook). */
	lastPromote: PromoteOutcome | undefined;

	/** S6: timings of the most recent compaction barrier, surfaced by /om:status. */
	lastBarrier: BarrierTelemetry | undefined;

	/**
	 * #11: outcome of the most recent consolidator run. Cleared the moment a run is dispatched and
	 * set in every settle path of `dispatchConsolidator` (never by observers), so a reader always
	 * sees THIS run's result rather than a stale one from an earlier attempt.
	 *
	 * The compaction barrier reads it to give a consolidation that failed while the barrier was
	 * pending exactly ONE retry before rendering. A failure on the BACKGROUND path is different:
	 * it neither retries nor triggers a compaction (the batch simply stays re-foldable).
	 */
	lastConsolidation: { ok: boolean; runId?: string; at: number } | undefined;

	/**
	 * S3: the work generation a consolidator run is currently writing into, when staging is
	 * active. `memoryRoot` is ALWAYS the logical live path — the render, status, `.runs/` IPC and
	 * every path helper keep resolving through it; only the worker's cwd + `OM_MEMORY_DIR` point
	 * at `staging.work`. Cleared by `commitStaging()` / `abortStaging()`.
	 */
	staging: StagingRoots | undefined;

	/**
	 * coversUpToId of the most-recent chunk DISPATCHED (committed or still in flight). Combined
	 * with the committed ledger watermark, this is the effective observation watermark: it keeps
	 * parallel observers from re-selecting the same slice and lets zero-observation chunks (which
	 * commit no ledger entry) still advance the clock. In-memory only — lost on resume (harmless;
	 * worst case a chunk is re-observed).
	 */
	dispatchedCoversUpToId: string | undefined;

	/**
	 * Observer slices whose dispatch FAILED and must be re-observed before the watermark moves
	 * past them (retry-once policy: an entry is dropped after its second failure). Oldest first.
	 * In-memory only, like dispatchedCoversUpToId.
	 */
	failedSlices: Array<{ afterEntryId: string | undefined; coversUpToId: string; attempts: number }> = [];

	/**
	 * Persistent per-range attempt counter backing the retry cap. Needed because takeRetrySlice
	 * CONSUMES the queue entry on dispatch — without a separate count, record→take→record would
	 * restart at 1 and a permanently-broken chunk would retry forever.
	 */
	sliceAttemptCounts: Map<string, number> = new Map();

	/** Guards so compaction trigger + hook never re-enter. */
	compactInFlight = false;
	compactHookInFlight = false;

	/** Re-entrancy flag for the worker-completion pump (see observer-trigger.ts). */
	pumpQueued = false;

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	/**
	 * Consecutive worker (observer OR consolidator) failures without an intervening success
	 * (P0.4 circuit breaker). At CIRCUIT_BREAKER_THRESHOLD the pipeline pauses so a broken
	 * provider/model cannot keep burning money every turn; cleared by any success or `/om on`.
	 */
	workerFailureStreak = 0;
	/** When true both worker triggers no-op until cleared (see `clearWorkerFailures`). */
	pipelinePaused = false;

	/**
	 * Whether the last compaction waited for in-flight observers or skipped the wait (fast path:
	 * no in-flight observer could affect the rendered block). Surfaced by /om:status.
	 */
	lastCompactionObserverWait: "skipped" | "waited" | undefined;

	readonly status = new StatusController();

	// ── Toast coalescer ──────────────────────────────────────────────────────────
	// Parallel observers fire finish toasts from independent async tasks. If two
	// land in the same event-loop tick, pi's showStatus() would replace the first
	// with the second. queueToast() accumulates info lines and flushes them as a
	// single multi-line notify on the next tick so both lines remain visible.

	private pendingInfoToastLines: string[] = [];
	private infoToastFlushTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Queue an info-level toast line for batched delivery on the next event-loop tick.
	 * Non-info levels (warning/error) bypass the queue and fire immediately so they
	 * always use their own styling and are never merged with info lines.
	 */
	queueToast(
		line: string,
		level: "info" | "warning" | "error",
		notify: (message: string, level: "info" | "warning" | "error") => void,
	): void {
		if (level !== "info") {
			notify(line, level);
			return;
		}
		this.pendingInfoToastLines.push(line);
		if (this.infoToastFlushTimer !== undefined) return;
		this.infoToastFlushTimer = setTimeout(() => {
			this.infoToastFlushTimer = undefined;
			const lines = this.pendingInfoToastLines.splice(0);
			if (lines.length > 0) notify(lines.join("\n"), "info");
		}, 0);
		this.infoToastFlushTimer.unref?.();
	}

	/** Discard any pending toast lines (called on session shutdown). */
	cancelPendingToasts(): void {
		if (this.infoToastFlushTimer !== undefined) {
			clearTimeout(this.infoToastFlushTimer);
			this.infoToastFlushTimer = undefined;
		}
		this.pendingInfoToastLines = [];
	}

	/**
	 * Load (or re-load) the layered settings for THIS session's cwd. Cached per cwd: pi can
	 * host sessions from different projects in one process, and a one-shot cache would keep
	 * the first project's `.pi/settings.json` overrides applied to all of them (P0.2).
	 */
	ensureConfig(cwd: string): void {
		if (this.configLoaded && this.configCwd === cwd) return;
		this.config = loadConfig(cwd);
		this.configCwd = cwd;
		this.configLoaded = true;
	}

	/** Recompute the live footer gauges (next-observer + pool + context) from the current branch. */
	refreshFooterGauges(branch: Entry[], contextTokens?: number | null): void {
		if (!this.enabled) return;
		const folded = foldLedger(branch);
		this.status.setGauges({
			nextValue: rawTokensSinceObservationCoverage(branch),
			nextMax: this.config.chunkTokens,
			poolValue: poolTokens(folded.activeObservations),
			poolMax: this.config.consolidateAtPoolTokens,
			ctxValue: contextTokens ?? 0,
			ctxMax: this.config.compactAtContextTokens,
		});
	}

	/**
	 * Recompute accumulated session cost for the footer from ALL entries (every branch), so the
	 * displayed spend never rolls back under /tree. Pass `getEntries()`, not `getBranch()`.
	 */
	refreshCost(allEntries: Entry[]): void {
		if (!this.enabled) return;
		const { costUsd, runs } = sumSessionCost(allEntries);
		this.status.setCost(costUsd, runs);
	}

	/**
	 * P0.1 (audit N4): session teardown is a session boundary. Invalidate in-flight workers BEFORE
	 * aborting them, so a completion that lands during teardown is discarded as stale — instead of
	 * burning circuit-breaker state and calling `ui.notify` through a ctx that is already dead
	 * (the documented crash class).
	 */
	shutdown(): void {
		this.generation += 1;
		this.status.detach();
		this.abortAllWorkers();
	}

	/** Abort and forget all in-flight workers (session shutdown / disable). */
	abortAllWorkers(): void {
		this.cancelPendingToasts();
		for (const { controller } of this.observersInFlight.values()) {
			controller.abort();
		}
		this.observersInFlight.clear();
		this.consolidatorController?.abort();
		this.consolidatorController = undefined;
		this.consolidatorInFlight = false;
		// A staged run that is being torn down is discarded, never promoted: the batch stays
		// un-tombstoned, so the next consolidation re-folds it (duplicate work, never lost data).
		this.abortStaging();
	}

	/**
	 * Begin a staged consolidation of this session's memory root. The caller must spawn the
	 * consolidator with `cwd`/`OM_MEMORY_DIR` = `roots.work`, keep every `.runs/` IPC path on the
	 * LIVE root, and finish with `commitStaging()` (clean exit) or `abortStaging()` (any other
	 * outcome). Promote only while no worker is in flight — the previous generation is deleted.
	 * Returns `staged: false` (work === live, in-place fallback) when staging is unavailable.
	 */
	beginStaging(): StagingRoots {
		this.abortStaging(); // never leave a second work generation behind
		const roots: StagingRoots = this.memoryRoot
			? beginStagingRoots(this.memoryRoot)
			: { live: "", work: "", staged: false };
		this.staging = roots.staged ? roots : undefined;
		return roots;
	}

	/**
	 * Commit the consolidator's staged run. `promoted` = atomic swap done; `in-place` = staging was
	 * unavailable, so the writes are already durable in the live root (drop the batch); `failed` =
	 * the live root is unchanged ⇒ the caller must KEEP the batch un-tombstoned for a re-fold.
	 */
	commitStaging(): PromoteOutcome {
		const roots = this.staging;
		this.staging = undefined;
		const outcome = promoteStaging(roots);
		// A failed promote leaves the work generation behind. Drop it: a higher-numbered `.g<N>`
		// sibling would otherwise be adopted by the crash-recovery branch of `ensureGenerationalRoot`
		// (which re-points the root at the NEWEST generation) as if it were live memory — and it
		// holds a partially-written run.
		if (outcome === "failed") discardStaging(roots);
		return outcome;
	}

	/** Drop the work generation — the live memory is left byte-identical. Safe to call twice. */
	abortStaging(): void {
		const roots = this.staging;
		this.staging = undefined;
		discardStaging(roots);
	}

	/** Track an observer task for the lifetime of its async run. */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		void task.finally(() => this.observerTasks.delete(task));
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(): Promise<void> {
		while (this.observerTasks.size > 0) {
			await Promise.allSettled([...this.observerTasks]);
		}
	}

	/** Track a consolidator task for the lifetime of its async run (see `whenConsolidatorIdle`). */
	trackConsolidatorTask(task: Promise<void>): void {
		this.consolidatorTask = task;
		// Clearing happens in a reaction registered BEFORE any waiter's `allSettled`, so a waiter
		// woken by the settle sees the field already cleared (and can never spin).
		void task.finally(() => {
			if (this.consolidatorTask === task) this.consolidatorTask = undefined;
		});
	}

	/**
	 * Resolve once no consolidator run is in flight. Loops because a settled task may already have
	 * pumped a successor (the barrier waits for the LAST one, not an arbitrary snapshot).
	 */
	async whenConsolidatorIdle(): Promise<void> {
		while (this.consolidatorTask) {
			await Promise.allSettled([this.consolidatorTask]);
		}
	}

	/**
	 * S2: resolve once EVERY worker has settled — observers first (so their just-committed
	 * observations are in the ledger), then the consolidator (so its topic-file writes are either
	 * promoted or dropped). This is the state the compaction render is a pure function of.
	 */
	async whenWorkersIdle(): Promise<void> {
		await this.whenObserversIdle();
		await this.whenConsolidatorIdle();
	}

	/** True when any worker subprocess (observer or consolidator) is in flight. */
	get workerBusy(): boolean {
		return this.consolidatorInFlight || this.observersInFlight.size > 0;
	}

	get observerSlotsAvailable(): number {
		// Serial mode: at most ONE worker in flight across both roles — observers queue behind
		// the running worker (and behind consolidator priority; see observer-trigger.ts).
		if (this.config.serialWorkers) {
			return this.workerBusy ? 0 : Math.min(1, this.config.observerConcurrency);
		}
		return Math.max(0, this.config.observerConcurrency - this.observersInFlight.size);
	}
}
