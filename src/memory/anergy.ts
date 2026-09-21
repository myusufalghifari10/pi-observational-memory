/**
 * Anergy — memory-vs-repo drift check (biology frame: immune self/non-self recognition).
 *
 * Topic files may assert concrete artifacts (`asserts:` front-matter: repo-relative paths,
 * optionally `path#symbol`). At compaction render the deterministic map renderer calls
 * checkAnergy(): each assertion is verified against the live repo with cheap, side-effect-
 * free filesystem checks — no model, no critic tier. A topic with failing assertions that
 * nothing in the active buffer re-asserts is "anergic": the injected memory map demotes it
 * to a one-line stub. State is NEVER persisted — it is recomputed per render, so it inherits
 * the throwaway-projection property (cannot decay) and a stale flag can never stick.
 *
 * Deliberately conservative: demote-never-delete, empty/absent asserts = exempt, and an IO
 * error while checking counts as PASS (only definite absence demotes — a false demotion that
 * hides healthy memory is worse than a missed drift flag).
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Observation } from "../ledger/types.js";
import type { Topic } from "./paths.js";

/** Bound the per-topic check so a pathological front-matter cannot stall compaction. */
const MAX_ASSERTIONS_PER_TOPIC = 20;
/** Bound the file read when searching for a `path#symbol` assertion. */
const MAX_SYMBOL_SCAN_BYTES = 256 * 1024;

/** Topic filename → the assertions that no longer hold. Absent = healthy/exempt. */
export type AnergyReport = Map<string, string[]>;

function mentionedInBuffer(activeObservations: Observation[], relPath: string): boolean {
	return activeObservations.some((observation) => observation.content.includes(relPath));
}

/** True when the artifact definitely exists (file/dir; symbol text found when given). */
function assertionHolds(absPath: string, symbol: string | undefined): boolean {
	try {
		if (!existsSync(absPath)) return false;
		if (symbol === undefined) return true;
		if (!statSync(absPath).isFile()) return false;
		const handle = openSync(absPath, "r");
		try {
			const size = fstatSync(handle).size;
			const length = Math.min(size, MAX_SYMBOL_SCAN_BYTES);
			const buffer = Buffer.alloc(length);
			readSync(handle, buffer, 0, length, 0);
			return buffer.toString("utf-8").includes(symbol);
		} finally {
			closeSync(handle);
		}
	} catch {
		// Unreadable ≠ absent: treat as pass so a permission hiccup can never demote a topic.
		return true;
	}
}

/**
 * Check every topic's assertions against the live repo. Returns a report containing ONLY
 * anergic topics (filename → failed assertions). Re-arm rule: a failing assertion is
 * forgiven when any active observation in the buffer mentions the path — renewed relevance
 * means the topic is not stale.
 */
export function checkAnergy(topics: Topic[], projectCwd: string, activeObservations: Observation[]): AnergyReport {
	const report: AnergyReport = new Map();

	for (const topic of topics) {
		if (!topic.asserts || topic.asserts.length === 0) continue;
		const failed: string[] = [];

		for (const assertion of topic.asserts.slice(0, MAX_ASSERTIONS_PER_TOPIC)) {
			const hash = assertion.lastIndexOf("#");
			const relPath = hash > 0 ? assertion.slice(0, hash) : assertion;
			const symbol = hash > 0 && assertion.length > hash + 1 ? assertion.slice(hash + 1) : undefined;
			const absPath = isAbsolute(relPath) ? relPath : resolve(projectCwd, relPath);

			if (!assertionHolds(absPath, symbol) && !mentionedInBuffer(activeObservations, relPath)) {
				failed.push(assertion);
			}
		}

		if (failed.length > 0) report.set(topic.filename, failed);
	}

	return report;
}
