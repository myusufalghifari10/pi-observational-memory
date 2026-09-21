# Spec — OM Improvements: Serial Workers, Anergy, Context Bridging

Date: 2026-09-21 · Status: APPROVED (pending final go) · Scope: 3 features, ~13 files

## Spec (requirements — immutable)

1. **`serialWorkers` (config, default false).** When true: at most ONE worker subprocess
   (observer OR consolidator) runs at any moment — no observer/observer parallelism and no
   observer/consolidator overlap. Rationale: local model backends thrash under parallel
   subprocess load; serial total throughput beats parallel latency.
   - Queue is event-driven (no daemon): when the slot frees, the next due task runs on the
     next `turn_end`/`agent_start` **plus** a completion-pump so the queue self-drains.
   - **Priority rule:** when the active pool is at/over `consolidateAtPoolTokens`, the
     consolidator gets the free slot before new observers (bounds the buffer under churn).
2. **Anergy (memory-vs-repo drift check).** Topic files may declare `asserts:` front-matter
   (comma-separated repo-relative paths, optionally `path#symbol`). At compaction render,
   the deterministic renderer checks each assertion against the live repo (stat / bounded
   content search). A topic with ≥1 failing assertion renders as a ONE-LINE STUB in the
   injected memory map until re-armed. Never deletes; never persists anergy state
   (re-derived per render — inherits cannot-decay). Empty/absent `asserts` = exempt.
   - **Re-arm:** a failing assertion is forgiven if any ACTIVE observation in the buffer
     mentions the asserted path (renewed relevance = not stale).
3. **Context bridging.** Each observer prompt may carry a PREVIOUS CONTEXT block: the last
   ≤5 active observations (chronological), fenced, labeled "already recorded — reference
   only for resolving references; do NOT re-observe". Omitted when the buffer is empty.

Out of scope (decided): `-p @file` prompt transport (NUL argv-strip stays), defaultOn,
adaptive compaction threshold, pool-growth alarm, recall tool in OM (retrieval lives in
pi-second-brain: topic files + JOURNEY.md sync at consolidation time — future work).

## Context (codebase facts this design relies on)

- Slots: `Runtime.observerSlotsAvailable` (config `observerConcurrency`, default 4);
  consolidator gated by `consolidatorInFlight` only — overlap with observers is deliberate
  today (design R5: compaction waits for observers, never the consolidator).
- Triggers register in order observer → consolidator on `turn_end` + `agent_start`
  (`src/index.ts`), so within one event the observer handler runs first.
- `dispatchObserver` builds `userText` inline; chunk serialization is
  `serializeSourceAddressedBranchEntries(slice.entries)`; buffer = `foldLedger(branch).activeObservations`.
- Topic front-matter parsed by tiny flat parser `parseFrontMatter` (`src/memory/paths.ts`);
  `renderMemoryMap(topics)` is called only from the compaction hook; `renderIndexFile`
  (on-disk INDEX.md) is orchestrator-owned and stays un-anergic.
- NUL argv guard (`kickoffPrompt.replace(/\0/g,"")`) already in `buildWorkerArgv`.

## Tasks

### A. serialWorkers
- `src/config.ts`: `Config.serialWorkers: boolean` + DEFAULTS(false) + normalize boolean +
  export `normalizeSettingsConfig` (for tests).
- `src/runtime.ts`: `get workerBusy()` = consolidatorInFlight || observersInFlight.size>0;
  `observerSlotsAvailable` → serial: `workerBusy ? 0 : Math.min(1, observerConcurrency)`.
- `src/hooks/observer-trigger.ts`:
  - top-of-evaluation yield: if serial && !consolidatorInFlight && pool ≥ consolidateAt →
    return (consolidator handler, registered next, takes the slot).
  - extract pure `buildObserverPrompt(chunkText, bridge?)` (used by C).
  - completion pump: `pumpWorkerQueue()` helper (queueMicrotask + Runtime.pumpQueued flag)
    → re-run evaluateObserverTriggers + evaluateConsolidatorTrigger; called from
    dispatchObserver finally.
- `src/hooks/consolidator-trigger.ts`: skip when serial && observersInFlight.size > 0;
  pump from its finally too.
- Tests (`tests/serial-workers.test.ts`): slot math (serial busy/free, non-serial
  unchanged), normalize serialWorkers, priority-yield predicate (pure helper
  `shouldYieldToConsolidator(config, poolTokensValue)`).
- README.md: config row + "local model" note.

### B. Anergy
- `src/memory/paths.ts`: `TopicFrontMatter.asserts?: string[]`; parse `asserts:` as
  comma-separated single line, strip quotes/whitespace.
- `src/memory/anergy.ts` (NEW, pure): `checkAnergy(topics, projectCwd, activeObservations)
  → Map<filename, string[]>` (filename → failed assertions). Semantics per assertion:
  `path#symbol` → file exists AND content (≤256KB read) contains symbol; `path` → exists.
  Cap 20 assertions/topic. Topic anergic iff ≥1 failure AND no active observation content
  contains the failed path. Never throws (IO error = assertion failed? NO — IO error =
  treat as pass to avoid false demotion; only definite absence demotes).
- `src/memory/index-render.ts`: `renderMemoryMap(topics, anergy?)` — anergic topic renders
  `- \`path\` — anergic: <failed> not found (topic may be stale)`; healthy unchanged.
  `renderIndexFile` unchanged.
- `src/hooks/compaction-hook.ts`: compute projectCwd = resolve(memoryRoot,"..",".."); pass
  `checkAnergy(...)` result into renderMemoryMap.
- `agent/consolidator/prompt.ts`: front-matter contract += `asserts:` line (maintain on
  every write; may be empty; comma-separated; repo-relative; `path#symbol` allowed).
- Tests (`tests/anergy.test.ts`): parser (quotes/commas/spaces), missing file, missing
  symbol, present, IO-error = pass, re-arm via observation, >20 cap, map render stub.

### C. Context bridging
- `src/hooks/observer-trigger.ts`: `bridgeContextBlock(obs) → string | undefined`
  (last ≤5 sorted active observations, fenced + "reference only / do not re-observe"
  labels); injected into `buildObserverPrompt` between intro and BEGIN fence; omitted when
  buffer empty. Constant `BRIDGE_TAIL = 5`.
- `agent/observer/prompt.ts`: OBSERVER_SYSTEM += one paragraph defining the PREVIOUS
  CONTEXT block and forbidding observations sourced from it.
- Tests (`tests/observer-bridge.test.ts`): empty→undefined; 3→all; 7→last 5 only;
  prompt contains fence + instruction; prompt without bridge unchanged shape.

## Risks
- **A:** queue drain depends on events → mitigated by completion pump (no daemon added).
  Consolidator starvation under endless churn → mitigated by priority-yield rule.
- **A:** compaction wait semantics unchanged; worst-case wait = 1 running worker.
- **B:** false demotion from hallucinated asserts → demote-never-delete, stub shows the
  failed assertion, exempt-when-empty, recompute per render (never persisted), IO-error
  treated as pass.
- **B:** render cost = ≤20 cheap fs checks per topic, compaction-only. Acceptable.
- **C:** prompt bloat → capped at 5 single-line observations; omitted when empty.
- **C:** observer re-observes bridge → mitigated by fence labels + system prompt rule +
  duplicate tolerance downstream (first-valid-wins fold).

## Completion
- `npx vitest run` all green (existing 99 + new), `npx tsc --noEmit` clean.
- Manual: `serialWorkers:true` session → observe one worker at a time in widget/timeline;
  topic file with a deleted asserted path renders anergic stub at next compaction; second
  observer prompt shows PREVIOUS CONTEXT block (inspectable in recorded worker session).
- Backup pushed to github.com/myusufalghifari10/pi-observational-memory before implementation.
