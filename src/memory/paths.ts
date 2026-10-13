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
import {
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const INDEX_FILENAME = "INDEX.md";
/**
 * The running, whole-project descriptive history. Consolidator-authored prose (no front-matter),
 * pushed into every compaction block for orientation. Like INDEX.md it is a special file, NOT a
 * topic file: it is excluded from `listTopics`/the memory map and read verbatim at compaction.
 */
export const JOURNEY_FILENAME = "JOURNEY.md";
/**
 * The live task state (forward-looking: goal/constraints/plan/done/blocked/next/open loops).
 * Consolidator-owned, no front-matter (§2.1 of the reconstruction plan). Read verbatim into
 * render section [2]; its "Open loops" section is repeated at the block end by the renderer.
 */
export const STATE_FILENAME = "STATE.md";
/**
 * The rejected-approaches archive (negative knowledge), one `rejected: X because Y` line per
 * entry (§2.1). Read raw here; P4.1 adds `parseDeaths` + anergy-style revocation.
 */
export const DEATHS_FILENAME = "DEATHS.md";

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

/**
 * Read `.memory/STATE.md` — the current task state, rendered verbatim into compaction
 * section [2]. Same shape discipline as `readJourney` (undefined = missing/effectively
 * empty), plus `updated` derived from the file's mtime: STATE.md has no front-matter by
 * convention, and the mtime is part of the durable file state the render is a pure
 * function of, so two renders of the same file yield the same `as of` stamp (C3).
 */
export function readState(root: string): { body: string; updated?: string } | undefined {
	const path = join(root, STATE_FILENAME);
	if (!existsSync(path)) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		if (body.length === 0) return undefined;
		let updated: string | undefined;
		try {
			const mtime = statSync(path).mtime;
			const pad = (n: number): string => n.toString().padStart(2, "0");
			updated = `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`;
		} catch {
			// No stamp is better than a failing read: the section still renders.
		}
		return { body, updated };
	} catch {
		return undefined;
	}
}

/** Read `.memory/DEATHS.md` raw, trimmed. Undefined when missing/empty (P4 parses it). */
export function readDeaths(root: string): string | undefined {
	const path = join(root, DEATHS_FILENAME);
	if (!existsSync(path)) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

/** One parsed DEATHS.md line (§2.1 convention). `verify` is `path` or `path#symbol`. */
export type DeathEntry = {
	approach: string;
	reason: string;
	verify?: string;
};

/**
 * P4.1 — parse the §2.1 line convention, leniently and deterministically:
 *   `- rejected: <approach> because <reason> (verify: <path[#symbol]>)`
 * `(verify: …)` is optional; lines that don't match the convention (headings, prose,
 * grouped edges from P4.4) are skipped rather than misparsed. Input order is preserved.
 */
export function parseDeaths(body: string | undefined): DeathEntry[] {
	if (!body) return [];
	const entries: DeathEntry[] = [];
	for (const line of body.split("\n")) {
		const match = /^-\s+rejected:\s+(.+?)\s+because\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		let reason = match[2];
		let verify: string | undefined;
		const verifyMatch = /\s*\(verify:\s*([^)]+)\)\s*$/.exec(reason);
		if (verifyMatch) {
			verify = verifyMatch[1].trim();
			reason = reason.slice(0, verifyMatch.index).trim();
		}
		if (reason.length === 0) continue;
		entries.push({ approach: match[1].trim(), reason, ...(verify ? { verify } : {}) });
	}
	return entries;
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
	/** Strat front-matter (P1.5 reader wiring; strats/ files — see `listStrats`). */
	cue?: string;
	command?: string;
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
		if (key === "id" || key === "title" || key === "summary" || key === "updated" || key === "cue" || key === "command") {
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

/** A procedural-memory strat file: `.memory/<sessionId>/strats/<name>.md` (§2.1, P4.3). */
export type Strat = Topic;

/**
 * List strat files under `<root>/strats/`, sorted by filename — the reader wiring for
 * render section [7] (P1.5). Returns `[]` when the directory does not exist, so the
 * renderer omits the section until strats actually exist. Front-matter fields used:
 * `cue` (what the parent says to cue it), `summary` (one line), `command` (optional).
 */
export function listStrats(root: string): Strat[] {
	const dir = join(root, "strats");
	if (!existsSync(dir)) return [];
	const cwd = resolve(root, "..", "..");
	const strats: Strat[] = [];
	for (const filename of readdirSync(dir)) {
		if (!filename.endsWith(".md") || filename.startsWith(".")) continue;
		let content: string;
		try {
			content = readFileSync(join(dir, filename), "utf-8");
		} catch {
			continue;
		}
		const { front } = parseFrontMatter(content);
		strats.push({ ...front, path: relative(cwd, join(dir, filename)), filename });
	}
	strats.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
	return strats;
}

// ── Staged consolidation generations (S3) ──────────────────────────────────────
//
// The live memory root `.memory/<sessionId>` is a SYMLINK to a generation directory
// `.memory/<sessionId>.g<N>`. A consolidator run writes into a FRESH generation created as a
// hardlink copy of the live one; a clean exit is promoted with a single atomic rename of the
// symlink, and any failure just drops the working generation — the live memory is never
// touched, and the batch stays un-tombstoned so the next run re-folds it.
//
// `live` is the only path the rest of the system uses (render, status, master `read`/`grep`,
// worker IPC); only the consolidator's sandbox root (`OM_MEMORY_DIR`) and its cwd point at
// `work`. Promotion must NOT run while a worker is in flight (the barrier guarantees that),
// because the previous generation is deleted on promote.

/**
 * A staging pair. `staged: false` means staging was unavailable (migration or copy failed) and
 * `work === live`: callers keep working in place, losing only the crash isolation.
 */
export type StagingRoots = {
	live: string;
	work: string;
	staged: boolean;
};

/** lstat-based symlink test (never follows the link; false for missing paths). */
function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** True when `name` is a generation directory of `root` (`<basename>.g<N>`). */
function isGenerationName(root: string, name: string): boolean {
	return name.startsWith(`${basename(root)}.g`);
}

/**
 * Highest-numbered existing generation directory of `root`, or undefined when there is none.
 *
 * FALLBACK ONLY: crash recovery prefers the recorded promoted generation
 * (`generationMarkerPath`). "Newest wins" is safe only when no work generation can leak — and a
 * SIGKILLed run leaks one (no `finally` runs), holding partial writes.
 */
export function latestGenerationDir(root: string): string | undefined {
	const parent = dirname(root);
	if (!existsSync(parent)) return undefined;
	let best: string | undefined;
	let bestN = 0;
	for (const name of readdirSync(parent)) {
		if (!isGenerationName(root, name)) continue;
		const n = Number.parseInt(name.slice(basename(root).length + 2), 10);
		if (!Number.isInteger(n) || n <= bestN) continue;
		bestN = n;
		best = name;
	}
	return best ? join(parent, best) : undefined;
}

/**
 * Persisted pointer to the generation the live symlink was LAST promoted to. Recovery follows
 * this instead of the newest `.g<N>`: a SIGKILLed run leaves its half-written work generation on
 * disk, and "newest wins" would adopt those partial writes as live memory.
 *
 * The marker filename is dot-prefixed and does not match the `<basename>.g<N>` generation shape
 * (see `isGenerationName`), so it can never be mistaken for a generation.
 */
export function generationMarkerPath(root: string): string {
	return join(dirname(root), `.livegen-${basename(root)}`);
}

/** Record the promoted generation (best-effort: without it, recovery falls back to newest). */
function writeGenerationMarker(root: string, generationName: string): void {
	try {
		atomicWrite(generationMarkerPath(root), `${generationName}\n`);
	} catch {
		/* best-effort; recovery falls back to the newest generation */
	}
}

/** The generation recorded by `writeGenerationMarker`, or undefined when missing/unusable. */
function readGenerationMarker(root: string): string | undefined {
	try {
		const name = readFileSync(generationMarkerPath(root), "utf-8").trim();
		if (!name || !isGenerationName(root, name)) return undefined;
		const candidate = join(dirname(root), name);
		if (isSymlink(candidate) || !existsSync(candidate)) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

/** Next free `<root>.g<N>` path (N starts at 1). */
export function nextGenerationDir(root: string): string {
	for (let n = 1; ; n++) {
		const candidate = `${root}.g${n}`;
		if (!existsSync(candidate) && !isSymlink(candidate)) return candidate;
	}
}

/**
 * Make `root` generational, idempotently:
 *   - already a symlink → nothing to do;
 *   - a real directory → rename it to the next free `.g<N>` and replace it with a RELATIVE
 *     symlink (relative so the whole tree survives a move);
 *   - missing while generation directories exist → re-point at the newest one (self-healing for
 *     a crash between the rename and the symlink step; no consolidated memory is stranded);
 *   - missing with no generations → nothing to do (the first promote will create the symlink).
 *
 * Returns false when the migration is impossible (e.g. a read-only parent). The directory is
 * then guaranteed to still be at its original path — callers fall back to in-place operation.
 */
export function ensureGenerationalRoot(root: string): boolean {
	if (isSymlink(root)) return true;
	if (!existsSync(root)) {
		// Prefer the recorded promoted generation. Only when there is none (legacy root, or a marker
		// lost together with the symlink) fall back to "newest" — a leaked work generation from a
		// SIGKILLed run is by definition not the recorded one, so it can never be adopted here.
		const orphan = readGenerationMarker(root) ?? latestGenerationDir(root);
		if (!orphan) return true;
		try {
			symlinkSync(basename(orphan), root);
			return true;
		} catch {
			return false;
		}
	}

	const target = nextGenerationDir(root);
	try {
		renameSync(root, target);
	} catch {
		return false; // nothing moved — still in place
	}
	try {
		symlinkSync(basename(target), root);
		// The migration itself is a promote: record it so recovery never has to guess.
		writeGenerationMarker(root, basename(target));
		return true;
	} catch {
		// The rename succeeded but the symlink could not be created: put the directory back so
		// the memory never becomes unreachable through its normal path.
		try {
			renameSync(target, root);
		} catch {
			// Leave the .g<N> directory; the `missing + generations exist` branch above re-points
			// the root at it on the next call.
		}
		return false;
	}
}

/**
 * Recursive copy of a memory tree using hardlinks (falling back to a byte copy when the
 * filesystem refuses a link). Safe because every writer (the consolidator's `write`/`edit`
 * tools, `atomicWrite`) replaces files via temp+rename: rewriting a file inside the copy
 * breaks the link instead of mutating the live file.
 *
 * Dot-prefixed entries are skipped — `.runs/` is transient worker IPC that must stay owned by
 * the live root (the orchestrator reads an in-flight worker's cost/result through it).
 */
export function hardlinkCopyTree(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const name of readdirSync(src)) {
		if (name.startsWith(".")) continue;
		const from = join(src, name);
		const to = join(dest, name);
		const stat = lstatSync(from);
		if (stat.isSymbolicLink()) continue; // never follow links out of the tree
		if (stat.isDirectory()) {
			hardlinkCopyTree(from, to);
			continue;
		}
		if (!stat.isFile()) continue;
		try {
			linkSync(from, to);
		} catch {
			copyFileSync(from, to); // EXDEV / filesystem without hardlinks
		}
	}
}

/**
 * Create the work generation for one consolidation: migrate the live root if needed, then
 * hardlink-copy its content into a fresh `.g<N>`. Always returns a usable `StagingRoots` —
 * `staged: false` (in-place) when the tree could not be prepared.
 */
export function beginStaging(liveRoot: string): StagingRoots {
	if (!ensureGenerationalRoot(liveRoot)) return { live: liveRoot, work: liveRoot, staged: false };
	const work = nextGenerationDir(liveRoot);
	try {
		mkdirSync(work, { recursive: true });
		if (existsSync(liveRoot)) hardlinkCopyTree(liveRoot, work);
	} catch {
		try {
			rmSync(work, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
		return { live: liveRoot, work: liveRoot, staged: false };
	}
	return { live: liveRoot, work, staged: true };
}

/**
 * Outcome of committing a consolidation. `in-place` is NOT a failure: staging was unavailable,
 * so the run wrote straight into the live root and its writes are already durable — callers must
 * drop the batch in that case and keep it only on `failed`.
 */
export type PromoteOutcome = "promoted" | "in-place" | "failed";

/**
 * Promote a staged work generation: build the new symlink next to the live root and swap it in
 * with ONE `rename()` (atomic on POSIX), then delete the previous generation.
 *
 * `failed` means the writes are NOT visible through the live root (the previous generation is
 * still live) — the caller must leave the batch un-tombstoned so the next run re-folds it.
 * Deleting the previous generation is guarded twice: only a `.g<N>` sibling of the live root is
 * ever removed, and never the generation just promoted.
 */
export function promoteStaging(roots: StagingRoots | undefined): PromoteOutcome {
	if (!roots) return "failed";
	if (!roots.staged || roots.work === roots.live) return "in-place";
	let previous: string | undefined;
	try {
		previous = readlinkSync(roots.live);
	} catch {
		previous = undefined; // fresh root: there was no live memory before
	}
	const swap = `${roots.live}.swap-${process.pid}-${Date.now()}`;
	try {
		symlinkSync(basename(roots.work), swap);
		renameSync(swap, roots.live);
	} catch {
		try {
			rmSync(swap, { force: true });
		} catch {
			/* best-effort cleanup */
		}
		return "failed";
	}
	// The swap is live: record it BEFORE any cleanup, so a crash during the GC below can never
	// leave recovery pointing at a generation that is no longer the promoted one.
	writeGenerationMarker(roots.live, basename(roots.work));
	if (previous) {
		const old = resolve(dirname(roots.live), previous);
		if (old !== resolve(roots.work) && isGenerationName(roots.live, basename(old))) {
			try {
				rmSync(old, { recursive: true, force: true });
			} catch {
				/* A leaked generation is inert: recovery follows the promoted-generation marker, not
				   the newest `.g<N>`, so its partial writes can never be adopted as live memory. */
			}
		}
	}
	return "promoted";
}

/** Drop a work generation (run failed / aborted / session replaced). Never throws, never
 * touches the live root. Safe on an undefined or in-place pair. */
export function discardStaging(roots: StagingRoots | undefined): void {
	if (!roots || !roots.staged || roots.work === roots.live) return;
	try {
		rmSync(roots.work, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
}
