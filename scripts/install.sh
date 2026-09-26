#!/bin/sh
# pi-observational-memory installer (POSIX) — macOS, Linux, and Windows via Git Bash.
# Native Windows? Run scripts\install.ps1 in PowerShell instead. Both launchers run
# the same cross-platform core: scripts/install-core.cjs.
#
#   sh scripts/install.sh              install + register + seed config
#   sh scripts/install.sh --no-register  install only (print what to add manually)
#   sh scripts/install.sh --test       also run the full test suite
set -eu

cd "$(dirname "$0")/.."

case "$(uname -s)" in
	Linux*) OS=linux ;;
	Darwin*) OS=macos ;;
	MINGW* | MSYS* | CYGWIN*) OS=windows ;;
	*) OS=unknown ;;
esac

printf '\033[1m  pi-observational-memory installer\033[0m  (detected OS: %s)\n' "$OS"

if ! command -v node >/dev/null 2>&1; then
	printf 'error: Node.js 20 or newer required — install it first:\n'
	case "$OS" in
		windows) printf '       winget install -e --id OpenJS.NodeJS.LTS   (or https://nodejs.org)\n' ;;
		macos)   printf '       brew install node   (or https://nodejs.org)\n' ;;
		*)       printf '       sudo apt install nodejs npm   (or https://nodejs.org)\n' ;;
	esac
	exit 1
fi

exec node scripts/install-core.cjs "$@"
