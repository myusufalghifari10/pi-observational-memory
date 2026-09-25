/**
 * Deterministic rendering of the long-term memory map (Phase B), from topic-file front-matter.
 *
 * Two consumers, both model-free and throwaway (regenerated, never edited incrementally — so
 * the projection cannot decay):
 *   - renderIndexFile: the orchestrator-owned INDEX.md on disk, re-rendered after each
 *     consolidation so live `ls`/`grep` truth leads the pushed map.
 *   - renderMemoryMap: the "memory map" section of the compaction injection block, built live
 *     from disk at each compaction and handed to renderSummary().
 */
import type { DeathEntry, Topic } from "./paths.js";
import { assertionHolds, type AnergyReport } from "./anergy.js";
import { resolve } from "node:path";

function summaryOf(topic: Topic): string {
	const s = (topic.summary ?? "").trim();
	return s.length > 0 ? s : "(no summary)";
}

function titleOf(topic: Topic): string {
	const t = (topic.title ?? "").trim();
	return t.length > 0 ? t : topic.filename;
}

/** The on-disk INDEX.md content. Orchestrator-owned; the consolidator never writes it. */
export function renderIndexFile(topics: Topic[]): string {
	const parts: string[] = ["# Memory index", ""];
	if (topics.length === 0) {
		parts.push("_No topics yet._");
		return `${parts.join("\n")}\n`;
	}
	parts.push("Durable memory topics for this project. Read a file for its full current state.", "");
	for (const topic of topics) {
		const updated = topic.updated ? ` · updated ${topic.updated}` : "";
		parts.push(`## ${titleOf(topic)}`);
		parts.push(`- \`${topic.path}\`${updated}`);
		parts.push(`- ${summaryOf(topic)}`);
		parts.push("");
	}
	return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * The compaction injection block's memory-map section. Returns undefined when there are no
 * topics (renderSummary then omits the section entirely). Each line is `path · summary
 * (updated …)` plus a thin orientation header — enough for the master to know a file exists
 * and decide whether to read it.
 *
 * Anergy: topics whose `asserts:` failed against the live repo (and were not re-armed by a
 * buffer observation) render as a one-line stub instead of their summary — the map flags
 * memory-vs-repo drift without deleting or editing anything on disk.
 */
/** P4.1 — DEATHS.md data for section [4]: parsed lines + the cwd used to resolve `(verify:)`.
 * fs lives HERE (index-render is an fs-owning module); the render block itself stays pure. */
export type DeathsContext = {
	entries: DeathEntry[];
	projectCwd: string;
};

/**
 * §2.1 death lines — cheap, revocable, never permanent (L11):
 * - `(verify:)` absent or the assertion still holds ⇒ authoritative `- rejected: … — because …`;
 * - the assertion FAILED ⇒ a one-line `- possibly-revived: … — re-verify before retrying`
 *   stub instead of an authoritative "never do this" (re-verify, never delete — the
 *   on-disk DEATHS.md is never touched by rendering).
 */
function renderDeathLines(deaths: DeathsContext): string[] {
	return deaths.entries.map((entry) => {
		if (entry.verify) {
			const [relPath, ...symbolParts] = entry.verify.split("#");
			const symbol = symbolParts.length > 0 ? symbolParts.join("#") : undefined;
			if (relPath && !assertionHolds(resolve(deaths.projectCwd, relPath), symbol || undefined)) {
				return `- possibly-revived: ${entry.approach} — re-verify before retrying (because ${entry.reason})`;
			}
		}
		return `- rejected: ${entry.approach} — because ${entry.reason}`;
	});
}

export function renderMemoryMap(
	topics: Topic[],
	anergy?: AnergyReport,
	deaths?: DeathsContext,
): string | undefined {
	const deathLines = deaths ? renderDeathLines(deaths) : [];
	if (topics.length === 0 && deathLines.length === 0) return undefined;
	const lines: string[] = [
		"## Memory map",
		"Durable long-term notes live in `.memory/`. Read a file when a topic below looks relevant; these summaries are intentionally terse.",
	];
	for (const topic of topics) {
		const failed = anergy?.get(topic.filename);
		if (failed && failed.length > 0) {
			lines.push(`- \`${topic.path}\` — anergic: ${failed.join(", ")} no longer holds (topic may be stale)`);
			continue;
		}
		const updated = topic.updated ? ` (updated ${topic.updated})` : "";
		lines.push(`- \`${topic.path}\` — ${summaryOf(topic)}${updated}`);
	}
	// P4.1: death stubs join section [4] after the topic rows (§2.3 map semantics).
	lines.push(...deathLines);
	return lines.join("\n");
}
