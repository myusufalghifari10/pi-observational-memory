import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger, poolTokens, selectPromotionOverflow, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { evaluateConsolidatorTrigger } from "../hooks/consolidator-trigger.js";
import { clearWorkerFailures } from "../hooks/observer-trigger.js";

/**
 * Force a consolidation now, ignoring the pool threshold. Promotes the oldest observations
 * above `poolTargetTokens`; no-op when there is nothing above target or one is already running.
 *
 * A manual command is an EXPLICIT user intent, so it also clears a paused pipeline (P0.4): the
 * breaker exists to stop AUTOMATIC dispatch loops, not to block the operator. Without this the
 * command silently did nothing once the breaker had tripped, leaving `/om off`→`/om on` as the
 * only recovery.
 */
export function registerConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:consolidate", {
		description: "Force an observational-memory consolidation now (ignores the pool threshold)",
		handler: async (_args: string, ctx: any) => {
			if (!runtime.enabled) {
				if (ctx.hasUI) ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			if (runtime.pipelinePaused) {
				// Capture the streak BEFORE clearing it, so the notice reports the real number.
				const streak = runtime.workerFailureStreak;
				clearWorkerFailures(runtime);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`om: pipeline paused (${streak} consecutive worker failures) — breaker reset, retrying consolidation`,
						"warning",
					);
				}
			}
			if (runtime.consolidatorInFlight) {
				if (ctx.hasUI)
					ctx.ui.notify(
						"om: consolidation already in progress (sequential pipeline: one worker at a time)",
						"warning",
					);
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const active = foldLedger(branch).activeObservations;
			const { promote } = selectPromotionOverflow(active, runtime.config.poolTargetTokens);
			if (promote.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`om: nothing to consolidate (pool ${poolTokens(active).toLocaleString()} tok <= target ${runtime.config.poolTargetTokens.toLocaleString()} tok)`,
						"info",
					);
				}
				return;
			}
			// Temporarily lower the threshold to 0 for this evaluation so the trigger fires
			// regardless of the configured pool threshold.
			const saved = runtime.config.consolidateAtPoolTokens;
			runtime.config.consolidateAtPoolTokens = 0;
			try {
				evaluateConsolidatorTrigger(pi, runtime, ctx);
			} finally {
				runtime.config.consolidateAtPoolTokens = saved;
			}
		},
	});
}
