import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { entryIndexForId, rawTokensAfterIndex, type Entry } from "../ledger/index.js";
import { clearWorkerFailures, evaluateObserverTriggers, effectiveWatermarkId } from "../hooks/observer-trigger.js";
import type { Runtime } from "../runtime.js";

/**
 * Force an observer run now, ignoring the chunk threshold — the observer-side twin of
 * `/om:consolidate`. The pending (below-threshold) tail is observed as one small chunk, and a
 * queued failed chunk retries first, so this doubles as the manual recovery hatch after a flaky
 * worker (bad API key, model outage). A no-op with a notice when there is nothing to observe.
 */
export function registerObserverCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:observer", {
		description: "Force an observational-memory observer run now (ignores the chunk threshold)",
		handler: async (_args: string, ctx: any) => {
			const notice = (message: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};
			if (!runtime.enabled) {
				notice("om is off (use /om on to enable)");
				return;
			}
			if (runtime.pipelinePaused) {
				// A manual command is an EXPLICIT user intent, so it clears a paused pipeline (P0.4): the
				// breaker stops AUTOMATIC dispatch loops, not the operator. Capture the streak before
				// clearing so the notice tells the truth, then fall through and actually run.
				const streak = runtime.workerFailureStreak;
				clearWorkerFailures(runtime);
				notice(
					`om: pipeline paused (${streak} consecutive worker failures) — breaker reset, retrying observation`,
					"warning",
				);
			}
			if (runtime.observerSlotsAvailable <= 0) {
				notice("om: observer busy (concurrency limit) — try again once a worker finishes", "warning");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const pending = rawTokensAfterIndex(branch, entryIndexForId(branch, effectiveWatermarkId(runtime, branch)));
			// A queued failure is work too: the trigger retries it before any fresh slice.
			if (runtime.failedSlices.length === 0 && pending <= 0) {
				notice("om: nothing to observe (no unobserved conversation since the last chunk)");
				return;
			}
			evaluateObserverTriggers(pi, runtime, ctx, { force: true });
		},
	});
}
