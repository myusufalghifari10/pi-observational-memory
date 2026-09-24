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
const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
if (extensions.includes(repoRoot)) {
  console.log("already registered in " + settingsPath);
  process.exit(0);
}
fs.copyFileSync(settingsPath, settingsPath + ".bak");
extensions.push(repoRoot);
settings.extensions = extensions;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log("registered in " + settingsPath + " (backup: settings.json.bak)");
EOF
else
  say "skipped registration — add this to the extensions array in ~/.pi/agent/settings.json:"
  say "  \"$REPO_ROOT\""
fi

say ""
say "done. Next steps:"
say "  1. restart pi (a new session picks up the extension)"
say "  2. inside pi run:  /om on      # observational memory is OFF by default"
say "  3. inspect anytime: /om:status"
say "config lives under the 'observational-memory' key in ~/.pi/agent/settings.json"
