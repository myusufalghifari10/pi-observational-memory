# pi-observational-memory installer (PowerShell) — native Windows (cmd/PowerShell).
# macOS/Linux/Git Bash users: run scripts/install.sh instead. Both launchers run
# the same cross-platform core: scripts/install-core.cjs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 --test
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 --no-register
$ErrorActionPreference = "Stop"

if (-not $PSScriptRoot) {
	# `irm | iex` style invocation has no script root; without the repo we would run in the wrong folder.
	Write-Host "error: run this script from a cloned repo (it needs the source tree):" -ForegroundColor Red
	Write-Host "       git clone https://github.com/myusufalghifari10/pi-observational-memory.git" -ForegroundColor Red
	Write-Host "       cd pi-observational-memory" -ForegroundColor Red
	Write-Host '       powershell -ExecutionPolicy Bypass -File scripts\install.ps1' -ForegroundColor Red
	exit 1
}
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host ""
Write-Host "  pi-observational-memory installer (Windows/PowerShell)" -ForegroundColor Bold
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	Write-Host "error: Node.js 20 or newer required - install it first:" -ForegroundColor Red
	Write-Host "       winget install -e --id OpenJS.NodeJS.LTS   (or https://nodejs.org)" -ForegroundColor Red
	exit 1
}

& node scripts/install-core.cjs @args
exit $LASTEXITCODE
