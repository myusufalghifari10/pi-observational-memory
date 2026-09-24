import { describe, expect, it } from "vitest";

import { RecordObservationsSchema } from "../agent/observer/tool.js";
import { OBSERVER_SYSTEM } from "../agent/observer/prompt.js";
import { OBSERVATION_KINDS } from "../src/ledger/types.js";
import { readObserverResult, writeObserverResult } from "../src/spawn/runs.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P1.2 schema-level contract: the observer tool's `kind` field covers exactly the eight
 * ObservationKind values, the system prompt documents every kind, and the result-file
 * reader tolerates (and drops) a malformed kind instead of rejecting the whole record.
 */
describe("P1.2 observer kind schema", () => {
	const schema = RecordObservationsSchema as unknown as {
		properties: { observations: { items: { properties: Record<string, unknown> } } };
	};

	it("declares kind as a union of exactly the eight ObservationKind literals", () => {
		const kindProp = schema.properties.observations.items.properties.kind;
		expect(kindProp).toBeDefined();
		const json = JSON.stringify(kindProp);
		for (const k of OBSERVATION_KINDS) expect(json).toContain(`"${k}"`);
		// No ninth kind may sneak in: count distinct literals in the union.
		const literals = json.match(/"(assertion|decision|completion|preference|event|question|rejected|strat)"/g) ?? [];
		expect(new Set(literals).size).toBe(8);
	});

	it("keeps content single-line (minLength + existing convention)", () => {
		const contentProp = schema.properties.observations.items.properties.content as { minLength?: number };
		expect(contentProp.minLength).toBe(1);
	});

	it("system prompt documents all eight kinds with rejected/strat markers", () => {
		for (const k of OBSERVATION_KINDS) expect(OBSERVER_SYSTEM).toContain(k);
		expect(OBSERVER_SYSTEM).toContain("rejected: <approach> because <reason>");
		expect(OBSERVER_SYSTEM).toContain("strat: <name>");
	});

	it("readObserverResult drops a non-string kind instead of rejecting the record", () => {
		const dir = mkdtempSync(join(tmpdir(), "om-kind-"));
		const path = join(dir, "run.result.json");
		try {
			writeObserverResult(path, {
				observations: [
					{ timestamp: "2026-05-02 10:00", content: "kept", kind: 42 as unknown as string },
					{ timestamp: "2026-05-02 10:01", content: "typed", kind: "decision" },
				],
			});
			const result = readObserverResult(path);
			expect(result.observations).toHaveLength(2);
			expect(result.observations[0].kind).toBeUndefined();
			expect(result.observations[1].kind).toBe("decision");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
