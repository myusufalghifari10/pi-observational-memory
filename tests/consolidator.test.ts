import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { CONSOLIDATOR_SYSTEM } from "../agent/consolidator/prompt.js";
import { buildWorkerEnv } from "../src/spawn/launch.js";

describe("P1.4 consolidator duties (prompt)", () => {
	it("declares all seven STATE.md section headings, in plan order", () => {
		const headings = [
			"## Goal",
			"## Constraints",
			"## Plan",
			"## Done",
			"## Blocked",
			"## Next",
			"## Open loops",
		];
		let last = -1;
		for (const heading of headings) {
			const idx = CONSOLIDATOR_SYSTEM.indexOf(heading);
			expect(idx, `missing STATE heading: ${heading}`).toBeGreaterThan(-1);
			expect(idx, `STATE heading out of order: ${heading}`).toBeGreaterThan(last);
			last = idx;
		}
	});

	it("carries the DEATHS.md line convention and the rejected:-routing rule", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain(
			"- rejected: <approach> because <reason> (verify: <path[#symbol]>)",
		);
		expect(CONSOLIDATOR_SYSTEM).toContain('starts with "rejected:"');
		// JOURNEY rules must stay untouched (plan: JOURNEY rules unchanged).
		expect(CONSOLIDATOR_SYSTEM).toContain("STRICTLY DESCRIPTIVE");
	});
});

describe("P4.4 death clustering (prompt)", () => {
	it("instructs merging same-subject rejections into ONE grouped line", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain("CLUSTERING (grouped edges)");
		expect(CONSOLIDATOR_SYSTEM).toContain("merge them into ONE grouped line");
		expect(CONSOLIDATOR_SYSTEM).toContain("instead of one line per attempt");
	});

	it("pins the grouped-edge example shape: - rejected prefix, shared cause, optional verify", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain(
			"- rejected: 3 approaches in auth/ — all because <the surviving reason> (verify: <path[#symbol]>)",
		);
	});

	it("states the acceptance: the 'because' survives, not the log", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain('The "because" survives, not the log');
		expect(CONSOLIDATOR_SYSTEM).toContain("drop the per-attempt history");
	});

	it("keeps the grouped line parseable (the '- rejected:' prefix shape) and never merges distinct causes", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain("'- rejected:' prefix");
		expect(CONSOLIDATOR_SYSTEM).toContain("one parseable entry");
		expect(CONSOLIDATOR_SYSTEM).toContain("Never group rejections whose causes differ");
	});

	it("preserves the P0.11 tool-call hardening and the base DEATHS convention (no regression)", () => {
		expect(CONSOLIDATOR_SYSTEM).toContain("standard mechanism only");
		expect(CONSOLIDATOR_SYSTEM).toContain(
			"- rejected: <approach> because <reason> (verify: <path[#symbol]>)",
		);
	});
});

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, and the .memory sandbox root", () => {
		const env = buildWorkerEnv("consolidator", { memoryRoot: "/proj/.memory/sess-1", runId: "c1" });
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_MEMORY_DIR).toBe("/proj/.memory/sess-1");
	});
});

describe("registerConsolidatorTools (scoped to .memory/)", () => {
	let cwd: string;
	let memoryRoot: string;
	let tools: Map<string, any>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		memoryRoot = join(cwd, ".memory");
		tools = new Map();
		const fakePi = { registerTool: (def: any) => tools.set(def.name, def) } as any;
		registerConsolidatorTools(fakePi, memoryRoot);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("registers the scoped tool belt (no terminal report tool)", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"].sort());
	});

	it("write then read a topic file", async () => {
		const res = await tools.get("write").execute("1", { path: "auth.md", content: "---\nid: auth\n---\nbody" });
		expect(res.content[0].text).toContain("Wrote auth.md");
		expect(readFileSync(join(memoryRoot, "auth.md"), "utf-8")).toContain("body");
		const read = await tools.get("read").execute("2", { path: "auth.md" });
		expect(read.content[0].text).toContain("body");
	});

	it("refuses to write or edit INDEX.md", async () => {
		const w = await tools.get("write").execute("1", { path: "INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		expect(existsSync(join(memoryRoot, "INDEX.md"))).toBe(false);
	});

	it("tools allow STATE.md and DEATHS.md writes and edits", async () => {
		const w1 = await tools.get("write").execute("1", { path: "STATE.md", content: "## Goal\nx" });
		expect(w1.content[0].text).toContain("Wrote STATE.md");
		expect(existsSync(join(memoryRoot, "STATE.md"))).toBe(true);
		const e1 = await tools.get("edit").execute("2", { path: "STATE.md", oldText: "x", newText: "y" });
		expect(e1.content[0].text).toContain("Edited");
		const w2 = await tools.get("write").execute("3", {
			path: "DEATHS.md",
			content: "- rejected: X because Y (verify: src/a.ts#f)",
		});
		expect(w2.content[0].text).toContain("Wrote DEATHS.md");
		expect(readFileSync(join(memoryRoot, "DEATHS.md"), "utf-8")).toContain("rejected: X");
	});

	it("still forbids INDEX.md writes and edits alongside the new files", async () => {
		const w = await tools.get("write").execute("1", { path: "INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		const e = await tools.get("edit").execute("2", { path: "INDEX.md", oldText: "x", newText: "y" });
		expect(e.content[0].text).toContain("generated automatically");
		expect(existsSync(join(memoryRoot, "INDEX.md"))).toBe(false);
	});

	it("rejects paths that escape .memory/", async () => {
		const r = await tools.get("write").execute("1", { path: "../escape.md", content: "x" });
		expect(r.content[0].text).toContain("escapes .memory/");
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
	});

	it("normalizes a .memory/-prefixed path to the sandbox root (no nested .memory/)", async () => {
		const res = await tools.get("write").execute("1", { path: ".memory/auth.md", content: "prefixed write" });
		expect(res.content[0].text).toContain("Wrote");
		expect(readFileSync(join(memoryRoot, "auth.md"), "utf-8")).toContain("prefixed write");
		expect(existsSync(join(memoryRoot, ".memory", "auth.md"))).toBe(false);
		const read = await tools.get("read").execute("2", { path: "./.memory/auth.md" });
		expect(read.content[0].text).toContain("prefixed write");
	});

	it("still blocks INDEX.md through a .memory/ prefix", async () => {
		const w = await tools.get("write").execute("1", { path: ".memory/INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		expect(existsSync(join(memoryRoot, ".memory"))).toBe(false);
	});

	it("edit replaces an exact unique substring and rejects ambiguous matches", async () => {
		await tools.get("write").execute("1", { path: "t.md", content: "alpha beta alpha" });
		const ambiguous = await tools.get("edit").execute("2", { path: "t.md", oldText: "alpha", newText: "X" });
		expect(ambiguous.content[0].text).toContain("ambiguous");
		const ok = await tools.get("edit").execute("3", { path: "t.md", oldText: "beta", newText: "BETA" });
		expect(ok.content[0].text).toContain("Edited");
		expect(readFileSync(join(memoryRoot, "t.md"), "utf-8")).toBe("alpha BETA alpha");
	});

	it("ls and grep operate within .memory/", async () => {
		await tools.get("write").execute("1", { path: "auth.md", content: "uses JWT tokens" });
		await tools.get("write").execute("2", { path: "deploy.md", content: "uses fly.io" });
		const ls = await tools.get("ls").execute("3", {});
		expect(ls.content[0].text.split("\n").sort()).toEqual(["auth.md", "deploy.md"]);
		const grep = await tools.get("grep").execute("4", { pattern: "JWT" });
		expect(grep.content[0].text).toContain("auth.md:1");
	});
});
