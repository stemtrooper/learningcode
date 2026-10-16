import { ensureProviderEntry } from "./models.mjs";

/**
 * ExpLabs: one key for many models, through an OpenAI-compatible endpoint, the
 * same shape as Token Harbor and River (see lib/tokenharbor.mjs, lib/river.mjs).
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login-provider explabs`), with the EXPLABS_API_KEY
 * environment variable as the fallback Pi's docs describe.
 *
 * Verified against the published contract at
 * https://platform.experientiallabs.ai/llms.txt (the endpoint, the key shape,
 * the key page, and every slug below were checked against the live catalog at
 * GET https://api.experientiallabs.ai/api/models on 2026-10-16). Only this file
 * changes when they move; the login path, picker filtering and doctor output all
 * derive from these constants.
 */
export const EXPLABS_PROVIDER = "explabs";
export const EXPLABS_BASE_URL = "https://api.experientiallabs.ai/v1";
export const EXPLABS_ENV = "EXPLABS_API_KEY";

/** Where a student mints a key (shown by `--login-provider explabs`). */
export const EXPLABS_KEY_PAGE = "https://platform.experientiallabs.ai/settings/api-keys";

/** The key shape the docs state: `xpl_` + a long lowercase-hex secret. */
export const EXPLABS_KEY_PREFIX = "xpl_";

/** The models the ExpLabs catalog lists, with the metadata Pi needs to show them. */
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
	"qwen3.8-27b",
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

/** Add or refresh the ExpLabs entry in models.json. A student's edit wins. */
export async function ensureExplabsProvider(agentDir) {
	return ensureProviderEntry(agentDir, EXPLABS_PROVIDER, explabsProviderDefinition());
}

/**
 * ExpLabs keys are `xpl_` followed by a long secret (the docs say 40 lowercase
 * hex chars). We check shape only — never the value — and accept a little slack
 * on length/encoding so a future format change does not lock a student out. A
 * key for the wrong provider is refused here with a clear message rather than
 * failing later at the first request.
 */
export function looksLikeExplabsKey(key) {
	return typeof key === "string" && new RegExp(`^${EXPLABS_KEY_PREFIX}[A-Za-z0-9]{8,}$`).test(key.trim());
}
