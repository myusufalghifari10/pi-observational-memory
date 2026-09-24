import { describe, expect, it } from "vitest";

import { assignObservationTimestamps } from "../src/ids.js";
import { rawMessage, textCustomMessage, toolResultMessage } from "./fixtures/session.js";

describe("assignObservationTimestamps (L5)", () => {
	it("derives a second-resolution id base from the model's minute timestamp", () => {
		const result = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content: "hi there" }]);
		expect(result).toEqual([
			{ timestamp: "2026-06-25T14:30:00", content: "hi there", tokenCount: 2, kind: "event" },
		]);
	});

	it("disambiguates same-minute observations with .NN suffixes in emission order", () => {
		const result = assignObservationTimestamps([
			{ timestamp: "2026-06-25 14:30", content: "first" },
			{ timestamp: "2026-06-25 14:30", content: "second" },
			{ timestamp: "2026-06-25 14:30", content: "third" },
		]);
		expect(result.map((o) => o.timestamp)).toEqual([
			"2026-06-25T14:30:00",
			"2026-06-25T14:30:00.01",
			"2026-06-25T14:30:00.02",
		]);
	});

	it("avoids collisions against already-used timestamps from the existing buffer", () => {
		const result = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content: "new" }], {
			used: ["2026-06-25T14:30:00", "2026-06-25T14:30:00.01"],
		});
		expect(result[0].timestamp).toBe("2026-06-25T14:30:00.02");
	});

	it("falls back to the anchor time when the model timestamp is malformed", () => {
		const anchor = new Date("2026-06-25T09:15:42").getTime();
		const result = assignObservationTimestamps([{ timestamp: "not a time", content: "x" }], { fallbackAnchor: anchor });
		expect(result[0].timestamp).toBe("2026-06-25T09:15:42");
	});

	it("computes tokenCount in code, never from the model", () => {
		const content = "a".repeat(40);
		const [obs] = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content }]);
		expect(obs.tokenCount).toBe(10);
	});

	it("passes a valid model-declared kind through (P1.1)", () => {
		const result = assignObservationTimestamps([
			{ timestamp: "2026-06-25 14:30", content: "User prefers dark mode (switching from light)", kind: "preference" },
		]);
		expect(result[0].kind).toBe("preference");
	});

	it("falls back to kind event when the model emits an unknown kind (P1.1)", () => {
		const result = assignObservationTimestamps([
			{ timestamp: "2026-06-25 14:30", content: "plain event", kind: "vibes" },
			{ timestamp: "2026-06-25 14:31", content: "no kind at all" },
		]);
		expect(result.map((o) => o.kind)).toEqual(["event", "event"]);
	});

	it("derives sourceEntryId from the bounding source entry of the slice (L1)", () => {
		const slice = [
			rawMessage("u-1000", "hi", { timestamp: "2026-05-02T10:00:00" }),
			toolResultMessage("tr-1007", "output", { timestamp: "2026-05-02T10:07:00" }),
			textCustomMessage("cm-1010", "note", { timestamp: "2026-05-02T10:10:00" }),
		];
		const result = assignObservationTimestamps(
			[
				{ timestamp: "2026-05-02 10:00", content: "from the user message", kind: "assertion" },
				{ timestamp: "2026-05-02 10:07", content: "from the tool result" },
				{ timestamp: "2026-05-02 11:00", content: "after every entry" },
			],
			{ slice },
		);
		expect(result[0].sourceEntryId).toBe("u-1000");
		expect(result[1].sourceEntryId).toBe("tr-1007");
		expect(result[2].sourceEntryId).toBe("cm-1010"); // fallback: slice's last entry
	});

	it("omits sourceEntryId when no slice is provided", () => {
		const [obs] = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content: "x" }]);
		expect(obs.sourceEntryId).toBeUndefined();
	});
});
