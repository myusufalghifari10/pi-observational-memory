import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertionHolds } from "../src/memory/anergy.js";
import { renderMemoryMap } from "../src/memory/index-render.js";
import { parseDeaths, readDeaths, DEATHS_FILENAME, type Topic } from "../src/memory/paths.js";

// ─── P4.1 — parseDeaths (§2.1 line convention, lenient + deterministic) ───

describe("P4.1 parseDeaths (§2.1 convention)", () => {
	it("parses the full line: approach, reason, and optional (verify:)", () => {
		const entries = parseDeaths(
			["# Deaths", "- rejected: MySQL as the store because ORM lock-in (verify: src/store/mysql.ts)"].join("\n"),
		);
		expect(entries).toEqual([
			{ approach: "MySQL as the store", reason: "ORM lock-in", verify: "src/store/mysql.ts" },
		]);
	});

	it("parses a line without (verify:) — verify stays undefined", () => {
		const entries = parseDeaths("- rejected: shared mutable config because hidden coupling");
		expect(entries).toEqual([{ approach: "shared mutable config", reason: "hidden coupling" }]);
	});

	it("preserves path#symbol verbatim in verify", () => {
		const entries = parseDeaths("- rejected: barrel imports because circular deps (verify: src/index.ts#exportAll)");
		expect(entries[0]?.verify).toBe("src/index.ts#exportAll");
	});

	it("keeps multi-word reasons (only the trailing verify group is stripped)", () => {
		const entries = parseDeaths(
			"- rejected: retry-on-429 loops because they amplify outages under load (verify: src/retry.ts)",
		);
		expect(entries[0]?.reason).toBe("they amplify outages under load");
		expect(entries[0]?.verify).toBe("src/retry.ts");
	});

	it("skips non-convention lines (headings, prose, plain bullets) instead of misparsing", () => {
		const body = [
			"# Rejected approaches",
			"",
			"Notes about the process live here.",
			"- plain bullet without the convention",
			"- possibly-revived: something already revoked", // not a `rejected:` line
			"- rejected: orphan without reason",
		].join("\n");
		expect(parseDeaths(body)).toEqual([]);
	});

	it("returns [] for empty/undefined input and preserves input order (deterministic)", () => {
		expect(parseDeaths(undefined)).toEqual([]);
		expect(parseDeaths("")).toEqual([]);
		expect(parseDeaths("\n  \n")).toEqual([]);
		const body = [
			"- rejected: A because r1",
			"- rejected: B because r2 (verify: x.ts)",
			"- rejected: C because r3",
		].join("\n");
		const first = parseDeaths(body);
		const second = parseDeaths(body);
		expect(first.map((entry) => entry.approach)).toEqual(["A", "B", "C"]);
		expect(second).toEqual(first);
	});
});

// ─── P4.1 — renderMemoryMap death stubs: revocation, never permanent (L11) ───

describe("P4.1 death stubs in section [4] (revocable, never permanent)", () => {
	function makeProject(): string {
		const cwd = mkdtempSync(join(tmpdir(), "om-deaths-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "store.ts"), "export function handle() {}\n");
		return cwd;
	}

	const topic: Topic = { path: ".memory/sid/auth.md", filename: "auth.md", summary: "auth topic" };

	it("verify PASSES ⇒ authoritative `- rejected: … — because …` line after the topic rows", () => {
		const cwd = makeProject();
		try {
			const deaths = {
				entries: parseDeaths("- rejected: MySQL as the store because ORM lock-in (verify: src/store.ts)"),
				projectCwd: cwd,
			};
			const map = renderMemoryMap([topic], undefined, deaths);
			expect(map).toBeDefined();
			const lines = map!.split("\n");
			expect(lines[0]).toBe("## Memory map");
			expect(lines.some((line) => line.includes(".memory/sid/auth.md"))).toBe(true);
			expect(lines.at(-1)).toBe("- rejected: MySQL as the store — because ORM lock-in");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("verify FAILS (artifact gone) ⇒ possibly-revived stub instead of an authoritative line (L11)", () => {
		const cwd = makeProject();
		try {
			const deaths = {
				entries: parseDeaths("- rejected: legacy adapter because scope creep (verify: src/gone.ts)"),
				projectCwd: cwd,
			};
			const line = renderMemoryMap([], undefined, deaths)!.split("\n").at(-1);
			expect(line).toBe(
				"- possibly-revived: legacy adapter — re-verify before retrying (because scope creep)",
			);
			expect(line).toContain("possibly-revived");
			expect(line).toContain("re-verify before retrying");
			expect(line).not.toContain("— because scope creep"); // no authoritative verdict
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("symbol verify: file present but symbol absent ⇒ revoked; symbol present ⇒ authoritative", () => {
		const cwd = makeProject();
		try {
			const withSymbol = renderMemoryMap(
				[],
				undefined,
				{ entries: parseDeaths("- rejected: X because r (verify: src/store.ts#handle)"), projectCwd: cwd },
			)!.split("\n").at(-1);
			expect(withSymbol).toBe("- rejected: X — because r");
			const withoutSymbol = renderMemoryMap(
				[],
				undefined,
				{ entries: parseDeaths("- rejected: X because r (verify: src/store.ts#missingFn)"), projectCwd: cwd },
			)!.split("\n").at(-1);
			expect(withoutSymbol).toBe("- possibly-revived: X — re-verify before retrying (because r)");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("re-verified entries render normally again (revocation is reversible — never permanent)", () => {
		const cwd = makeProject();
		try {
			const entries = parseDeaths("- rejected: config vars because implicit globals (verify: src/config.ts)");
			const gone = renderMemoryMap([], undefined, { entries, projectCwd: cwd })!.split("\n").at(-1);
			expect(gone).toContain("possibly-revived");
			// The artifact comes back: same input, restored file ⇒ authoritative again.
			writeFileSync(join(cwd, "src", "config.ts"), "export const x = 1;\n");
			const restored = renderMemoryMap([], undefined, { entries, projectCwd: cwd })!.split("\n").at(-1);
			expect(restored).toBe("- rejected: config vars — because implicit globals");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("render never touches the file (L11): readDeaths returns the same bytes after render", () => {
		const cwd = makeProject();
		try {
			const root = join(cwd, ".memory", "sid");
			mkdirSync(root, { recursive: true });
			const body = "- rejected: A because r1 (verify: src/gone.ts)\n- rejected: B because r2";
			writeFileSync(join(root, DEATHS_FILENAME), body);
			const before = readDeaths(root);
			renderMemoryMap([], undefined, { entries: parseDeaths(before), projectCwd: cwd });
			renderMemoryMap([topic], undefined, { entries: parseDeaths(before), projectCwd: cwd });
			expect(readDeaths(root)).toBe(before);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("deaths-only (no topics) still renders the section; topic rows come first (§2.3 order)", () => {
		const cwd = makeProject();
		try {
			const deaths = {
				entries: parseDeaths("- rejected: A because r\n- rejected: B because r2 (verify: src/gone.ts)"),
				projectCwd: cwd,
			};
			const deathsOnly = renderMemoryMap([], undefined, deaths);
			expect(deathsOnly?.startsWith("## Memory map")).toBe(true);
			expect(deathsOnly!.split("\n")).toHaveLength(4); // heading + intro + 2 death lines

			const both = renderMemoryMap([topic], undefined, deaths)!.split("\n");
			const topicIdx = both.findIndex((line) => line.includes(".memory/sid/auth.md"));
			const rejectedIdx = both.findIndex((line) => line.startsWith("- rejected:"));
			const revivedIdx = both.findIndex((line) => line.startsWith("- possibly-revived:"));
			expect(topicIdx).toBeGreaterThan(0);
			expect(rejectedIdx).toBeGreaterThan(topicIdx);
			expect(revivedIdx).toBeGreaterThan(rejectedIdx);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("double render of identical input is byte-identical (C3)", () => {
		const cwd = makeProject();
		try {
			const deaths = {
				entries: parseDeaths("- rejected: A because r\n- rejected: B because r2 (verify: src/gone.ts)"),
				projectCwd: cwd,
			};
			expect(renderMemoryMap([topic], undefined, deaths)).toBe(renderMemoryMap([topic], undefined, deaths));
			expect(renderMemoryMap([], undefined, deaths)).toBe(renderMemoryMap([], undefined, deaths));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("assertionHolds is the SAME semantics anergy uses (exported, side-effect-free)", () => {
		const cwd = makeProject();
		try {
			expect(assertionHolds(join(cwd, "src", "store.ts"), undefined)).toBe(true);
			expect(assertionHolds(join(cwd, "src", "store.ts"), "handle")).toBe(true);
			expect(assertionHolds(join(cwd, "src", "store.ts"), "nope")).toBe(false);
			expect(assertionHolds(join(cwd, "src", "missing.ts"), undefined)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
