import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UserError } from "./config.mjs";
import { modelsPath } from "./models.mjs";

/**
 * ExpLabs: one key for many models, through an OpenAI-compatible endpoint, the
 * same shape as Token Harbor and River (see lib/tokenharbor.mjs, lib/river.mjs).
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login-provider explabs`), with the EXPLABS_API_KEY
 * environment variable as the fallback Pi's docs describe.
 *
 * TODO(confirm with ExpLabs before a release): the endpoint, the key page and
 * the catalog below are the values to check against the published docs. Only
 * this file changes when they are known; the login path, picker filtering and
 * doctor output all derive from these constants.
 */
export const EXPLABS_PROVIDER = "explabs";
export const EXPLABS_BASE_URL = "https://explabs.ai/v1";
export const EXPLABS_ENV = "EXPLABS_API_KEY";

/** The models the ExpLabs docs list, with the metadata Pi needs to show them. */
export const EXPLABS_MODELS = [
	"claude-opus-5.5",
	"claude-sonnet-5.5",
	"claude-haiku-5.5",
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-luna",
	"gemini-3.8-flash",
	"grok-4.7",
	"kimi-k3",
	"deepseek-v4-pro",
	"deepseek-v4.1-flash",
	"qwen3.8-max",
	"glm-5.3",
	"glm-5.3-flash",
];

export function explabsProviderDefinition() {
	return {
		name: "ExpLabs",
		baseUrl: EXPLABS_BASE_URL,
		api: "openai-completions",
		// Pi docs: a `!command` runs at request time and reads the env var, so the
		// key is never written into models.json.
		apiKey: `!node -e "const k=process.env.${EXPLABS_ENV};if(!k)process.exit(1);process.stdout.write(k)"`,
		models: EXPLABS_MODELS.map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	};
}

async function readJson(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") {
			throw new UserError(`Could not parse ${path}: ${error.message}`);
		}
	}
	return {};
}

/** Add or refresh the ExpLabs entry in models.json. A student's edit wins. */
export async function ensureExplabsProvider(agentDir) {
	const path = modelsPath(agentDir);
	const models = await readJson(path);
	const existing = models.providers?.[EXPLABS_PROVIDER];
	if (existing) {
		// Merge: append catalog models missing from an older install without
		// removing or reordering the student's entries.
		const have = new Set((existing.models ?? []).map((m) => m?.id));
		const fresh = explabsProviderDefinition().models;
		const missing = fresh.filter((m) => !have.has(m.id));
		if (!missing.length) return { path, created: false, added: 0 };
		existing.models = [...(existing.models ?? []), ...missing];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		return { path, created: false, added: missing.length };
	}
	models.providers = { ...models.providers, [EXPLABS_PROVIDER]: explabsProviderDefinition() };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, added: EXPLABS_MODELS.length };
}

/**
 * ExpLabs does not publish a fixed key prefix, so this checks shape only: a
 * long opaque token, without the quotes or whitespace a paste drags along.
 */
export function looksLikeExplabsKey(key) {
	return typeof key === "string" && /^[A-Za-z0-9_-]{8,}$/.test(key.trim());
}
