#!/usr/bin/env node
/**
 * pi-observational-memory installer core — every install step lives HERE so the
 * POSIX (install.sh) and PowerShell (install.ps1) launchers cannot drift apart.
 * Runs anywhere Node runs: Linux, macOS, Windows (cmd/PowerShell/Git Bash).
 *
 *   node scripts/install-core.js              install + register + seed config
 *   node scripts/install-core.js --no-register  install only
 *   node scripts/install-core.js --test       also run the full test suite
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
// Windows resolves npm/npx as .cmd shims — spawning the bare name needs a shell there.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const argv = process.argv.slice(2);
let register = true;
let runTests = false;
for (const arg of argv) {
	if (arg === "--no-register") register = false;
	else if (arg === "--test") runTests = true;
	else if (arg === "-h" || arg === "--help") {
		console.log("usage: scripts/install.sh [--test] [--no-register]   (or install.ps1 on Windows)");
		process.exit(0);
	} else {
		console.error(`unknown option: ${arg} (see --help)`);
		process.exit(2);
	}
}

const say = (msg) => console.log(msg);
const fail = (msg) => {
	console.error(`error: ${msg}`);
	process.exit(1);
};

/** Cross-platform "is this command on PATH?" — PATHEXT-aware on Windows. */
function onPath(cmd) {
	const dirs = (process.env.PATH || "").split(path.delimiter);
	const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
	return dirs.some((dir) =>
		exts.some((ext) => {
			try {
				return fs.statSync(path.join(dir, cmd + ext)).isFile();
			} catch {
				return false;
			}
		}),
	);
}

/** Run a command, stream output live; throw on non-zero exit. */
function run(cmd, args) {
	const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: false });
	if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
	if (result.status !== 0) fail(`${cmd} ${args.join(" ")} exited with code ${result.status}`);
}

/** Run a command, capture output; on failure replay the diagnostics (never swallow). */
function runCaptured(cmd, args, what) {
	const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "pipe", shell: false, encoding: "utf8" });
	if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
	if (result.status !== 0) {
		say("");
		say(`${what} failed — full output below:`);
		say("--------------------------------------------------");
		say((result.stdout || "") + (result.stderr || ""));
		say("--------------------------------------------------");
		fail(`${what} failed (see output above)`);
	}
}

// ── 1. Prerequisites ─────────────────────────────────────────────────────────
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20) fail(`Node.js >= 20 required (found ${process.version})`);
if (!onPath("npm")) fail("npm not found — it ships with Node.js (reinstall Node)");
if (!onPath("pi")) say("warning: 'pi' not on PATH — install pi first (https://pi.dev), then re-run or add the extension manually");
say(`prerequisites ok (node ${process.version})`);

// ── 2. Dependencies ──────────────────────────────────────────────────────────
run(NPM, fs.existsSync(path.join(REPO_ROOT, "package-lock.json")) ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"]);
say("dependencies installed");

// ── 3. Sanity: typecheck (+ optional full tests) ─────────────────────────────
runCaptured(NPX, ["tsc", "--noEmit"], "typecheck");
say("typecheck ok");
if (runTests) {
	runCaptured(NPX, ["vitest", "run"], "test suite");
	say("tests ok");
}

// ── 4. Register the extension + seed config in ~/.pi/agent/settings.json ────
if (register) {
	// os.homedir() resolves HOME/USERPROFILE correctly on every OS.
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	if (!fs.existsSync(path.dirname(settingsPath))) {
		fail(`${path.dirname(settingsPath)} not found — is pi installed and has it been run at least once?`);
	}
	let settings = {};
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch {
		/* first run: keep {} */
	}

	// Registration lives in the "packages" array (a pi package resolves its entry from
	// package.json "pi.extensions"). Older revisions of the installer pushed the repo
	// dir into "extensions" — migrate that entry so the result matches a working setup.
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
	let changed = false;
	if (extensions.includes(REPO_ROOT)) {
		settings.extensions = extensions.filter((entry) => entry !== REPO_ROOT);
		changed = true;
	}
	if (!packages.includes(REPO_ROOT)) {
		packages.push(REPO_ROOT);
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
		debugLog: false,
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
		say(`registered in ${settingsPath} (backup: settings.json.bak)`);
	} else {
		say(`already registered in ${settingsPath}`);
	}
	if (seededConfig) {
		say("seeded 'observational-memory' config (spec values; add a 'models' block to pick your worker model)");
	} else {
		say("existing 'observational-memory' config left untouched");
	}
} else {
	say("skipped registration — add this to the packages array in ~/.pi/agent/settings.json:");
	say(`  "${REPO_ROOT}"`);
}

say("");
say("done. Next steps:");
say("  1. restart pi (a new session picks up the extension)");
say("  2. inside pi run:  /om on      # observational memory is OFF by default");
say("  3. inspect anytime: /om:status");
say("config lives under the 'observational-memory' key in ~/.pi/agent/settings.json");
say("(seeded with the spec values on first install — add a 'models' block there to pick your worker model)");
