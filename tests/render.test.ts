import { describe, expect, it } from "vitest";

import { observationToLine, renderSummary, sortObservations } from "../src/ledger/index.js";
import { observation } from "./fixtures/session.js";

describe("renderSummary (Phase A — observations only)", () => {
	it("renders a chronological observations section", () => {
		const observations = [
			observation("2026-05-02T10:05:00", { content: "second event" }),
			observation("2026-05-02T10:00:01", { content: "first event" }),
		];

		const block = renderSummary(undefined, undefined, observations);
		expect(block).toContain("## Observations");
		const obsSection = block.split("## Observations\n")[1];
		expect(obsSection).toBe("2026-05-02T10:00:01  first event\n2026-05-02T10:05:00  second event");
	});

	it("returns an empty string when there is nothing to render", () => {
		expect(renderSummary(undefined, undefined, [])).toBe("");
	});

	it("includes the map section when provided", () => {
		const block = renderSummary(undefined, "## Memory map\nauth.md · auth stuff", [observation("2026-05-02T10:00:01")]);
		expect(block).toContain("## Memory map");
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders the journey first, before map and observations", () => {
		const block = renderSummary("## 2026-05-01\nStarted the project.", "## Memory map\nauth.md · auth", [
			observation("2026-05-02T10:00:01"),
		]);
		expect(block).toContain("## Journey");
		expect(block.indexOf("## Journey")).toBeLessThan(block.indexOf("## Memory map"));
		expect(block.indexOf("## Memory map")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("renders a journey-only block when there are no observations or map", () => {
		const block = renderSummary("## 2026-05-01\nStarted the project.", undefined, []);
		expect(block).toContain("## Journey");
		expect(block).toContain("Started the project.");
	});

	it("tells the reader it can query older memory via knowledge_search", () => {
		const block = renderSummary(undefined, undefined, [observation("2026-05-02T10:00:01")]);
		expect(block).toContain("knowledge_search");
		expect(block.indexOf("knowledge_search")).toBeLessThan(block.indexOf("## Observations"));
	});

	it("formats a single observation line as 'timestamp  content'", () => {
		expect(observationToLine(observation("2026-05-02T10:00:01", { content: "hi" }))).toBe("2026-05-02T10:00:01  hi");
	});

	it("sorts disambiguated same-minute ids in suffix order", () => {
		const sorted = sortObservations([
			observation("2026-05-02T10:00:00.02"),
			observation("2026-05-02T10:00:00"),
			observation("2026-05-02T10:00:00.01"),
		]);
		expect(sorted.map((o) => o.timestamp)).toEqual([
			"2026-05-02T10:00:00",
			"2026-05-02T10:00:00.01",
			"2026-05-02T10:00:00.02",
		]);
	});
});
