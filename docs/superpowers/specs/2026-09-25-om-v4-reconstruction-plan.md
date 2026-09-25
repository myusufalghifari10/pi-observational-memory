# OM v4 Reconstruction Plan — Trust-Weighted Lossless Rehydration

Date: 2026-09-25 · Status: MASTER PLAN (single source of truth for the reconstruction) · Target: `/home/yusuf/pi-observational-memory` (branch `main`)

> **How to use this document.** This is the immutable execution guide for the OM v4
> reconstruction. Worker subagents implement strictly per the phase sections below; reviewer
> subagents verify against the same sections; the parent orchestrator confirms each phase and
> commits before the next phase starts. If any instruction here is ambiguous, STOP and ask the
> supervisor — do not improvise. If a phase task contradicts this doc, this doc wins.

---

## 0. Spec (requirements — immutable)

**Goal.** Rebuild pi-observational-memory as SOTA context engineering for a parent agent with a
**1M-token context window** doing **very long-horizon coding tasks** (hours-to-days, hundreds of
steps). The single quality metric: **the excellence of the parent's live context at every
moment**. Compaction frequency is a free variable. Memory volume is not a goal.

**Thesis.** The parent's live context is a *cache projection of durable state* — never a
shrinking copy of chat. Three interlocking pillars implement this:

1. **Trust-weighted knapsack assembly** — what enters context is packed deterministically by
   trust-per-token (provenance, staleness, supersession count, kind).
2. **Lossless save-load rehydration** — compaction never evicts unflushed state; the render is
   a byte-reproducible projection of durable files; corrections are rendered as
   `believed X → now Y` pairs; a gap marker bounds every failure.
3. **Negative-space & procedural memory** — abandoned approaches compress to one-line
   `rejected: X because Y` edges (`DEATHS.md`); verified routines compile to strats.

**Hard constraints (never violated):**
- C1: Workers stay subprocess `pi` sessions (see `src/spawn/launch.ts`); no in-process LLM agents.
- C2: Storage stays markdown-first and human-readable (`.memory/<sessionId>/*.md`).
- C3: The compaction render stays **model-free and deterministic** (zero LLM calls; byte-identical
  output for identical inputs).
- C4: Stay within the pi extension API surface already used (events: `session_start`,
  `session_shutdown`, `turn_end`, `agent_start`, `session_before_compact`, `message_end`;
  `pi.appendEntry`, `pi.registerCommand`, `pi.registerTool`, `pi.sendMessage`, `ctx.compact`).
- C5: Backward compatibility: existing ledgers (old `om.observations.recorded` entries without
  new fields) and existing `.memory/` content must keep working. New fields are optional in
  validators.
- C6: Zero new runtime dependencies (std-lib + existing peer deps only).
- C7: `npm run typecheck` and `npm test` stay green at every phase boundary.

**Non-goals (YAGNI — do not build):** vector DB inside OM (pi-second-brain is the retrieval
engine); LLM judges on the write path (empirically proven fragile — see TOKI / MemoryAgent-Bench
evidence in `docs/superpowers/specs/` sibling research notes); command-execution from memory
files (dynamic `cmd:` asserts — security: LLM-authored files must never execute code; static
path/symbol asserts only); parent-side agentic memory editing; reflection tiers; any UI redesign
beyond `/om:status` telemetry additions.

---

## 1. Locked decisions (L1–L12)

| # | Decision | Rationale |
|---|---|---|
| L1 | **Provenance is derived at the extension boundary, never labeled by LLM.** Each observation's `sourceEntryId` is assigned at commit by the orchestrator: the source entry bounding the observation's timestamp within the dispatched slice. Provenance class = the role of that source entry: `user-asserted` (user/custom_message), `tool-derived` (tool result), `model-distilled` (assistant). | Deterministic, free, cannot hallucinate (self-grading is the #1 trust failure mode). |
| L2 | **Contradiction/supersession counting is a deterministic lexical pass**, never an LLM judgment. At commit, a new observation that shares ≥2 identifier tokens (see §2.4) with an existing active observation of kind `assertion`/`decision`/`preference` supersedes the older one (pair). | LLM judges on write paths fail fact-consolidation benchmarks; determinism is the fix. |
| L3 | **Metadata is derived, never persisted in markdown.** Kind lives in the ledger entry; staleness, supersession counts, and trust are recomputed per render. | "Throwaway projections cannot decay" — repo philosophy. |
| L4 | **Corrections are never deletions.** Supersession produces `believed X → now Y` pairs rendered adjacent; the losing fact is preserved. | Echo-chamber prevention; bitemporal audit row equivalent. |
| L5 | **Flush-ack gate with bounded escape hatch.** A compaction cutoff may only advance past chunk boundaries that are *acked* (observation committed, OR gap marker committed). A chunk that exhausts its retry budget writes `om.observations.gap` — this IS the ack and surfaces as `UNOBSERVED WINDOW` in the render. | No silent memory holes; no head-of-line blocking. |
| L6 | **Knapsack fallback is mandatory.** When a line has no metadata (old entries), packing falls back to current chronological behavior — byte-identical to today's output. | Upgrade can never regress; verifiable in tests. |
| L7 | **Reserved sections first.** The knapsack governs only variable lines (typed observations + relevant-memory candidates). Sections [1]–[4], [7], [8] of the render layout (§2.3) are always included (they are small and load-bearing). | Invariants/STATE/open-loops must never lose a knapsack slot. |
| L8 | **STATE.md is consolidator-authored, forward-looking, and separate from JOURNEY.md** (which stays purely descriptive). | Task state (goal/plan/done/blocked/next) is the #1 long-horizon failure driver. |
| L9 | **Gap entries replace silent slice drops.** `recordSliceFailure` at attempt cap appends `om.observations.gap` instead of dropping silently. | Fixes the audit finding "silent memory hole after retry cap" at the architecture level. |
| L10 | **Secret redaction at the two egress points**: (a) worker chunk text, (b) observation content at commit. Regex-based, model-free. | Observations persist verbatim today; security is non-negotiable. |
| L11 | **Destructive defaults are conservative.** No on-disk file is ever deleted by the render; anergy stays demote-never-delete; DEATHS entries get revocation conditions instead of permanence. | Safety. |
| L12 | **Compaction policy:** `compactAtContextTokens` default changes to **64_000** in `DEFAULTS` (frequency flip — lossless render makes frequent compaction cheap). Explicit user config always wins (the current user config of 262k stays until they change it). `tailTokens` default stays 30_000. | User delegated frequency; quality-per-moment is the priority. |

---

## 2. Target architecture

### 2.1 Data model (ledger vocabulary v2 — all additive, validators backward-compatible)

New/changed types in `src/ledger/types.ts`:

```ts
export type ObservationKind =
  | "assertion" | "decision" | "completion" | "preference"
  | "event" | "question" | "rejected" | "strat";

export type Observation = {
  timestamp: string;          // unchanged: precise id, "YYYY-MM-DDTHH:MM:SS[.NN]"
  content: string;            // unchanged: single line, no CR/LF
  tokenCount: number;         // unchanged
  kind?: ObservationKind;     // NEW, optional (default "event" for old entries)
  sourceEntryId?: string;     // NEW, optional; assigned at commit (L1)
};

export type SupersessionPair = {
  oldTimestamp: string;       // the losing ("believed X") observation id
  newTimestamp: string;       // the winning ("now Y") observation id
  reason: "lexical-supersession"; // deterministic detector, reserved for future kinds
};

// NEW custom types (namespace "om.", same vocabulary style):
OM_OBSERVATIONS_SUPERSEDED = "om.observations.superseded"
  // data: { pairs: SupersessionPair[]; coversUpToId: string }
OM_OBSERVATIONS_GAP = "om.observations.gap"
  // data: { afterEntryId?: string; coversUpToId: string; attempts: number; lastError: string }
```

- `isObservation` accepts entries without `kind`/`sourceEntryId` (C5); new emissions always set both.
- `foldLedger` additionally returns `supersessions: Map<oldTs, newTs>` and `gaps: Gap[]`.
- Dropping stays as-is (`om.observations.dropped` tombstones from the consolidator).

On-disk memory (all under `.memory/<sessionId>/`):

```
INDEX.md          unchanged (orchestrator-owned)
JOURNEY.md        unchanged (consolidator-owned, descriptive)
STATE.md          NEW (consolidator-owned, forward-looking; L8)
DEATHS.md         NEW (consolidator-owned; rejected: X because Y lines)
<topic>.md        unchanged format (front-matter + prose)
strats/<name>.md  NEW (optional; procedural memory)
.runs/            unchanged (transient IPC; now GC'd — task P0.7)
```

`STATE.md` section convention (consolidator prompt enforces; renderer treats as opaque text):

```markdown
## Goal
## Constraints        (user assertions & hard rules — authoritative)
## Plan               (current approach; steps marked done/pending)
## Done               (completed milestones — anti-rework)
## Blocked
## Next               (immediate next actions)
## Open loops         (everything unfinished; renderer repeats this at block end)
```

`DEATHS.md` line convention (one line per entry):

```
- rejected: <approach> because <reason> (verify: <path[#symbol]>)
```

`(verify: …)` is optional and uses the SAME assertion semantics as anergy (§2.5). When the
verified artifact no longer exists, the death renders as `possibly-revived — re-verify before
retrying` instead of an authoritative "never do this".

### 2.2 Provenance & trust model (deterministic)

Provenance derivation (L1) in `src/ledger/progress.ts` (new pure helper):

```ts
export function deriveProvenance(
  slice: Entry[], obsTimestamp: string
): { sourceEntryId: string; provenance: "user-asserted" | "tool-derived" | "model-distilled" }
```

Rule: walk the slice's source entries; the bounding entry is the last source entry whose
timestamp ≤ the observation's minute-resolution base time (fallback: slice's last entry).
Role mapping: `user`/`custom_message` → `user-asserted`; tool result → `tool-derived`;
`assistant` → `model-distilled`.

Trust score (new pure module `src/ledger/trust.ts` — NO pi imports):

```ts
export type LineMeta = {
  kind: ObservationKind;
  provenance: "user-asserted" | "tool-derived" | "model-distilled";
  supersessionCount: number;   // times this line appears as the LOSING side + winning side? → count as the losing side only
  ageCompactions: number;      // compaction entries newer than this line's covering entry
  tokenCount: number;
};

export const KIND_W: Record<ObservationKind, number> = {
  assertion: 1.0, decision: 1.0, preference: 1.0, completion: 0.9,
  strat: 0.8, rejected: 0.7, question: 0.6, event: 0.5,
};
export const PROV_W = { "user-asserted": 1.2, "model-distilled": 1.0, "tool-derived": 0.8 };

export function scoreLine(meta: LineMeta): number {
  const stale = Math.max(0.2, 1 - meta.ageCompactions * 0.15);
  const conflict = Math.pow(0.85, meta.supersessionCount);
  return (KIND_W[meta.kind] * PROV_W[meta.provenance] * stale * conflict) / Math.max(1, meta.tokenCount);
}
```

`packKnapsack(lines, budget)` — greedy by `scoreLine` desc; ties broken chronologically
(oldest first) for determinism. Output = `{ packed, evicted }`. When ANY line lacks metadata,
the whole pack falls back to chronological order (L6) and `explain` reports `fallback: true`.

Supersession detector (L2) — in `src/ledger/supersede.ts`, pure:

```ts
export function detectSupersessions(
  incoming: Observation[], existing: Observation[]
): SupersessionPair[]
```

Identifier tokens = content lowercased, split on non-alphanumerics, keep tokens with
length ≥ 3 that are NOT in a stop-word list (~40 common English words). Two observations
"overlap" when they share ≥2 identifier tokens (path tokens like `src/auth.ts` and
CamelCase/snake_case identifiers count double by splitting them further). Pair only when the
OLDER is kind `assertion`/`decision`/`preference` and the NEWER is `assertion`/`decision`.
One-to-one: each observation participates in at most one pair (newest wins).

### 2.3 Render layout (the compaction block — `src/ledger/render.ts` v2)

```
[1] INSTRUCTIONS & CONTEXT POLICY   (unchanged voice; adds: "corrections render as
    believed X → now Y pairs; trust the Y", "grep .memory/DEATHS.md before choosing
    any new implementation approach")
[2] STATE (STATE.md verbatim + "as of <updated>")
[3] JOURNEY (verbatim + optional "next-likely" pointers line)
[4] MEMORY MAP (topic rows: path · summary · updated · anergy flags · death stubs)
[5] RELEVANT MEMORY (top-k candidates by scoreLine against the last user instruction;
    empty section omitted; pure lexical match — see §2.6)
[6] OBSERVATIONS (knapsack-packed typed lines; supersession pairs rendered adjacent:
    "<ts-old> believed: X\n<ts-new> now: Y")
[7] STRATS registry (cue names + one-liners) — section omitted when empty
[8] OPEN LOOPS (STATE's Open-loops section repeated verbatim) + UNOBSERVED WINDOW
    markers (from gap entries) — the recency anchor
```

Budget: `RENDER_BUDGET_TOKENS = 18_000` (constant in `src/ledger/render.ts`) — topic/STATE
section-[5] candidates and section [6] are token-charged against it (topics reserve first,
then [6] packs the remainder); reserved sections exempt (L7). **Line-capped exception (locked
2026-09-25, supervisor decision after the P3a defect proof):** section-[5] *observation
teasers* (top-k lines that did NOT make the [6] knapsack — §2.6) are **line-capped at
RELEVANT_TOP_K = 5, NOT token-charged**. Rationale: charging them against the same budget
makes the teaser path structurally unreachable exactly when it matters most (budget full —
proven by the greedy invariant: any [6]-evicted unit's cost exceeds the leftover). Grouped by
the tests/relevant.test.ts 'Fix A / Fix B' block; the §2.3 'combined' wording is superseded
accordingly.

Render function shape:

```ts
export function renderSummaryV2(input: {
  instructions: string; state?: string; journey?: string; map?: string;
  strats?: string; openLoops?: string; gaps: Gap[];
  candidates: ScoredLine[]; budget?: number;
}): { summary: string; packExplain: PackExplain }
```

`PackExplain` (audit trail — ContextPipe EXPLAIN ANALYZE analog): per line
`{ id, score, admitted, reason }`; emitted to debugLog (`render.pack`) and returned for tests.

**Determinism invariant (C3):** identical input ⇒ byte-identical output. Enforced by golden
tests (P2.4). Sort orders: typed lines by `scoreLine` desc, tie → timestamp asc.

### 2.4 Flush-ack gate & cutoffs (P3)

`src/hooks/compaction-hook.ts` + `src/hooks/observer-trigger.ts`:

- A chunk range `[afterEntryId .. coversUpToId]` is **acked** iff the branch contains, whose
  `coversUpToId` resolves at-or-before the candidate cutoff: an `om.observations.recorded`
  entry, OR an `om.observations.gap` entry, OR the chunk produced a committed
  `om.observations.recorded` with zero observations is NOT sufficient (zero-obs chunks have no
  ledger entry today) — therefore `dispatchedCoversUpToId` zero-obs chunks MUST also write a
  tiny `om.observations.recorded` entry with `observations: []`?? → **No** (validator requires
  non-empty). Solution (locked): zero-observation chunks commit an `om.observations.gap` entry
  with `attempts: 0, lastError: "no observations extracted"` — semantically "acknowledged,
  nothing to record". Render treats `attempts: 0` gaps as silent (no UNOBSERVED marker).
- `snapCutoff` gains a filter: boundaries whose chunk is not acked are ineligible; the gate
  falls back to pi's proposed cutoff ONLY if no acked boundary qualifies.
- Give-up path (`recordSliceFailure` reaching cap) appends `om.observations.gap` with
  `attempts: 2` and the last error message (L5/L9). Render shows:
  `⚠ UNOBSERVED WINDOW [idA..idB] — re-read ledger lines X..Y if relevant`.

### 2.5 Anergy v2 (static only)

`src/memory/anergy.ts` improvements:
- Symbol matching moves to word-boundary regex (`new RegExp("\\b" + escape(sym) + "\\b")`),
  scanning head 256 KB **and** tail 256 KB of the file.
- Re-arm rule extends to basename mentions: a buffer observation mentioning either the full
  relPath OR its basename re-arms.
- Assertion count per topic stays capped (20); IO-error = PASS (unchanged, L11).
- DEATHS `(verify: …)` reuses `assertionHolds()` (exported) — same semantics, no duplication.
- **Dynamic `cmd:` asserts are OUT** (security non-goal; see §0).

### 2.6 RELEVANT MEMORY (section [5])

Pure lexical scoring — no embeddings. Candidate pool: topic summaries + STATE lines + typed
observations already packed candidates. Query = the last `user`/`custom_message` content
(bounded to 2,000 chars) captured from the branch at compaction time. Score = shared-identifier
count (same tokenization as §2.2). Top-k = 5 lines that did NOT already make the knapsack.
Omit section when score is 0 for all. This is a deterministic teaser, not a search engine —
deep retrieval remains pi-second-brain's job.

### 2.7 Secret redaction (P0)

`src/redact.ts` (new, pure):

```ts
export function redactSecrets(text: string): string
```

Patterns (replace with `[REDACTED:<label>]`): AWS access keys (`AKIA[0-9A-Z]{16}`), GitHub
tokens (`ghp_…`, `github_pat_…`), OpenAI/Anthropic-style keys (`sk-[A-Za-z0-9]{20,}`),
Google API keys (`AIza[0-9A-Za-z\-_]{35}`), Slack tokens (`xox[baprs]-…`), bearer tokens
(`Bearer [A-Za-z0-9\-._~+/]{20,}`), private key blocks (`-----BEGIN [A-Z ]*PRIVATE KEY-----…
-----END …-----`), generic `password=…`/`api_key=…`/`token=…` assignments (value side only).
Applied at exactly two egress points (L10):
1. `serializeSourceAddressedBranchEntries` output (chunk text to workers),
2. `assignObservationTimestamps` output content (before `pi.appendEntry`).
Not applied to cost telemetry or debug logs of lengths only.

---

## 3. Phase plan

> **Per-phase contract.** Every task lists: files, exact change, tests, acceptance. The parent
> orchestrates worker → reviewer → (loop ≤3) → parent-verify → commit per phase. A phase is
> DONE only when its acceptance criteria hold AND `npm run typecheck && npm test` are green.

### P0 — Foundation fixes (from the pre-v4 audit)

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P0.1 Stale-session commit race | `src/runtime.ts`, `src/hooks/observer-trigger.ts`, `src/hooks/consolidator-trigger.ts` | Add `runtime.generation = 0`; `++` on `session_start`. `dispatchObserver`/`dispatchConsolidator` capture `const gen = runtime.generation` at dispatch; before EVERY `pi.appendEntry`, status/toast, and `pumpWorkerQueue`, require `runtime.generation === gen && runtime.enabled`; else silently discard result (no retry, no error toast). | `tests/session-race.test.ts`: simulate generation bump mid-flight; assert no appendEntry, no pump dispatch. | Observations/cost from a stale session can never land in the wrong ledger. ✅ done |
| P0.2 Config cache per cwd | `src/runtime.ts` | `ensureConfig(cwd)`: reload when `cwd !== this.configCwd`. | extend `tests/config-layering.test.ts` | Two sessions in one process with different cwd each see their project settings. ✅ done |
| P0.3 Sandbox dedup | `src/memory/paths.ts`, `agent/consolidator/tools.ts` | Move `.memory/`-prefix strip INTO `resolveWithinMemory(root, requested)`; `scoped()` calls it; delete duplicate logic. Keep the "..foo.md" false-reject fix (`rel === ".." \|\| rel.startsWith(".." + sep)` semantics — use `rel.split(sep)[0] === ".."`). | `tests/memory.paths.test.ts` covers the function production uses. | Single sandbox implementation; traversal cases (`../x`, `x/../../y`, absolute paths) rejected. ✅ done |
| P0.4 Worker circuit breaker | `src/runtime.ts`, `src/hooks/observer-trigger.ts`, `src/hooks/consolidator-trigger.ts`, `src/commands/status.ts` | `runtime.workerFailureStreak`; reset on any success or on `/om off`→`on`; at ≥3 set `runtime.pipelinePaused = true` (both triggers no-op), one error toast, flag shown in `/om:status` (`pipeline: PAUSED (N consecutive worker failures)`). | `tests/circuit-breaker.test.ts` | Repeated worker failure stops burning money; state visible; recoverable. ✅ done |
| P0.5 Front-matter `asserts` list forms | `src/memory/paths.ts` | `parseFrontMatter` accepts: single-line comma list (existing), inline `[a, b]`, and block list (`asserts:` followed by `  - item` lines). | extend `tests/memory.paths.test.ts` (3 new cases) | An LLM writing YAML lists cannot silently disable anergy. ✅ done |
| P0.6 Tool-result truncation | `src/ledger/serialize.ts` | Raise `MAX_RECORD_CONTENT_CHARS` to 40_000; apply `truncateRecordContent` ONLY to tool-result record content in `serializeConversation` (user/assistant text untouched). | extend `tests/…` (new `tests/serialize.test.ts`) | A 500 KB tool result can no longer blow up an observer chunk. ✅ done |
| P0.7 `.runs/` GC | `src/memory/session.ts` or `src/index.ts` | At `session_start` (enabled path), delete `.runs/*` files older than 7 days under this session's root. | `tests/session.memory.test.ts` extension | `.runs/` bounded in practice. ✅ done |
| P0.8 Journey over-size warn | `src/commands/status.ts` | `/om:status` marks journey `⚠ OVER TARGET` when `estimateStringTokens(journey) > 2 × journeyTargetTokens`. | extend `tests/…` status test | Visibility without enforcement (user decision: growth is fine). ✅ done |
| P0.9 Installer honesty | `scripts/install.sh` | Show tsc output on failure instead of swallowing it. | n/a (manual check) | `sh scripts/install.sh --no-register` prints real errors on failure. ✅ done |
| P0.10 Secret redaction | `src/redact.ts` (new), `src/ledger/serialize.ts`, `src/ids.ts` call sites | §2.7. | `tests/redact.test.ts` with fixture secrets of every pattern | Both egress points redacted; ordinary text untouched. ✅ done |

### P1 — State foundation (typed observations, supersession, STATE, render restructure)

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P1.1 Observation v2 + provenance | `src/ledger/types.ts`, `src/ids.ts`, `src/ledger/progress.ts` | §2.1 types; `assignObservationTimestamps` gains `kind` pass-through + `deriveProvenance` assignment (L1); validators accept old shape (C5). | extend `tests/ids.test.ts`, `tests/ledger.fold.test.ts` | Old entries still fold; new entries carry kind+sourceEntryId. ✅ done |
| P1.2 Observer tool schema | `agent/observer/tool.ts`, `agent/observer/prompt.ts` | Tool schema adds `kind` enum (default `event`); prompt documents the 8 kinds with examples (assertion vs event; `rejected:` and `strat:` markers land in content with those kinds). | extend `tests/…` (schema-level) | Model can emit kinds; content stays single-line. ✅ done |
| P1.3 Supersession | `src/ledger/supersede.ts` (new), commit path in `observer-trigger.ts` | §2.2 detector; at commit, append `om.observations.superseded` when pairs found; fold exposes `supersessions`. | `tests/supersede.test.ts` (≥6 cases: overlap, no-overlap, one-pair-only, old-entries) | Deterministic pairing; pairs survive fold. ✅ done |
| P1.4 STATE.md + DEATHS.md duties | `agent/consolidator/prompt.ts`, `agent/consolidator/tools.ts` (allow STATE/DEATHS writes; still forbid INDEX.md) | Prompt: maintain STATE.md per §2.1 convention (forward-looking, authoritative Constraints, Open loops); maintain DEATHS.md per §2.1 lines (consolidator emits `rejected:`-kind observations into it). JOURNEY rules unchanged. | extend `tests/consolidator.test.ts` (prompt contains required sections; tool writes allowed) | Consolidator instructions enforce both files. ✅ done |
| P1.5 Render restructure | `src/ledger/render.ts`, `src/hooks/compaction-hook.ts` | `renderSummaryV2` with layout §2.3 **in chronological packing mode** (knapsack lands in P2; until then section [6] uses today's order, sections [1]-[5],[7],[8] wired). Wire STATE/DEATHS/strats readers (`src/memory/paths.ts`: `readState`, `readDeaths`, `listStrats`). | extend `tests/render.test.ts` (section order, open-loops repeat, pair adjacency, gap markers, empty-section omission) | Block shape matches §2.3; deterministic. ✅ done |

### P2 — Knapsack assembly

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P2.1 Trust module | `src/ledger/trust.ts` (new) | §2.2 exact constants + `scoreLine` + `packKnapsack`. | `tests/trust.test.ts` (formula values asserted numerically) | Byte-stable scores. ✅ done |
| P2.2 Supersession count & age | fold wiring | `supersessionCount` = times a line appears as LOSING side; `ageCompactions` = compaction entries newer than the line's covering entry. | extend fold tests | Metadata derivable with zero persisted state. ✅ done |
| P2.3 Pack + fallback + explain | `src/ledger/render.ts`, `src/hooks/compaction-hook.ts` | Knapsack for [5]+[6] under `RENDER_BUDGET_TOKENS`; L6 fallback to chronological when any metadata missing; `PackExplain` returned + `render.pack` debugLog. | `tests/render.test.ts`: (a) budget never exceeded; (b) stale low-trust evicted before fresh user-asserted; (c) all-equal/absent metadata ⇒ byte-identical to P1 output; (d) explain matches admissions. | Deterministic quality ordering with safe fallback. ✅ done |
| P2.4 Golden determinism | `tests/golden.test.ts` (new) | Fixture session (reuse `tests/fixtures/session.ts`) rendered twice ⇒ byte-identical; after appending a supersession pair ⇒ delta is exactly the pair. | the test itself | C3 enforced forever. ✅ done |
| P2.5 RELEVANT MEMORY | `src/ledger/render.ts` helper | §2.6 lexical top-k. | `tests/relevant.test.ts` | Section appears only when candidates score > 0. ✅ done |

### P3 — Lossless rehydration

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P3.1 Gap entries | `src/ledger/types.ts`, `src/hooks/observer-trigger.ts` | §2.4: zero-obs chunks + give-up path append `om.observations.gap`; validators; fold exposes `gaps`. | extend `tests/observer-retry.test.ts`, `tests/ledger.fold.test.ts` | No silent holes; `attempts: 0` gaps silent in render. ✅ done |
| P3.2 Flush-ack gate | `src/hooks/compaction-hook.ts`, `src/ledger/progress.ts` | `snapCutoff` filters unacked boundaries (§2.4); conservative fallback to pi's proposal only when nothing qualifies. | extend `tests/compaction-cutoff.test.ts` (branch with unacked chunk ⇒ boundary refused; acked ⇒ accepted) | Compaction cannot evict unflushed chunks. ✅ done |
| P3.3 Restart rehydration | `src/hooks/compaction-hook.ts` (verify path) | Ensure `session_before_compact` output depends only on durable files + ledger (it already does — write the regression test). | `tests/rehydration.test.ts` (fixture; §4 metrics probes, deterministic) | Crash recovery = normal compaction path. ✅ done |
| P3.4 Frequency flip | `src/config.ts` | `DEFAULTS.compactAtContextTokens = 64_000` (L12); README documents. | extend `tests/config-layering.test.ts` | Explicit user config still wins. ✅ done |

### P4 — Negative-space & procedural memory

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P4.1 DEATHS render + revocation | `src/memory/paths.ts` (`parseDeaths`), `src/memory/anergy.ts` (export `assertionHolds`), `src/ledger/render.ts` | §2.1 line convention; `(verify:)` failure ⇒ `possibly-revived` stub (L11); render section [4]/[7] stubs. | `tests/deaths.test.ts` | Deaths cheap, revocable, never permanent. ✅ done |
| P4.2 Pre-approach guard | `src/ledger/render.ts` instructions | One standing line in [1]: "grep .memory/DEATHS.md before choosing any new implementation approach". | extend golden test | Model-free reflex. ✅ done |
| P4.3 Strats | `src/memory/paths.ts` (`listStrats`), `src/commands/` (optional `/strat` list+show command), `src/ledger/render.ts` | `.memory/<sid>/strats/*.md` (front-matter: `cue`, `summary`, `command`); render section [7]; `/strat` lists and shows a strat. | `tests/strats.test.ts` | Procedural memory cues are one token each in context. ✅ done |
| P4.4 Death clustering (prompt) | `agent/consolidator/prompt.ts` | Instruct: merge same-subject rejections into one grouped edge ("rejected 3 approaches in auth/ — all because X"). | prompt assertion in `tests/consolidator.test.ts` | The "because" survives, not the log. ✅ done |

### P5 — Eval & telemetry

| Task | Files | Change | Tests | Acceptance |
|---|---|---|---|---|
| P5.1 Rehydration probes | `tests/rehydration.test.ts` (expand) | Deterministic probes over 3 fixture sessions: (a) STATE content present in block; (b) every `Done` item present; (c) every open loop present at block END; (d) supersession pairs adjacent; (e) gap markers present; (f) constraints section first. | the tests themselves | Long-horizon resume facts are provably in the block. ✅ done |
| P5.2 Telemetry | `src/commands/status.ts`, `src/ui/status-controller.ts` (no visual redesign) | `/om:status` adds: render block size (last), packed/evicted counts, gap count, death count, supersession count, pipeline pause state, anergy count. | extend status tests | Operator can see memory health at a glance. ✅ done |
| P5.3 README + docs | `README.md`, this doc (mark done) | Document v4 architecture, config defaults, DEATHS/STATE/strats conventions, migration note (old ledgers work as-is). | n/a | Public docs match reality. ✅ done |

---

## 4. Global invariants (reviewers must check every phase)

1. **C1–C7 hold** (§0). Especially: no LLM call in the render path; no new deps; markdown-first.
2. **Determinism:** any render input produces byte-identical output across runs (golden tests).
3. **Backward compat:** ledger entries from v1 sessions still fold/validate (C5).
4. **The losing fact is preserved** (L4) — no destructive history rewrites anywhere.
5. **Test-first:** each task's tests exist and fail before the implementation lands (level: per-task asserts; project convention).
6. **One writer per phase**; reviewer never edits; worker never touches tests owned by `tests/` conventions (vitest).
7. Every phase boundary: `npm run typecheck && npm test` green.

## 5. Risks & mitigations (top 5)

| Risk | Mitigation (already designed in) |
|---|---|
| Trust mis-assignment silently degrades packing | L6 fallback byte-identical to current behavior; explain trace; tests (P2.3c) |
| Flush-ack gate blocks compaction forever on dead worker | Gap entries are acks (L5); bounded by retry cap |
| Supersession false positives hide distinct facts | Strict ≥2 identifier-token rule, one-pair-per-line, losing fact still rendered (L4) |
| Consolidator ignores STATE/DEATHS duties | Prompt tests (P1.4); render falls back gracefully when files absent (section omitted) |
| Scope creep during execution | This doc is the only source of truth; workers STOP and ask on ambiguity |

## 6. Completion criteria (global)

- All phases P0–P5 merged on `main`; `npm test` green (target: 200+ tests), `npm run typecheck` clean.
- `tests/golden.test.ts` + `tests/rehydration.test.ts` prove determinism and resume-fidelity.
- Live end-to-end smoke (final tester): `/om on` in a real session → observers run → consolidation
  writes STATE/DEATHS/topics → `/om:compact` renders the v4 block → `/om:status` shows telemetry.
  If the tester needs a pi `/reload` or fresh session, it reports that requirement instead of
  forcing it.

## 7. Execution protocol (orchestration contract)

Per phase, in order:
1. **Worker** (one, sole writer, `context: fork`): implement the phase's tasks exactly; run
   `npm run typecheck && npm test` after each task; write a summary of changed files + test
   results to its output artifact.
2. **Reviewer** (fresh, read-only): diff against THIS doc's phase section; report
   `Conforms / Deviates` per task with `file:line` evidence for every deviation.
3. **Loop:** on any `Deviates`, spawn a worker with the reviewer's findings; re-review. Loop cap 3.
4. **Parent verify:** the orchestrator independently runs the test suite, inspects the diff, and
   checks the phase's Acceptance column before committing. Only then the next phase starts.
5. **Final tester** (after all phases): full suite + live smoke per §6; report reload/session
   needs to the user.

Commit convention: one commit per phase (squash its tasks), message
`feat(om-v4): P<n> <phase name> — <one-line summary>`.

**Every task contract MUST include:** "Read and obey '§8 Subagent continuity guide' in this
plan before your first action."

---

## 8. Subagent continuity guide (MANDATORY for every child)

> Why this exists: runs have died mid-task (infrastructure aborts, premature turn-ends),
> silently burning budget and losing context. These ten rules make a run either FINISH or
> stop for a real, documented reason — never vanish halfway.

1. **You run until your Stop rules fire — nothing else.** There is no human watching mid-run.
   Do NOT end your run to "report progress", "check in", or "ask whether to continue".
   Progress reports go into your output artifact at the END. Ending early = failed run.
2. **One task at a time, in contract order.** When task N is done (implementation +
   validation green), start task N+1 immediately. No pauses between tasks.
3. **Checkpoint after EVERY task.** APPEND (never rewrite) a few lines to your output
   artifact: task id, files touched, test result. If infrastructure kills your run, a
   successor will resume from your checkpoint — good checkpoints make recovery instant.
4. **Never stop mid-edit.** Finish the current file edit, then run the validation command,
   before any other consideration — including if you suspect you are near a limit.
5. **Tool call failed?** Retry ONCE with corrected input. If it fails again, note it in the
   checkpoint and CONTINUE with the remaining work.
6. **Only three things justify stopping early** (and nothing else): (a) a plan instruction is
   ambiguous or contradictory, (b) a test will not go green after 2 fix attempts, (c) a
   required tool is unavailable. When you stop early: write the exact blocker + what you
   already tried into the output artifact, then make your FINAL message a one-line blocker
   report ("BLOCKED: <exact reason> — see artifact").
7. **Need a decision from the supervisor?** Use `contact_supervisor(reason: "need_decision")`
   with the exact question and WAIT for the reply — do NOT end the run and do NOT improvise.
8. **Validation is part of the work, not the end of it.** Run the phase's validation command
   after each task. A red suite is unfinished work — it is never a reason to stop or to
   weaken a test to make it pass (weakening a test is a blocker-level violation).
9. **Never redo completed work.** If your context or `git diff` shows work is done, verify it
   quickly (read the diff, run its tests) and move on to the next task.
10. **Your run is COMPLETE only when** every task in your contract meets its Success criteria
    AND your final message starts with "COMPLETE" and names your output artifact. Any other
    ending is a failed run and will be re-worked.
