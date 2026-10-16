import { ensureProviderEntry } from "./models.mjs";

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

/** Add or refresh the River entry in models.json. A student's edit wins. */
export async function ensureRiverProvider(agentDir) {
	return ensureProviderEntry(agentDir, RIVER_PROVIDER, riverProviderDefinition());
}

export function looksLikeRiverKey(key) {
	return typeof key === "string" && /^rv_[A-Za-z0-9_-]{8,}$/.test(key.trim());
}