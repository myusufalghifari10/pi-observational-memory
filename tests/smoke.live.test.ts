import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { checkAnergy } from "../src/memory/anergy.js";
import type { Topic } from "../src/memory/paths.js";
import { buildObserverPrompt, bridgeContextBlock } from "../src/hooks/observer-trigger.js";
import { Runtime } from "../src/runtime.js";
import { DEFAULTS } from "../src/config.js";
import type { Observation } from "../src/ledger/index.js";

// LIVE smoke: run the real checker against THIS repo's real filesystem.
const REPO = resolve(import.meta.dirname, "..");

describe("LIVE: anergy against the real repo filesystem", () => {
	const topics: Topic[] = [
		{
			filename: "real.md",
			path: ".memory/x/real.md",
			asserts: ["src/ledger/fold.ts#foldLedger", "src/ledger/types.ts#OM_FOLDED", "package.json"],
		},
		{
			filename: "half-broken.md",
			path: ".memory/x/half-broken.md",
			asserts: ["src/ledger/types.ts", "src/this-file-does-not-exist.ts"],
		},
		{
			filename: "rearmed.md",
			path: ".memory/x/rearmed.md",
			asserts: ["src/another-missing-file.ts"],
		},
	];

	it("classifies real files: healthy passes, partially-broken lists only the failed one, re-armed forgives", () => {
		const buffer: Observation[] = [{ timestamp: "2026-09-21T00:00:00", content: "moved things into src/another-missing-file.ts", tokenCount: 10 }];
		const report = checkAnergy(topics, REPO, buffer);

		expect(report.has("real.md")).toBe(false); // real file + real symbols → healthy
		expect(report.get("half-broken.md")).toEqual(["src/this-file-does-not-exist.ts"]); // only the missing one fails
		expect(report.has("rearmed.md")).toBe(false); // buffer observation mentions its path → re-armed
	});
});

describe("LIVE: serial queue state transitions", () => {
	it("walks the real Runtime through a serialized worker lifecycle", () => {
		const runtime = new Runtime();
		runtime.config = { ...DEFAULTS, serialWorkers: true };

		// Idle → one observer slot.
		expect(runtime.observerSlotsAvailable).toBe(1);
		const controller = new AbortController();
		runtime.observersInFlight.set("r1", { controller, coversUpToId: "raw-1" });

		// Observer running → slot closed for observers AND consolidator cannot start.
		expect(runtime.observerSlotsAvailable).toBe(0);

		// Observer settles → slot reopens (the completion pump re-evaluates triggers here).
		runtime.observersInFlight.delete("r1");
		expect(runtime.observerSlotsAvailable).toBe(1);

		// Consolidator takes the slot → observers queue behind it.
		runtime.consolidatorInFlight = true;
		expect(runtime.observerSlotsAvailable).toBe(0);

		// Consolidator settles → queue drains again.
		runtime.consolidatorInFlight = false;
		expect(runtime.observerSlotsAvailable).toBe(1);
	});
});

describe("LIVE: observer prompt with bridge renders in a realistic shape", () => {
	it("produces the full recorded prompt a worker would receive", () => {
		const buffer: Observation[] = [
			{ timestamp: "2026-09-21T00:01:00", content: "User decided to keep vitest as the test runner", tokenCount: 9 },
			{ timestamp: "2026-09-21T00:02:00", content: "completed: NUL argv guard in buildWorkerArgv", tokenCount: 8 },
		];
		const prompt = buildObserverPrompt("[Source entry id: raw-9]\n[User @ 2026-09-21 05:40]: lanjutkan yang tadi itu", bridgeContextBlock(buffer));
		expect(prompt.indexOf("PREVIOUS CONTEXT")).toBeLessThan(prompt.indexOf("BEGIN CONVERSATION CHUNK"));
		expect(prompt).toContain("2026-09-21T00:02:00  completed: NUL argv guard in buildWorkerArgv");
		const begin = prompt.indexOf("BEGIN CONVERSATION CHUNK");
		const end = prompt.indexOf("END CONVERSATION CHUNK");
		const chunkBody = prompt.indexOf("lanjutkan yang tadi itu");
		expect(chunkBody).toBeGreaterThan(begin);
		expect(chunkBody).toBeLessThan(end);
	});
});
