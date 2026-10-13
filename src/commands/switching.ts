/**
 * OM commands: /om-sequential (informational) and /om-change-model.
 *
 * The worker pipeline is ALWAYS sequential — one worker subprocess (observer OR consolidator) at
 * a time; see `config.serialWorkers`. There is no parallel mode to switch back to, so
 * /om-sequential writes nothing and only explains the mode.
 *
 * /om-change-model persists to the GLOBAL ~/.pi/agent/settings.json (atomic tmp+rename, .bak
 * backup — same as the subagents-change-model reference) AND applies to runtime.config in memory
 * so the current session picks the change up without /reload. It works regardless of the /om gate.
 * Note: a project .pi/settings.json still overrides the global file on the next config load
 * (documented in README).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../runtime.js";

type Settings = Record<string, unknown>;

const SETTINGS_KEY = "observational-memory";
const DEFAULT_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Set observational-memory.models.<role> = { provider, id, thinking } for each role,
 * merged over the role's existing object (extra fields survive). modelSpec splits at the
 * FIRST slash: "openrouter/z-ai/glm-5.3" ⇒ provider "openrouter", id "z-ai/glm-5.3".
 * Never mutates input.
 */
export function applyOmModelChange(
	settings: Settings,
	roles: string[],
	modelSpec: string,
	thinking: string,
): Settings {
	const next = structuredClone(settings);
	const om = isRecord(next[SETTINGS_KEY]) ? { ...next[SETTINGS_KEY] } : {};
	const models: Record<string, unknown> = isRecord(om.models) ? { ...om.models } : {};
	const slash = modelSpec.indexOf("/");
	const provider = slash === -1 ? modelSpec : modelSpec.slice(0, slash);
	const id = slash === -1 ? "" : modelSpec.slice(slash + 1);
	for (const role of roles) {
		const existing = isRecord(models[role]) ? models[role] : {};
		models[role] = { ...existing, provider, id, thinking };
	}
	om.models = models;
	next[SETTINGS_KEY] = om;
	return next;
}

/** Atomic tab-indented JSON write (tmp + rename); backs up an existing target to <path>.bak. */
export function writeSettingsAtomic(settings: Settings, path: string = DEFAULT_SETTINGS_PATH): void {
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	renameSync(tmp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSettings(path: string): Settings {
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf-8")) as Settings;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Old "provider/id @ thinking" for a role, from settings.json with runtime.config fallback. */
function currentSpec(settings: Settings, role: "observer" | "consolidator", runtime: Runtime): string {
	const om = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
	const models = isRecord(om.models) ? om.models : {};
	const fromFile = models[role];
	if (isRecord(fromFile)) {
		const thinking = typeof fromFile.thinking === "string" ? ` @ ${fromFile.thinking}` : "";
		return `${String(fromFile.provider)}/${String(fromFile.id)}${thinking}`;
	}
	const model = runtime.config.models[role];
	return `${model.provider}/${model.id}${model.thinking ? ` @ ${model.thinking}` : ""}`;
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerSwitchingCommands(pi: ExtensionAPI, runtime: Runtime): void {
	registerSequentialInfoCommand(pi, runtime);
	registerModelCommand(pi, runtime);
}

/**
 * `/om-sequential` is informational only: sequential is the one and only mode. The command is
 * kept (rather than deleted) so the old muscle memory lands on an explanation instead of
 * "unknown command" — but it writes nothing, because there is no parallel mode to return to.
 */
function registerSequentialInfoCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-sequential", {
		description: "Report the worker mode (sequential is mandatory: one worker at a time)",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			runtime.ensureConfig(ctx.cwd);
			ctx.ui.notify(
				"om: sequential mode (mandatory) — one worker at a time; observers queue behind the running worker, and compaction waits for in-flight work before folding memory",
				"info",
			);
		},
	});
}

function registerModelCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om-change-model", {
		description: "Change observer/consolidator model: role → provider → model → thinking (persisted + applied now)",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			let settings: Settings;
			try {
				settings = readSettings(DEFAULT_SETTINGS_PATH);
			} catch (error) {
				ctx.ui.notify(`Cannot parse ${DEFAULT_SETTINGS_PATH}: ${errorMessage(error)}`, "error");
				return;
			}

			const rolePick = await ctx.ui.select("Change model for:", ["Observer", "Consolidator", "Both roles"]);
			if (!rolePick) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const roles: Array<"observer" | "consolidator"> =
				rolePick === "Both roles" ? ["observer", "consolidator"] : [rolePick === "Observer" ? "observer" : "consolidator"];

			const available: Model<Api>[] = ctx.modelRegistry.getAvailable(); // authenticated providers only
			if (available.length === 0) {
				ctx.ui.notify("No models available (no provider has credentials)", "error");
				return;
			}
			const byProvider = new Map<string, Model<Api>[]>();
			for (const model of available) {
				const list = byProvider.get(model.provider) ?? [];
				list.push(model);
				byProvider.set(model.provider, list);
			}
			const providerIds = [...byProvider.keys()].sort((a, b) =>
				ctx.modelRegistry.getProviderDisplayName(a).localeCompare(ctx.modelRegistry.getProviderDisplayName(b)),
			);

			const providerLabels: string[] = [];
			const providerChoices: string[] = [];
			for (const id of providerIds) {
				let label = `${ctx.modelRegistry.getProviderDisplayName(id)} — ${byProvider.get(id)?.length ?? 0} model(s)`;
				if (providerLabels.includes(label)) label = `${label} [${id}]`; // keep labels unique
				providerLabels.push(label);
				providerChoices.push(id);
			}

			const providerPick = await ctx.ui.select("Provider (authenticated only):", providerLabels);
			if (!providerPick) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const providerId = providerChoices[providerLabels.indexOf(providerPick)] as string;

			const models = (byProvider.get(providerId) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
			const modelLabels = models.map((m) => `${m.name} (${m.id}) · ${Math.round(m.contextWindow / 1000)}k ctx`);
			const modelPick = await ctx.ui.select(`Model (${providerId}):`, modelLabels);
			if (!modelPick) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const model = models[modelLabels.indexOf(modelPick)] as Model<Api>;

			const levels = getSupportedThinkingLevels(model);
			if (levels.length === 0) {
				ctx.ui.notify("Model exposes no thinking levels", "error");
				return;
			}
			const thinking: ModelThinkingLevel = await ctx.ui.select(`Thinking effort for ${model.name}:`, levels);
			if (!thinking) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const modelSpec = `${providerId}/${model.id}`;
			const summary = roles.map((role) => `${role}: ${currentSpec(settings, role, runtime)} → ${modelSpec} @ ${thinking}`).join("\n");
			const confirmed = await ctx.ui.confirm("Apply model change?", summary);
			if (!confirmed) {
				ctx.ui.notify("Cancelled — nothing written", "info");
				return;
			}

			const next = applyOmModelChange(settings, roles, modelSpec, thinking);
			try {
				writeSettingsAtomic(next, DEFAULT_SETTINGS_PATH);
			} catch (error) {
				ctx.ui.notify(`Failed to write ${DEFAULT_SETTINGS_PATH}: ${errorMessage(error)}`, "error");
				return;
			}

			// Apply to the live session too — no /reload needed.
			runtime.ensureConfig(ctx.cwd);
			for (const role of roles) {
				runtime.config.models[role] = { provider: providerId, id: model.id, thinking };
			}
			ctx.ui.notify(`Saved — ${roles.join(" + ")}: ${modelSpec} @ ${thinking} (applied this session)`, "info");
		},
	});
}
