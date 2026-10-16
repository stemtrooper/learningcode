import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./config.mjs";

/**
 * Read a JSON object from disk, treating a missing file as {}. Throws a
 * UserError naming the file when it exists but is unreadable or not a JSON
 * object, so the launcher can say which file is broken instead of dumping a
 * stack. `label` names the file in prose (e.g. "Pi settings").
 */
async function readJsonFile(path, label) {
	try {
		const contents = await readFile(path, "utf-8");
		try {
			const parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new UserError(`${label} at ${path} must contain a JSON object.`);
			}
			return parsed;
		} catch (error) {
			if (error instanceof UserError) throw error;
			throw new UserError(`Could not parse ${label} at ${path}: ${error.message}`);
		}
	} catch (error) {
		if (error instanceof UserError) throw error;
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not read ${label} at ${path}: ${error.message}`);
		}
		return {};
	}
}

/** Persist settings.json (mkdir + pretty JSON), creating the agent dir. */
async function writeSettings(agentDir, settings) {
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/** Read Pi settings.json, returning {} when absent. Throws UserError when corrupt. */
export async function readSettings(agentDir) {
	return readJsonFile(join(agentDir, "settings.json"), "Pi settings");
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
	await writeSettings(agentDir, settings);
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
	const bindings = await readJsonFile(path, "Pi keybindings");
	if (bindings["app.thinking.cycle"] !== undefined) return false;
	bindings["app.thinking.cycle"] = THINKING_CYCLE_KEY;
	await mkdir(agentDir, { recursive: true });
	await writeFile(path, `${JSON.stringify(bindings, null, 2)}\n`, "utf-8");
	return true;
}

/**
 * Pi renders its built-in header before extension `session_start` handlers run.
 * Its supported quietStartup setting prevents that header flashing before the
 * LearningCode banner is installed. Only seed the setting when it is unset, so
 * an explicit choice in the student's LearningCode settings remains theirs.
 */
export async function ensureQuietStartup(agentDir) {
	const settings = await readSettings(agentDir);
	if (typeof settings.quietStartup === "boolean" || settings.quietStartup === "header") {
		return false;
	}
	settings.quietStartup = true;
	await writeSettings(agentDir, settings);
	return true;
}

/** Settings key: commands the student has approved to always run without prompting. */
export const ALWAYS_ALLOW_KEY = "alwaysAllowCommands";

/** Commands the student has said "always allow" to. Empty array when none or the file is absent. */
export async function readAlwaysAllow(agentDir) {
	return readAlwaysAllowList(await readSettings(agentDir));
}

/** Remember a command so it never prompts again. Returns true when the file changed. */
export async function addAlwaysAllow(agentDir, command) {
	const settings = await readSettings(agentDir);
	const list = new Set(readAlwaysAllowList(settings));
	const trimmed = String(command ?? "").trim();
	if (!trimmed || list.has(trimmed)) return false;
	list.add(trimmed);
	settings[ALWAYS_ALLOW_KEY] = [...list];
	await writeSettings(agentDir, settings);
	return true;
}

function readAlwaysAllowList(settings) {
	const list = settings[ALWAYS_ALLOW_KEY];
	return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}
