import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UserError } from "./config.mjs";
import { modelsPath } from "./models.mjs";

/**
 * CommandCode: one key for many models, through an OpenAI-compatible endpoint,
 * the same shape as Token Harbor, River and ExpLabs.
 *
 * Checked against their own documentation and catalogue rather than guessed:
 *   API           https://commandcode.ai/docs/provider
 *   catalogue     GET {BASE_URL}/models   (public, no key needed)
 *   API keys      https://commandcode.ai/settings/keys
 *   auth          Authorization: Bearer <key>, or x-api-key: <key>
 *
 * A models.json provider shows up in Pi's `/login` too, which is not obvious: Pi
 * composes every configured provider through core/provider-composer.js, and
 * composeApiKeyAuth() hands any provider with an apiKey a fabricated login()
 * that prompts for a secret and stores an ordinary api_key credential. So
 * `/login` -> "Sign in with an API key" -> CommandCode works, and lands the same
 * credential in auth.json that `--login-provider commandcode` writes. Streaming
 * is delegated to Pi's built-in OpenAI/Anthropic clients by that same composer,
 * which is why this file needs no stream implementation of its own.
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login-provider commandcode`), with the
 * COMMANDCODE_API_KEY environment variable as the fallback Pi's docs describe.
 *
 * CommandCode serves most of its catalogue over /chat/completions, but its whole
 * Claude line is listed as /messages-only and needs the Anthropic wire, which is
 * why the entries below carry a wire of their own. Both facts come from the
 * public models endpoint, so the ids, names and context windows are theirs.
 */
export const COMMANDCODE_PROVIDER = "commandcode";
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
/**
 * The same root without the trailing /v1, for the Claude line only. Pi appends
 * "/chat/completions" to a baseUrl on the OpenAI wire but "/v1/messages" on the
 * Anthropic one, so pointing those entries one level up is what lands them on
 * .../provider/v1/messages. Left as-is they ask for .../provider/v1/v1/messages
 * and CommandCode answers 404.
 */
export const COMMANDCODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
export const COMMANDCODE_ENV = "COMMANDCODE_API_KEY";

/**
 * [id, display name, context window, wire], in the order CommandCode lists them
 * (their ranking, not ours). Tuples rather than ninety objects of the same five
 * fields, because the shape is uniform and the list is long.
 */
const CATALOG = [
	["claude-sonnet-5-5", "Claude Sonnet 5.5", 1000000, "messages"],
	["claude-sonnet-5", "Claude Sonnet 5", 1000000, "messages"],
	["claude-sonnet-4-6", "Claude Sonnet 4.6", 1000000, "messages"],
	["claude-fable-5-1", "Claude Fable 5.1", 1000000, "messages"],
	["claude-fable-5", "Claude Fable 5", 1000000, "messages"],
	["claude-opus-5-5", "Claude Opus 5.5", 1000000, "messages"],
	["claude-opus-5", "Claude Opus 5", 1000000, "messages"],
	["claude-opus-4-8", "Claude Opus 4.8", 1000000, "messages"],
	["claude-opus-4-7", "Claude Opus 4.7", 1000000, "messages"],
	["claude-haiku-5-5", "Claude Haiku 5.5", 1000000, "messages"],
	["claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200000, "messages"],
	["gpt-6-astra", "GPT-6 Astra", 1050000, "openai"],
	["gpt-6.1-sol", "GPT-6.1 Sol", 1050000, "openai"],
	["gpt-6-sol", "GPT-6 Sol", 1050000, "openai"],
	["gpt-6-luna", "GPT-6 Luna", 1050000, "openai"],
	["gpt-5.6-sol", "GPT-5.6 Sol", 1050000, "openai"],
	["gpt-5.6-terra", "GPT-5.6 Terra", 1050000, "openai"],
	["gpt-5.6-luna", "GPT-5.6 Luna", 1050000, "openai"],
	["gpt-5.5", "GPT-5.5", 400000, "openai"],
	["gpt-5.4", "GPT-5.4", 400000, "openai"],
	["gpt-5.3-codex", "GPT-5.3 Codex", 400000, "openai"],
	["gpt-5.4-mini", "GPT-5.4 Mini", 400000, "openai"],
	["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (latest)", 1000000, "openai"],
	["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (latest)", 1000000, "openai"],
	["deepseek/deepseek-v4-flash-vision-exp", "DeepSeek V4 Flash Vision (exp)", 1000000, "openai"],
	["deepseek/deepseek-v4-flash-fast", "DeepSeek V4 Flash Fast", 1000000, "openai"],
	["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1000000, "openai"],
	["deepseek/deepseek-v4.1-flash-fast", "DeepSeek V4.1 Flash Fast", 1000000, "openai"],
	["moonshotai/Kimi-K3", "Kimi K3", 1000000, "openai"],
	["moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code", 256000, "openai"],
	["moonshotai/Kimi-K2.7-Code-Highspeed", "Kimi K2.7 Code HighSpeed", 262000, "openai"],
	["moonshotai/Kimi-K2.6", "Kimi K2.6", 256000, "openai"],
	["moonshotai/Kimi-K2.5", "Kimi K2.5", 256000, "openai"],
	["z-ai/glm-5.3-flash", "GLM-5.3 Flash", 1048576, "openai"],
	["z-ai/glm-5.3-flashx", "GLM-5.3 FlashX", 1000000, "openai"],
	["zai-org/GLM-5.3", "GLM-5.3", 1000000, "openai"],
	["zai-org/GLM-5.2", "GLM-5.2", 1000000, "openai"],
	["zai-org/GLM-5.2-Fast", "GLM-5.2 Fast", 1000000, "openai"],
	["zai-org/GLM-5.1", "GLM-5.1", 200000, "openai"],
	["zai-org/GLM-5", "GLM-5", 200000, "openai"],
	["MiniMaxAI/MiniMax-M3", "MiniMax M3", 1000000, "openai"],
	["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7", 200000, "openai"],
	["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5", 200000, "openai"],
	["xiaomi/mimo-v2.6-pro", "MiMo V2.6 Pro", 1048576, "openai"],
	["xiaomi/mimo-v2.6-pro-ultraspeed", "MiMo V2.6 Pro UltraSpeed", 1048576, "openai"],
	["xiaomi/mimo-v2.6-flash", "MiMo V2.6 Flash", 1048576, "openai"],
	["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro", 1000000, "openai"],
	["xiaomi/mimo-v2.5", "MiMo V2.5", 1000000, "openai"],
	["Qwen/Qwen3.8-Omni-Flash", "Qwen 3.8 Omni Flash", 1000000, "openai"],
	["Qwen/Qwen3.8-Max-Prime", "Qwen 3.8 Max Prime", 1000000, "openai"],
	["Qwen/Qwen3.8-Max-0902", "Qwen 3.8 Max 0902", 1000000, "openai"],
	["Qwen/Qwen3.8-Max", "Qwen 3.8 Max", 1000000, "openai"],
	["Qwen/Qwen3.8-27B", "Qwen 3.8 27B", 262144, "openai"],
	["Qwen/Qwen3.8-Flash", "Qwen 3.8 Flash", 1000000, "openai"],
	["Qwen/Qwen3.7-Max", "Qwen 3.7 Max", 1000000, "openai"],
	["Qwen/Qwen3.7-Plus", "Qwen 3.7 Plus", 1000000, "openai"],
	["Qwen/Qwen3.7-Flash", "Qwen 3.7 Flash", 1000000, "openai"],
	["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview", 200000, "openai"],
	["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus", 200000, "openai"],
	["meituan/LongCat-2.0", "LongCat 2.0", 1048576, "openai"],
	["stepfun/Step-5-Preview", "Step 5 Preview", 1000000, "openai"],
	["stepfun/Step-3.7-Flash", "Step 3.7 Flash", 256000, "openai"],
	["stepfun/Step-3.5-Flash", "Step 3.5 Flash", 262144, "openai"],
	["tencent/hy3-paid", "Tencent Hy3", 262144, "openai"],
	["tencent/hy4-preview", "Tencent Hy4 Preview", 1048576, "openai"],
	["google/gemini-4-argon", "Gemini 4 Argon", 1000000, "openai"],
	["google/gemini-3.8-flash", "Gemini 3.8 Flash", 1000000, "openai"],
	["google/gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, "openai"],
	["google/gemini-3.6-flash", "Gemini 3.6 Flash", 1000000, "openai"],
	["google/gemini-3.5-flash", "Gemini 3.5 Flash", 1000000, "openai"],
	["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1000000, "openai"],
	["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", 1000000, "openai"],
	["sakana/fugu-ultra", "Fugu Ultra", 1000000, "openai"],
	["nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra", 1000000, "openai"],
	["thinkingmachines/inkling", "Inkling", 256000, "openai"],
	["thinkingmachines/inkling-small", "Inkling Small", 1000000, "openai"],
	["stealth/glyph-cluster:free", "Glyph Cluster", 256000, "openai"],
	["poolside/laguna-s-2.1-free", "Laguna S 2.1", 256000, "openai"],
	["inclusionai/ling-3.0-flash-sante:free", "Ling 3.0 Flash Sante", 262144, "openai"],
	["inclusionai/ling-3.1-flash", "Ling 3.1 Flash", 262144, "openai"],
	["meta/muse-spark-1.1", "Muse Spark 1.1", 1048576, "openai"],
	["meta/muse-spark-1.2", "Muse Spark 1.2", 1048576, "openai"],
	["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor", 1048576, "openai"],
	["meta/muse-spark-1.3", "Muse Spark 1.3", 1048576, "openai"],
	["meta/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", 1048576, "openai"],
	["meta/muse-wonder-1.0", "Muse Wonder", 1048576, "openai"],
	["xai/grok-4.5", "Grok 4.5", 500000, "openai"],
	["xai/grok-4.6", "Grok 4.6", 500000, "openai"],
	["xai/grok-4.7", "Grok 4.7", 500000, "openai"],
	["mistral/mistral-large-4", "Mistral Large 4", 524288, "openai"]
];

export const COMMANDCODE_MODELS = CATALOG.map(([id, name, contextWindow, wire]) => ({
	id,
	name,
	contextWindow,
	// A models.json entry may pick its own wire, which is what the Claude line needs.
	...(wire === "messages"
		? { api: "anthropic-messages", baseUrl: COMMANDCODE_ANTHROPIC_BASE_URL }
		: {}),
	reasoning: true,
	// Their provider FAQ: a message takes text and images, and a model without
	// vision answers with its own upstream error rather than being pre-gated here.
	// Advertising images is the honest default; the alternative silently drops
	// screenshots for the models that do read them.
	input: ["text", "image"],
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

export function commandcodeProviderDefinition() {
	return {
		name: "CommandCode",
		baseUrl: COMMANDCODE_BASE_URL,
		api: "openai-completions",
		// Pi docs: a `!command` runs at request time and reads the env var, so the
		// key is never written into models.json.
		apiKey: `!node -e "const k=process.env.${COMMANDCODE_ENV};if(!k)process.exit(1);process.stdout.write(k)"`,
		models: COMMANDCODE_MODELS,
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

/** Add or refresh the CommandCode entry in models.json. A student's edit wins. */
export async function ensureCommandCodeProvider(agentDir) {
	const path = modelsPath(agentDir);
	const models = await readJson(path);
	const existing = models.providers?.[COMMANDCODE_PROVIDER];
	if (existing) {
		// Merge: append catalog models missing from an older install without
		// removing or reordering the student's entries.
		const have = new Set((existing.models ?? []).map((m) => m?.id));
		const fresh = commandcodeProviderDefinition().models;
		const missing = fresh.filter((m) => !have.has(m.id));
		if (!missing.length) return { path, created: false, added: 0 };
		existing.models = [...(existing.models ?? []), ...missing];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
		return { path, created: false, added: missing.length };
	}
	models.providers = { ...models.providers, [COMMANDCODE_PROVIDER]: commandcodeProviderDefinition() };
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(models, null, 2)}\n`, "utf-8");
	return { path, created: true, added: COMMANDCODE_MODELS.length };
}

/**
 * CommandCode does not publish a fixed key prefix, so this checks shape only: a
 * long opaque token, without the quotes or whitespace a paste drags along.
 */
export function looksLikeCommandCodeKey(key) {
	return typeof key === "string" && /^[A-Za-z0-9_-]{8,}$/.test(key.trim());
}
