import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, rawTokensSinceObservationCoverage, sumSessionCost, type Entry } from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
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
			const topicCount = listTopics(runtime.memoryRoot).length;
			const journey = readJourney(runtime.memoryRoot);
			const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);

			const lines = [
				`om status`,
				`  observers in flight: ${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
				`  active observations: ${folded.activeObservations.length}`,
				`  next observer: ${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`,
				`  pool: ${pool.toLocaleString()} tok (target ${runtime.config.poolTargetTokens.toLocaleString()}, consolidate at ${runtime.config.consolidateAtPoolTokens.toLocaleString()})`,
				`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
				`  pipeline: ${formatPipelineLine(runtime)}`, // P0.4 circuit-breaker visibility
				`  last compaction wait: ${runtime.lastCompactionObserverWait ?? "n/a"}`,
				`  topic files: ${topicCount}`,
				`  ${formatJourneyLine(journey, runtime.config.journeyTargetTokens, estimateStringTokens)}`, // P0.8 over-size warn
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
