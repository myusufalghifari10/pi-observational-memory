# Spec — OM Mode & Model Switcher Commands

Date: 2026-09-22 · Status: APPROVED · Scope: 4 files

## Spec (requirements — immutable)

1. **`/om-parallel`** — set `observational-memory.serialWorkers=false` (parallel observers for
   cloud models). Instant, one notify.
2. **`/om-sequential`** — set `serialWorkers=true` (one worker at a time, local models).
   Instant, one notify.
3. **`/om-change-model`** — interactive picker mirroring
   `~/.pi/agent/extensions/subagents-change-model.ts`: role (Observer / Consolidator / Both)
   → provider (authenticated only) → model (name, id, ctx window) → thinking level
   (`getSupportedThinkingLevels`, per-model) → confirm. Writes
   `observational-memory.models.{observer,consolidator}.{provider,id,thinking}`.
4. **Persistence:** `~/.pi/agent/settings.json` (atomic tmp+rename, `.bak` backup — same as the
   reference) so changes stick across sessions; PLUS immediate in-memory apply to
   `runtime.config` so the current session uses it without `/reload` (better than reference).
5. Both mode commands work regardless of the `/om` gate; they report current state.

## Context

- `ctx.ui.select(label, options)` / `ctx.ui.confirm(label, message)` — interactive pickers
  (verified API in the reference extension).
- `ctx.modelRegistry.getAvailable()` (authenticated), `getAll()`, `getProviderDisplayName(id)`;
  `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai` (already a peer dep).
- `loadConfig` merges global → project `.pi/settings.json` → env. Command writes the GLOBAL
  file (reference behavior); a project-level override would still win on next load — accepted,
  documented in README.
- Slot math (`runtime.observerSlotsAvailable`, yield rule, pump) already reads
  `runtime.config.serialWorkers` per evaluation — a mid-flight flip is safe: in-flight workers
  finish, the next dispatch follows the new mode.

## Tasks

- `src/commands/switching.ts` (NEW): exported pure helpers `applyOmMode(settings, parallel)` and
  `applyOmModelChange(settings, roles, modelSpec, thinking)` + `writeSettingsAtomic` (`.bak`);
  `registerSwitchingCommands(pi, runtime)` registering the three commands. UI flow is thin
  (select → select → select → confirm → write → in-memory apply → notify).
- `src/index.ts`: call `registerSwitchingCommands(pi, runtime)` next to the other commands.
- `tests/switching.test.ts` (NEW): mode toggle (default on, flips both ways, preserves other
  keys), model change (single role, both roles, preserves overrides/thinking), settings
  immutability (input not mutated).
- `README.md`: three rows in the Commands table + note on global-vs-project precedence.

## Risks

- Global write affects all projects — intended (same as subagents reference); `.bak` backup +
  confirm step before writing.
- Project `.pi/settings.json` overrides global on reload — document; not a bug.
- `ctx.modelRegistry` unavailable in headless mode → guard `ctx.hasUI` like the reference.

## Completion

- `npx vitest run` green (133 + new), `npx tsc --noEmit` clean.
- Manual: `/om-change-model` shows picker chain; chosen model appears in settings.json +
  next observer run logs/uses it; `/om-parallel` ⇄ `/om-sequential` flip `/om:status`.
