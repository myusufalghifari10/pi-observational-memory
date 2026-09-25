#!/usr/bin/env sh
# pi-observational-memory installer — checks prerequisites, installs dev deps,
# verifies the extension loads, and registers it in ~/.pi/agent/settings.json.
#
#   sh scripts/install.sh              install + register
#   sh scripts/install.sh --no-register  install only (print what to add manually)
#   sh scripts/install.sh --test        also run the full test suite
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SETTINGS="$HOME/.pi/agent/settings.json"
REGISTER=1
RUN_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --no-register) REGISTER=0 ;;
    --test) RUN_TESTS=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s (see --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
say()  { printf '%s\n' "$*"; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail "node not found — install Node.js 20+ (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail "Node.js >= 20 required (found $(node -v))"
command -v npm  >/dev/null 2>&1 || fail "npm not found — it ships with Node.js"
command -v pi   >/dev/null 2>&1 || say "warning: 'pi' not on PATH — install pi first (https://pi.dev), then re-run or add the extension manually"
say "prerequisites ok (node $(node -v))"

# ── 2. Dependencies ───────────────────────────────────────────────────────────
cd "$REPO_ROOT"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund
else npm install --no-audit --no-fund
fi
say "dependencies installed"

# ── 3. Sanity: typecheck (+ optional full tests) ──────────────────────────────
# P0.9: keep the real diagnostics — a swallowed tsc error just told the user to "re-clone",
# which is never the actual cause. Capture the output and replay it only on failure.
SANITY_LOG=$(mktemp "${TMPDIR:-/tmp}/om-install.XXXXXX")
trap 'rm -f "$SANITY_LOG"' EXIT INT TERM

if ! npx tsc --noEmit >"$SANITY_LOG" 2>&1; then
  say ""
  say "typecheck failed — full diagnostics below:"
  say "--------------------------------------------------"
  sed 's/^/  /' "$SANITY_LOG"
  say "--------------------------------------------------"
  fail "typecheck failed (see diagnostics above)"
fi
say "typecheck ok"
if [ "$RUN_TESTS" -eq 1 ]; then
  if ! npx vitest run >"$SANITY_LOG" 2>&1; then
    say ""
    say "test suite failed — full output below:"
    say "--------------------------------------------------"
    sed 's/^/  /' "$SANITY_LOG"
    say "--------------------------------------------------"
    fail "test suite failed (see output above) — do not register; please open an issue with this log"
  fi
  say "tests ok"
fi

# ── 4. Register the extension in ~/.pi/agent/settings.json ────────────────────
if [ "$REGISTER" -eq 1 ]; then
  [ -d "$HOME/.pi/agent" ] || fail "$HOME/.pi/agent not found — is pi installed and has it been run at least once?"
  node - <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const settingsPath = path.join(process.env.HOME, ".pi", "agent", "settings.json");
const repoRoot = process.cwd();
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { /* first run: keep {} */ }

// Registration lives in the "packages" array (a pi package resolves its entry from
// package.json "pi.extensions"). Older revisions of this script pushed the repo dir
// into "extensions" — migrate that entry so the result matches a working setup.
const packages = Array.isArray(settings.packages) ? settings.packages : [];
const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
let changed = false;
if (extensions.includes(repoRoot)) {
  settings.extensions = extensions.filter((entry) => entry !== repoRoot);
  changed = true;
}
if (!packages.includes(repoRoot)) {
  packages.push(repoRoot);
  settings.packages = packages;
  changed = true;
}

// Seed the spec config block ONLY when the key is absent — an existing
// "observational-memory" block (e.g. a tuned live setup) is never touched.
// No "models" is seeded on purpose: any provider/model works, and an unset
// models.* falls back to the built-in default worker model.
const SPEC = {
  chunkTokens: 15000,
  chunkOverlapTokens: 0,
  poolTargetTokens: 12000,
  consolidateAtPoolTokens: 20000,
  compactAtContextTokens: 264000,
  tailTokens: 30000,
  journeyTargetTokens: 1000,
  observerConcurrency: 4,
  serialWorkers: false,
  resumeAfterMidRunCompaction: true,
  passive: false,
  debugLog: false
};
let seededConfig = false;
if (settings["observational-memory"] === undefined) {
  settings["observational-memory"] = SPEC;
  seededConfig = true;
  changed = true;
}

if (changed) {
  fs.copyFileSync(settingsPath, settingsPath + ".bak");
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("registered in " + settingsPath + " (backup: settings.json.bak)");
} else {
  console.log("already registered in " + settingsPath);
}
if (seededConfig) {
  console.log("seeded 'observational-memory' config (spec values; add a 'models' block to pick your worker model)");
} else if (settings["observational-memory"] !== undefined) {
  console.log("existing 'observational-memory' config left untouched");
}
EOF
else
  say "skipped registration — add this to the packages array in ~/.pi/agent/settings.json:"
  say "  \"$REPO_ROOT\""
fi

say ""
say "done. Next steps:"
say "  1. restart pi (a new session picks up the extension)"
say "  2. inside pi run:  /om on      # observational memory is OFF by default"
say "  3. inspect anytime: /om:status"
say "config lives under the 'observational-memory' key in ~/.pi/agent/settings.json"
say "(seeded with the spec values on first install — add a 'models' block there to pick your worker model)"
