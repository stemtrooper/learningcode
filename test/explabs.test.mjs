import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXPLABS_BASE_URL,
	EXPLABS_MODELS,
	ensureExplabsProvider,
	looksLikeExplabsKey,
} from "../lib/explabs.mjs";
import { loggedInProviders, saveProviderKey, visibleModelPatterns } from "../lib/auth.mjs";
import { ensureSparkProvider } from "../lib/models.mjs";
import { TOKENHARBOR_BASE_URL } from "../lib/tokenharbor.mjs";
import { RIVER_BASE_URL } from "../lib/river.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-explabs-"));
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

test("ExpLabs is written to models.json with the documented endpoint and key command", async () => {
	const dir = await scratch();
	await ensureExplabsProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const provider = cfg.providers.explabs;
	assert.equal(provider.name, "ExpLabs");
	assert.equal(provider.baseUrl, EXPLABS_BASE_URL);
	assert.equal(provider.api, "openai-completions");
	assert.match(provider.apiKey, /^!node -e .*EXPLABS_API_KEY/);
	assert.equal(provider.models.length, EXPLABS_MODELS.length);
	assert.deepEqual(provider.models.map((m) => m.id), EXPLABS_MODELS);
});

test("an existing ExpLabs entry is merged, so a student's edits survive", async () => {
	const dir = await scratch();
	await ensureExplabsProvider(dir);
	const path = join(dir, "models.json");
	const models = JSON.parse(await readFile(path, "utf-8"));
	models.providers.explabs.baseUrl = "http://localhost:9000/v1";
	models.providers.explabs.models = [{ id: "my-own-model", name: "My own model" }];
	await writeFile(path, JSON.stringify(models, null, 2));

	const again = await ensureExplabsProvider(dir);
	assert.equal(again.added, EXPLABS_MODELS.length, "missing catalog models are appended");
	const after = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(after.providers.explabs.baseUrl, "http://localhost:9000/v1", "a student's endpoint wins");
	assert.equal(after.providers.explabs.models[0].id, "my-own-model", "their entries come first");

	// A second run is a no-op now that the catalog is complete.
	assert.equal((await ensureExplabsProvider(dir)).added, 0);
});

test("ExpLabs sits beside the other providers without disturbing them", async () => {
	const dir = await scratch();
	await ensureSparkProvider(dir);
	await ensureExplabsProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.deepEqual(Object.keys(cfg.providers).sort(), ["explabs", "tlc-spark"]);
	assert.notEqual(EXPLABS_BASE_URL, TOKENHARBOR_BASE_URL);
	assert.notEqual(EXPLABS_BASE_URL, RIVER_BASE_URL);
});

test("only a plausible key is accepted, judged by shape and never by value", () => {
	assert.equal(looksLikeExplabsKey(`xpl_${"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"}`), true);
	assert.equal(looksLikeExplabsKey("  xpl_abcdef12345678  "), true, "paste whitespace is trimmed");
	assert.equal(looksLikeExplabsKey("sk-live-abcdef1234567890"), false, "another provider's key is refused");
	assert.equal(looksLikeExplabsKey("exp_abcdef1234567890"), false, "a key without the xpl_ prefix is refused");
	assert.equal(looksLikeExplabsKey("xpl_short"), false, "too short after the prefix");
	assert.equal(looksLikeExplabsKey("has spaces in it"), false);
	assert.equal(looksLikeExplabsKey(""), false);
	assert.equal(looksLikeExplabsKey(undefined), false);
});

test("the endpoint and catalog are the verified Experiential Labs values", () => {
	// Verified 2026-10-16 against https://platform.experientiallabs.ai/llms.txt
	// and the live keyless catalog at api.experientiallabs.ai/api/models.
	assert.equal(EXPLABS_BASE_URL, "https://api.experientiallabs.ai/v1");
	assert.ok(!EXPLABS_BASE_URL.includes("explabs.ai/"), "not the dead short host");
	assert.ok(EXPLABS_MODELS.includes("qwen3.8-27b"), "the real qwen slug");
	assert.ok(!EXPLABS_MODELS.includes("qwen3.8-max"), "the invented slug is gone");
});

/** A trimmed catalog payload in the shape the live endpoint returns. */
const CATALOG = {
	models: [
		{
			model: {
				slug: "claude-fable-5.1",
				display_name: "Claude Fable 5.1",
				status: "active",
				context_window: 1000000,
				max_output_tokens: 128000,
				supported_params: { reasoning: true },
				input_modalities: ["text", "image"],
			},
			providers: [
				{
					routable: true,
					input_nano_usd_per_million: 10000000000,
					output_nano_usd_per_million: 50000000000,
					cached_input_nano_usd_per_million: 250000000,
				},
			],
		},
		{
			model: { slug: "glm-5.3-flash", display_name: "GLM 5.3 Flash", status: "active", context_window: 200000, max_output_tokens: 8192, supported_params: { reasoning: true }, input_modalities: ["text"] },
			providers: [{ routable: true }],
		},
		// Dropped: not routable, retired, and a duplicate slug.
		{ model: { slug: "not-routable", display_name: "Nope", status: "active" }, providers: [{ routable: false }] },
		{ model: { slug: "retired", display_name: "Old", status: "deprecated" }, providers: [{ routable: true }] },
		{ model: { slug: "glm-5.3-flash", display_name: "Dup", status: "active" }, providers: [{ routable: true }] },
	],
};
const catalogFetch = async () => ({ ok: true, json: async () => CATALOG });

test("refresh takes the live catalog, with its real metadata and prices", async () => {
	const dir = await scratch();
	const result = await ensureExplabsProvider(dir, { refresh: true, fetchImpl: catalogFetch });
	assert.equal(result.added, 2, "only the routable, active, deduped models");
	const models = JSON.parse(await readFile(join(dir, "models.json"), "utf-8")).providers.explabs.models;
	assert.deepEqual(models.map((m) => m.id), ["claude-fable-5.1", "glm-5.3-flash"]);

	const fable = models[0];
	assert.equal(fable.name, "Claude Fable 5.1");
	assert.equal(fable.contextWindow, 1000000, "the catalog's real window, not a blanket 200k");
	assert.equal(fable.maxTokens, 128000);
	assert.equal(fable.reasoning, true);
	assert.deepEqual(fable.input, ["text", "image"]);
	// nano-USD per million -> USD per million.
	assert.equal(fable.cost.input, 10);
	assert.equal(fable.cost.output, 50);
	assert.equal(fable.cost.cacheRead, 0.25);
});

test("the fetched catalog is reused on later launches, without a request", async () => {
	const dir = await scratch();
	await ensureExplabsProvider(dir, { refresh: true, fetchImpl: catalogFetch });
	// A plain launch must not fetch, and must not fall back to the built-in list
	// (which would append slugs the catalog does not have).
	const again = await ensureExplabsProvider(dir, {
		refresh: false,
		fetchImpl: () => assert.fail("a launch must not fetch the catalog"),
	});
	assert.equal(again.added, 0, "the cached catalog already covers the entry");
	const ids = JSON.parse(await readFile(join(dir, "models.json"), "utf-8")).providers.explabs.models.map((m) => m.id);
	assert.deepEqual(ids, ["claude-fable-5.1", "glm-5.3-flash"]);
});

test("an unreachable catalog falls back instead of breaking the login", async () => {
	const dir = await scratch();
	const result = await ensureExplabsProvider(dir, {
		refresh: true,
		fetchImpl: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(result.added, EXPLABS_MODELS.length, "the built-in list is used when the catalog cannot be reached");
});

test("ExpLabs counts as logged in once its key is stored, or its env var is set", async () => {
	const dir = await scratch();
	assert.equal((await loggedInProviders(dir, {})).has("explabs"), false);
	await saveProviderKey(dir, "explabs", "exp_TESTKEY1234567890");
	assert.ok((await loggedInProviders(dir, {})).has("explabs"));
	const fresh = await scratch();
	assert.ok((await loggedInProviders(fresh, { EXPLABS_API_KEY: "x" })).has("explabs"));
});

test("the picker keeps only ExpLabs models once it is logged in to", async () => {
	const dir = await scratch();
	const listing = [
		"provider     model                context",
		"tlc-spark    TLC-Spark            32K",
		"anthropic    claude-fable-5       1M",
		"explabs      glm-5.3-flash        200K",
	].join("\n");
	await saveProviderKey(dir, "explabs", "exp_TESTKEY1234567890");
	assert.deepEqual(visibleModelPatterns(listing, await loggedInProviders(dir, {})), [
		"tlc-spark/TLC-Spark",
		"explabs/glm-5.3-flash",
	]);
});

test("learningcode --login-provider explabs stores the key and lists the provider", async () => {
	const dir = await scratch();
	const result = loginWith(["--login-provider", "explabs"], "xpl_abcdef1234567890\n", dir);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Get an ExpLabs key at https:\/\/platform\.experientiallabs\.ai\/settings\/api-keys/);
	assert.match(result.stdout, /Saved\. ExpLabs models now appear in \/model\./);
	// The Spark token prompt must not block logging in to another provider.
	assert.doesNotMatch(result.stdout + result.stderr, /Paste your Spark API token/);

	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
	assert.equal(auth.explabs.key, "xpl_abcdef1234567890");
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.ok(cfg.providers.explabs, "the provider entry is written by the login too");
});

test("a bad key is refused and nothing is saved", async () => {
	const dir = await scratch();
	const bad = loginWith(["--login-provider", "explabs"], "nope\n", dir);
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /does not look like an ExpLabs key/);
	// A rejected key must leave no credential behind. The login runs before Pi
	// starts, so auth.json may not even exist — either way, explabs is absent.
	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8").catch(() => "{}"));
	assert.equal(auth.explabs, undefined, "a rejected key must not be stored");
});

test("an unknown provider names every provider that is available", async () => {
	const unknown = loginWith(["--login-provider", "notaprovider"], "", await scratch());
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /Available: tokenharbor, river, explabs, commandcode/);
});

test("the TokenHarbor login still works alongside it", async () => {
	const dir = await scratch();
	const result = loginWith(["--login-provider", "tokenharbor"], "thk_abcdef123456\n", dir);
	assert.equal(result.status, 0, result.stderr);
	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
	assert.equal(auth.tokenharbor.key, "thk_abcdef123456");
});
