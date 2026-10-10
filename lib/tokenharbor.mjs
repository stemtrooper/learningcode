import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UserError } from "./config.mjs";
import { modelsPath } from "./models.mjs";

/**
 * TokenHarbor: one `thk_...` key for many models, through an OpenAI-compatible
 * endpoint. Setup follows https://tokenharbor.ai/docs/integrations/pi.
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login tokenharbor`), with the TOKENHARBOR_API_KEY
 * environment variable as the fallback Pi's docs describe.
 */
export const TOKENHARBOR_PROVIDER = "tokenharbor";
export const TOKENHARBOR_BASE_URL = "https://tokenharbor.ai/v1";
export const TOKENHARBOR_ENV = "TOKENHARBOR_API_KEY";

/** The models the TokenHarbor docs list, with the metadata Pi needs to show them. */
export const TOKENHARBOR_MODELS = [
	"deepseek-v4.1-flash",
	"mimo-v2.6-flash",
	"claude-opus-5.5",
	"claude-sonnet-5.5",
	"claude-haiku-5.5",
	"claude-fable-5.1",
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-5.6-terra",
	"gemini-3.8-flash",
	"grok-4.7",
	"kimi-k3",
	"deepseek-v4-pro",
	"qwen3.8-max",
	"qwen3.8-27b",
	"qwen3.8-flash",
	"glm-5.3",
	"glm-5.3-flash",
	"mimo-v2.6-pro",
	"muse-spark-1-3",
];

export function tokenHarborProviderDefinition() {
	return {
		name: "Token Harbor",
		baseUrl: TOKENHARBOR_BASE_URL,
		api: "openai-completions",
		// Pi docs: a `!command` runs at request time and reads the env var, so the
		// key is never written into models.json.
		apiKey: `!node -e "const k=process.env.${TOKENHARBOR_ENV};if(!k)process.exit(1);process.stdout.write(k)"`,
		models: TOKENHARBOR_MODELS.map((id) => ({
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

/** Add or refresh the TokenHarbor entry in models.json. A student's edit wins. */
export async function ensureTokenHarborProvider(agentDir) {
	const path = modelsPath(agentDir);
	const models = await readJson(path);
	const existing = models.providers?.[TOKENHARBOR_PROVIDER];
	if (existing) {
		// Merge: append catalog models missing from an older install without
		// removing or reordering the student's entries (e.g. claude-haiku-5.5
		// added after the provider was first written).
		const have = new Set((existing.models ?? []).map((m) => m?.id));
		const fresh = tokenHarborProviderDefinition().models;
		const missing = fresh.filter((m) => !have.has(m.id));
		if (!missing.length) return { path, created: false, added: 0 };
		existing.models = [...(existing.models ?? []), ...missing];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		return { path, created: false, added: missing.length };
	}
	models.providers = { ...models.providers, [TOKENHARBOR_PROVIDER]: tokenHarborProviderDefinition() };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, added: TOKENHARBOR_MODELS.length };
}

/** Accepts a key in the thk_ format the TokenHarbor dashboard issues. */
export function looksLikeTokenHarborKey(key) {
	return typeof key === "string" && /^thk_[A-Za-z0-9_-]{8,}$/.test(key.trim());
}

