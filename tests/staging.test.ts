import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	atomicWrite,
	beginStaging,
	discardStaging,
	ensureGenerationalRoot,
	generationMarkerPath,
	latestGenerationDir,
	promoteStaging,
} from "../src/memory/paths.js";
import { Runtime } from "../src/runtime.js";

const scratchDirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "om-staging-"));
	scratchDirs.push(dir);
	return dir;
}

/** A live memory root with two durable files, one in a subdirectory (strats/), plus .runs/ IPC. */
function liveRootWithContent(base: string): string {
	const live = join(base, "session-1");
	mkdirSync(join(live, "strats"), { recursive: true });
	mkdirSync(join(live, ".runs"), { recursive: true });
	writeFileSync(join(live, "topic.md"), "original topic");
	writeFileSync(join(live, "strats", "deploy.md"), "cue: deploy");
	writeFileSync(join(live, ".runs", "obs-1.result.json"), "{}");
	return live;
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		try {
			chmodSync(dir, 0o700); // a fallback test may have made it read-only
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

describe("staged consolidation generations (S3)", () => {
	it("migrates a real root to a symlink and copies content into an isolated work generation", () => {
		const base = scratch();
		const live = liveRootWithContent(base);

		const roots = beginStaging(live);

		expect(roots.staged).toBe(true);
		expect(roots.work).not.toBe(live);
		expect(lstatSync(live).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
		expect(existsSync(join(roots.work, "topic.md"))).toBe(true);
		expect(existsSync(join(roots.work, "strats", "deploy.md"))).toBe(true);
		expect(existsSync(join(roots.work, ".runs"))).toBe(false); // IPC stays live-only
	});

	it("a write into the work generation never touches the live memory (crash isolation)", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const roots = beginStaging(live);

		// Same call the consolidator's `write`/`edit` tools make (temp + rename).
		atomicWrite(join(roots.work, "topic.md"), "CHANGED BY CONSOLIDATOR");

		expect(readFileSync(join(roots.work, "topic.md"), "utf-8")).toBe("CHANGED BY CONSOLIDATOR");
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
	});

	it("promotes the work generation atomically, exposes it through the live path and GCs the old one", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const unrelated = join(base, "unrelated.md");
		writeFileSync(unrelated, "keep me");
		const roots = beginStaging(live);
		// The generation the LIVE symlink currently points at (the work generation is a different,
		// newer one). This is what promotion must garbage-collect.
		const previous = join(base, readlinkSync(live));

		atomicWrite(join(roots.work, "topic.md"), "new truth");
		expect(promoteStaging(roots)).toBe("promoted");

		expect(lstatSync(live).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("new truth");
		expect(readlinkSync(live)).toBe(roots.work.slice(base.length + 1)); // live now points at the new generation
		expect(existsSync(previous)).toBe(false);
		expect(existsSync(roots.work)).toBe(true);
		expect(existsSync(unrelated)).toBe(true); // never deletes outside the generations
	});

	it("discarding a work generation leaves the live memory byte-identical", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const roots = beginStaging(live);
		const work = roots.work;

		atomicWrite(join(work, "topic.md"), "discard me");
		discardStaging(roots);

		expect(existsSync(work)).toBe(false);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
		expect(readFileSync(join(live, "strats", "deploy.md"), "utf-8")).toBe("cue: deploy");
	});

	it("re-staging is idempotent: a generational root is migrated once, contents carried over", () => {
		const base = scratch();
		const live = liveRootWithContent(base);

		const first = beginStaging(live);
		atomicWrite(join(first.work, "topic.md"), "v2");
		expect(promoteStaging(first)).toBe("promoted");

		const second = beginStaging(live);
		expect(second.staged).toBe(true);
		expect(second.work).not.toBe(first.work);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("v2");
		expect(readFileSync(join(second.work, "topic.md"), "utf-8")).toBe("v2");
		expect(ensureGenerationalRoot(live)).toBe(true);
	});

	it("a fresh root (no live directory yet) becomes live on promote", () => {
		const base = scratch();
		const live = join(base, "session-new");

		const roots = beginStaging(live);
		expect(roots.staged).toBe(true);
		expect(existsSync(live)).toBe(false);

		atomicWrite(join(roots.work, "topic.md"), "first memory");
		expect(promoteStaging(roots)).toBe("promoted");

		expect(existsSync(live)).toBe(true);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("first memory");
	});

	it("self-heals a root that was left orphaned next to its generation directory", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const roots = beginStaging(live);
		atomicWrite(join(roots.work, "topic.md"), "kept");
		expect(promoteStaging(roots)).toBe("promoted");

		const generation = latestGenerationDir(live);
		rmSync(live, { force: true }); // simulate: symlink lost, generation remains

		expect(ensureGenerationalRoot(live)).toBe(true);
		expect(lstatSync(live).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("kept");
		expect(latestGenerationDir(live)).toBe(generation);
	});

	it("recovers the PROMOTED generation, never a leaked work generation from a SIGKILLed run (N3)", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const roots = beginStaging(live);
		atomicWrite(join(roots.work, "topic.md"), "promoted content");
		expect(promoteStaging(roots)).toBe("promoted");
		const promoted = latestGenerationDir(live);
		expect(promoted).toBeDefined();

		// A SIGKILLed run never runs `finally`, so its half-written work generation survives — with a
		// HIGHER generation number than the promoted one. "Newest wins" would adopt those partial
		// writes as live memory; the promoted-generation marker must win instead.
		const leaked = join(base, "session-1.g9");
		mkdirSync(leaked, { recursive: true });
		writeFileSync(join(leaked, "topic.md"), "half-written by a killed run");
		rmSync(live, { force: true }); // ...and then the symlink is lost too

		expect(ensureGenerationalRoot(live)).toBe(true);
		expect(readlinkSync(live)).toBe(basename(promoted!));
		// The recovery followed the RECORDED generation — not "newest", which is the leaked one.
		expect(readFileSync(generationMarkerPath(live), "utf-8").trim()).toBe(basename(promoted!));
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("promoted content");
	});

	it("falls back to the newest generation when no promoted-generation marker exists (N3)", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const roots = beginStaging(live);
		expect(promoteStaging(roots)).toBe("promoted");
		const promoted = latestGenerationDir(live);

		rmSync(generationMarkerPath(live), { force: true }); // legacy root: nothing recorded
		rmSync(live, { force: true });

		expect(ensureGenerationalRoot(live)).toBe(true);
		expect(lstatSync(live).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
		expect(latestGenerationDir(live)).toBe(promoted);
	});

	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"falls back to in-place when the root cannot be migrated (read-only parent)",
		() => {
			const base = scratch();
			const live = liveRootWithContent(base);
			chmodSync(base, 0o500);
			try {
				const roots = beginStaging(live);
				expect(roots.staged).toBe(false);
				expect(roots.work).toBe(live);
				expect(lstatSync(live).isDirectory()).toBe(true);
				expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
				// Nothing was staged, so commit reports the in-place outcome rather than a fake success.
				expect(promoteStaging(roots)).toBe("in-place");
			} finally {
				chmodSync(base, 0o700);
			}
		},
	);
});

describe("Runtime staging lifecycle", () => {
	it("begin → commit promotes the work generation and clears the staging state", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const runtime = new Runtime();
		runtime.memoryRoot = live;

		const roots = runtime.beginStaging();
		expect(runtime.staging).toEqual(roots);
		atomicWrite(join(roots.work, "topic.md"), "committed");
		expect(runtime.commitStaging()).toBe("promoted");
		expect(runtime.staging).toBeUndefined();
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("committed");
	});

	it("begin → abort discards the work generation and leaves live untouched", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const runtime = new Runtime();
		runtime.memoryRoot = live;

		const roots = runtime.beginStaging();
		atomicWrite(join(roots.work, "topic.md"), "never committed");
		runtime.abortStaging();

		expect(runtime.staging).toBeUndefined();
		expect(existsSync(roots.work)).toBe(false);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
		expect(runtime.commitStaging()).toBe("failed"); // nothing left to promote
	});

	it("abortAllWorkers discards a staged run (teardown never promotes)", () => {
		const base = scratch();
		const live = liveRootWithContent(base);
		const runtime = new Runtime();
		runtime.memoryRoot = live;

		const roots = runtime.beginStaging();
		runtime.abortAllWorkers();

		expect(runtime.staging).toBeUndefined();
		expect(existsSync(roots.work)).toBe(false);
		expect(readFileSync(join(live, "topic.md"), "utf-8")).toBe("original topic");
	});

	it("is a no-op when no session memory root is resolved yet", () => {
		const runtime = new Runtime();
		const roots = runtime.beginStaging();
		expect(roots).toEqual({ live: "", work: "", staged: false });
		expect(runtime.staging).toBeUndefined();
		expect(runtime.commitStaging()).toBe("failed");
	});
});
