import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureProviderEntry } from "./models.mjs";

/**
 * OrcaRouter: one `sk-orca-` key for many models, through an OpenAI-compatible
 * endpoint, the same shape as Token Harbor, River, ExpLabs and CommandCode.
 *
 * Checked against their own documentation rather than guessed:
 *   API           https://docs.orcarouter.ai/introduction
 *   catalogue     GET {BASE_URL}/models   (live, the models your key may reach)
 *   API keys      https://www.orcarouter.ai/console
 *   auth          Authorization: Bearer sk-orca-...
 *
 * A models.json provider shows up in Pi's `/login` too, which is not obvious: Pi
 * composes every configured provider through core/provider-composer.js, and
 * composeApiKeyAuth() hands any provider with an apiKey a fabricated login()
 * that prompts for a secret and stores an ordinary api_key credential. So
 * `/login` -> "Sign in with an API key" -> OrcaRouter works, and lands the same
 * credential in auth.json that `--login-provider orcarouter` writes. Streaming
 * is delegated to Pi's built-in OpenAI client by that same composer, which is
 * why this file needs no stream implementation of its own.
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login-provider orcarouter`), with the
 * ORCAROUTER_API_KEY environment variable as the fallback Pi's docs describe.
 *
 * Model metadata comes from OrcaRouter's own catalog rather than a list we
 * maintain: correct slugs, context windows and prices without a release. The
 * `/v1/models` payload is the live, per-key catalogue — "the list only includes
 * models your account has access to" — so it is fetched with the student's key
 * at login (a deliberate, one-time action) and cached beside it. A launch reads
 * the cache and makes no request; the one exception is a key stored through Pi's
 * own `/login`, which has no launcher hook, so the catalogue is re-synced on the
 * next launch by `autoSync` (bounded, and only when the cache is missing or was
 * built for a different key). The built-in list below is the last resort.
 */
export const ORCAROUTER_PROVIDER = "orcarouter";
export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
export const ORCAROUTER_ENV = "ORCAROUTER_API_KEY";

/** Where a student mints a key (shown by `--login-provider orcarouter`). */
export const ORCAROUTER_KEY_PAGE = "https://www.orcarouter.ai/console";

/** The key shape the docs state: `sk-orca-` + an opaque secret. */
export const ORCAROUTER_KEY_PREFIX = "sk-orca-";

/** The live model catalog, and the cache that keeps launches offline. */
export const ORCAROUTER_CATALOG_URL = "https://api.orcarouter.ai/v1/models";
export const ORCAROUTER_CATALOG_FILE = "orcarouter-catalog.json";
const CATALOG_TIMEOUT_MS = 8000;
/**
 * The budget for the startup auto-sync (see `ensureOrcaRouterProvider`). It only
 * runs when OrcaRouter is logged in but its catalogue is missing or was fetched
 * with a different key, so a warm install never waits on it; 2s is enough for a
 * healthy call and short enough that a dead network does not hold up a prompt.
 */
export const ORCAROUTER_STARTUP_TIMEOUT_MS = 2000;

/**
 * The fallback list, used only until a catalog has been fetched once. Every id
 * here is one the live catalog publishes, so it appends nothing stale.
 */
export const ORCAROUTER_MODELS = [
	"openai/gpt-4o-mini",
	"anthropic/claude-sonnet-4.6",
	"google/gemini-2.5-pro",
	"deepseek/deepseek-chat",
	"grok/grok-4.7",
	"qwen/qwen3.8-max",
	"kimi/kimi-k2.6",
	"z-ai/glm-5.1",
	"minimax/minimax-m2.7",
];

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Endpoint surfaces a chat model can speak. OrcaRouter advertises each model's
 * /v1 surface here, so anything that only offers embeddings, image generation
 * or video is not something `/model` should offer for a coding session.
 */
const CHAT_ENDPOINTS = new Set(["openai", "anthropic", "openai-response", "gemini"]);
const NON_CHAT_ENDPOINTS = new Set(["embeddings", "image-generation", "openai-video", "systemone"]);

/**
 * Last-resort id filter, for entries with no usable capability metadata: a
 * model whose name is a known non-text family. Kept deliberately narrow — a
 * false negative (a non-chat model slips through and errors on first use) is
 * cheaper than a false positive, which would hide a model the student's key can
 * actually reach.
 */
const NON_CHAT_ID =
	/gpt-image|imagen|dall-e|whisper|embedding|seedance|kling|grok-imagine|minimax-h3|(?:^|[/-])(?:tts|image|sora|veo|dub)(?:[/-]|$)/i;

const catalogPath = (agentDir) => join(agentDir, ORCAROUTER_CATALOG_FILE);

const positive = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
/** Prices arrive as USD-per-million strings; a missing or junk value is zero. */
const perMillion = (value) => {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
};
/**
 * `input_cache_read` is USD per token (a per-token cache price), unlike the
 * `*_per_million` fields, so it is scaled up to the unit Pi's cost table uses.
 */
const perTokenToMillion = (value) => {
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n > 0 ? n * 1e6 : 0;
};

/**
 * True when a catalog entry is a text-in/text-out chat model. Reads the
 * capability matrix when the gateway publishes one, and only then falls back to
 * the endpoint surface and the id, so a model that genuinely reasons is never
 * dropped for looking like an image one.
 */
export function isChatModel(entry) {
	const endpoints = Array.isArray(entry?.supported_endpoint_types) ? entry.supported_endpoint_types : null;
	if (endpoints?.some((t) => NON_CHAT_ENDPOINTS.has(t))) return false;
	if (typeof entry?.id === "string" && NON_CHAT_ID.test(entry.id)) return false;

	const outputs = entry?.architecture?.output_modalities;
	if (Array.isArray(outputs) && outputs.length) return outputs.includes("text");
	// No decisive output list: trust a chat endpoint, or keep an unknown entry
	// rather than hide a model the key can reach.
	if (endpoints) return endpoints.some((t) => CHAT_ENDPOINTS.has(t));
	return true;
}

function staticOrcaRouterModels() {
	return ORCAROUTER_MODELS.map((id) => ({
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

/**
 * Reduce OrcaRouter's catalog payload to the model entries Pi needs. Only
 * chat-capable models, so the picker never offers an image, TTS or video model
 * that would fail on its first turn. Pure, so it is tested without network.
 */
export function modelsFromCatalog(payload) {
	const seen = new Set();
	const models = [];
	for (const entry of payload?.data ?? []) {
		if (typeof entry?.id !== "string" || !entry.id) continue;
		if (!isChatModel(entry)) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);

		const inputs = Array.isArray(entry.architecture?.input_modalities)
			? entry.architecture.input_modalities.filter((m) => m === "text" || m === "image")
			: [];
		models.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
			// The catalog does not flag reasoning per model; OrcaRouter exposes one
			// unified reasoning syntax across its providers, so it is advertised.
			reasoning: true,
			input: inputs.length ? inputs : ["text"],
			contextWindow: positive(entry.context_length, DEFAULT_CONTEXT_WINDOW),
			maxTokens: positive(entry.max_completion_tokens, DEFAULT_MAX_TOKENS),
			cost: {
				input: perMillion(entry.pricing?.prompt_per_million),
				output: perMillion(entry.pricing?.completion_per_million),
				cacheRead: perTokenToMillion(entry.pricing?.input_cache_read),
				cacheWrite: 0,
			},
		});
	}
	return models;
}

/**
 * Fetch and reduce the catalog, or null on any failure (offline, HTTP, shape).
 * The key is sent when we have it, so the result is the models *that key* can
 * reach rather than the public list.
 */
async function fetchCatalog(fetchImpl, timeoutMs, key) {
	try {
		const response = await fetchImpl(ORCAROUTER_CATALOG_URL, {
			signal: AbortSignal.timeout(timeoutMs),
			...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
		});
		if (!response.ok) return null;
		const models = modelsFromCatalog(await response.json());
		return models.length ? models : null;
	} catch {
		return null;
	}
}

async function readCatalogCache(agentDir) {
	try {
		const parsed = JSON.parse(await readFile(catalogPath(agentDir), "utf-8"));
		if (Array.isArray(parsed?.models) && parsed.models.length) {
			return { models: parsed.models, keyHash: typeof parsed.keyHash === "string" ? parsed.keyHash : null };
		}
	} catch {
		/* absent or unreadable: treated as no cache */
	}
	return null;
}

async function writeCatalogCache(agentDir, models, keyHash) {
	try {
		await mkdir(agentDir, { recursive: true });
		const payload = { fetchedAt: new Date().toISOString(), keyHash: keyHash ?? null, models };
		await writeFile(catalogPath(agentDir), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	} catch {
		/* best effort: a full disk must not stop a login */
	}
}

/**
 * A short, non-secret fingerprint of the key, stored beside the catalogue so a
 * later launch can tell whether the cache was built for the key in hand without
 * ever writing the key itself to disk.
 */
const keyFingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function orcaRouterProviderDefinition(models = staticOrcaRouterModels()) {
	return {
		name: "OrcaRouter",
		baseUrl: ORCAROUTER_BASE_URL,
		api: "openai-completions",
		// Pi docs: a `!command` runs at request time and reads the env var, so the
		// key is never written into models.json.
		apiKey: `!node -e "const k=process.env.${ORCAROUTER_ENV};if(!k)process.exit(1);process.stdout.write(k)"`,
		models,
	};
}

const offline = (env = process.env) => env.PI_OFFLINE === "1" || env.LEARNINGCODE_OFFLINE === "1";

/**
 * Add or refresh the OrcaRouter entry in models.json. A student's edit wins.
 *
 * The catalogue is fetched at login (`refresh: true`) and, for a key stored
 * through Pi's own `/login`, on the next launch (`autoSync: true`) — the
 * launcher has no hook into Pi's login, so this is how a key entered that way
 * gets a synced catalogue. `autoSync` only fetches when the cache is missing or
 * was built for a different key, so a warm install stays offline. Everything
 * else reads the cache, so a normal launch makes no request. Passing `key`
 * scopes the fetch to that key's catalogue.
 */
export async function ensureOrcaRouterProvider(
	agentDir,
	{ refresh = false, key, fetchImpl, timeoutMs = CATALOG_TIMEOUT_MS, autoSync = false } = {},
) {
	const cache = await readCatalogCache(agentDir);
	const keyHash = key ? keyFingerprint(key) : null;
	const shouldRefresh = refresh || (autoSync && key && (!cache || cache.keyHash !== keyHash));

	let models = null;
	const impl = fetchImpl ?? (offline() ? null : fetch);
	if (shouldRefresh && impl) {
		models = await fetchCatalog(impl, timeoutMs, key);
		if (models) await writeCatalogCache(agentDir, models, keyHash);
	}
	models = models ?? cache?.models ?? staticOrcaRouterModels();
	return ensureProviderEntry(agentDir, ORCAROUTER_PROVIDER, orcaRouterProviderDefinition(models));
}

/**
 * OrcaRouter keys are `sk-orca-` followed by an opaque secret. We check shape
 * only — never the value — and accept a little slack on the tail so a future
 * format change does not lock a student out. A key for the wrong provider is
 * refused here with a clear message rather than failing later at the first
 * request.
 */
export function looksLikeOrcaRouterKey(key) {
	return typeof key === "string" && new RegExp(`^${ORCAROUTER_KEY_PREFIX}[A-Za-z0-9_-]{8,}$`).test(key.trim());
}
