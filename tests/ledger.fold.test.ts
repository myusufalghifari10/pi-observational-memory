import { describe, expect, it } from "vitest";

import { foldLedger, isObservationsGapData, OM_OBSERVATIONS_GAP } from "../src/ledger/index.js";
import {
	branchSummary,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	textCustomMessage,
	unknownCustomEntry,
	type TestObservation,
} from "./fixtures/session.js";

describe("foldLedger (minimal schema, timestamp-keyed)", () => {
	it("folds observations from branch root through the target entry", () => {
		const obs1 = observation("2026-05-02T10:00:01");
		const obs2 = observation("2026-05-02T10:05:00");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs1], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [obs2], coversUpToId: "raw-2" }),
		];

		const folded = foldLedger(entries, { upToEntryId: "om-1" });

		expect(folded.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(folded.activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(folded.observationsByTimestamp.get("2026-05-02T10:05:00")).toBeUndefined();
	});

	it("applies drops as tombstones while preserving observation history", () => {
		const obs1 = observation("2026-05-02T10:00:01");
		const obs2 = observation("2026-05-02T10:00:02");
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [obs1, obs2], coversUpToId: "raw-1" }),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01", "2026-05-02T10:00:02"]);
		expect(folded.activeObservations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:02"]);
		expect(folded.droppedObservationTimestamps.has("2026-05-02T10:00:01")).toBe(true);
		expect(folded.observationsByTimestamp.get("2026-05-02T10:00:01")).toEqual(obs1);
	});

	it("keeps the first valid observation when duplicate timestamp-ids appear", () => {
		const first = observation("2026-05-02T10:00:01", { content: "first" });
		const dup = observation("2026-05-02T10:00:01", { content: "duplicate" });
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [first], coversUpToId: "raw-1" }),
			observationsRecordedEntry("om-2", { observations: [dup], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observationsByTimestamp.get("2026-05-02T10:00:01")?.content).toBe("first");
		expect(folded.observations).toHaveLength(1);
	});

	it("retains tombstones for unknown drop timestamps without throwing", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["2099-01-01T00:00:00"], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.droppedObservationTimestamps.has("2099-01-01T00:00:00")).toBe(true);
		expect(folded.activeObservations).toEqual([]);
	});

	it("ignores unknown custom entries and invalid data", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			unknownCustomEntry("other", "other.memory", { any: true }),
			observationsRecordedEntry("invalid", { observations: [], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toEqual([]);
		expect(folded.activeObservations).toEqual([]);
	});

	it("folds only the branch path supplied by the caller", () => {
		const mainObs = observation("2026-05-02T10:00:01");
		const forkObs = observation("2026-05-02T11:00:01");
		const mainBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-main", "main"),
			observationsRecordedEntry("main-ledger", { observations: [mainObs], coversUpToId: "raw-main" }),
		];
		const forkBranch = [
			branchSummary("root", "root summary"),
			textCustomMessage("raw-fork", "fork"),
			observationsRecordedEntry("fork-ledger", { observations: [forkObs], coversUpToId: "raw-fork" }),
		];

		expect(foldLedger(mainBranch).observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
		expect(foldLedger(forkBranch).observations.map((o) => o.timestamp)).toEqual(["2026-05-02T11:00:01"]);
	});

	it("accepts v1 observations without kind/sourceEntryId (C5 backward compat)", () => {
		const legacy = observation("2026-05-02T10:00:01"); // no kind, no sourceEntryId
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [legacy], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toHaveLength(1);
		expect(folded.observations[0].kind).toBeUndefined();
		expect(folded.observations[0].sourceEntryId).toBeUndefined();
	});

	it("folds v2 observations carrying kind and sourceEntryId untouched", () => {
		const typed = observation("2026-05-02T10:00:01", {
			content: "User stated they prefer dark mode (switching from light)",
			kind: "assertion",
			sourceEntryId: "raw-1",
		});
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [typed], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations[0].kind).toBe("assertion");
		expect(folded.observations[0].sourceEntryId).toBe("raw-1");
	});

	it("ignores a recorded entry whose observation carries an invalid kind", () => {
		// Deliberately invalid kind: the runtime validator must reject it, so it cannot
		// satisfy the compile-time union — cast at the fixture boundary only (assertion intact).
		const bogus = observation("2026-05-02T10:00:01", { kind: "vibes" } as unknown as Partial<TestObservation>);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [bogus], coversUpToId: "raw-1" }),
		];

		const folded = foldLedger(entries);

		expect(folded.observations).toEqual([]);
	});
});

// ─── P3.1 (§2.4) — om.observations.gap: validator + fold.gaps ───

describe("P3.1 gap entries (validator + fold.gaps)", () => {
	/** Local builder: fixtures/session.ts is out of scope for this phase's authority. */
	function gapEntry(
		id: string,
		data: Record<string, unknown>,
	): { type: string; id: string; customType: string; data: unknown; parentId: null; timestamp: string } {
		return {
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-09-25T10:00:00",
			customType: OM_OBSERVATIONS_GAP,
			data,
		};
	}

	it("isObservationsGapData accepts the two locked shapes and rejects malformed ones", () => {
		// attempts:0 — the clean empty-chunk ack (§2.4 locked solution).
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: 0, lastError: "no observations extracted" })).toBe(true);
		// attempts:2 — the give-up marker; afterEntryId absent for the very first chunk.
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: 2, lastError: "observer exited with code 1" })).toBe(true);
		// with a start id
		expect(isObservationsGapData({ afterEntryId: "raw-1", coversUpToId: "raw-4", attempts: 2 })).toBe(true);

		expect(isObservationsGapData(undefined)).toBe(false);
		expect(isObservationsGapData("gap")).toBe(false);
		expect(isObservationsGapData({ attempts: 2 })).toBe(false); // missing coversUpToId
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: -1 })).toBe(false);
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: 1.5 })).toBe(false);
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: "two" })).toBe(false);
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: 2, afterEntryId: 42 })).toBe(false); // strict-when-present
		expect(isObservationsGapData({ coversUpToId: "raw-4", attempts: 2, lastError: 7 })).toBe(false);
	});

	it("fold.gaps collects valid gaps in branch order (attempts 0 and 2 alike) and skips invalid data", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			gapEntry("gap-1", { coversUpToId: "raw-1", attempts: 0, lastError: "no observations extracted" }),
			textCustomMessage("raw-2", "bbbb"),
			gapEntry("gap-2", { afterEntryId: "raw-1", coversUpToId: "raw-2", attempts: 2, lastError: "boom" }),
			gapEntry("gap-3", { coversUpToId: "" }), // invalid: empty coversUpToId
		];

		const folded = foldLedger(entries);

		expect(folded.gaps).toHaveLength(2);
		expect(folded.gaps[0]).toMatchObject({ coversUpToId: "raw-1", attempts: 0 });
		expect(folded.gaps[1]).toMatchObject({ afterEntryId: "raw-1", coversUpToId: "raw-2", attempts: 2 });
		// Branch-local like every other fold surface: nothing past the fold boundary
		// (the boundary cuts at raw-1, so gap-1 — which sits after it — is excluded).
		const bounded = foldLedger(entries, { upToEntryId: "raw-1" });
		expect(bounded.gaps).toEqual([]);
	});
});
