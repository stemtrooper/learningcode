import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./config.mjs";

/**
 * Pi renders its built-in header before extension `session_start` handlers run.
 * Its supported quietStartup setting prevents that header flashing before the
 * LearningCode banner is installed. Only seed the setting when it is unset, so
 * an explicit choice in the student's LearningCode settings remains theirs.
 */
/** Read Pi settings.json, returning {} when absent. Throws UserError when corrupt. */
export async function readSettings(agentDir) {
	const path = join(agentDir, "settings.json");
	try {
		const contents = await readFile(path, "utf-8");
		try {
			const parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new UserError(`Pi settings at ${path} must contain a JSON object.`);
			}
			return parsed;
		} catch (error) {
			if (error instanceof UserError) throw error;
			throw new UserError(`Could not parse Pi settings at ${path}: ${error.message}`);
		}
	} catch (error) {
		if (error instanceof UserError) throw error;
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not read Pi settings at ${path}: ${error.message}`);
		}
		return {};
	}
}

/**
 * Persisted model preferences Pi itself maintains (`/model` Ctrl+S writes
 * `defaultModel`, `/scoped-models` writes `enabledModels`). A non-empty
 * `enabledModels` means the student has curated (or we have seeded) a scope,
 * so the launcher must not override it with `--models`.
 */
export async function persistedModelPrefs(agentDir) {
	const settings = await readSettings(agentDir);
	const defaultModel = typeof settings.defaultModel === "string" && settings.defaultModel ? settings.defaultModel : null;
	const enabledModels = Array.isArray(settings.enabledModels) && settings.enabledModels.length ? settings.enabledModels : null;
	return { defaultModel, enabledModels };
}

/**
 * Seed model prefs absent from settings.json without touching keys the student
 * (or Pi's `/scoped-models`) already set. Returns true when the file changed.
 */
/** Replace the persisted `enabledModels` scope wholesale (used to extend it). */
export async function writeEnabledModels(agentDir, enabledModels) {
	const settings = await readSettings(agentDir);
	settings.enabledModels = enabledModels;
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export async function seedModelPrefs(agentDir, { defaultModel = null, enabledModels = null } = {}) {
	const settings = await readSettings(agentDir);
	let changed = false;
	if (defaultModel && !settings.defaultModel) {
		settings.defaultModel = defaultModel;
		changed = true;
	}
	if (enabledModels?.length && (!Array.isArray(settings.enabledModels) || !settings.enabledModels.length)) {
		settings.enabledModels = enabledModels;
		changed = true;
	}
	if (!changed) return false;
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return true;
}

/**
 * Rebind thinking-level cycling off Shift+Tab (reserved for the planned
 * Plan/Build mode toggle, matching other agents) onto Ctrl+Shift+E.
 * Every Ctrl+letter is taken by Pi's defaults (Ctrl+I/M are Tab/Enter
 * aliases), so a Ctrl+Shift chord is the nearest free mnemonic (Effort).
 * Only seeds when unset; a student's keybindings.json always wins.
 */
export const THINKING_CYCLE_KEY = "ctrl+shift+e";

export async function ensureThinkingCycleKey(agentDir) {
	const path = join(agentDir, "keybindings.json");
	let bindings;
	try {
		const contents = await readFile(path, "utf-8");
		try {
			bindings = JSON.parse(contents.replace(/^\uFEFF/, ""));
		} catch (error) {
			throw new UserError(`Could not parse Pi keybindings at ${path}: ${error.message}`);
		}
	} catch (error) {
		if (error instanceof UserError) throw error;
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not read Pi keybindings at ${path}: ${error.message}`);
		}
		bindings = {};
	}
	if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
		throw new UserError(`Pi keybindings at ${path} must contain a JSON object.`);
	}
	if (bindings["app.thinking.cycle"] !== undefined) return false;
	bindings["app.thinking.cycle"] = THINKING_CYCLE_KEY;
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, `${JSON.stringify(bindings, null, 2)}\n`, "utf-8");
	return true;
}

/** True when none of the persisted `enabledModels` patterns covers `provider`. */
export function scopeCoversProvider(enabledModels, provider) {
	return (enabledModels ?? []).some((p) => String(p).split("/")[0] === provider || String(p).startsWith(`${provider}/`));
}

export async function ensureQuietStartup(agentDir) {
	const path = join(agentDir, "settings.json");
	let settings;

	try {
		const contents = await readFile(path, "utf-8");
		try {
			settings = JSON.parse(contents.replace(/^\uFEFF/, ""));
		} catch (error) {
			throw new UserError(`Could not parse Pi settings at ${path}: ${error.message}`);
		}
	} catch (error) {
		if (error instanceof UserError) throw error;
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not read Pi settings at ${path}: ${error.message}`);
		}
		settings = {};
	}

	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new UserError(`Pi settings at ${path} must contain a JSON object.`);
	}

	if (typeof settings.quietStartup === "boolean" || settings.quietStartup === "header") {
		return false;
	}

	settings.quietStartup = true;
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return true;
}
