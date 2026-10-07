import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./config.mjs";

/**
 * TLC brand themes, shipped with the package and seeded into the agent
 * directory on first run.
 *
 * Pi reads themes from `<agentDir>/themes`, which for learningcode is
 * ~/.learningcode/agent/themes. Seeding rather than forcing keeps the same rule
 * the provider config follows: an existing file belongs to the student, so it is
 * never overwritten. Someone who edits tlc-dark.json keeps their edit across
 * upgrades.
 */

/** The theme Pi starts with when a terminal reports no colour support. */
const SYSTEM_THEME = "system";

export const THEME_NAMES = ["tlc-dark", "tlc-light"];

export function themesDir(agentDir) {
	return join(agentDir, "themes");
}

function packageThemeDir() {
	// fileURLToPath, not import.meta.url.pathname: on Windows the pathname is a
	// /C:/... URL fragment that no path function will resolve.
	return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "themes");
}

/**
 * Pick which TLC theme suits the terminal. Pi's system theme already probes the
 * terminal, but it cannot tell us its answer from here, so the choice is made
 * from the platform default and can be overridden by the caller.
 */
export function preferredTheme(env = process.env) {
	const forced = env.LEARNINGCODE_THEME;
	if (forced) return forced;
	// Windows Terminal defaults to a dark scheme for most profiles; macOS and
	// Linux terminals are more often light. This is a guess either way, which is
	// why an explicit --theme still wins.
	return env.LEARNINGCODE_LIGHT_THEME === "1" ? "tlc-light" : "tlc-dark";
}

/**
 * Copy any missing theme into the agent directory. Returns the names that were
 * actually written, so a caller can tell a fresh install from an existing one.
 */
export async function ensureThemes(agentDir) {
	const source = packageThemeDir();
	const target = themesDir(agentDir);
	const written = [];

	let available;
	try {
		available = await readdir(source);
	} catch {
		return written; // themes are a nicety, never a hard failure
	}

	await mkdir(target, { recursive: true });

	for (const name of THEME_NAMES) {
		if (!available.includes(`${name}.json`)) continue;
		const destination = join(target, `${name}.json`);
		try {
			await readFile(destination, "utf-8");
			continue; // already present: the student's copy wins
		} catch (error) {
			if (error?.code !== "ENOENT") {
				throw new UserError(`Could not read ${destination}: ${error.message}`);
			}
		}
		await writeFile(destination, await readFile(join(source, `${name}.json`), "utf-8"), "utf-8");
		written.push(name);
	}

	return written;
}