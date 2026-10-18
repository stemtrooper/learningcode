import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ORCAROUTER_BASE_URL,
	ORCAROUTER_MODELS,
	ensureOrcaRouterProvider,
	isChatModel,
	looksLikeOrcaRouterKey,
	modelsFromCatalog,
} from "../lib/orcarouter.mjs";
import { loggedInProviders, providerKey, saveProviderKey, visibleModelPatterns } from "../lib/auth.mjs";
import { ensureSparkProvider } from "../lib/models.mjs";
import { EXPLABS_BASE_URL } from "../lib/explabs.mjs";
import { COMMANDCODE_BASE_URL } from "../lib/commandcode.mjs";
import { TOKENHARBOR_BASE_URL } from "../lib/tokenharbor.mjs";
import { RIVER_BASE_URL } from "../lib/river.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-orcarouter-"));
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "learningcode.mjs");

/** Run the launcher with `stdin` holding the key a student would paste. */
const loginWith = (args, stdin, dir) =>
	spawnSync(process.execPath, [launcher, ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
		timeout: 60_000,
		input: stdin,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			LEARNINGCODE_DIR: dir,
		},
	});

test("OrcaRouter is written to models.json with the documented endpoint and key command", async () => {
	const dir = await scratch();
	await ensureOrcaRouterProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const provider = cfg.providers.orcarouter;
	assert.equal(provider.name, "OrcaRouter");
	assert.equal(provider.baseUrl, ORCAROUTER_BASE_URL);
	assert.equal(provider.api, "openai-completions");
	assert.match(provider.apiKey, /^!node -e .*ORCAROUTER_API_KEY/);
	assert.deepEqual(provider.models.map((m) => m.id), ORCAROUTER_MODELS);
});

test("an existing OrcaRouter entry is merged, so a student's edits survive", async () => {
	const dir = await scratch();
	await ensureOrcaRouterProvider(dir);
	const path = join(dir, "models.json");
	const models = JSON.parse(await readFile(path, "utf-8"));
	models.providers.orcarouter.baseUrl = "http://localhost:9000/v1";
	models.providers.orcarouter.models = [{ id: "my-own-model", name: "My own model" }];
	await writeFile(path, JSON.stringify(models, null, 2));

	const again = await ensureOrcaRouterProvider(dir);
	assert.equal(again.added, ORCAROUTER_MODELS.length, "missing catalog models are appended");
	const after = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(after.providers.orcarouter.baseUrl, "http://localhost:9000/v1", "a student's endpoint wins");
	assert.equal(after.providers.orcarouter.models[0].id, "my-own-model", "their entries come first");

	assert.equal((await ensureOrcaRouterProvider(dir)).added, 0, "a second run is a no-op");
});

test("OrcaRouter sits beside the other providers without disturbing them", async () => {
	const dir = await scratch();
	await ensureSparkProvider(dir);
	await ensureOrcaRouterProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.deepEqual(Object.keys(cfg.providers).sort(), ["orcarouter", "tlc-spark"]);
	assert.notEqual(ORCAROUTER_BASE_URL, EXPLABS_BASE_URL);
	assert.notEqual(ORCAROUTER_BASE_URL, COMMANDCODE_BASE_URL);
	assert.notEqual(ORCAROUTER_BASE_URL, TOKENHARBOR_BASE_URL);
	assert.notEqual(ORCAROUTER_BASE_URL, RIVER_BASE_URL);
});

test("only a plausible key is accepted, judged by shape and never by value", () => {
	assert.equal(looksLikeOrcaRouterKey("sk-orca-abcdef123456"), true);
	assert.equal(looksLikeOrcaRouterKey("  sk-orca-abcdef123456  "), true, "paste whitespace is trimmed");
	assert.equal(looksLikeOrcaRouterKey("sk-live-abcdef1234567890"), false, "another provider's key is refused");
	assert.equal(looksLikeOrcaRouterKey("sk_orca_abcdef123456"), false, "the wrong separator is refused");
	assert.equal(looksLikeOrcaRouterKey("sk-orca-short"), false, "too short after the prefix");
	assert.equal(looksLikeOrcaRouterKey("has spaces in it"), false);
	assert.equal(looksLikeOrcaRouterKey(""), false);
	assert.equal(looksLikeOrcaRouterKey(undefined), false);
});

/** A trimmed catalog payload in the shape the live endpoint returns. */
const CATALOG = {
	data: [
		{
			id: "openai/gpt-4o-mini",
			name: "OpenAI: GPT-4o-mini",
			supported_endpoint_types: ["openai", "openai-response"],
			context_length: 128000,
			max_completion_tokens: 16384,
			architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
			pricing: { prompt_per_million: "0.150000", completion_per_million: "0.600000", input_cache_read: "0.0000000750" },
		},
		{
			id: "google/gemini-2.5-pro",
			name: "Google: Gemini 2.5 Pro",
			supported_endpoint_types: ["openai", "gemini"],
			context_length: 1048576,
			max_completion_tokens: 65536,
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			pricing: { prompt_per_million: "2.500000", completion_per_million: "15.000000" },
		},
		// Kept: a chat model whose capability matrix omits the output list.
		{
			id: "deepseek/deepseek-reasoner",
			supported_endpoint_types: ["openai"],
			architecture: { input_modalities: ["text"], output_modalities: null },
		},
		// Dropped: image generation, TTS, video, embeddings-only, and a duplicate.
		{ id: "openai/gpt-image-1", supported_endpoint_types: ["image-generation"], architecture: { input_modalities: ["text", "image"], output_modalities: null } },
		{ id: "openai/tts-1", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"], output_modalities: null } },
		{ id: "kling/kling-v3", supported_endpoint_types: ["openai-video"] },
		{ id: "openai/text-embedding-3-large", supported_endpoint_types: ["embeddings"] },
		{ id: "openai/gpt-4o-mini", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
	],
};
const catalogFetch = async () => ({ ok: true, json: async () => CATALOG });

test("the reducer keeps chat models with their real metadata and prices", () => {
	const models = modelsFromCatalog(CATALOG);
	assert.deepEqual(models.map((m) => m.id), ["openai/gpt-4o-mini", "google/gemini-2.5-pro", "deepseek/deepseek-reasoner"]);

	const mini = models[0];
	assert.equal(mini.name, "OpenAI: GPT-4o-mini");
	assert.equal(mini.contextWindow, 128000, "the catalog's real window, not a blanket 200k");
	assert.equal(mini.maxTokens, 16384);
	assert.deepEqual(mini.input, ["text", "image"], "file is not a Pi input modality");
	// per-million strings pass through; per-token cache price is scaled.
	assert.equal(mini.cost.input, 0.15);
	assert.equal(mini.cost.output, 0.6);
	assert.equal(mini.cost.cacheRead, 0.075);

	const reasoner = models[2];
	assert.equal(reasoner.contextWindow, 200000, "a missing window falls back to the default");
	assert.equal(reasoner.input[0], "text");
});

test("the chat filter reads capability first, endpoints and id only as fallback", () => {
	assert.equal(isChatModel({ id: "x/y", architecture: { output_modalities: ["text"] } }), true);
	assert.equal(isChatModel({ id: "x/y", architecture: { output_modalities: ["image"] } }), false);
	assert.equal(isChatModel({ id: "x/y", supported_endpoint_types: ["openai"] }), true);
	assert.equal(isChatModel({ id: "x/y", supported_endpoint_types: ["embeddings"] }), false);
	assert.equal(isChatModel({ id: "openai/tts-1", supported_endpoint_types: ["openai"] }), false, "a known non-chat id is refused even on the chat surface");
	assert.equal(isChatModel({ id: "some/unknown" }), true, "an unknown entry is kept, not hidden");
});

test("refresh fetches the catalogue with the student's key, and caches it", async () => {
	const dir = await scratch();
	let seen;
	const result = await ensureOrcaRouterProvider(dir, {
		refresh: true,
		key: "sk-orca-testkey1234",
		fetchImpl: async (url, options) => {
			seen = { url, options };
			return { ok: true, json: async () => CATALOG };
		},
	});
	assert.equal(result.added, 3, "only the chat-capable, deduped models");
	assert.equal(seen.url, "https://api.orcarouter.ai/v1/models");
	assert.equal(seen.options.headers.Authorization, "Bearer sk-orca-testkey1234", "the key scopes the catalogue");

	const cache = JSON.parse(await readFile(join(dir, "orcarouter-catalog.json"), "utf-8"));
	assert.equal(cache.models.length, 3);

	// A plain launch reads the cache and makes no request.
	const again = await ensureOrcaRouterProvider(dir, {
		refresh: false,
		fetchImpl: () => assert.fail("a launch must not fetch the catalog"),
	});
	assert.equal(again.added, 0, "the cached catalog already covers the entry");
	const ids = JSON.parse(await readFile(join(dir, "models.json"), "utf-8")).providers.orcarouter.models.map((m) => m.id);
	assert.deepEqual(ids, ["openai/gpt-4o-mini", "google/gemini-2.5-pro", "deepseek/deepseek-reasoner"]);
});

test("autoSync fills the catalogue on the next launch after a key is stored", async () => {
	const dir = await scratch();
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return { ok: true, json: async () => CATALOG };
	};
	// A key stored through Pi's own /login has no cache: the next launch fetches.
	const first = await ensureOrcaRouterProvider(dir, { autoSync: true, key: "sk-orca-testkey1234", fetchImpl });
	assert.equal(calls, 1);
	assert.equal(first.added, 3);

	// A warm cache for the same key makes no request.
	const second = await ensureOrcaRouterProvider(dir, { autoSync: true, key: "sk-orca-testkey1234", fetchImpl });
	assert.equal(calls, 1, "a matching cache is reused without a request");
	assert.equal(second.added, 0);

	// A different key invalidates the cache and refetches.
	await ensureOrcaRouterProvider(dir, { autoSync: true, key: "sk-orca-otherkey1234", fetchImpl });
	assert.equal(calls, 2, "a new key resyncs the catalogue");
});

test("the cache stores a key fingerprint, never the key itself", async () => {
	const dir = await scratch();
	await ensureOrcaRouterProvider(dir, { autoSync: true, key: "sk-orca-secretvalue1234", fetchImpl: catalogFetch });
	const raw = await readFile(join(dir, "orcarouter-catalog.json"), "utf-8");
	assert.doesNotMatch(raw, /secretvalue/, "the key must not be written to disk");
	assert.match(raw, /"keyHash"/, "only a fingerprint is kept");
});

test("an unreachable catalog falls back instead of breaking the login", async () => {
	const dir = await scratch();
	const result = await ensureOrcaRouterProvider(dir, {
		refresh: true,
		key: "sk-orca-testkey1234",
		fetchImpl: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(result.added, ORCAROUTER_MODELS.length, "the built-in list is used when the catalog cannot be reached");
});

test("OrcaRouter counts as logged in once its key is stored, or its env var is set", async () => {
	const dir = await scratch();
	assert.equal((await loggedInProviders(dir, {})).has("orcarouter"), false);
	await saveProviderKey(dir, "orcarouter", "sk-orca-TESTKEY1234567890");
	assert.ok((await loggedInProviders(dir, {})).has("orcarouter"));
	const fresh = await scratch();
	assert.ok((await loggedInProviders(fresh, { ORCAROUTER_API_KEY: "x" })).has("orcarouter"));
});

test("providerKey resolves a stored key or the environment variable", async () => {
	const dir = await scratch();
	assert.equal(await providerKey(dir, "orcarouter"), null);
	await saveProviderKey(dir, "orcarouter", "sk-orca-stored123456");
	assert.equal(await providerKey(dir, "orcarouter", {}), "sk-orca-stored123456");
	const fresh = await scratch();
	assert.equal(await providerKey(fresh, "orcarouter", { ORCAROUTER_API_KEY: "sk-orca-env123456" }), "sk-orca-env123456");
});

test("the picker keeps only OrcaRouter models once it is logged in to", async () => {
	const dir = await scratch();
	const listing = [
		"provider     model                        context",
		"tlc-spark    TLC-Spark                    32K",
		"anthropic    claude-sonnet-5             1M",
		"orcarouter   openai/gpt-4o-mini          128K",
		"orcarouter   anthropic/claude-sonnet-4.6 1M",
	].join("\n");
	await saveProviderKey(dir, "orcarouter", "sk-orca-TESTKEY1234567890");
	assert.deepEqual(visibleModelPatterns(listing, await loggedInProviders(dir, {})), [
		"tlc-spark/TLC-Spark",
		"orcarouter/openai/gpt-4o-mini",
		"orcarouter/anthropic/claude-sonnet-4.6",
	]);
});

test("learningcode --login-provider orcarouter stores the key and lists the provider", async () => {
	const dir = await scratch();
	const result = loginWith(["--login-provider", "orcarouter"], "sk-orca-abcdef1234567890\n", dir);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Get an sk-orca- key at https:\/\/www\.orcarouter\.ai\/console/);
	assert.match(result.stdout, /Saved\. OrcaRouter models now appear in \/model\./);
	// The Spark token prompt must not block logging in to another provider.
	assert.doesNotMatch(result.stdout + result.stderr, /Paste your Spark API token/);

	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
	assert.equal(auth.orcarouter.key, "sk-orca-abcdef1234567890");
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.ok(cfg.providers.orcarouter, "the provider entry is written by the login too");
});

test("the name is normalised, so orca-router and orcarouter.ai both land", async () => {
	for (const spelling of ["orcarouter", "orca-router", "orcarouter.ai", "orca"]) {
		const dir = await scratch();
		const result = loginWith(["--login-provider", spelling], "sk-orca-abcdef1234567890\n", dir);
		assert.equal(result.status, 0, `${spelling}: ${result.stderr}`);
		const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
		assert.equal(auth.orcarouter.key, "sk-orca-abcdef1234567890", `${spelling} stores under orcarouter`);
	}
});

test("a bad key is refused and nothing is saved", async () => {
	const dir = await scratch();
	const bad = loginWith(["--login-provider", "orcarouter"], "nope\n", dir);
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /does not look like an OrcaRouter key/);
	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8").catch(() => "{}"));
	assert.equal(auth.orcarouter, undefined, "a rejected key must not be stored");
});

test("an unknown provider names every provider that is available", async () => {
	const unknown = loginWith(["--login-provider", "notaprovider"], "", await scratch());
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /Available: tokenharbor, river, explabs, commandcode, orcarouter/);
});
