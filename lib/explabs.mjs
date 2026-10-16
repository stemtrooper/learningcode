import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureProviderEntry } from "./models.mjs";

/**
 * ExpLabs: one key for many models, through an OpenAI-compatible endpoint, the
 * same shape as Token Harbor and River (see lib/tokenharbor.mjs, lib/river.mjs).
 *
 * The provider is written into models.json. The key is read from auth.json
 * (saved by `learningcode --login-provider explabs`), with the EXPLABS_API_KEY
 * environment variable as the fallback Pi's docs describe.
 *
 * Model metadata comes from ExpLabs' own keyless catalog
 * (GET https://api.experientiallabs.ai/api/models) rather than a list we
 * maintain: correct slugs, context windows, reasoning flags and prices without
 * a release. That catalog is fetched at login (a deliberate, one-time action)
 * and cached beside it, so a normal launch never blocks on the network — it
 * reads the cache, and falls back to the built-in list below when there is none.
 */
export const EXPLABS_PROVIDER = "explabs";
export const EXPLABS_BASE_URL = "https://api.experientiallabs.ai/v1";
export const EXPLABS_ENV = "EXPLABS_API_KEY";

/** Where a student mints a key (shown by `--login-provider explabs`). */
export const EXPLABS_KEY_PAGE = "https://platform.experientiallabs.ai/settings/api-keys";

/** The key shape the docs state: `xpl_` + a long lowercase-hex secret. */
export const EXPLABS_KEY_PREFIX = "xpl_";

/** The keyless model catalog, and the cache that keeps launches offline. */
export const EXPLABS_CATALOG_URL = "https://api.experientiallabs.ai/api/models";
export const EXPLABS_CATALOG_FILE = "explabs-catalog.json";
const CATALOG_TIMEOUT_MS = 8000;

/** The fallback list, used only until a catalog has been fetched once. */
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

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;

const catalogPath = (agentDir) => join(agentDir, EXPLABS_CATALOG_FILE);
const usdPerMillion = (nano) => (typeof nano === "number" && Number.isFinite(nano) && nano > 0 ? nano / 1e9 : 0);
const positive = (value, fallback) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

function staticExplabsModels() {
	return EXPLABS_MODELS.map((id) => ({
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
 * Reduce ExpLabs' catalog payload to the model entries Pi needs. Only models the
 * gateway can actually route right now, and only active ones, so the picker
 * never offers something that will fail. Pure, so it is tested without network.
 */
export function modelsFromCatalog(payload) {
	const seen = new Set();
	const models = [];
	for (const entry of payload?.models ?? []) {
		const model = entry?.model;
		if (!model || typeof model.slug !== "string" || !model.slug) continue;
		if (model.status && model.status !== "active") continue;
		if (seen.has(model.slug)) continue;
		// The gateway may list several routes for one slug; take one that is live.
		const provider = (entry.providers ?? []).find((p) => p?.routable === true);
		if (!provider) continue;
		seen.add(model.slug);
		const inputs = Array.isArray(model.input_modalities)
			? model.input_modalities.filter((m) => m === "text" || m === "image")
			: [];
		models.push({
			id: model.slug,
			name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug,
			reasoning: model.supported_params?.reasoning === true,
			input: inputs.length ? inputs : ["text"],
			contextWindow: positive(model.context_window, DEFAULT_CONTEXT_WINDOW),
			maxTokens: positive(model.max_output_tokens, DEFAULT_MAX_TOKENS),
			cost: {
				input: usdPerMillion(provider.input_nano_usd_per_million),
				output: usdPerMillion(provider.output_nano_usd_per_million),
				cacheRead: usdPerMillion(provider.cached_input_nano_usd_per_million),
				cacheWrite: usdPerMillion(provider.cache_write_input_nano_usd_per_million),
			},
		});
	}
	return models;
}

/** Fetch and reduce the catalog, or null on any failure (offline, HTTP, shape). */
async function fetchCatalog(fetchImpl, timeoutMs) {
	try {
		const response = await fetchImpl(EXPLABS_CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) });
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
		return Array.isArray(parsed?.models) && parsed.models.length ? parsed.models : null;
	} catch {
		return null;
	}
}

async function writeCatalogCache(agentDir, models) {
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(catalogPath(agentDir), `${JSON.stringify({ fetchedAt: new Date().toISOString(), models }, null, 2)}\n`, "utf-8");
	} catch {
		/* best effort: a full disk must not stop a login */
	}
}

export function explabsProviderDefinition(models = staticExplabsModels()) {
	return {
		name: "ExpLabs",
		baseUrl: EXPLABS_BASE_URL,
		api: "openai-completions",
		// Pi docs: a `!command` runs at request time and reads the env var, so the
		// key is never written into models.json.
		apiKey: `!node -e "const k=process.env.${EXPLABS_ENV};if(!k)process.exit(1);process.stdout.write(k)"`,
		models,
	};
}

const offline = (env = process.env) => env.PI_OFFLINE === "1" || env.LEARNINGCODE_OFFLINE === "1";

/**
 * Add or refresh the ExpLabs entry in models.json. A student's edit wins.
 *
 * `refresh: true` (the login path) fetches the live catalog and caches it; an
 * explicit `fetchImpl` overrides that, and with neither a fetch is only skipped
 * when the environment says we are offline. Everything else reads the cache, so
 * a normal launch makes no request.
 */
export async function ensureExplabsProvider(agentDir, { refresh = false, fetchImpl, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
	let models = null;
	const impl = fetchImpl ?? (offline() ? null : fetch);
	if (refresh && impl) {
		models = await fetchCatalog(impl, timeoutMs);
		if (models) await writeCatalogCache(agentDir, models);
	}
	models = models ?? (await readCatalogCache(agentDir)) ?? staticExplabsModels();
	return ensureProviderEntry(agentDir, EXPLABS_PROVIDER, explabsProviderDefinition(models));
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
