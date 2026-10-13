import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UserError } from "./config.mjs";
import { modelsPath } from "./models.mjs";

export const RIVER_PROVIDER = "river";
export const RIVER_BASE_URL = "https://api.river.ai/v1";
export const RIVER_ENV = "RIVER_API_KEY";
export const RIVER_MODELS = [
	"deepseek-ai/DeepSeek-V4.1-Flash",
	"zai-org/GLM-5.3-Flash",
];

export function riverProviderDefinition() {
	return {
		name: "River",
		baseUrl: RIVER_BASE_URL,
		api: "openai-completions",
		apiKey: "!node -e \"const k=process.env.RIVER_API_KEY;if(!k)process.exit(1);process.stdout.write(k)\"",
		models: RIVER_MODELS.map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
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
			throw new UserError("Could not parse " + path + ": " + error.message);
		}
	}
	return {};
}

export async function ensureRiverProvider(agentDir) {
	const path = modelsPath(agentDir);
	const models = await readJson(path);
	const existing = models.providers?.[RIVER_PROVIDER];
	if (existing) {
		const have = new Set((existing.models ?? []).map((m) => m?.id));
		const fresh = riverProviderDefinition().models;
		const missing = fresh.filter((m) => !have.has(m.id));
		if (!missing.length) return { path, created: false, added: 0 };
		existing.models = [...(existing.models ?? []), ...missing];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		return { path, created: false, added: missing.length };
	}
	models.providers = { ...models.providers, [RIVER_PROVIDER]: riverProviderDefinition() };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, added: RIVER_MODELS.length };
}

export function looksLikeRiverKey(key) {
	return typeof key === "string" && /^rv_[A-Za-z0-9_-]{8,}$/.test(key.trim());
}

export const RIVER_AI_PROVIDER = RIVER_PROVIDER;
export const RIVERAI_PROVIDER = RIVER_PROVIDER;
export const RIVERAI_BASE_URL = RIVER_BASE_URL;
export const RIVER_AI_BASE_URL = RIVER_BASE_URL;
export const RIVERAI_MODELS = RIVER_MODELS;
export const RIVER_AI_MODELS = RIVER_MODELS;
export const RIVERAI_ENV = RIVER_ENV;
export const RIVER_AI_ENV = RIVER_ENV;
export const RIVER_API_KEY_ENV = RIVER_ENV;
export const RIVER_KEY_ENV = RIVER_ENV;
export const RIVER_API_KEY = RIVER_ENV;
export const RIVER_KEY = RIVER_ENV;
export const riverAiProviderDefinition = riverProviderDefinition;
export const riverAIProviderDefinition = riverProviderDefinition;
export const ensureRiver = ensureRiverProvider;
export const ensureRiverAiProvider = ensureRiverProvider;
export const ensureRiverAIProvider = ensureRiverProvider;
export const ensureRiveraiProvider = ensureRiverProvider;
export const looksLikeRiver = looksLikeRiverKey;
export const looksLikeRiverAiKey = looksLikeRiverKey;
export const looksLikeRiverAIKey = looksLikeRiverKey;
export const looksLikeRiveraiKey = looksLikeRiverKey;
export const looksLikeRiverApiKey = looksLikeRiverKey;