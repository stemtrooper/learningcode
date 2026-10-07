import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./config.mjs";

/**
 * Pi renders its built-in header before extension `session_start` handlers run.
 * Its supported quietStartup setting prevents that header flashing before the
 * LearningCode banner is installed. Only seed the setting when it is unset, so
 * an explicit choice in the student's LearningCode settings remains theirs.
 */
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
