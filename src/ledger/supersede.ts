/**
 * P1.3 — deterministic lexical supersession detector (L2: never an LLM judge).
 *
 * A correction is not a deletion (L4): when a newer observation overtakes an older one, both
 * stay in the buffer and render adjacent as `believed X → now Y`. This module only *detects*
 * the pairing at commit time; the losing fact is never rewritten or dropped here.
 *
 * Pairing rule (plan §2.2 — exact):
 *   - overlap = ≥2 shared identifier tokens between the two contents;
 *   - the OLDER observation must be kind assertion | decision | preference;
 *   - the NEWER observation must be kind assertion | decision;
 *   - one-to-one: each observation participates in at most one pair (newest wins).
 *
 * Pure, deterministic, no I/O — safe on the commit path.
 */
import type { Observation, SupersessionPair } from "./types.js";

/**
 * Common English glue words. Identifier tokens matching these never count toward the
 * ≥2-token overlap (otherwise "user said the project uses the same" would pair).
 */
const STOP_WORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was",
	"one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "new", "now",
	"old", "see", "two", "way", "who", "did", "she", "may", "use", "than", "then", "that",
	"this", "with", "from", "have", "been", "were", "said", "each", "which", "their", "will",
	"what", "when", "make", "like", "time", "just", "know", "take", "people", "into", "year",
	"your", "good", "some", "could", "them", "see", "other", "than", "then", "now", "look",
	"only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how",
	"our", "work", "first", "well", "even", "want", "because", "these", "give", "most",
	// Observation-prose glue: nearly every observation opens with "User …" / "The project …",
	// so these carry no discriminative signal for overlap (plan §2.2 — stop-word list).
	"user", "users", "same", "via", "does", "done", "every", "where", "those", "while",
]);

/**
 * Identifier tokens of a content string (plan §2.2):
 * lowercase → split on non-alphanumerics → drop short/stop words → additionally split
 * path segments (`src/auth.ts` → `src`, `auth`) and camelCase/snake_case identifiers so
 * `handleAuth` and `auth_handler` both contribute `auth`.
 */
export function identifierTokens(content: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of content.toLowerCase().split(/[^a-z0-9_]+/)) {
		if (!raw) continue;
		// Path/snake segments first (`src/auth`, `auth_handler`).
		for (const segment of raw.split(/_+/)) {
			if (segment.length >= 3 && !STOP_WORDS.has(segment)) tokens.add(segment);
		}
		// camelCase split (raw is already lowercased by the outer lowercase, so detect
		// boundaries on the ORIGINAL casing before lowering — done below in camelTokens).
	}
	// camelCase boundaries need original casing: re-walk the raw content.
	for (const word of content.split(/[^A-Za-z0-9_]+/)) {
		for (const m of word.matchAll(/[a-z]+|[A-Z][a-z0-9]*|[A-Z]+(?![a-z])/g)) {
			const seg = m[0].toLowerCase();
			if (seg.length >= 3 && !STOP_WORDS.has(seg)) tokens.add(seg);
		}
	}
	return tokens;
}

function sharedIdentifierCount(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared;
}

/**
 * §2.2 one-to-one pre-filter for the COMMIT path: a fact that has already lost a pair
 * (it is a key of the fold's `supersessions` map) may never enter another pair.
 *
 * Why this must happen at the call site: without it, a second correction batch would pair
 * the same losing fact again (`old → n2`), and fold's first-valid-wins semantics would then
 * silently DROP the newer pair — the rendered "now" would stay at the STALE first correction
 * while the newest truth only floats as a standalone line. Filtering the loser out lets the
 * newest correction pair with the previous WINNER instead (`old → n1`, `n1 → n2`), which is
 * a chain of distinct keys — one pair per losing observation, exactly §2.2 one-to-one.
 */
export function excludeAlreadySuperseded(
	existing: readonly Observation[],
	supersessions: ReadonlyMap<string, string>,
): Observation[] {
	return existing.filter((observation) => !supersessions.has(observation.timestamp));
}

const OLDER_KINDS = new Set(["assertion", "decision", "preference"]);
const NEWER_KINDS = new Set(["assertion", "decision"]);

/**
 * Detect supersession pairs between a just-committed incoming batch (newest facts) and the
 * existing active buffer. Iterates incoming newest-first so "newest wins" holds when several
 * incoming observations compete for the same older fact. Each observation lands in at most
 * one pair (one-to-one, plan §2.2).
 */
export function detectSupersessions(
	incoming: Observation[],
	existing: Observation[],
): SupersessionPair[] {
	// Existing = only non-losing candidates that qualify as the OLDER side.
	const eligibleOlder = existing.filter((o) => OLDER_KINDS.has(o.kind ?? ""));
	const tokenCache = new Map<string, Set<string>>();
	const tokensOf = (obs: Observation): Set<string> => {
		let set = tokenCache.get(obs.timestamp);
		if (!set) {
			set = identifierTokens(obs.content);
			tokenCache.set(obs.timestamp, set);
		}
		return set;
	};

	const pairs: SupersessionPair[] = [];
	const usedOlder = new Set<string>();
	const usedNewer = new Set<string>();

	// Newest incoming first (descending timestamp — ids are lexicographically ordered).
	const incomingNewestFirst = [...incoming].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

	for (const newer of incomingNewestFirst) {
		if (!NEWER_KINDS.has(newer.kind ?? "")) continue;
		if (usedNewer.has(newer.timestamp)) continue;
		const newerTokens = tokensOf(newer);

		let best: Observation | undefined;
		let bestShared = 1; // need ≥2
		for (const older of eligibleOlder) {
			if (usedOlder.has(older.timestamp)) continue;
			if (older.timestamp === newer.timestamp) continue;
			const shared = sharedIdentifierCount(newerTokens, tokensOf(older));
			if (shared > bestShared) {
				bestShared = shared;
				best = older;
			}
		}
		if (best) {
			usedOlder.add(best.timestamp);
			usedNewer.add(newer.timestamp);
			pairs.push({ oldTimestamp: best.timestamp, newTimestamp: newer.timestamp, reason: "lexical-supersession" });
		}
	}

	// Deterministic output order: oldest losing fact first.
	return pairs.sort((a, b) => (a.oldTimestamp < b.oldTimestamp ? -1 : a.oldTimestamp > b.oldTimestamp ? 1 : 0));
}
