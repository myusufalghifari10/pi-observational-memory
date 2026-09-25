import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findStrat, formatStratDetail } from "../src/commands/strat.js";
import { renderSummaryV2, renderStratLines } from "../src/ledger/index.js";
import { listStrats, parseFrontMatter } from "../src/memory/paths.js";

// ─── P4.3 — strats front-matter parse + registry ───

const DEPLOY_MD = `---
id: deploy
summary: one-shot deploy checklist
cue: ship it
command: ./scripts/deploy.sh
updated: 2026-09-25 09:00
---
Run tests, then the deploy script.
`;

describe("P4.3 strats front-matter (cue, summary, command)", () => {
	it("parseFrontMatter surfaces cue, summary, command for a strat file", () => {
		const { front, body } = parseFrontMatter(DEPLOY_MD);
		expect(front.cue).toBe("ship it");
		expect(front.summary).toBe("one-shot deploy checklist");
		expect(front.command).toBe("./scripts/deploy.sh");
		expect(body).toContain("Run tests, then the deploy script.");
	});

	it("listStrats reads strats/*.md sorted by filename with path, cue, summary, command", () => {
		const root = mkdtempSync(join(tmpdir(), "om-strats-"));
		try {
			mkdirSync(join(root, "strats"), { recursive: true });
			writeFileSync(join(root, "strats", "deploy.md"), DEPLOY_MD);
			writeFileSync(
				join(root, "strats", "review.md"),
				"---\nsummary: PR review order\n---\nRead tests first.\n",
			);
			const strats = listStrats(root);
			expect(strats.map((strat) => strat.filename)).toEqual(["deploy.md", "review.md"]);
			const deploy = strats[0];
			expect(deploy?.cue).toBe("ship it");
			expect(deploy?.summary).toBe("one-shot deploy checklist");
			expect(deploy?.command).toBe("./scripts/deploy.sh");
			expect(deploy?.path).toContain("strats/deploy.md");
			// A cue-less strat still parses (name falls back to the filename stem at render).
			expect(strats[1]?.cue).toBeUndefined();
			expect(strats[1]?.summary).toBe("PR review order");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ─── P4.3 — section [7] rendering (cues are one token each in context) ───

describe("P4.3 section [7] STRATS rendering", () => {
	it("renders cue name, summary, path, and the run command; cue-less falls back to the stem", () => {
		const { summary } = renderSummaryV2({
			observations: [],
			strats: [
				{ filename: "deploy.md", path: ".memory/sid/strats/deploy.md", cue: "ship it", summary: "one-shot deploy checklist", command: "./scripts/deploy.sh" },
				{ filename: "review.md", path: ".memory/sid/strats/review.md", summary: "PR review order" },
			],
		});
		const section = summary.split("## Strats\n")[1]?.split("\n").filter((line) => line.startsWith("- ")) ?? [];
		expect(section).toHaveLength(2);
		expect(section[0]).toBe(
			"- ship it — one-shot deploy checklist `.memory/sid/strats/deploy.md` — run: `./scripts/deploy.sh`",
		);
		expect(section[1]).toBe("- review — PR review order `.memory/sid/strats/review.md`");
		// The registry renders as the LAST ## section before Open loops only when open loops
		// are absent — here [7] is the final heading.
		const headings = [...summary.matchAll(/^## .*/gm)].map((match) => match[0]);
		expect(headings.at(-1)).toBe("## Strats");
	});

	it("section is omitted wholesale when there are no strats", () => {
		const { summary } = renderSummaryV2({ observations: [], strats: [] });
		expect(summary).not.toContain("## Strats");
	});

	it("renderStratLines (the /strat list output) equals the section [7] lines — one source of truth", () => {
		const strats = [
			{ filename: "deploy.md", path: ".memory/sid/strats/deploy.md", cue: "ship it", summary: "one-shot deploy checklist", command: "./scripts/deploy.sh" },
		];
		expect(renderStratLines(strats)).toEqual([
			"- ship it — one-shot deploy checklist `.memory/sid/strats/deploy.md` — run: `./scripts/deploy.sh`",
		]);
	});
});

// ─── P4.3 — /strat helpers (list + show) ───

describe("P4.3 /strat command helpers", () => {
	const strats = [
		{ filename: "deploy.md", path: ".memory/sid/strats/deploy.md", cue: "ship it", summary: "deploy", command: "./deploy.sh" },
		{ filename: "review.md", path: ".memory/sid/strats/review.md" },
	];

	it("findStrat matches cue, filename, then stem — deterministically", () => {
		expect(findStrat(strats, "ship it")?.filename).toBe("deploy.md");
		expect(findStrat(strats, "deploy.md")?.filename).toBe("deploy.md");
		expect(findStrat(strats, "review")?.filename).toBe("review.md");
		expect(findStrat(strats, "review.md")?.filename).toBe("review.md");
		expect(findStrat(strats, "nope")).toBeUndefined();
		expect(findStrat(strats, "")).toBeUndefined();
	});

	it("formatStratDetail shows front-matter fields then a bounded body", () => {
		const detail = formatStratDetail(strats[0]!, "Run the script.\n", 100);
		expect(detail).toContain("cue: ship it");
		expect(detail).toContain("summary: deploy");
		expect(detail).toContain("command: ./deploy.sh");
		expect(detail).toContain("path: .memory/sid/strats/deploy.md");
		expect(detail.trimEnd().endsWith("Run the script.")).toBe(true);
		// Body bound: long content is truncated with an ellipsis (never unbounded notify).
		const bounded = formatStratDetail(strats[0]!, "x".repeat(500), 100);
		expect(bounded.length).toBeLessThan(400);
		expect(bounded.endsWith("…")).toBe(true);
	});
});
