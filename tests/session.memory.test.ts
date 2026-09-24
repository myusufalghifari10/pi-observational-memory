import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionMemoryRoot } from "../src/memory/paths.js";
import { collectRuns, ensureSessionMemory, RUNS_MAX_AGE_MS } from "../src/memory/session.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-session-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** Minimal session-file header line, as written by pi's SessionManager. */
function writeSessionFile(id: string): string {
	const file = join(cwd, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd })}\n`, "utf-8");
	return file;
}

function fakeCtx(sessionId: string, header?: { parentSession?: string }) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ id: sessionId, cwd, ...header }),
		},
	};
}

describe("ensureSessionMemory", () => {
	it("returns the per-session root and does not create it without a parent", () => {
		const root = ensureSessionMemory(fakeCtx("child"));
		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		// Lazy: nothing to seed, so the dir is left for the first durable write to create.
		expect(existsSync(root)).toBe(false);
	});

	it("seeds from the parent session on first touch, excluding .runs/", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		mkdirSync(join(parentRoot, ".runs"), { recursive: true });
		writeFileSync(join(parentRoot, "auth.md"), "---\nid: auth\n---\nbody", "utf-8");
		writeFileSync(join(parentRoot, "JOURNEY.md"), "## history", "utf-8");
		writeFileSync(join(parentRoot, ".runs", "obs-1.cost.json"), "{}", "utf-8");

		const parentFile = writeSessionFile("parent");
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));

		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("body");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## history");
		// Transient IPC is never carried across the fork.
		expect(existsSync(join(root, ".runs"))).toBe(false);
	});

	it("is idempotent: an existing root is never re-seeded from the parent", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		mkdirSync(parentRoot, { recursive: true });
		writeFileSync(join(parentRoot, "auth.md"), "parent copy", "utf-8");
		const parentFile = writeSessionFile("parent");

		// Child already has its own divergent memory — seeding must not clobber it.
		const childRoot = sessionMemoryRoot(cwd, "child");
		mkdirSync(childRoot, { recursive: true });
		writeFileSync(join(childRoot, "auth.md"), "child copy", "utf-8");

		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toBe("child copy");
	});

	it("skips seeding when the parent kept no memory under this project", () => {
		const parentFile = writeSessionFile("parent"); // no parent memory root on disk
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(existsSync(root)).toBe(false);
	});
});

describe("collectRuns (P0.7 .runs/ GC)", () => {
	const DAY = 24 * 60 * 60 * 1000;

	it("removes only files older than the 7-day window", () => {
		const root = join(cwd, "sess");
		const runs = join(root, ".runs");
		mkdirSync(runs, { recursive: true });
		const old = join(runs, "obs-old.result.json");
		const fresh = join(runs, "obs-fresh.result.json");
		const inFlight = join(runs, "obs-inflight.result.json");
		writeFileSync(old, "{}", "utf-8");
		writeFileSync(fresh, "{}", "utf-8");
		writeFileSync(inFlight, "{}", "utf-8");

		const now = Date.now();
		utimesSync(old, new Date(now - (RUNS_MAX_AGE_MS + DAY)), new Date(now - (RUNS_MAX_AGE_MS + DAY)));
		utimesSync(fresh, new Date(now - DAY), new Date(now - DAY)); // 1 day old → keep
		utimesSync(inFlight, new Date(now - 5 * DAY), new Date(now - 5 * DAY)); // 5 days → keep

		const removed = collectRuns(root);
		expect(removed).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(inFlight)).toBe(true); // recent handoffs survive a restart
	});

	it("is a no-op when there is no .runs directory (returns 0, never throws)", () => {
		const root = join(cwd, "no-runs");
		mkdirSync(root, { recursive: true });
		expect(collectRuns(root)).toBe(0);
	});

	it("leaves sibling memory files untouched", () => {
		const root = join(cwd, "sess2");
		const runs = join(root, ".runs");
		mkdirSync(runs, { recursive: true });
		const old = join(runs, "stale.json");
		writeFileSync(old, "{}", "utf-8");
		utimesSync(old, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
		const topic = join(root, "auth.md"); // durable memory file beside .runs/
		writeFileSync(topic, "---\nid: auth\n---\nkeep", "utf-8");

		collectRuns(root);
		expect(existsSync(topic)).toBe(true);
		expect(readFileSync(topic, "utf-8")).toContain("keep");
	});
});
