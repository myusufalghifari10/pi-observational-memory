import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderStratLines } from "../ledger/render.js";
import { listStrats, parseFrontMatter, type Strat } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";

/**
 * P4.3 — `/strat`: list the procedural-memory strats (exactly the section [7] lines) and
 * show one strat's full content (`/strat <cue|name>`). Read-only; never edits memory.
 */

/** Match order is exact and deterministic: cue, then filename, then filename stem. */
export function findStrat(strats: Strat[], query: string): Strat | undefined {
	const q = query.trim();
	if (q.length === 0) return undefined;
	return (
		strats.find((strat) => (strat.cue ?? "").trim() === q) ??
		strats.find((strat) => strat.filename === q) ??
		strats.find((strat) => strat.filename.replace(/\.md$/, "") === q)
	);
}

/** Detail view: front-matter fields first, then the body (bounded). */
export function formatStratDetail(strat: Strat, body: string, maxBodyChars = 2000): string {
	const cue = (strat.cue ?? "").trim() || strat.filename.replace(/\.md$/, "");
	const lines = [`cue: ${cue}`];
	const summary = (strat.summary ?? "").trim();
	if (summary) lines.push(`summary: ${summary}`);
	const command = (strat.command ?? "").trim();
	if (command) lines.push(`command: ${command}`);
	lines.push(`path: ${strat.path}`);
	const trimmed = body.trim();
	if (trimmed.length > 0) {
		lines.push("", trimmed.slice(0, maxBodyChars) + (trimmed.length > maxBodyChars ? "…" : ""));
	}
	return lines.join("\n");
}

export function registerStratCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("strat", {
		description: "List procedural-memory strats (/strat), or show one (/strat <cue>)",
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			if (!runtime.enabled) {
				ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			const strats = listStrats(runtime.memoryRoot);
			if (strats.length === 0) {
				ctx.ui.notify("no strats yet (create .memory/<session>/strats/<name>.md)", "info");
				return;
			}
			const query = (args ?? "").trim();
			if (query.length === 0) {
				ctx.ui.notify(renderStratLines(strats).join("\n"), "info");
				return;
			}
			const strat = findStrat(strats, query);
			if (!strat) {
				ctx.ui.notify(
					`no strat matching '${query}' — known: ${strats.map((s) => (s.cue ?? "").trim() || s.filename.replace(/\.md$/, "")).join(", ")}`,
					"warning",
				);
				return;
			}
			const dir = join(runtime.memoryRoot, "strats");
			let body = "";
			try {
				body = parseFrontMatter(readFileSync(join(dir, strat.filename), "utf-8")).body;
			} catch {
				// Unreadable file: show the front-matter we already parsed rather than fail.
			}
			ctx.ui.notify(formatStratDetail(strat, body), "info");
		},
	});
}
