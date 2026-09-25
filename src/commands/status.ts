import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	foldLedger,
	poolTokens,
	rawTokensSinceObservationCoverage,
	sumSessionCost,
	type Entry,
	type FoldedLedger,
} from "../ledger/index.js";
import { checkAnergy } from "../memory/anergy.js";
import { listTopics, readDeaths, readJourney } from "../memory/paths.js";
import { resolve } from "node:path";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

/** P0.4 circuit-breaker line for /om:status (extracted for testability). */
export function formatPipelineLine(runtime: Runtime): string {
	return runtime.pipelinePaused
		? `pipeline: PAUSED (${runtime.workerFailureStreak} consecutive worker failures)`
		: "pipeline: active";
}

/**
 * P0.8 — journey size line for /om:status (extracted for testability).
 *
 * Visibility only, per the user's decision: growth of JOURNEY.md on a long session is fine
 * and there is NO enforcement (the consolidator compresses its own tail when over target).
 * The flag marks a journey past 2× target so overgrowth is at least visible.
 */
export function formatJourneyLine(
	journey: string | undefined,
	journeyTargetTokens: number,
	estimate: (text: string) => number,
): string {
	if (!journey) return "journey: none yet";
	const tokens = estimate(journey);
	const over = tokens > journeyTargetTokens * 2;
	const flag = over ? ` ⚠ OVER TARGET` : "";
	return `journey: ~${tokens.toLocaleString()} / ${journeyTargetTokens.toLocaleString()} tok${flag}`;
}

/**
 * P5.2 — operator telemetry for /om:status. All fields read from EXISTING durable
 * sources (last compaction entry, fold, DEATHS.md, live anergy check) — no new
 * persistence, no re-render, model-free.
 */
export type MemoryHealth = {
	/** Tokens of the LAST compaction block (from the entry's stored summary text). */
	blockTokens: number | undefined;
	/** Packed/evicted line counts stamped into details.render at compaction (P5.2 stamp). */
	packed: number | undefined;
	evicted: number | undefined;
	/** fold.gaps — chunk-coverage gap entries in branch order. */
	gaps: number;
	/** Give-up gaps (attempts >= 2) — the ones that render an UNOBSERVED WINDOW marker. */
	unobservedGaps: number;
	/** `- rejected:` convention lines in DEATHS.md. */
	deaths: number;
	/** fold.supersessions — deterministic lexical corrections. */
	supersessions: number;
	/** Topics demoted by the last model-free anergy check. */
	anergyFlagged: number;
};

/** Last compaction's rendered block size, derived from the entry's stored summary. */
export function lastCompactionBlockTokens(entries: Entry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		return typeof entry.summary === "string" ? estimateStringTokens(entry.summary) : undefined;
	}
	return undefined;
}

/**
 * Packed/evicted counts from the last compaction entry's `details.render` stamp (written
 * by the compaction hook). Legacy entries without the stamp return undefined → "n/a".
 */
export function lastRenderPack(entries: Entry[]): { packed: number; evicted: number } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		const details = entry.details;
		if (!details || typeof details !== "object") return undefined;
		const render = (details as { render?: unknown }).render;
		if (!render || typeof render !== "object") return undefined;
		const { packed, evicted } = render as { packed?: unknown; evicted?: unknown };
		return typeof packed === "number" && typeof evicted === "number" ? { packed, evicted } : undefined;
	}
	return undefined;
}

/** Count `- rejected:` convention lines in DEATHS.md (§2.1 line convention). */
export function countDeathLines(body: string | undefined): number {
	if (!body) return 0;
	let count = 0;
	for (const line of body.split("\n")) {
		if (line.trimStart().startsWith("- rejected:")) count++;
	}
	return count;
}

export function collectMemoryHealth(args: {
	entries: Entry[];
	folded: FoldedLedger;
	deathsBody: string | undefined;
	anergyFlagged: number;
}): MemoryHealth {
	const pack = lastRenderPack(args.entries);
	return {
		blockTokens: lastCompactionBlockTokens(args.entries),
		packed: pack?.packed,
		evicted: pack?.evicted,
		gaps: args.folded.gaps.length,
		unobservedGaps: args.folded.gaps.filter((gap) => gap.attempts >= 2).length,
		deaths: countDeathLines(args.deathsBody),
		supersessions: args.folded.supersessions.size,
		anergyFlagged: args.anergyFlagged,
	};
}

/** P5.2 — two compact "at a glance" lines; numbers laid out for quick scanning. */
export function formatHealthLines(health: MemoryHealth): string[] {
	const block =
		health.blockTokens === undefined
			? "last render: n/a"
			: health.packed !== undefined && health.evicted !== undefined
				? `last render: ~${health.blockTokens.toLocaleString()} tok · packed ${health.packed} / evicted ${health.evicted}`
				: `last render: ~${health.blockTokens.toLocaleString()} tok (pack n/a)`;
	return [
		`  ${block}`,
		`  memory health: gaps ${health.gaps} (${health.unobservedGaps} unobserved) · deaths ${health.deaths} · supersessions ${health.supersessions} · anergy ${health.anergyFlagged}`,
	];
}

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (workers, buffer, clocks)",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			if (!runtime.enabled) {
				ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(branch);
			const sinceObservation = rawTokensSinceObservationCoverage(branch);
			const contextTokens = ctx.getContextUsage?.()?.tokens ?? null;
			const pool = poolTokens(folded.activeObservations);
			const topics = listTopics(runtime.memoryRoot);
			const journey = readJourney(runtime.memoryRoot);
			const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);
			// P5.2 health: last compaction stamp + fold + DEATHS.md + a live anergy
			// check (model-free fs assertions, recomputed like the render does — never persisted).
			const health = collectMemoryHealth({
				entries: branch,
				folded,
				deathsBody: readDeaths(runtime.memoryRoot),
				anergyFlagged: checkAnergy(topics, resolve(runtime.memoryRoot, "..", ".."), folded.activeObservations)
					.size,
			});

			const lines = [
				`om status`,
				`  observers in flight: ${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
				`  active observations: ${folded.activeObservations.length}`,
				`  next observer: ${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`,
				`  pool: ${pool.toLocaleString()} tok (target ${runtime.config.poolTargetTokens.toLocaleString()}, consolidate at ${runtime.config.consolidateAtPoolTokens.toLocaleString()})`,
				`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
				`  pipeline: ${formatPipelineLine(runtime)}`, // P0.4 circuit-breaker visibility
				`  last compaction wait: ${runtime.lastCompactionObserverWait ?? "n/a"}`,
				`  topic files: ${topics.length}`,
				`  ${formatJourneyLine(journey, runtime.config.journeyTargetTokens, estimateStringTokens)}`, // P0.8 over-size warn
				...formatHealthLines(health), // P5.2 operator telemetry
				`  context: ${contextTokens != null ? contextTokens.toLocaleString() : "?"} / ${runtime.config.compactAtContextTokens.toLocaleString()} tok`,
				`  session cost: $${costUsd.toFixed(4)} (${runs} run${runs === 1 ? "" : "s"})`,
				runtime.lastWorkerError ? `  last error: ${runtime.lastWorkerError}` : `  last error: none`,
				"",
				renderTimeline(branch, runtime.config),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
