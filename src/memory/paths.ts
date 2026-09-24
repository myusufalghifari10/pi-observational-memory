/**
 * `.memory/` substrate (Phase B). The filesystem IS the long-term recall interface: the master
 * reads topic files with ordinary `ls`/`read`/`grep`. Topic files are NOT rolled back by `/tree`
 * (they track the repo, not the session branch).
 *
 * Layout under <project>/.memory/:
 *   INDEX.md            — orchestrator-owned; (re)rendered from topic front-matter
 *   <topic>.md          — consolidator-authored; YAML front-matter + current-state prose
 *   .runs/<id>.json     — transient worker IPC (not GC'd in v1)
 *
 * All writes are atomic (temp + rename) so a reader never sees a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const INDEX_FILENAME = "INDEX.md";
/**
 * The running, whole-project descriptive history. Consolidator-authored prose (no front-matter),
 * pushed into every compaction block for orientation. Like INDEX.md it is a special file, NOT a
 * topic file: it is excluded from `listTopics`/the memory map and read verbatim at compaction.
 */
export const JOURNEY_FILENAME = "JOURNEY.md";

/** The project-level `.memory/` base. Per-session roots live one level below it. */
export function memoryBaseDir(cwd: string): string {
	return join(cwd, ".memory");
}

/**
 * The per-session memory root: `.memory/<sessionId>/`. All durable long-term memory (INDEX,
 * topic files, JOURNEY) and transient `.runs/` IPC are scoped under here so two sessions in the
 * same project never share consolidator output. Keyed by the immutable session header id
 * (survives /name, /resume, /tree) — NOT the session filename or display name.
 */
export function sessionMemoryRoot(cwd: string, sessionId: string): string {
	return join(memoryBaseDir(cwd), sessionId);
}

export function indexPath(root: string): string {
	return join(root, INDEX_FILENAME);
}

export function journeyPath(root: string): string {
	return join(root, JOURNEY_FILENAME);
}

/** Read `.memory/JOURNEY.md` body, trimmed. Returns undefined when missing or effectively empty. */
export function readJourney(root: string): string | undefined {
	const path = journeyPath(root);
	if (!existsSync(path)) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename). Creates parent dirs as needed. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

/**
 * Resolve a (possibly relative) path and confirm it stays inside `.memory/`. Returns the
 * absolute path, or undefined if it escapes the sandbox. The consolidator's scoped tools use
 * this to reject any path outside `.memory/` (design risk 6).
 *
 * This is the SINGLE sandbox implementation (P0.3): the consolidator's `scoped()` delegates
 * here instead of keeping a second copy of the rules.
 */
export function resolveWithinMemory(root: string, requestedPath: string): string | undefined {
	const base = resolve(root);
	// The model may naturally pass a project-relative ".memory/x.md" path. Strip that prefix
	// so the file lands at the sandbox root — a nested root/.memory/x.md would be invisible
	// to listTopics/readJourney (observed incident — 9 archived files hidden from the map).
	const normalized = requestedPath.replace(/^(?:\.\/)?\.memory(?:\/+|$)/, "");
	const abs = resolve(base, normalized === "" ? "." : normalized);
	const rel = relative(base, abs);
	if (rel === "" || rel === ".") return abs; // the session memory root itself
	// Escape check by FIRST relative segment only: rel.startsWith("..") would falsely reject
	// legitimate names like "..backup.md", while ".." / "../x" / "x/../../y" all resolve to
	// a first segment of ".." and are rejected. The normalization check backstops both.
	if (rel.split(sep)[0] === ".." || resolve(base, rel) !== abs) return undefined;
	return abs;
}

export type TopicFrontMatter = {
	id?: string;
	title?: string;
	summary?: string;
	updated?: string;
	/**
	 * Repo-relative paths (optionally `path#symbol`) this topic asserts exist in the project.
	 * Checked model-free at compaction render (see memory/anergy.ts); a topic whose
	 * assertions all still hold is unaffected — absence demotes it to a stub in the injected
	 * map. Empty/absent = exempt. On-disk files are NEVER touched by this check.
	 */
	asserts?: string[];
};

export type Topic = TopicFrontMatter & {
	/** Path relative to the project root, e.g. ".memory/auth.md". */
	path: string;
	/** Bare filename, e.g. "auth.md". */
	filename: string;
};

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse leading YAML-ish front-matter. Intentionally tiny (no YAML dep): supports the flat
 * `key: value` fields the consolidator authors (id, title, summary, updated). Returns the
 * parsed fields plus the body after the front-matter block.
 */
/** Strip one layer of matching single/double quotes around an `asserts` entry. */
function unquoteEntry(entry: string): string {
	const t = entry.trim();
	if (
		t.length >= 2 &&
		((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
	) {
		return t.slice(1, -1);
	}
	return t;
}

/**
 * Parse an inline `asserts` value: handles the bare comma list (`a, b`) AND the YAML flow
 * sequence (`[a, b]`). Returns raw (still-quoted) entries, trimmed and empties dropped.
 */
function splitInlineAsserts(value: string): string[] {
	let raw = value.trim();
	if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function parseFrontMatter(content: string): { front: TopicFrontMatter; body: string } {
	const match = FRONT_MATTER_RE.exec(content);
	if (!match) return { front: {}, body: content };
	const front: TopicFrontMatter = {};
	const lines = match[1].split("\n");
	// Index loop (not `for..of`): an `asserts:` block list consumes its own `- item` lines
	// by advancing `i`, so those never get re-interpreted as `key: value` rows.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === "id" || key === "title" || key === "summary" || key === "updated") {
			front[key] = value;
			continue;
		}
		if (key !== "asserts") continue;

		const entries: string[] = [];
		if (value === "") {
			// P0.5 YAML block list:
			//   asserts:
			//     - src/a.ts
			//     - src/b.ts#handle
			while (i + 1 < lines.length && lines[i + 1].trim().startsWith("-")) {
				const item = lines[i + 1].trim().slice(1).trim();
				if (item.length > 0) entries.push(item);
				i++;
			}
		} else {
			// P0.5: single-line comma list (`a, b`) or inline YAML flow (`[a, b]`).
			entries.push(...splitInlineAsserts(value));
		}

		const list: string[] = [];
		for (const entry of entries) {
			const unquoted = unquoteEntry(entry);
			if (unquoted.length > 0 && !list.includes(unquoted)) list.push(unquoted);
		}
		if (list.length > 0) front.asserts = list;
	}
	return { front, body: content.slice(match[0].length) };
}

/**
 * List parsed topic files (every `*.md` except INDEX.md/JOURNEY.md) under a session memory
 * root, sorted by filename. Each topic's `path` is rendered relative to the project cwd (e.g.
 * `.memory/<sessionId>/auth.md`) so the master can `read`/`grep` it directly from the map.
 */
export function listTopics(root: string): Topic[] {
	if (!existsSync(root)) return [];
	const cwd = resolve(root, "..", "..");
	const topics: Topic[] = [];
	for (const filename of readdirSync(root)) {
		if (!filename.endsWith(".md") || filename === INDEX_FILENAME || filename === JOURNEY_FILENAME) continue;
		let content: string;
		try {
			content = readFileSync(join(root, filename), "utf-8");
		} catch {
			continue;
		}
		const { front } = parseFrontMatter(content);
		topics.push({ ...front, path: relative(cwd, join(root, filename)), filename });
	}
	topics.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
	return topics;
}
