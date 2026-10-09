import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./config.mjs";

/**
 * Pi resolves provider credentials from auth.json first, then the environment.
 * auth.json is keyed by provider id, so a key stored under one provider cannot
 * satisfy another.
 *
 * That matters because OpenCode Zen and OpenCode Go share a single
 * `OPENCODE_API_KEY` env var. Setting it authenticates *both*, which exposes 111
 * pay-per-use Zen models alongside the 29 covered by a Go subscription, where
 * per-turn cost runs to $20/M output on the expensive ones.
 *
 * Writing the key under `opencode-go` alone authenticates Go and leaves Zen with
 * no credential, so Zen models never register. Verified against Pi: with the key
 * scoped this way, `--list-models claude` reports no matches, while the same
 * search with the env var set lists Zen's catalogue.
 */
export const GO_PROVIDER = "opencode-go";

/** Providers offered without any stored credential. */
export const PROVIDER_ALWAYS_VISIBLE = "tlc-spark";

export function authPath(agentDir) {
	return join(agentDir, "auth.json");
}

async function readAuth(agentDir) {
	try {
		const parsed = JSON.parse(await readFile(authPath(agentDir), "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		throw new UserError(`${authPath(agentDir)} is not a JSON object. Fix or delete it.`);
	} catch (error) {
		if (error instanceof UserError) throw error;
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not parse ${authPath(agentDir)}: ${error.message}`);
		}
		return {};
	}
}

/**
 * Store an API key for one provider, preserving any credentials Pi or the user
 * has already written. Mode 0600 because this file holds bearer tokens.
 */
export async function saveProviderKey(agentDir, providerId, key) {
	const auth = await readAuth(agentDir);
	auth[providerId] = { type: "api_key", key };

	const path = authPath(agentDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	// `mode` only applies when creating the file.
	await chmod(path, 0o600).catch(() => {});
	return path;
}

/**
 * Environment variables that count as a credential for a provider, from Pi's
 * provider table (docs/providers.md). Only the providers a student is likely to
 * meet are listed; a provider not here is judged by auth.json alone.
 */
export const PROVIDER_ENV = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
	openai: ["OPENAI_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"opencode-zen": ["OPENCODE_API_KEY"],
	tokenharbor: ["TOKENHARBOR_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	google: ["GEMINI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	xai: ["XAI_API_KEY"],
};

/**
 * The providers that have a usable credential: a stored key in auth.json, or the
 * provider's environment variable. Providers that are only listed by Pi's
 * built-in catalogue are not logged in, so the model picker hides them.
 */
export async function loggedInProviders(agentDir, env = process.env) {
	const auth = await readAuth(agentDir);
	// TLC-Spark is the school's own model: it is always offered, with or without
	// a key, so a student is never left with nothing to choose.
	const ids = new Set([PROVIDER_ALWAYS_VISIBLE]);
	for (const [id, entry] of Object.entries(auth)) {
		if (entry && (entry.key || entry.access || entry.refresh)) ids.add(id);
	}
	for (const [id, vars] of Object.entries(PROVIDER_ENV)) {
		if (vars.some((name) => env[name])) ids.add(id);
	}
	return ids;
}

/**
 * Parse `pi --list-models` output into `provider/id` pairs. The table has a
 * header row, then `provider  model  ...` columns separated by whitespace.
 */
export function parseModelTable(text) {
	const rows = [];
	for (const line of String(text).split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2 || cols[0] === "provider") continue;
		rows.push(`${cols[0]}/${cols[1]}`);
	}
	return rows;
}

/**
 * The `provider/id` patterns to pass Pi as `--models`: only models whose
 * provider has a credential. Returns null when nothing is logged in, so the
 * caller can leave Pi's own default in place rather than hide every model.
 */
export function visibleModelPatterns(listing, loggedIn) {
	const patterns = parseModelTable(listing).filter((pair) => loggedIn.has(pair.split("/")[0]));
	return patterns.length ? patterns : null;
}