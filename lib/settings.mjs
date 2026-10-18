import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
	const path = join(agentDir, "settings.json");
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	// `mode` only applies at creation; keep it private if it already existed.
	await chmod(path, 0o600).catch(() => {});
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
 * Settings key: the provider ids whose models have been folded into the
 * student's `enabledModels` scope. It is what lets a later launch tell a
 * *newly logged-in* provider (never seen) from one the student has already
 * curated — a new provider's models are added once, and models the student
 * later unchecks are never re-added.
 */
export const SCOPED_PROVIDERS_KEY = "scopedProviders";

/** The provider ids already folded into the model scope. Empty when absent. */
export async function scopedProviders(agentDir) {
	return new Set(stringList((await readSettings(agentDir))[SCOPED_PROVIDERS_KEY]));
}

/**
 * Fold `patterns` (`provider/id`) into the persisted `enabledModels` scope and
 * remember `providers` as considered. Writes only when something changes, so a
 * steady-state launch touches nothing. An absent scope is left absent unless
 * patterns are given, so this never seeds a scope by itself. Returns true when
 * the file changed.
 */
export async function extendModelScope(agentDir, { patterns = [], providers = [] } = {}) {
	const settings = await readSettings(agentDir);
	const hadScope = Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0;
	const scope = new Set(stringList(settings.enabledModels));
	const known = new Set(stringList(settings[SCOPED_PROVIDERS_KEY]));
	const scopeBefore = scope.size;
	const knownBefore = known.size;
	for (const pattern of patterns) scope.add(pattern);
	for (const id of providers) known.add(id);
	if (scope.size === scopeBefore && known.size === knownBefore) return false;
	if (hadScope || patterns.length) settings.enabledModels = [...scope];
	settings[SCOPED_PROVIDERS_KEY] = [...known];
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
	await writeFile(path, `${JSON.stringify(bindings, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	await chmod(path, 0o600).catch(() => {});
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

/**
 * Settings key: the strict plan preset (see lib/plan-mode.mjs). When true,
 * editing stays locked in Build until a plan exists and has been approved. A
 * lab can place this in settings.json; `/plan strict on|off` is the student's
 * control, and LEARNINGCODE_PLAN_STRICT in the environment overrides both.
 */
export const PLAN_STRICT_KEY = "planStrict";

/** Whether the strict plan preset is on. False when the file is absent. */
export async function readPlanStrict(agentDir) {
	return (await readSettings(agentDir))[PLAN_STRICT_KEY] === true;
}

/** Turn the strict plan preset on or off. Returns true when the file changed. */
export async function setPlanStrict(agentDir, value) {
	const next = Boolean(value);
	const settings = await readSettings(agentDir);
	if (settings[PLAN_STRICT_KEY] === next) return false;
	settings[PLAN_STRICT_KEY] = next;
	await writeSettings(agentDir, settings);
	return true;
}

/**
 * Settings key: the student's quota reserve (see lib/pace.mjs). A whole number
 * of assistant steps to keep back so the day's Spark quota is not run to zero
 * mid-assignment; 0 means off. A lab may pin a floor with
 * LEARNINGCODE_PACE_RESERVE, which `/pace` resolves against this value.
 */
export const PACE_RESERVE_KEY = "paceReserve";

/** Steps kept in reserve. 0 (off) when the file is absent or the value is junk. */
export async function readPaceReserve(agentDir) {
	const value = Number((await readSettings(agentDir))[PACE_RESERVE_KEY]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Set the reserve. Returns true when the file changed. */
export async function setPaceReserve(agentDir, value) {
	const n = Number(value);
	const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	const settings = await readSettings(agentDir);
	if (settings[PACE_RESERVE_KEY] === next) return false;
	settings[PACE_RESERVE_KEY] = next;
	await writeSettings(agentDir, settings);
	return true;
}

/** Settings key: commands the student has approved to always run without prompting. */
export const ALWAYS_ALLOW_KEY = "alwaysAllowCommands";

/**
 * Settings key: destructive *kinds* (lib/approval.mjs) the student has said
 * "always allow" to. This is the durable one: the agent rewrites a command's
 * text (temp paths, echo lines) on almost every run, so remembering the exact
 * string — `alwaysAllowCommands`, kept for older settings files — rarely
 * matched again. The kind does.
 */
export const ALWAYS_ALLOW_KINDS_KEY = "alwaysAllowKinds";

/** Commands the student has said "always allow" to. Empty array when none or the file is absent. */
export async function readAlwaysAllow(agentDir) {
	return stringList((await readSettings(agentDir))[ALWAYS_ALLOW_KEY]);
}

/** Destructive kinds the student has said "always allow" to. */
export async function readAlwaysAllowKinds(agentDir) {
	return stringList((await readSettings(agentDir))[ALWAYS_ALLOW_KINDS_KEY]);
}

/** Remember a command so it never prompts again. Returns true when the file changed. */
export async function addAlwaysAllow(agentDir, command) {
	const trimmed = String(command ?? "").trim();
	if (!trimmed) return false;
	return addToSetting(agentDir, ALWAYS_ALLOW_KEY, trimmed);
}

/** Remember a destructive kind so it never prompts again. Returns true when the file changed. */
export async function addAlwaysAllowKind(agentDir, kind) {
	return addAlwaysAllowKinds(agentDir, [kind]);
}

/** Remember several destructive kinds in one write (a compound command). */
export async function addAlwaysAllowKinds(agentDir, kinds) {
	const values = stringList(kinds).map((k) => k.trim()).filter(Boolean);
	if (!values.length) return false;
	return addManyToSetting(agentDir, ALWAYS_ALLOW_KINDS_KEY, values);
}

/** Add one string to a JSON-array setting, skipping it when already present. */
async function addToSetting(agentDir, key, value) {
	return addManyToSetting(agentDir, key, [value]);
}

/** Add many strings to a JSON-array setting in one read-modify-write. */
async function addManyToSetting(agentDir, key, values) {
	const settings = await readSettings(agentDir);
	const list = new Set(stringList(settings[key]));
	let changed = false;
	for (const value of values) {
		if (list.has(value)) continue;
		list.add(value);
		changed = true;
	}
	if (!changed) return false;
	settings[key] = [...list];
	await writeSettings(agentDir, settings);
	return true;
}

function stringList(list) {
	return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}
