import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { TOKEN_ENV, TOKEN_FILE, UserError } from "./config.mjs";

const TOKEN_PREFIX = "spark_live_";

export function tokenPath(agentDir) {
	return join(agentDir, TOKEN_FILE);
}

async function readCachedToken(agentDir) {
	try {
		const value = (await readFile(tokenPath(agentDir), "utf-8")).trim();
		return value || undefined;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return undefined;
	}
}

async function writeCachedToken(agentDir, token) {
	const path = tokenPath(agentDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
	// `mode` only applies at creation; tighten it if the file already existed.
	await chmod(path, 0o600).catch(() => {});
}

/** Read a secret without echoing it. Falls back to a plain readline if raw mode is unavailable. */
async function promptSecret(prompt) {
	const input = process.stdin;
	const output = process.stdout;

	if (!input.isTTY) {
		const rl = createInterface({ input, output });
		const answer = await rl.question(prompt);
		rl.close();
		return answer.trim();
	}

	process.stdout.write(prompt);
	return new Promise((resolve) => {
		const stdin = input;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf-8");
		let value = "";

		const onData = (chunk) => {
			for (const char of chunk) {
				switch (char) {
					case "\r":
					case "\n":
					case "":
						stdin.setRawMode(false);
						stdin.pause();
						stdin.removeListener("data", onData);
						process.stdout.write("\n");
						resolve(value.trim());
						return;
					case "":
						stdin.setRawMode(false);
						stdin.pause();
						stdin.removeListener("data", onData);
						process.stdout.write("\n");
						resolve(undefined);
						return;
					case "":
					case "\b":
						if (value.length) {
							value = value.slice(0, -1);
							process.stdout.write("\b \b");
						}
						break;
					default:
						// Ignore control characters, accept printable input.
						if (char >= " ") {
							value += char;
							process.stdout.write("*");
						}
				}
			}
		};

		stdin.on("data", onData);
	});
}

/**
 * Resolve the personal Spark token, in precedence order:
 * explicit flag, environment, cached file, interactive prompt.
 *
 * Caching matters because a token is issued once and shown only once in the
 * Spark bench; a student who loses it has to ask for a rotation.
 */
export async function resolveToken(agentDir, explicit) {
	if (explicit) return { token: explicit.trim(), source: "--token" };

	const fromEnv = process.env.LEARNINGCODE_TOKEN || process.env[TOKEN_ENV];
	if (fromEnv) return { token: fromEnv.trim(), source: "environment" };

	const cached = await readCachedToken(agentDir);
	if (cached) return { token: cached, source: "cached" };

	const entered = await promptSecret(
		"Paste your Spark API token (Bench > Issue / rotate token): ",
	);
	if (!entered) throw new UserError("No token entered. Run `learningcode --help` for non-interactive setup.");
	return { token: entered, source: "prompt", shouldCache: true };
}

export function looksLikeToken(token) {
	return token.startsWith(TOKEN_PREFIX);
}

/** True when a token can be found without asking the student anything. */
export async function hasToken(agentDir, explicit) {
	if (explicit) return true;
	if (process.env.LEARNINGCODE_TOKEN || process.env[TOKEN_ENV]) return true;
	return Boolean(await readCachedToken(agentDir));
}

/**
 * The leading fragment of the cached token, for display only.
 *
 * Spark keeps `raw.slice(0, 18)` as tokenPrefix for the same reason, so showing
 * this much identifies a token without disclosing it. Nothing here ever returns
 * the full value.
 */
export async function cachedTokenPrefix(agentDir, length = 18) {
	const token = await readCachedToken(agentDir);
	return token ? token.slice(0, length) : undefined;
}

export { writeCachedToken };