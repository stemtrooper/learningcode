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