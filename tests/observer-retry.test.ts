import { describe, expect, it } from "vitest";

import { clearSliceFailure, recordSliceFailure, takeRetrySlice } from "../src/hooks/observer-trigger.js";
import { Runtime } from "../src/runtime.js";
import { textCustomMessage } from "./fixtures/session.js";

/** Four source entries so a slice's range is observable. */
function branchFixture() {
	return [
		textCustomMessage("raw-1", "abcd"),
		textCustomMessage("raw-2", "efgh"),
		textCustomMessage("raw-3", "ijkl"),
		textCustomMessage("raw-4", "mnop"),
	];
}

/** Budget large enough that the whole range after a watermark fits in one slice. */
const BIG_BUDGET = 100_000;

describe("observer-failure retry state (Runtime.failedSlices)", () => {
	it("a fresh Runtime starts with an empty failedSlices array", () => {
		const runtime = new Runtime();
		expect(Array.isArray(runtime.failedSlices)).toBe(true);
		expect(runtime.failedSlices).toEqual([]);
	});

	it("record + take returns the same range (recomputed via selectSourceSlice)", () => {
		const runtime = new Runtime();
		const branch = branchFixture();
		recordSliceFailure(runtime, "raw-1", "raw-4");
		expect(runtime.failedSlices).toHaveLength(1);
		expect(runtime.failedSlices[0]?.attempts).toBe(1);

		const taken = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(taken).toBeDefined();
		expect(taken?.afterEntryId).toBe("raw-1");
		expect(taken?.slice.coversUpToId).toBe("raw-4");
		expect(taken?.slice.entries.map((entry) => entry.id)).toEqual(["raw-2", "raw-3", "raw-4"]);
	});

	it("record accepts an undefined afterEntryId (retry of the very first chunk)", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, undefined, "raw-2");
		const taken = takeRetrySlice(branchFixture(), runtime, BIG_BUDGET);
		expect(taken?.afterEntryId).toBeUndefined();
		expect(taken?.slice.coversUpToId).toBe("raw-2");
		expect(taken?.slice.entries.map((entry) => entry.id)).toEqual(["raw-1", "raw-2"]);
	});

	it("clear then take returns undefined; clearing an unknown id is a no-op", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		clearSliceFailure(runtime, "raw-2");
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();

		expect(() => clearSliceFailure(runtime, "no-such-id")).not.toThrow();
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});

	it("a coversUpToId failing twice is discarded (give up after 2 total attempts)", () => {
		const runtime = new Runtime();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		expect(runtime.failedSlices).toHaveLength(1);
		// same coversUpToId upserts and increments attempts to 2 → entry dropped
		recordSliceFailure(runtime, "raw-1", "raw-2");
		expect(runtime.failedSlices).toEqual([]);
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});

	it("two failed entries retry oldest-first (insertion order)", () => {
		const runtime = new Runtime();
		const branch = branchFixture();
		recordSliceFailure(runtime, "raw-1", "raw-2");
		recordSliceFailure(runtime, "raw-2", "raw-4");

		const first = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(first?.slice.coversUpToId).toBe("raw-2");
		clearSliceFailure(runtime, "raw-2");

		const second = takeRetrySlice(branch, runtime, BIG_BUDGET);
		expect(second?.afterEntryId).toBe("raw-2");
		expect(second?.slice.coversUpToId).toBe("raw-4");
	});

	it("takeRetrySlice on empty failedSlices returns undefined", () => {
		const runtime = new Runtime();
		expect(takeRetrySlice(branchFixture(), runtime, BIG_BUDGET)).toBeUndefined();
	});
});
