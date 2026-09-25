import { describe, expect, it } from "vitest";

import { foldLedger, renderSummary, renderSummaryV2 } from "../src/ledger/index.js";
import { buildPackMeta } from "../src/hooks/compaction-hook.js";
import {
	observation,
	observationsRecordedEntry,
	observationsSupersededEntry,
	rawMessage,
	type TestEntry,
	type TestObservation,
} from "./fixtures/session.js";

/** Fixture session: two committed observation chunks over two raw messages (full v2 metadata). */
function fixture(): { branch: TestEntry[]; a: TestObservation; b: TestObservation } {
	const a = observation("2026-05-02T10:00:00", {
		content: "auth module uses JWT",
		kind: "event",
		sourceEntryId: "e1",
		tokenCount: 10,
	});
	const b = observation("2026-05-02T10:01:00", {
		content: "tests wired via vitest",
		kind: "event",
		sourceEntryId: "e1",
		tokenCount: 10,
	});
	const c = observation("2026-05-02T11:00:00", {
		content: "deployment targets linux",
		kind: "event",
		sourceEntryId: "e2",
		tokenCount: 10,
	});
	const branch: TestEntry[] = [
		rawMessage("e1", "set up auth and tests"),
		observationsRecordedEntry("om-1", { observations: [a, b], coversUpToId: "e1" }),
		rawMessage("e2", "deployment plan"),
		observationsRecordedEntry("om-2", { observations: [c], coversUpToId: "e2" }),
	];
	return { branch, a, b };
}

/** Packed render: fold → hook-derived metadata → renderSummaryV2 (the production path). */
function renderPacked(branch: TestEntry[]) {
	const folded = foldLedger(branch);
	return renderSummaryV2({
		observations: folded.observations,
		supersessions: folded.supersessions,
		observationMeta: buildPackMeta(branch, folded),
	});
}

/** L6 fallback render: no metadata handed in at all. */
function renderFallback(branch: TestEntry[]) {
	const folded = foldLedger(branch);
	return renderSummaryV2({ observations: folded.observations, supersessions: folded.supersessions });
}

/** The section [6] body as an array of rendered lines ("" input ⇒ undefined-guarded). */
function observationLines(summary: string): string[] {
	return (summary.split("## Observations\n")[1] ?? "").split("\n");
}

describe("golden determinism (P2.4 — C3 enforced forever)", () => {
	it("packed render is byte-identical across runs", () => {
		const { branch } = fixture();
		const once = renderPacked(branch);
		const twice = renderPacked(branch);
		expect(twice).toEqual(once); // summary AND packExplain
		expect(once.packExplain.fallback).toBe(false);
		const lines = observationLines(once.summary);
		expect(lines).toHaveLength(3);
		for (const fact of ["auth module uses JWT", "tests wired via vitest", "deployment targets linux"]) {
			expect(once.summary).toContain(fact);
		}
	});

	it("fallback render is byte-identical across runs and matches the P1 chronological block", () => {
		const { branch } = fixture();
		const once = renderFallback(branch);
		const twice = renderFallback(branch);
		expect(twice).toEqual(once);
		expect(once.packExplain.fallback).toBe(true);
		const folded = foldLedger(branch);
		expect(once.summary).toBe(renderSummary(undefined, undefined, folded.observations));
	});

	it("after appending a supersession pair the delta is EXACTLY the pair (packed and fallback)", () => {
		const { branch, a, b } = fixture();
		const withPair: TestEntry[] = [
			...branch,
			observationsSupersededEntry("om-3", {
				pairs: [{ oldTimestamp: a.timestamp, newTimestamp: b.timestamp, reason: "lexical-supersession" }],
				coversUpToId: "e2",
			}),
		];

		for (const render of [renderPacked, renderFallback]) {
			const before = observationLines(render(branch).summary);
			const after = observationLines(render(withPair).summary);
			expect(after).toHaveLength(before.length);
			const changes = before.flatMap((line, index) =>
				line === after[index] ? [] : [{ index, from: line, to: after[index] }],
			);
			expect(changes).toHaveLength(2);
			expect(changes[0]).toEqual({
				index: 0,
				from: `${a.timestamp}  auth module uses JWT`,
				to: `${a.timestamp}  believed: auth module uses JWT`,
			});
			expect(changes[1]).toEqual({
				index: 1,
				from: `${b.timestamp}  tests wired via vitest`,
				to: `${b.timestamp}  now: tests wired via vitest`,
			});
		}
	});
});

describe("P4.2 pre-approach guard (golden-pinned instruction line)", () => {
	it("both packed and fallback renders carry the standing DEATHS.md grep reflex", () => {
		const { branch } = fixture();
		for (const summary of [renderPacked(branch).summary, renderFallback(branch).summary]) {
			expect(summary).toContain("Before choosing any new implementation approach");
			expect(summary).toContain("grep .memory/DEATHS.md");
			expect(summary).toContain("rejected approaches and their reasons");
		}
	});
});
