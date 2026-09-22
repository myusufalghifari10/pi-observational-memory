# pi-observational-memory

> **Long-running Pi sessions that remember — tiered, subprocess-backed memory with parallel observers, durable markdown files, and a memory that knows when it's gone stale.**

*Built for [pi](https://pi.dev) — an agent extension that distills your conversation into observations, files them into `.memory/` topic files, and renders them back deterministically every time your context compacts. Local-model friendly: flip one switch to run every worker serially. Optionally indexes your memory into [pi-second-brain](https://github.com/myusufalghifari10/pi-second-brain) so old context becomes queryable.*

> **Provenance.** Based on [amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory) (MIT — © 2026 Amos Blomqvist), whose code comments describe it as a trimmed adaptation of "OM V3". The wider concept traces back to [Mastra](https://mastra.ai)'s *Observational Memory* research, and the canonical popular implementation is [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory). This repo keeps the original license, credits both, and adds its own layer of fixes and features (see below). Comparison table and lineage at the bottom — verified against each project's source code.

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
        │                                   (atomic temp+rename writes)
        ▼
  at context ≥ 150k: compaction hook snaps the cutoff to a chunk boundary and
  renders  [ instructions | JOURNEY | memory map | observations ]  — model-free —
  then keeps the verbatim tail.  Stale topics are demoted (anergy), not trusted.
```

**Three tiers, three lifetimes:**

1. **Raw** — the session ledger itself. Branch-local, so `/tree` rolls short-term memory back natively; spend is summed across all branches so money never lies.
2. **Observations** — structured `{timestamp, content, tokenCount}` records promoted from chunks by the observers, kept in a bounded buffer with promotion thresholds.
3. **Durable** — `.memory/<sessionId>/*.md` topic files, `INDEX.md`, `JOURNEY.md`: grep-able markdown any tool can read, seeded into child sessions on fork.

## Highlights

- **Parallel *or* serial workers.** Observers fan out (default concurrency 4) on cloud models; `/om-sequential` switches the whole pipeline to one worker at a time for local models — applied live, persisted to settings.
- **Model-free compaction.** The render path is pure code: deterministic, instant, failure-proof; empty memory delegates to Pi's native summarizer.
- **Context bridging.** Observers see a bounded tail of previous observations, so they stop restating facts and can spot contradictions across chunks.
- **Anergy — stale-memory detection.** Topic files carry `asserts:` paths checked against your live repo at render time; topics whose assertions no longer hold (and that no current observation re-mentions) are demoted to one-line stubs instead of misleading you.
- **Failed chunks retry once, bounded.** A crashed observer no longer permanently loses its chunk: failures are recorded and re-dispatched oldest-first, capped so a poison chunk can never loop forever.
- **Everything is inspectable.** Every worker is an ordinary recorded pi session; every file is markdown; `.runs/` IPC is plain JSON. No black boxes.
- **Honest accounting.** Worker spend is captured from pi's own usage totals, summed monotonically across branches, shown in the footer and `/om:status`.
- **`/tree`-correct by construction.** Ledger folds are branch-local; durable files are session-scoped; cost never rolls back.
- **Hardened subprocess transport.** Worker argv is stripped of NUL bytes (PDF tool output used to crash dispatch), the worker pump survives session reloads, and the consolidator's tools are path-sandboxed to `.memory/`.
- **Second-brain retrieval.** Every compaction block tells the reader that older memory is indexed in pi-second-brain and can be queried with `knowledge_search` — retrieval lives in a real vector KB instead of a bespoke recall tool.
- **Off by default.** Nothing runs until you type `/om on`. Workers disable themselves when their model/provider is unset, even if the gate is on.

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

## Comparison with other observational-memory implementations

### At a glance

| | **this repo** | [elpapi42](https://github.com/elpapi42/pi-observational-memory) | [amosblomqvist](https://github.com/amosblomqvist/pi-observational-memory) | [casret](https://github.com/casret/pi-observational-memory) | [nik1t7n](https://github.com/nik1t7n/pi-observational-memory-extension) |
|---|---|---|---|---|---|
| Created | 2026-09 (this fork) | 2026-04 | 2026-06 | 2026-08 (fork) | 2026-06 |
| Relationship | git fork of amosblomqvist + 11 feature/fix commits | the canonical implementation (v3.1.4, ~650★) | trimmed adaptation of OM V3; **upstream base of this fork** | git fork of amosblomqvist used as a branch lab | independent, Mastra-style |
| Roles | observer, consolidator | Observer, Reflector, Dropper | observer, consolidator | same as amos | Actor, Observer, Reflector |
| Workers | subprocess `pi` sessions, parallel **or** serial | in-process agents, always serial | subprocess, parallel (4) | subprocess, parallel (4) | in-process LLM calls |
| Storage | ledger + `.memory/*.md` topic files | session ledger only | ledger + `.memory/*.md` | ledger + `.memory/*.md` | JSON state files (`.pi/om/`) |
| Retrieval | filesystem grep + pi-second-brain `knowledge_search` | `recall` tool by 12-hex id | filesystem grep | filesystem grep | `om_recall` + optional vector search |
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
| Secret redaction before persistence | ✗ | ✗ | ✗ | ✗ | ✓ |
| Attachment/image gates | ✗ | ✗ | ✗ | ✗ | ✓ (2 MB) |
| Debug logging actually wired to call sites | ✓ | ✓ | ✗⁸ | ✗⁸ | ✓ |
| **Retrieval** ||||||
| Recall-by-id tool | ✗ | ✓ | ✗ | ✗ | ✓ |
| Built-in vector/semantic search | ✗ | ✗ | ✗ | ✗ | ✓ (hash/BOW + Gemini) |
| External semantic KB integration (pi-second-brain) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Ops & UX** ||||||
| Cost/spend tracking (per session, monotonic) | ✓ | ✗ | ✓ | ✓ | ✗ |
| TUI footer gauges + worker widget | ✓ | ✗ | ✓ | ✓ | ✓ |
| ASCII timeline / status overlay | ✓ | ✗ | ✓ | ✓ | ✓ |
| Runtime mode/model switching commands | ✓ (3) | ✗ | ✗ | ✗ | ✓ (`/om set …`) |
| Enable gate default | **OFF** | ON | OFF | OFF | ON |
| Zero runtime dependencies | ✓ | ✓ | ✓ | ✓ | ✓ |
| End-user install instructions | ✓ | ✓ | ✗ | ✗ | ✗ |

¹ elpapi42 has an in-session projection (`om.folded`), no standalone file. ² The compaction *render* is pure, but the same hook runs LLM observer/reflector passes first. ³ Branch-local folding exists; no dedicated `/tree` rollback test path. ⁴ Always serial by design — no config knob. ⁵ Stage clocks re-anchor across compaction; no explicit resume message. ⁶ Bridged to the *consolidator*, not the observer. ⁷ Pool-aware threshold, not context-window-aware. ⁸ NDJSON logger exists but has **zero call sites** — the documented `debugLog` flag can never turn it on.

*Verified by source inspection of each repo's default branch on 2026-09-23. casret's interesting work lives on 8 stacked, unmerged branches (`fix-e2big-prompt-file`, `adaptive-context-compaction`, `friendly-name-memory-index`, `om-handoff-integration`, …) — cells marked ◐ reflect that; its `main` is byte-identical to amosblomqvist's `78a1efc`. Stars and dates from GitHub/npm as of Sep 2026.*

### Lineage — who came from what

- **The concept** is [Mastra](https://mastra.ai)'s *Observational Memory* research; elpapi42's README credits it as the origin.
- **First OM extension for pi** was [ohmyzhell's](https://github.com/GitHubFoxy/pi-extension-observational-memory) (Feb 2026, dormant). **elpapi42's** (Apr 2026) became *the* canonical one: ~650★, 25 npm releases up to 3.1.4, and a richer design — three in-process agents (Observer/Reflector/Dropper) and a recall-by-id tool, but everything lives inside the session file.
- **amosblomqvist's** (Jun 2026) is *not* a git fork of elpapi42 — it's an independent, structurally different rewrite (subprocess workers, on-disk `.memory/` files) whose own code comments describe it as "trimmed from OM V3". 53★, quiet since Aug 2026.
- **This repo** is a git fork of amosblomqvist's `78a1efc`, extended with: NUL-safe worker argv, serial mode for local models, observer context bridging, anergy, bounded failed-chunk retry, stale-ctx crash hardening, `.memory/` path normalization, wired debug logging, `/om-parallel` · `/om-sequential` · `/om-change-model`, pi-second-brain retrieval advertising, and this README.
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
  "compactAtContextTokens": 150000,
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
- `models.*` unset/`"off"` disables that role at runtime even when `/om on`, so an unconfigured provider can never block the pipeline.
- Setting `models.*` in a project config no longer discards the provider chosen in global config — partial overrides merge field-by-field.

## Development

```bash
npm install
npm test              # vitest — 160 tests in 21 files
npm run typecheck     # tsc --noEmit
sh scripts/install.sh --test --no-register   # everything, without touching settings
```

Architecture notes: `src/ledger/*` (fold, projection, render) and `src/memory/*` are pure TypeScript with zero pi imports — the pi-specific shell is the hooks, commands, and spawn layers. Worker roles live in `agent/` and run headless with builtin tools disabled.

## Limitations

Honest list, because the table above shows others doing some of this better:

- **No built-in vector search or recall-by-id tool.** Retrieval is filesystem grep, optionally via pi-second-brain's `knowledge_search` (advertised at every compaction).
- **No secret redaction or attachment/image gates yet.** Observations persist verbatim — nik1t7n's extension is currently the only one in this table that redacts. Treat what you paste into observed sessions accordingly.
- **Memory is per-session** (fork-seeded, not project-shared). Two sessions in the same project keep separate `.memory/` trees.
- **`.runs/` IPC files are never garbage-collected** (v1 trade-off; plain JSON, one pair per worker run).

## License

MIT — see [LICENSE](./LICENSE) (© 2026 Amos Blomqvist, preserved from the upstream this project builds on). Lineage credits: [Mastra](https://mastra.ai) (concept), [elpapi42](https://github.com/elpapi42/pi-observational-memory) (canonical implementation), [amosblomqvist](https://github.com/amosblomqvist/pi-observational-memory) (upstream).
