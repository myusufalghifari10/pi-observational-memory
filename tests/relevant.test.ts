import { describe, expect, it } from "vitest";

import {
	RELEVANT_TOP_K,
	renderSummaryV2,
	relevanceScore,
	type LineMeta,
	type Observation,
	type ScoredLine,
} from "../src/ledger/index.js";
import { buildRelevantCandidates, lastUserQuery, QUERY_MAX_CHARS } from "../src/hooks/compaction-hook.js";
import { estimateStringTokens } from "../src/tokens.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

const candidate = (id: string, text: string, tokenCount = 4): ScoredLine => ({
	id,
	text,
	meta: {
		kind: "event",
		provenance: "model-distilled",
		supersessionCount: 0,
		ageCompactions: 0,
		tokenCount,
	},
});

const meta = (overrides: Partial<LineMeta> = {}): LineMeta => ({
	kind: "assertion",
	provenance: "model-distilled",
	supersessionCount: 0,
	ageCompactions: 0,
	tokenCount: 10,
	...overrides,
});

const at = (second: number) => `2026-05-02T10:00:${String(second).padStart(2, "0")}`;

/** Extract a section's body (heading line removed, next `## ` heading excluded). */
function section(block: string, heading: string): string | undefined {
	if (!block.includes(`${heading}\n`)) return undefined;
	const after = block.split(`${heading}\n`)[1];
	const cut = after.indexOf("\n\n## ");
	return cut >= 0 ? after.slice(0, cut) : after;
}

describe("P2.5 §2.6 relevanceScore — shared-identifier scoring (same tokenizer as §2.2)", () => {
	it("counts shared identifiers with camelCase/snake_case splitting", () => {
		// authHandler → auth + handler; auth_handler → auth + handler ⇒ shared = 2.
		expect(relevanceScore("Implement src/authHandler login flow", "the auth_handler function")).toBe(2);
	});

	it("counts path segments (src/auth.ts → src + auth; ts drops below length 3)", () => {
		expect(relevanceScore("touch src/auth.ts now", "auth lives in src")).toBe(2);
	});

	it("drops stop-words and short tokens — glue prose scores 0", () => {
		expect(relevanceScore("the a of", "is it the")).toBe(0);
		expect(relevanceScore("", "anything at all")).toBe(0);
	});
});

describe("P2.5 §2.6 section [5] — top-k, exclusion, omission, budget", () => {
	it("(b) caps the section at TOP_K candidates by rank, ties broken by id", () => {
		const candidates = ["a", "b", "c", "d", "e", "f"].map((letter) =>
			candidate(`topic:${letter}.md`, `topic ${letter} zebra facts`),
		);
		const { summary } = renderSummaryV2({
			state: { body: "## Goal\nKeep the zebra enclosure standing." },
			observations: [],
			query: "zebra",
			candidates,
		});
		const body = section(summary, "## Relevant memory");
		expect(body).toBeDefined();
		const lines = (body as string).split("\n");
		expect(lines).toHaveLength(RELEVANT_TOP_K); // exactly 5 of the 6 scored >0
		expect(lines).toEqual([
			"topic a zebra facts",
			"topic b zebra facts",
			"topic c zebra facts",
			"topic d zebra facts",
			"topic e zebra facts",
		]); // score tie (all 1) ⇒ id-ascending rank order
		expect(body).not.toContain("topic f zebra facts"); // rank 6 never renders
	});

	it("(b) excludes an observation that made the [6] knapsack — never twice in one block", () => {
		const teaser = observation(at(1), {
			content: "zebra migration completed",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const observationMeta = new Map<string, LineMeta>([[teaser.timestamp, meta()]]);
		const keeperNote = candidate("topic:keeper.md", "zebra keeper notes");
		const { summary, packExplain } = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			candidates: [keeperNote],
			observations: [teaser],
			observationMeta,
			budget: 100,
		});
		// [6] admits the observation (score 0.12, plenty of budget)…
		expect(packExplain.lines.find((line) => line.id === teaser.timestamp)?.admitted).toBe(true);
		// …so [5] must NOT repeat it: exactly one render, inside [6].
		const teaserLine = `${teaser.timestamp}  zebra migration completed`;
		expect(summary.split(teaserLine)).toHaveLength(2); // one occurrence (split → 2 parts)
		const body = section(summary, "## Relevant memory");
		expect(body).toContain("zebra keeper notes");
		expect(body).not.toContain(teaser.timestamp);
	});

	it("(c) omits the section entirely when every score is 0", () => {
		const { summary } = renderSummaryV2({
			state: { body: "## Goal\nUnrelated." },
			observations: [],
			query: "quantum yodeling",
			candidates: [candidate("topic:x.md", "boring summary line"), candidate("topic:y.md", "another plain row")],
		});
		expect(summary).not.toContain("## Relevant memory");
	});

	it("(d) shares the budget: [5] counts FIRST, [6] packs the remainder", () => {
		const alpha = observation(at(1), {
			content: "alpha platform config",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const beta = observation(at(2), {
			content: "beta platform config",
			tokenCount: 10,
			kind: "event",
			sourceEntryId: "e1",
		});
		const observationMeta = new Map<string, LineMeta>([
			[alpha.timestamp, meta({ provenance: "user-asserted" })], // 1.0·1.2/10 = 0.12
			[beta.timestamp, meta({ kind: "event" })], // 0.5/10 = 0.05
		]);
		const observations: Observation[] = [alpha, beta];
		const deployNote = candidate("topic:deploy.md", "deploy pipeline summary", 6);

		// With [5]: candidate spends 6 of 20 ⇒ [6] gets 14 ⇒ only alpha fits.
		const withTeaser = renderSummaryV2({
			state: { body: "## Goal\nShipping." },
			query: "deploy pipeline",
			candidates: [deployNote],
			observations,
			observationMeta,
			budget: 20,
		});
		expect(section(withTeaser.summary, "## Relevant memory")).toContain("deploy pipeline summary");
		// [5] renders BEFORE [6] (§2.3 order).
		expect(withTeaser.summary.indexOf("## Relevant memory")).toBeLessThan(withTeaser.summary.indexOf("## Observations"));
		expect(withTeaser.summary).toContain("alpha platform config");
		expect(withTeaser.summary).not.toContain("beta platform config");
		expect(withTeaser.packExplain.lines.find((line) => line.id === beta.timestamp)).toMatchObject({
			admitted: false,
			reason: "evicted-budget",
		});

		// Control (no [5]): the same 20 tokens admit BOTH observations.
		const control = renderSummaryV2({ observations, observationMeta, budget: 20 });
		expect(control.packExplain.lines.filter((line) => line.admitted)).toHaveLength(2);
		// Budget never overrun: [5] tokens + [6] admitted tokens ≤ budget.
		const admittedTokens = withTeaser.packExplain.lines
			.filter((line) => line.admitted)
			.reduce((sum, line) => sum + (observationMeta.get(line.id)?.tokenCount ?? 0), 0);
		expect(admittedTokens + estimateStringTokens("deploy pipeline summary")).toBeLessThanOrEqual(20);
	});

	it("(e) byte-identical across double renders (C3 determinism with [5] active)", () => {
		const obs = observation(at(1), { content: "zebra facts hold", tokenCount: 10, kind: "assertion", sourceEntryId: "e1" });
		const input = {
			state: { body: "## Goal\nZoology." },
			query: "zebra enclosure",
			candidates: [
				candidate("topic:keeper.md", "zebra keeper roster"),
				candidate("topic:feed.md", "zebra feed schedule"),
			],
			observations: [obs],
			observationMeta: new Map<string, LineMeta>([[obs.timestamp, meta()]]),
			budget: 40,
		};
		expect(renderSummaryV2(input)).toEqual(renderSummaryV2(input));
	});
});

// NOTE (BLOCKED run): the "fills to TOP_K" and "surfaces in [5] WHOLE" tests below are
// INTENTIONAL reproducers of a src/ledger/render.ts defect (teaserBudget is structurally
// smaller than any evicted unit's cost — see p3a1-fixab-tests.md). They fail until src is
// fixed; the other three tests in this block pass today.
describe("P3a Fix A / Fix B — exclude-then-cap and belief-group teasers (§2.6)", () => {
	const zebraMeta = (overrides: Partial<LineMeta> = {}): LineMeta => meta({ ...overrides });

	it("Fix A: with [6]-admitted lines excluded first, [5] still fills to TOP_K from the remainder", () => {
		// 8 singleton observations all match the query; [6] admits exactly the two
		// highest-ranked (budget 25 ⇒ 20 used, each remaining unit costs 10 > 5).
		// Exclude-then-cap: the 6 remainder teasers rank on their own, top-5 renders
		// (obs3..obs7 by id tie-break); the [6]-bound obs1/obs2 never waste a rank slot.
		const observations: Observation[] = Array.from({ length: 8 }, (_, index) =>
			observation(at(index + 1), {
				content: `zebra fact number ${index + 1}`,
				tokenCount: 10,
				kind: "assertion",
				sourceEntryId: "e1",
			}),
		);
		const observationMeta = new Map<string, LineMeta>(
			observations.map((obs) => [obs.timestamp, zebraMeta()]),
		);
		const { summary } = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			observations,
			observationMeta,
			budget: 25,
		});
		const body = section(summary, "## Relevant memory");
		expect(body).toBeDefined();
		const lines = (body as string).split("\n");
		expect(lines).toHaveLength(RELEVANT_TOP_K); // fills to 5 from the remainder
		// Excluded lines (in [6]) never appear in [5]: one render each, in [6].
		expect(body).not.toContain(observations[0].timestamp);
		expect(body).not.toContain(observations[1].timestamp);
		// Rank tie ⇒ id asc among the remainder: obs3..obs7, obs8 cut by the cap.
		expect(lines).toEqual(
			observations.slice(2, 7).map((obs) => `${obs.timestamp}  ${obs.content}`),
		);
		// The 2 excluded lines DID make [6].
		const admittedIds = summary.split("## Observations\n")[1]
			? summary.split("## Observations\n")[1].split("\n")[0]
			: undefined;
		expect(admittedIds).toContain(observations[0].timestamp);
	});

	it("Fix A: deduped observation lines reserve NO budget — [5] never shrinks [6]", () => {
		const observations: Observation[] = [1, 2, 3].map((second) =>
			observation(at(second), {
				content: `zebra checklist item ${second}`,
				tokenCount: 10,
				kind: "assertion",
				sourceEntryId: "e1",
			}),
		);
		const observationMeta = new Map<string, LineMeta>(
			observations.map((obs) => [obs.timestamp, zebraMeta()]),
		);
		const withQuery = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			observations,
			observationMeta,
			budget: 30,
		});
		const control = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			observations,
			observationMeta,
			budget: 30,
		});
		// All three make [6] with the query present — identical to the no-query control:
		// deduped lines (bound for [6]) reserve nothing, so [6]'s capacity is untouched.
		const admitted = (result: { packExplain: { lines: { id: string; admitted: boolean }[] } }) =>
			result.packExplain.lines.filter((line) => line.admitted).map((line) => line.id).sort();
		expect(admitted(withQuery)).toEqual(admitted(control));
		expect(admitted(withQuery)).toHaveLength(3);
		expect(section(withQuery.summary, "## Relevant memory")).toBeUndefined(); // all in [6], no teaser
	});

	it("Fix A: only ADMITTED [5] lines reserve budget — an evicted topic frees its tokens for [6]", () => {
		// Three topics match (score tie ⇒ id asc): a(6) + b(6) admitted, c(12) evicted
		// under budget 20 ⇒ topicTokens = 12 ⇒ [6] gets 8 ⇒ the 8-token observation fits.
		// If an evicted topic still reserved its tokens, [6] would get ≤0 and the obs evicts.
		const topics = [
			candidate("topic:a.md", "topic alpha zebra facts", 6),
			candidate("topic:b.md", "topic beta zebra facts", 6),
			candidate("topic:c.md", "topic gamma zebra facts", 12),
		];
		const obs = observation(at(1), {
			content: "zebra hull integrity check",
			tokenCount: 8,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const observationMeta = new Map<string, LineMeta>([[obs.timestamp, zebraMeta({ tokenCount: 8 })]]);
		const { summary, packExplain } = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			candidates: topics,
			observations: [obs],
			observationMeta,
			budget: 20,
		});
		const body = section(summary, "## Relevant memory");
		expect(body).toBeDefined();
		expect(body).toContain("topic alpha zebra facts");
		expect(body).toContain("topic beta zebra facts");
		expect(body).not.toContain("topic gamma zebra facts"); // evicted ⇒ reserves nothing
		// [6] received exactly budget − admittedTopics = 20 − 12 = 8 ⇒ the obs is admitted.
		expect(packExplain.lines.find((line) => line.id === obs.timestamp)).toMatchObject({
			admitted: true,
			reason: "packed",
		});
	});

	it("Fix B: a belief group evicted from [6] surfaces in [5] WHOLE — believed:/now: partners adjacent", () => {
		const loser = observation(at(1), {
			content: "zebra habitat is restored",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const winner = observation(at(2), {
			content: "zebra habitat is relocated",
			tokenCount: 10,
			kind: "event",
			sourceEntryId: "e2",
		});
		const soaker = observation(at(3), {
			content: "deploy pipeline ready",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e3",
		});
		const observationMeta = new Map<string, LineMeta>([
			[loser.timestamp, zebraMeta({ kind: "event" })], // unit score = winner's = 0.05
			[winner.timestamp, zebraMeta({ kind: "event" })],
			[soaker.timestamp, zebraMeta({ provenance: "user-asserted" })], // 0.12 ranks first
		]);
		// budget 25: soaker (10) admitted, group (20) cannot fit (30 > 25) ⇒ evicted from [6].
		const { summary, packExplain } = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			observations: [loser, winner, soaker],
			supersessions: new Map([[loser.timestamp, winner.timestamp]]),
			observationMeta,
			budget: 25,
		});
		// The group really is outside [6]…
		expect(packExplain.lines.find((line) => line.id === loser.timestamp)?.admitted).toBe(false);
		expect(packExplain.lines.find((line) => line.id === winner.timestamp)?.admitted).toBe(false);
		// …so [5] surfaces it WHOLE: both partners adjacent, never a bare member.
		const body = section(summary, "## Relevant memory");
		expect(body).toBeDefined();
		const lines = (body as string).split("\n");
		expect(lines).toEqual([
			`${loser.timestamp}  believed: ${loser.content}`,
			`${winner.timestamp}  now: ${winner.content}`,
		]);
	});

	it("Fix B: a belief group admitted to [6] never re-surfaces bare in [5]", () => {
		const loser = observation(at(1), {
			content: "zebra habitat is restored",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e1",
		});
		const winner = observation(at(2), {
			content: "zebra habitat is relocated",
			tokenCount: 10,
			kind: "assertion",
			sourceEntryId: "e2",
		});
		const observationMeta = new Map<string, LineMeta>([
			[loser.timestamp, zebraMeta()],
			[winner.timestamp, zebraMeta()],
		]);
		const { summary, packExplain } = renderSummaryV2({
			state: { body: "## Goal\nZoology." },
			query: "zebra",
			observations: [loser, winner],
			supersessions: new Map([[loser.timestamp, winner.timestamp]]),
			observationMeta,
			budget: 100,
		});
		// Group admitted to [6] as one unit…
		expect(packExplain.lines.find((line) => line.id === loser.timestamp)?.admitted).toBe(true);
		expect(packExplain.lines.find((line) => line.id === winner.timestamp)?.admitted).toBe(true);
		// …and rendered exactly once total (in [6]); [5] has no teaser of it.
		const loserLine = `${loser.timestamp}  believed: ${loser.content}`;
		const winnerLine = `${winner.timestamp}  now: ${winner.content}`;
		expect(summary.split(loserLine)).toHaveLength(2);
		expect(summary.split(winnerLine)).toHaveLength(2);
		expect(section(summary, "## Relevant memory")).toBeUndefined();
	});
});

describe("P2.5 hook capture — lastUserQuery + buildRelevantCandidates", () => {
	it("picks the NEWEST user/custom_message and skips hidden om.* synthetics", () => {
		const branch: TestEntry[] = [
			rawMessage("u1", "first ask about the deploy pipeline"),
			textCustomMessage("c1", "second ask about the deploy pipeline"),
			textCustomMessage("om1", "hidden bridge text", { customType: "om.resume" }),
		];
		expect(lastUserQuery(branch)).toBe("second ask about the deploy pipeline");
		expect(lastUserQuery([rawMessage("u1", "only ask")])).toBe("only ask");
		expect(lastUserQuery([observationsRecordedEntry("om-1", { observations: [], coversUpToId: "u1" })])).toBeUndefined();
		expect(lastUserQuery([])).toBeUndefined();
	});

	it("bounds the query to QUERY_MAX_CHARS (2,000)", () => {
		const huge = "deploy pipeline ".repeat(300); // 4,800 chars
		const query = lastUserQuery([rawMessage("u1", huge)]);
		expect(query).toHaveLength(QUERY_MAX_CHARS);
		expect(QUERY_MAX_CHARS).toBe(2_000);
	});

	it("builds candidates from STATE lines + topic summaries with code-computed tokens", () => {
		const state = { body: "## Goal\nShip the ship\n## Done\n- launched" };
		const topics = [
			{ path: ".memory/test-session/auth.md", filename: "auth.md", summary: "auth module uses JWT" },
			{ path: ".memory/test-session/plain.md", filename: "plain.md" }, // no summary ⇒ not a candidate
		];
		const candidates = buildRelevantCandidates(state, topics);
		expect(candidates.map((entry) => entry.id)).toEqual([
			"state:0",
			"state:1",
			"state:2",
			"state:3",
			"topic:.memory/test-session/auth.md",
		]);
		for (const entry of candidates) {
			expect(entry.meta.tokenCount).toBe(estimateStringTokens(entry.text));
		}
	});
});

