import { describe, expect, it } from "vitest";

import { buildCompactionProjection, fullProjection, visibleProjection } from "../src/ledger/index.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	textCustomMessage,
} from "./fixtures/session.js";

describe("buildCompactionProjection", () => {
	it("includes observations covered up to the cutoff and excludes those after it", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-2" }),
			textCustomMessage("raw-3", "cccc"), // verbatim tail begins here
		];

		// Cut so raw-3 stays verbatim; observations covering raw-1..raw-2 are rendered.
		const projection = buildCompactionProjection(entries, "raw-3");
		expect(projection.observations.map((o) => o.timestamp)).toEqual([
			"2026-05-02T10:00:01",
			"2026-05-02T10:05:00",
		]);
		expect(projection.details).toEqual({
			type: "om.folded",
			version: 1,
			observations: projection.observations,
		});
	});

	it("excludes observations whose source lies inside the verbatim tail", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-2" }),
		];

		// Cut at raw-2 → raw-2's observation is in the kept tail, so not rendered.
		const projection = buildCompactionProjection(entries, "raw-2");
		expect(projection.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
	});

	it("applies promotion tombstones within the cutoff (Phase B drops)", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01"), observation("2026-05-02T10:00:02")],
				coversUpToId: "raw-1",
			}),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["2026-05-02T10:00:01"], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbb"),
		];

		const projection = buildCompactionProjection(entries, "raw-2");
		expect(projection.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:02"]);
	});

	it("drops observations tombstoned by an om.observations.dropped entry whose coversUpToId is inside the verbatim tail", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01"), observation("2026-05-02T10:00:02")],
				coversUpToId: "raw-1",
			}),
			textCustomMessage("raw-2", "bbbb"), // verbatim tail starts here
			textCustomMessage("raw-3", "cccc"), // branch tip inside verbatim tail
			observationsDroppedEntry("om-drop-tip", {
				observationTimestamps: ["2026-05-02T10:00:01"],
				coversUpToId: "raw-3",
			}),
		];

		const projection = buildCompactionProjection(entries, "raw-2");
		expect(projection.observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:02"]);
		// Tree navigation at an earlier entry before the drop entry still retains the observation.
		expect(fullProjection(entries, "raw-2").observations.map((o) => o.timestamp)).toEqual([
			"2026-05-02T10:00:01",
			"2026-05-02T10:00:02",
		]);
	});
});

describe("visibleProjection", () => {
	it("reads observations back from the latest compaction details when at the tip", () => {
		const entries = [
			compactionEntry("cmp-1", {
				firstKeptEntryId: "raw-2",
				details: memoryDetails({ observations: [observation("2026-05-02T10:00:01")] }),
			}),
			textCustomMessage("raw-2", "bbbb"),
		];
		expect(visibleProjection(entries).observations.map((o) => o.timestamp)).toEqual(["2026-05-02T10:00:01"]);
	});

	it("returns empty when there is no compaction", () => {
		expect(visibleProjection([textCustomMessage("raw-1", "aaaa")]).observations).toEqual([]);
	});
});
