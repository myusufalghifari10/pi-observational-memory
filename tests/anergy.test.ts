import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkAnergy } from "../src/memory/anergy.js";
import { parseFrontMatter, type Topic } from "../src/memory/paths.js";
import { renderMemoryMap } from "../src/memory/index-render.js";
import type { Observation } from "../src/ledger/index.js";

const obs = (content: string): Observation => ({ timestamp: "2026-09-21T00:00:00", content, tokenCount: 10 });

const topic = (filename: string, asserts: string[] | undefined, path?: string): Topic => ({
	filename,
	path: path ?? `.memory/sess-1/${filename}`,
	asserts,
});

describe("parseFrontMatter: asserts", () => {
	it("parses a comma-separated asserts line, trimming entries and stripping quotes", () => {
		const { front } = parseFrontMatter('---\nid: auth\nasserts: src/a.ts, src/b.ts#handle, "docs/c.md"\n---\nbody');
		expect(front.asserts).toEqual(["src/a.ts", "src/b.ts#handle", "docs/c.md"]);
	});

	it("drops empty entries and omits the field entirely when empty/absent", () => {
		expect(parseFrontMatter("---\nasserts:  , ,\n---\nbody").front.asserts).toBeUndefined();
		expect(parseFrontMatter("---\nid: x\n---\nbody").front.asserts).toBeUndefined();
	});
});

describe("checkAnergy", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-anergy-"));
		writeFileSync(join(cwd, "keep.ts"), "export function handle() {}\nexport const other = 1;\n");
		mkdirSync(join(cwd, "dir"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("passes a topic whose file and symbol assertions hold", () => {
		const report = checkAnergy([topic("t.md", ["keep.ts", "keep.ts#handle"])], cwd, []);
		expect(report.size).toBe(0);
	});

	it("flags a topic whose asserted file is gone", () => {
		const report = checkAnergy([topic("t.md", ["gone/gone.ts"])], cwd, []);
		expect(report.get("t.md")).toEqual(["gone/gone.ts"]);
	});

	it("flags a missing symbol in an existing file", () => {
		const report = checkAnergy([topic("t.md", ["keep.ts#nonexistent"])], cwd, []);
		expect(report.get("t.md")).toEqual(["keep.ts#nonexistent"]);
	});

	it("accepts a directory assertion without a symbol", () => {
		const report = checkAnergy([topic("t.md", ["dir"])], cwd, []);
		expect(report.size).toBe(0);
	});

	it("re-arms a failed assertion when an active observation mentions the path", () => {
		const report = checkAnergy([topic("t.md", ["gone/gone.ts"])], cwd, [obs("completed: ported auth to gone/gone.ts")]);
		expect(report.size).toBe(0);
	});

	it("treats unreadable paths as pass (IO error must never demote)", () => {
		// existsSync=true but openSync throws EACCES → must count as pass, not absence.
		const guarded = join(cwd, "secret.ts");
		writeFileSync(guarded, "export const x = 1;\n");
		chmodSync(guarded, 0o000);
		try {
			const report = checkAnergy([topic("t.md", ["secret.ts#x"])], cwd, []);
			expect(report.size).toBe(0);
		} finally {
			chmodSync(guarded, 0o644);
		}
	});

	it("exempts topics without asserts", () => {
		const report = checkAnergy([topic("a.md", undefined), topic("b.md", [])], cwd, []);
		expect(report.size).toBe(0);
	});

	it("caps the checked assertions per topic", () => {
		const asserts = Array.from({ length: 30 }, (_, i) => `gone/f${i}.ts`);
		const report = checkAnergy([topic("t.md", asserts)], cwd, []);
		expect(report.get("t.md")).toHaveLength(20);
	});
});

describe("renderMemoryMap with anergy", () => {
	const topics: Topic[] = [
		topic("healthy.md", undefined, ".memory/sess-1/healthy.md"),
		topic("stale.md", undefined, ".memory/sess-1/stale.md"),
	];

	it("renders an anergic topic as a stub with the failed assertion, others normally", () => {
		const map = renderMemoryMap(topics, new Map([["stale.md", ["gone/gone.ts#handle"]]]))!;
		expect(map).toContain(".memory/sess-1/stale.md` — anergic: gone/gone.ts#handle no longer holds");
		// The anergic stub must NOT carry a summary line of its own.
		const staleLine = map.split("\n").find((line) => line.includes("stale.md"))!;
		expect(staleLine).not.toContain("(no summary)");
		expect(map).toContain(".memory/sess-1/healthy.md` —");
	});

	it("renders all topics normally when no report is given", () => {
		const map = renderMemoryMap(topics);
		expect(map).not.toContain("anergic");
	});
});
