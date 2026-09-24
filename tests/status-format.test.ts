/**
 * P0.8 — /om:status journey over-size warning (visibility only, no enforcement).
 *
 * The user's decision: growth of JOURNEY.md on a long session is fine; only surface it when
 * the journey passes 2× its token target. Format helpers are extracted from the command so
 * they can be asserted without driving the TUI.
 */
import { describe, expect, it } from "vitest";

import { formatJourneyLine } from "../src/commands/status.js";
import { estimateStringTokens } from "../src/tokens.js";

const TARGET = 1_000;
const estimate = estimateStringTokens;

describe("P0.8 journey over-size warn", () => {
	it("reports none yet when the journey is absent", () => {
		expect(formatJourneyLine(undefined, TARGET, estimate)).toBe("journey: none yet");
	});

	it("stays quiet within the target", () => {
		const journey = "word ".repeat(100); // well under 1000 tokens
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).toContain("journey: ~");
		expect(line).not.toContain("OVER TARGET");
	});

	it("stays quiet between target and 2× target (growth is fine)", () => {
		const journey = "x".repeat(1_500); // ~375 tokens: over target, under 2×
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).not.toContain("OVER TARGET");
	});

	it("flags OVER TARGET once past 2× the target", () => {
		const journey = "x".repeat(10_000); // ~2500 tokens > 2×1000
		const line = formatJourneyLine(journey, TARGET, estimate);
		expect(line).toContain("⚠ OVER TARGET");
		expect(line).toContain(`/ ${TARGET.toLocaleString()} tok`);
	});
});
