import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir, sparkBaseUrl } from "./config.mjs";
import { credentialSources, PROVIDER_ALWAYS_VISIBLE } from "./auth.mjs";
import { modelsPath } from "./models.mjs";
import { readRemoteState } from "./remote/config.mjs";

/** True when a process id is alive. EPERM means it exists but belongs to someone else. */
export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/** Providers configured in models.json, by id. Empty when the file is absent. */
async function configuredProviders(dir) {
	try {
		const parsed = JSON.parse(await readFile(modelsPath(dir), "utf-8"));
		return Object.keys(parsed.providers ?? {});
	} catch {
		return [];
	}
}

/**
 * A plain-text health report for `learningcode doctor`. Read-only: it never
 * prints a key, only whether one exists and where it came from. Each check is
 * a line the student can act on.
 *
 * `checkSpark` is injected so the report can be tested without a network call.
 */
export async function doctorReport({ dir = agentDir(), env = process.env, checkSpark, remoteDir = dir } = {}) {
	const lines = [];
	const sources = await credentialSources(dir, env);
	const configured = await configuredProviders(dir);

	lines.push("Providers");
	const ids = [...new Set([PROVIDER_ALWAYS_VISIBLE, ...configured, ...Object.keys(sources)])];
	for (const id of ids) {
		const from = sources[id];
		const state = id === PROVIDER_ALWAYS_VISIBLE
			? "always offered"
			: from
				? `logged in (${from.join(", ")})`
				: "not logged in";
		lines.push(`  ${id.padEnd(14)} ${state}`);
	}

	lines.push("Spark");
	const spark = checkSpark ? await checkSpark(sparkBaseUrl()) : { ok: null, reason: "not checked" };
	lines.push(
		spark.ok === true
			? `  reachable at ${sparkBaseUrl()}`
			: spark.ok === false
				? `  not answering at ${sparkBaseUrl()} (${spark.reason})`
				: `  ${sparkBaseUrl()} (${spark.reason})`,
	);

	lines.push("Remote");
	const state = await readRemoteState(remoteDir).catch(() => null);
	if (!state) {
		lines.push("  no session yet");
	} else {
		lines.push(`  ${processAlive(state.pid) ? `running (pid ${state.pid})` : "not running"} for ${state.cwd ?? "?"}`);
	}

	lines.push("Files");
	lines.push(`  agent dir   ${dir}`);
	lines.push(`  models.json ${modelsPath(dir)}`);
	lines.push(`  auth.json   ${join(dir, "auth.json")}`);

	return lines.join("\n") + "\n";
}