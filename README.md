# pi-observational-memory

> **Long-running Pi sessions that remember — and stay *executable* after compaction: tiered, subprocess-backed memory with parallel observers, durable markdown files, and trust-weighted lossless rehydration.**

*Built for [pi](https://pi.dev) — an agent extension that distills your conversation into observations, files them into `.memory/` topic files, and renders them back deterministically every time your context compacts. Local-model friendly: flip one switch to run every worker serially. Optionally indexes your memory into [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain) so old context becomes queryable.*

> **Provenance.** Based on [amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory) (MIT — © 2026 Amos Blomqvist), whose code comments describe it as a trimmed adaptation of "OM V3". The wider concept traces back to [Mastra](https://mastra.ai)'s *Observational Memory* research, and the canonical popular implementation is [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory). This repo keeps the original license, credits both, and adds a **full v4 rebuild — trust-weighted lossless rehydration** (see below). Comparison table and lineage at the bottom — verified against each project's source code.

## Built for long-horizon agents

Big context windows did not fix long-horizon execution. What breaks first is never recall — it is *execution*: the agent forgets the constraint stated in hour one, redoes work it already finished, retries the approach it already rejected, and loses the open loop that was the whole point of the session. The usual failure is compaction itself: a living context becomes a summary of a summary, and every round trip loses state you never get back.

OM v4 is built around what long-horizon work actually demands from a context:

1. **State, not story.** Every compaction leads with a forward-looking `## State` (Goal / Constraints / Plan / Done / Blocked / Next / Open loops) and ends with **Open loops** as the very last heading. The slots that keep a multi-hour task executable sit at the top and at the recency anchor — in the same place every time.
2. **Nothing disappears silently.** The cutoff is flush-acked — an unobserved chunk can never be evicted; failed ranges surface as `⚠ UNOBSERVED WINDOW` markers; corrections render as adjacent `believed: X` → `now: Y` pairs instead of overwriting the past. If memory has a hole, the block *says so*.
3. **Negative space and procedure, not just facts.** `DEATHS.md` records `rejected: <approach> because <reason>` (with a standing instruction to grep it before trying anything new), and `strats/` holds proven routines at one line each. Knowing what *not* to try again is half of finishing a long task.
4. **Triage under budget, not truncation.** When memory outgrows the render budget, lines pack by a deterministic trust score (user-asserted > model-distilled > tool-derived; fresh > stale) instead of being cut at the tail.
5. **Determinism you can test.** The whole rehydration path is model-free: same durable state ⇒ byte-identical block — proven by golden tests and by rehydration probes over three fixture sessions (state present, every Done item present, open loops anchored last, corrections adjacent, gaps marked, constraints first). Crash recovery is literally the same code path.

The result: after any number of compactions, the parent rehydrates a context that is **executable** — goal, constraints, plan, status, dead ends, and fresh facts in a fixed, budget-aware layout. The rest of this README is the technical tour.

## Why

Context windows are finite. Native compaction throws away the middle of your session; next week you re-answer questions you already answered, re-research things you already researched, and your agent quietly loses the plot.

The usual fixes fail in practice:

- **Chat-history logbooks** grow forever and burn context on retrieval.
- **Pure semantic databases** hide memory behind a search box your agent never thinks to open.
- **In-context-only memory** evaporates the moment compaction runs.

Observational memory takes the third path: **observe in the background, store durably, render deterministically.** Small observer workers distill raw conversation into structured observations; a consolidator files them into plain markdown; and the compaction render — the one path that *must* work — contains **zero LLM calls**, so it can never fail, cost money, or hallucinate your history.

## How it works

```
   your conversation (pi session ledger, branch-local)
        │   chunk ≈ 10k tokens, cut only at safe boundaries
        ▼
  ┌── observers ── parallel headless `pi` subprocesses ──┐
  │   fenced prompt + PREVIOUS CONTEXT bridge            │ → record_observations
  └───────────────────────────────────────────────────────┘
        │  om.observations.recorded   (append-only ledger)
        ▼
  observation buffer  ── pool ≥ 15k ──►  consolidator (sandboxed subprocess)
        │                                   │ files/discard judgment
        │                                   ▼
        │                     .memory/<session>/*.md + INDEX.md + JOURNEY.md
        │                     + STATE.md + DEATHS.md + strats/*.md
        │                                   (atomic temp+rename writes)
        ▼
  at context ≥ 64k: the flush-ack gate snaps the cutoff to an OBSERVED chunk
  boundary (compaction can never evict an unflushed chunk), then renders
  [ instructions | State | Journey | Memory map | Relevant memory |
    Observations | Strats | Open loops ] + ⚠ UNOBSERVED WINDOW markers —
  model-free — then keeps the verbatim tail.  Stale topics are demoted
  (anergy), not trusted.
```

**Three tiers, three lifetimes:**

1. **Raw** — the session ledger itself. Branch-local, so `/tree` rolls short-term memory back natively; spend is summed across all branches so money never lies.
2. **Observations** — structured `{timestamp, content, tokenCount}` records promoted from chunks by the observers, kept in a bounded buffer with promotion thresholds. v4 adds a **kind** (`assertion` / `decision` / `completion` / `preference` / `event` / `question` / `rejected` / `strat` — old entries default to `event`) and a `sourceEntryId` provenance anchor.
3. **Durable** — `.memory/<sessionId>/*.md` topic files, `INDEX.md`, `JOURNEY.md`, plus v4's `STATE.md` (forward-looking plan), `DEATHS.md` (rejected approaches) and `strats/` (procedural cues): grep-able markdown any tool can read, seeded into child sessions on fork.

## v4 architecture — trust-weighted lossless rehydration

The v4 thesis: **your live context is a cache projection of durable state, not a shrinking copy of the chat.** A compaction is therefore a *re-render from `.memory/` + the ledger* — the better the render, the more often compaction can run without losing the plot. Three pillars:

1. **Trust-weighted packing.** Every observation carries a kind and provenance (user-asserted / model-distilled / tool-derived). Under the 18k-token render budget, lines pack greedily by a deterministic trust score (`KIND_W × PROV_W × staleness × 0.85^supersessions ÷ tokens` — `src/ledger/trust.ts`); topic/STATE lines are token-charged first, observation teasers in *Relevant memory* are line-capped at 5. If any line lacks metadata (a v1 ledger), the whole pack **falls back to chronological order, byte-identical to the pre-v4 render** — the upgrade can never regress.
2. **Lossless rehydration.** The cutoff is gated: a chunk range is only evicted once an `om.observations.recorded` or `om.observations.gap` entry covers it (**flush-ack gate**), so compaction can never discard conversation no observer has seen. Corrections never delete: a superseded fact renders as an adjacent `believed: X` → `now: Y` pair (chains included), and the memory map's death stubs are revocable — a `(verify:)` target that vanished downgrades the verdict to `possibly-revived — re-verify`.
3. **Negative & procedural memory.** `DEATHS.md` records *rejected: <approach> because <reason>* lines (grouped by shared cause, not by log), and the instructions block carries a standing reflex: *grep `.memory/DEATHS.md` before choosing any new implementation approach*. `strats/<name>.md` files hold one-line procedural cues (`cue` / `summary` / `command` front-matter) listed by `/strat`.

The rendered block, in order: instructions & context policy → `## State (as of …)` (STATE.md verbatim; its **Open loops** section is also repeated as the block's final heading — the recency anchor) → `## Journey` → `## Memory map` (anergy flags + death stubs) → `## Relevant memory` (lexical top-5 teaser against the last instruction, omitted when empty) → `## Observations` (trust-packed, corrections adjacent) → `## Strats` → `## Open loops` → gap markers.

**Gap semantics (`om.observations.gap` entries — no silent holes):**

| Entry | When | In the render |
|---|---|---|
| `attempts: 0` | observer ran clean but extracted nothing ("acked, nothing to record") | nothing — silent ack |
| `attempts: 2` | observer hit the retry cap and gave up on that range | `⚠ UNOBSERVED WINDOW [after..covers]` marker, counted as acked coverage |

**Migration:** old ledgers work as-is — ledger types are additive (C5). v1 observations have no `kind`/`sourceEntryId`, so they fail the metadata check and force the L6 chronological fallback (output stays byte-identical to the previous release); `om.observations.gap` / `.superseded` entries only exist from now on, and `.memory/` files keep their format (STATE.md/DEATHS.md/strats are simply created when first written).

## Highlights

- **Parallel *or* serial workers.** Observers fan out (default concurrency 4) on cloud models; `/om-sequential` switches the whole pipeline to one worker at a time for local models — applied live, persisted to settings.
- **Model-free compaction.** The render path is pure code: deterministic, instant, failure-proof; empty memory delegates to Pi's native summarizer.
- **Context bridging.** Observers see the 8 most recent observations (full content, read-only) before their chunk, so they stop restating facts and can spot contradictions across chunks.
- **Anergy — stale-memory detection.** Topic files carry `asserts:` paths checked against your live repo at render time; topics whose assertions no longer hold (and that no current observation re-mentions) are demoted to one-line stubs instead of misleading you.
- **Failed chunks retry once, bounded.** A crashed observer no longer permanently loses its chunk: failures are recorded and re-dispatched oldest-first, capped so a poison chunk can never loop forever — and a give-up leaves an `attempts: 2` gap entry that renders as `⚠ UNOBSERVED WINDOW`, so a hole can never be *silent*.
- **STATE.md — anti-forgetting.** The consolidator keeps a forward-looking `## Goal / Constraints / Plan / Done / Blocked / Next / Open loops` file; the block shows it verbatim and repeats **Open loops** at the very end, the slot long-horizon tasks actually read.
- **Corrections, never deletions.** A deterministic lexical detector supersedes stale facts: the block renders `believed: X` next to `now: Y` (chains flatten to the final winner), and the losing fact is never removed from the ledger.
- **DEATHS.md — negative memory.** Rejected approaches are archived as `rejected: <approach> because <reason> (verify: …)` lines, grouped by shared cause; a failing verify downgrades the verdict to `possibly-revived — re-verify`. The instructions block tells the reader to grep it before picking any new approach.
- **Strats — procedural memory.** One-line cues in `.memory/<sid>/strats/*.md` (`cue` / `summary` / `command`), listed by `/strat`, rendered as the `## Strats` section — a full routine costs a line of context.
- **Flush-ack gate.** Compaction's cutoff only snaps to chunk boundaries an observer has already accounted for — it can never evict conversation that is still in flight.
- **Trust-ordered observations.** Under budget pressure the render keeps high-trust lines (user-asserted decisions and assertions) and evicts low-trust noise first — deterministically, with a chronological byte-identical fallback for old ledgers.
- **Secret redaction at both egress points.** Observation content and outgoing worker prompts pass through `src/redact.ts` (AWS/GitHub/OpenAI/Google/Slack keys, bearer/`token=`/`password=`-style assignments) before they touch disk.
- **Circuit breaker.** Three consecutive worker failures pause the whole pipeline (visible in the footer and `/om:status`) instead of burning money in a loop; any success or `/om off`→`on` recovers it.
- **Everything is inspectable.** Every worker is an ordinary recorded pi session; every file is markdown; `.runs/` IPC is plain JSON. No black boxes.
- **Honest accounting.** Worker spend is captured from pi's own usage totals, summed monotonically across branches, shown in the footer and `/om:status`.
- **`/tree`-correct by construction.** Ledger folds are branch-local; durable files are session-scoped; cost never rolls back.
- **Hardened subprocess transport.** Worker argv is stripped of NUL bytes (PDF tool output used to crash dispatch), the worker pump survives session reloads, commits are generation-gated per session, a stale extension ctx after reload/`/tree` replacement is caught and kills the pipeline gracefully instead of crashing the process, and the consolidator's tools are path-sandboxed to `.memory/`.
- **Second-brain retrieval.** Every compaction block tells the reader that older memory is indexed in [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain) and can be queried with `knowledge_search` — retrieval lives in a real vector KB instead of a bespoke recall tool.
- **Off by default.** Nothing runs until you type `/om on`, and `passive: true` is a full kill-switch. Unset `models.*` fields simply fall back to the built-in default model.

## Commands

| Command | What it does |
|---|---|
| `/om on` / `/om off` | Enable/disable the whole pipeline (persisted in the ledger; default **OFF**) |
| `/om:status` | Clocks, pools, in-flight workers, cost, last error, ASCII timeline |
| `/om:compact` | Force a compaction now, ignoring the threshold |
| `/om:consolidate` | Force consolidation of the observation pool now |
| `/om-parallel` | Switch to parallel observers (`serialWorkers: false`) — for cloud models |
| `/om-sequential` | Switch to serial workers (`serialWorkers: true`) — for local models |
| `/om-change-model` | Interactive picker: role → provider → model → thinking level, applied live |
| `/strat` | List procedural-memory strats; `/strat <cue>` shows one in full |

## Comparison with other observational-memory implementations

### At a glance

| | **this repo** | [elpapi42](https://github.com/elpapi42/pi-observational-memory) | [amosblomqvist](https://github.com/amosblomqvist/pi-observational-memory) | [casret](https://github.com/casret/pi-observational-memory) | [nik1t7n](https://github.com/nik1t7n/pi-observational-memory-extension) |
|---|---|---|---|---|---|
| Created | 2026-09 (this fork) | 2026-04 | 2026-06 | 2026-08 (fork) | 2026-06 |
| Relationship | git fork of amosblomqvist + **v4 rebuild** (P0–P5, 368 tests) | the canonical implementation (v3.1.4, ~650★) | trimmed adaptation of OM V3; **upstream base of this fork** | git fork of amosblomqvist used as a branch lab | independent, Mastra-style |
| Roles | observer, consolidator | Observer, Reflector, Dropper | observer, consolidator | same as amos | Actor, Observer, Reflector |
| Workers | subprocess `pi` sessions, parallel **or** serial | in-process agents, always serial | subprocess, parallel (4) | subprocess, parallel (4) | in-process LLM calls |
| Storage | ledger + `.memory/*.md` topic files | session ledger only | ledger + `.memory/*.md` | ledger + `.memory/*.md` | JSON state files (`.pi/om/`) |
| Retrieval | filesystem grep + [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain) `knowledge_search` | `recall` tool by 12-hex id | filesystem grep | filesystem grep | `om_recall` + optional vector search |
| License | MIT | MIT | MIT | MIT | MIT |
| Activity (Sep 2026) | active | active (v3.1.4 on 2026-09-20) | quiet since 2026-08-25 | 8 stacked branches, Aug–Sep | dormant since 2026-06-23 |

### Feature completeness

`✓` available · `✗` not available · `◐` partial / indirect / lives on an unmerged branch · `–` not applicable (the architecture has no such mechanism). Every cell was verified by reading the project's source (`file:line` evidence), not its marketing.

| Feature | **this repo** | elpapi42 | amosblomqvist | casret | nik1t7n |
|---|:-:|:-:|:-:|:-:|:-:|
| **Memory durability** ||||||
| Durable grep-able topic files (`.memory/*.md`) | ✓ | ✗ | ✓ | ✓ | ✗ |
| `JOURNEY.md` running narrative | ✓ | ✗ | ✓ | ✓ | ✗ |
| `INDEX.md` / human-readable memory map | ✓ | ◐¹ | ✓ | ✓ | ✗ |
| Model-free deterministic compaction render | ✓ | ✓ | ✓ | ✓ | ◐² |
| Branch-local ledger, native `/tree` rollback | ✓ | ◐³ | ✓ | ✓ | ✗ |
| Cross-session fork/parent memory seeding | ✓ | ✗ | ✓ | ✓ | ✗ |
| Project-shared memory scope | ✗ | ✗ | ✗ | ✗ | ✓ |
| **v4 — trust-weighted lossless rehydration (2026-09-25 rebuild)** ||||||
| Trust-scored knapsack packing under render budget | ✓ | ✗ | ✗ | ✗ | ✗ |
| Corrections kept adjacent (`believed:` → `now:`, chains included) | ✓ | ✗⁹ | ✗ | ✗ | ✗ |
| Flush-ack cutoff gate (never evict an unobserved chunk) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Gap markers — `⚠ UNOBSERVED WINDOW` (no silent holes) | ✓ | ✗ | ✗ | ✗ | ✗ |
| `STATE.md` task state + Open-loops recency anchor | ✓ | ✗ | ✗ | ✗ | ✗ |
| Negative memory (`DEATHS.md`) + pre-approach guard + revocable verdicts | ✓ | ✗ | ✗ | ✗ | ✗ |
| Procedural memory (`strats/` + `/strat`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| JIT *Relevant memory* section at render time | ✓ | ◐¹⁰ | ✗ | ✗ | ◐¹⁰ |
| Restart rehydration — same durable state ⇒ byte-identical block | ✓ | ✗ | ✗ | ✗ | ✗ |
| Circuit breaker (3 consecutive worker failures ⇒ pipeline pause) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Render-audit telemetry (packed/evicted, gaps, deaths, supersessions) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Workers & pipeline** ||||||
| Subprocess workers (each an inspectable pi session) | ✓ | ✗ | ✓ | ✓ | ✗ |
| Parallel observers (concurrency configurable) | ✓ | ✗ | ✓ | ✓ | ✗ |
| Serial mode for local models (runtime switch) | ✓ | ◐⁴ | ✗ | ✗ | ✗ |
| Reflection/refinement tier (LLM rewrites) | ✗ | ✓ | ✗ | ✗ | ✓ (levels 0–4) |
| Dropper tier (LLM decides what to drop) | ✗ | ✓ | ✗ | ✗ | ✗ |
| Failed-chunk retry / backlog recovery | ✓ | ✓ | ✗ | ✗ | ✓ |
| Mid-run auto-resume after compaction | ✓ | ◐⁵ | ✓ | ✓ | ✗ |
| Context bridging into the observer prompt | ✓ | ✓ | ✗ | ◐⁶ | ✓ |
| Adaptive compaction threshold | ✗ | ✓ (ratio mode) | ✗ | ◐ (branch) | ◐⁷ |
| **Robustness** ||||||
| Anergy — stale-memory detection vs the live repo | ✓ | ✗ | ✗ | ✗ | ✗ |
| Worker transport hardening (NUL-safe argv / E2BIG) | ✓ | – | ✗ | ◐ (branch) | – |
| Secret redaction before persistence | ✓ (observations + prompts) | ✗ | ✗ | ✗ | ✓ |
| Attachment/image gates | ✗ | ✗ | ✗ | ✗ | ✓ (2 MB) |
| Debug logging actually wired to call sites | ✓ | ✓ | ✗⁸ | ✗⁸ | ✓ |
| **Retrieval** ||||||
| Recall-by-id tool | ✗ | ✓ | ✗ | ✗ | ✓ |
| Built-in vector/semantic search | ✗ | ✗ | ✗ | ✗ | ✓ (hash/BOW + Gemini) |
| External semantic KB integration ([pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain)) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Ops & UX** ||||||
| Cost/spend tracking (per session, monotonic) | ✓ | ✗ | ✓ | ✓ | ✗ |
| TUI footer gauges + worker widget | ✓ | ✗ | ✓ | ✓ | ✓ |
| ASCII timeline / status overlay | ✓ | ✗ | ✓ | ✓ | ✓ |
| Runtime mode/model switching commands | ✓ (3) | ✗ | ✗ | ✗ | ✓ (`/om set …`) |
| Enable gate default | **OFF** | ON | OFF | OFF | ON |
| Zero runtime dependencies | ✓ | ✓ | ✓ | ✓ | ✓ |
| End-user install instructions | ✓ | ✓ | ✗ | ✗ | ✗ |

¹ elpapi42 has an in-session projection (`om.folded`), no standalone file. ² The compaction *render* is pure, but the same hook runs LLM observer/reflector passes first. ³ Branch-local folding exists; no dedicated `/tree` rollback test path. ⁴ Always serial by design — no config knob. ⁵ Stage clocks re-anchor across compaction; no explicit resume message. ⁶ Bridged to the *consolidator*, not the observer. ⁷ Pool-aware threshold, not context-window-aware. ⁸ NDJSON logger exists but has **zero call sites** — the documented `debugLog` flag can never turn it on. ⁹ elpapi42's Dropper tier *deletes* judged-irrelevant facts — the opposite invariant. ¹⁰ Recall exists as a tool (`recall` / `om_recall`) the model must think to call; nothing is injected at compaction time.

*Verified by source inspection of each repo's default branch on 2026-09-23. The **v4** rows were added 2026-09-25: this-repo cells are backed by the test suite (368 tests — golden byte-identity, rehydration probes, gap/flush-ack regressions); competitor cells rest on the same source inspection — open an issue if a project has since grown one of these. casret's interesting work lives on 8 stacked, unmerged branches (`fix-e2big-prompt-file`, `adaptive-context-compaction`, `friendly-name-memory-index`, `om-handoff-integration`, …) — cells marked ◐ reflect that; its `main` is byte-identical to amosblomqvist's `78a1efc`. Stars and dates from GitHub/npm as of Sep 2026.*

### Lineage — who came from what

- **The concept** is [Mastra](https://mastra.ai)'s *Observational Memory* research; elpapi42's README credits it as the origin.
- **First OM extension for pi** was [ohmyzhell's](https://github.com/GitHubFoxy/pi-extension-observational-memory) (Feb 2026, dormant). **elpapi42's** (Apr 2026) became *the* canonical one: ~650★, 25 npm releases up to 3.1.4, and a richer design — three in-process agents (Observer/Reflector/Dropper) and a recall-by-id tool, but everything lives inside the session file.
- **amosblomqvist's** (Jun 2026) is *not* a git fork of elpapi42 — it's an independent, structurally different rewrite (subprocess workers, on-disk `.memory/` files) whose own code comments describe it as "trimmed from OM V3". 53★, quiet since Aug 2026.
- **This repo** is a git fork of amosblomqvist's `78a1efc`, extended with: NUL-safe worker argv, serial mode for local models, observer context bridging, anergy, bounded failed-chunk retry, stale-ctx crash hardening, `.memory/` path normalization, wired debug logging, `/om-parallel` · `/om-sequential` · `/om-change-model`, [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain) retrieval advertising, and this README.
- **casret** forks amosblomqvist as a laboratory: eight stacked feature branches, none merged.
- **nik1t7n's** is an independent Mastra-style take (Jun 2026) — one 2,500-line file, LLM reflection levels 0–4, optional vector recall, and the ecosystem's only secret redaction and attachment gates.

## Install

**Requirements:** [Node.js](https://nodejs.org) ≥ 20, [pi](https://pi.dev) installed and run at least once, and an LLM provider configured for your worker models (default: `openrouter/z-ai/glm-5.3`).

```bash
git clone https://github.com/myusufalghifari10/pi-observational-memory.git
cd pi-observational-memory
sh scripts/install.sh
```

The script checks prerequisites, installs dev dependencies, typechecks, and registers the repo in the `extensions` array of `~/.pi/agent/settings.json` (a `.bak` backup is written; the run is idempotent).

- `sh scripts/install.sh --test` — also run the full test suite before registering
- `sh scripts/install.sh --no-register` — install only, and print the line to add manually

Manual alternative: `npm install`, then add the absolute clone path to the `extensions` array in `~/.pi/agent/settings.json`. Either way, **restart pi**, then run `/om on`.

## Configuration

All settings live under the `observational-memory` key — global `~/.pi/agent/settings.json`, optionally overridden per project in `<project>/.pi/settings.json` (per-field merge: project → global → defaults). These are the **actual defaults** from `src/config.ts`:

```json
"observational-memory": {
  "chunkTokens": 10000,
  "chunkOverlapTokens": 0,
  "poolTargetTokens": 10000,
  "consolidateAtPoolTokens": 15000,
  "compactAtContextTokens": 64000,
  "tailTokens": 20000,
  "journeyTargetTokens": 1000,
  "observerConcurrency": 4,
  "serialWorkers": false,
  "resumeAfterMidRunCompaction": true,
  "models": {
    "observer":     { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "low" },
    "consolidator": { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "medium" }
  },
  "passive": false,
  "debugLog": false
}
```

- `serialWorkers: true` = one worker at a time (use `/om-sequential`; made for local models).
- `passive: true` (or env `PI_OM_PASSIVE=true`) is a kill-switch that suppresses all triggering.
- Unset `models.*` fields fall back to the built-in default model — there is no per-role disable (use `passive: true` to suppress all triggering).
- Setting `models.*` in a project config no longer discards the provider chosen in global config — partial overrides merge field-by-field.

## Development

```bash
npm install
npm test              # vitest — 34 test files, 368 tests (P0–P5, v4 probes)
npm run typecheck     # tsc --noEmit
sh scripts/install.sh --test --no-register   # everything, without touching settings
```

Architecture notes: `src/ledger/*` (fold, projection, render) and `src/memory/*` are pure TypeScript with zero pi imports — the pi-specific shell is the hooks, commands, and spawn layers. Worker roles live in `agent/` and run headless with builtin tools disabled.

## Limitations

Honest list, because the table above shows others doing some of this better:

- **No built-in vector search or recall-by-id tool.** Retrieval is filesystem grep, optionally via [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain)'s `knowledge_search` (advertised at every compaction).
- **Attachment/image gates are absent.** Observations persist (redacted for known secret patterns) but not gated by size or type — nik1t7n's extension is still the only one in this table that refuses attachments outright. Treat what you paste into observed sessions accordingly.
- **Memory is per-session** (fork-seeded, not project-shared). Two sessions in the same project keep separate `.memory/` trees.
- **`.runs/` IPC files are garbage-collected only at session start, after 7 days** (one JSON pair per worker run; transient by design).

## Related project

> **[pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain)** — a portable, harness-agnostic second brain: an embeddable index plus hybrid (BM25 + vector + rerank) search that runs standalone on any machine. This extension feeds it: consolidated `.memory/` topic files get indexed as a knowledge base and become queryable with `knowledge_search` at any time. **Observational memory writes; pi-second-brain retrieves.** Two halves of one memory stack — this repo is the pi-native writer, that one is the portable retrieval engine.

## License

MIT — see [LICENSE](./LICENSE) (© 2026 Amos Blomqvist, preserved from the upstream this project builds on). Lineage credits: [Mastra](https://mastra.ai) (concept), [elpapi42](https://github.com/elpapi42/pi-observational-memory) (canonical implementation), [amosblomqvist](https://github.com/amosblomqvist/pi-observational-memory) (upstream).
