import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COMMANDCODE_ANTHROPIC_BASE_URL,
	COMMANDCODE_BASE_URL,
	COMMANDCODE_MODELS,
	ensureCommandCodeProvider,
	looksLikeCommandCodeKey,
} from "../lib/commandcode.mjs";
import { loggedInProviders, saveProviderKey, visibleModelPatterns } from "../lib/auth.mjs";
import { ensureSparkProvider } from "../lib/models.mjs";
import { EXPLABS_BASE_URL } from "../lib/explabs.mjs";
import { TOKENHARBOR_BASE_URL } from "../lib/tokenharbor.mjs";
import { RIVER_BASE_URL } from "../lib/river.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-commandcode-"));
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

test("CommandCode is written to models.json with the documented endpoint and key command", async () => {
	const dir = await scratch();
	await ensureCommandCodeProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const provider = cfg.providers.commandcode;
	assert.equal(provider.name, "CommandCode");
	assert.equal(provider.baseUrl, COMMANDCODE_BASE_URL);
	assert.equal(provider.api, "openai-completions");
	assert.match(provider.apiKey, /^!node -e .*COMMANDCODE_API_KEY/);
	assert.equal(provider.models.length, COMMANDCODE_MODELS.length);
	assert.deepEqual(provider.models.map((m) => m.id), COMMANDCODE_MODELS.map((m) => m.id));
});

test("the Claude line is put on the Anthropic wire, at the base URL that wire needs", async () => {
	// Pi appends /chat/completions to a baseUrl on the OpenAI wire but /v1/messages
	// on the Anthropic one. CommandCode serves both under one root, so a Claude
	// entry that kept the provider's /v1 base URL asked for /provider/v1/v1/messages
	// and got a 404. This is that bug, pinned.
	const dir = await scratch();
	await ensureCommandCodeProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const models = cfg.providers.commandcode.models;
	const claude = models.find((m) => m.id === "claude-sonnet-5-5");
	assert.ok(claude, "the Claude line is in the catalogue");
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.baseUrl, COMMANDCODE_ANTHROPIC_BASE_URL);
	assert.equal(claude.baseUrl, "https://api.commandcode.ai/provider", "no /v1 on the Anthropic root");
	assert.notEqual(claude.baseUrl, COMMANDCODE_BASE_URL);

	// The OpenAI-wire majority must not carry the override, or it would lose its /v1.
	const openai = models.find((m) => m.id === "deepseek/deepseek-v4-pro");
	assert.equal(openai.api, undefined, "inherits the provider's OpenAI wire");
	assert.equal(openai.baseUrl, undefined, "and the provider's base URL");
	assert.ok(models.filter((m) => m.api === "anthropic-messages").length > 0);
	assert.ok(models.filter((m) => m.api === undefined).length > models.length / 2);
});

test("vendor-prefixed model ids survive the picker, slash and all", async () => {
	// 68 of the 90 ids carry a vendor prefix (deepseek/deepseek-v4-pro), which is
	// indistinguishable from the provider/id separator unless the split is right.
	const dir = await scratch();
	const listing = [
		"provider     model                          context",
		"tlc-spark    TLC-Spark                      32K",
		"commandcode  deepseek/deepseek-v4-pro       128K",
		"commandcode  claude-sonnet-5-5              1M",
		"explabs      glm-5.3-flash                  200K",
	].join("\n");
	await saveProviderKey(dir, "commandcode", "cmd_TESTKEY1234567890");
	assert.deepEqual(visibleModelPatterns(listing, await loggedInProviders(dir, {})), [
		"tlc-spark/TLC-Spark",
		"commandcode/deepseek/deepseek-v4-pro",
		"commandcode/claude-sonnet-5-5",
	]);
});

test("an existing CommandCode entry is merged, so a student's edits survive", async () => {
	const dir = await scratch();
	await ensureCommandCodeProvider(dir);
	const path = join(dir, "models.json");
	const models = JSON.parse(await readFile(path, "utf-8"));
	models.providers.commandcode.baseUrl = "http://localhost:9000/v1";
	models.providers.commandcode.models = [{ id: "my-own-model", name: "My own model" }];
	await writeFile(path, JSON.stringify(models, null, 2));

	const again = await ensureCommandCodeProvider(dir);
	assert.equal(again.added, COMMANDCODE_MODELS.length, "missing catalog models are appended");
	const after = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(after.providers.commandcode.baseUrl, "http://localhost:9000/v1", "a student's endpoint wins");
	assert.equal(after.providers.commandcode.models[0].id, "my-own-model", "their entries come first");

	assert.equal((await ensureCommandCodeProvider(dir)).added, 0, "a second run is a no-op");
});

test("CommandCode sits beside the other providers without disturbing them", async () => {
	const dir = await scratch();
	await ensureSparkProvider(dir);
	await ensureCommandCodeProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.deepEqual(Object.keys(cfg.providers).sort(), ["commandcode", "tlc-spark"]);
	assert.notEqual(COMMANDCODE_BASE_URL, EXPLABS_BASE_URL);
	assert.notEqual(COMMANDCODE_BASE_URL, RIVER_BASE_URL);
	assert.notEqual(COMMANDCODE_BASE_URL, TOKENHARBOR_BASE_URL);
});

test("only a plausible key is accepted, judged by shape and never by value", () => {
	assert.equal(looksLikeCommandCodeKey("cmd_abcdef1234567890"), true);
	assert.equal(looksLikeCommandCodeKey("abcdefgh12345678"), true);
	assert.equal(looksLikeCommandCodeKey(" abcdefgh12345678\n"), true, "paste whitespace is trimmed");
	assert.equal(looksLikeCommandCodeKey("short"), false);
	assert.equal(looksLikeCommandCodeKey("has spaces in it"), false);
	assert.equal(looksLikeCommandCodeKey(""), false);
	assert.equal(looksLikeCommandCodeKey(undefined), false);
});

test("CommandCode counts as logged in once its key is stored, or its env var is set", async () => {
	const dir = await scratch();
	assert.equal((await loggedInProviders(dir, {})).has("commandcode"), false);
	await saveProviderKey(dir, "commandcode", "cmd_TESTKEY1234567890");
	assert.ok((await loggedInProviders(dir, {})).has("commandcode"));
	const fresh = await scratch();
	assert.ok((await loggedInProviders(fresh, { COMMANDCODE_API_KEY: "x" })).has("commandcode"));
});

test("learningcode --login-provider commandcode stores the key and lists the provider", async () => {
	const dir = await scratch();
	const result = loginWith(["--login-provider", "commandcode"], "cmd_abcdef1234567890\n", dir);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Get a CommandCode key at https:\/\/commandcode\.ai\/settings\/keys/);
	assert.match(result.stdout, /Saved\. CommandCode models now appear in \/model\./);
	// The Spark token prompt must not block logging in to another provider.
	assert.doesNotMatch(result.stdout + result.stderr, /Paste your Spark API token/);

	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
	assert.equal(auth.commandcode.key, "cmd_abcdef1234567890");
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	assert.ok(cfg.providers.commandcode, "the provider entry is written by the login too");
});

test("the name is normalised, so command-code and commandcode.ai both land", async () => {
	for (const spelling of ["command-code", "commandcode.ai", "command code"]) {
		const dir = await scratch();
		const result = loginWith(["--login-provider", spelling], "cmd_abcdef1234567890\n", dir);
		assert.equal(result.status, 0, `${spelling}: ${result.stderr}`);
		const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
		assert.equal(auth.commandcode.key, "cmd_abcdef1234567890", `${spelling} stores under commandcode`);
	}
});

test("a bad key is refused and nothing is saved", async () => {
	const dir = await scratch();
	const bad = loginWith(["--login-provider", "commandcode"], "nope\n", dir);
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /does not look like a CommandCode key/);
	const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8").catch(() => "{}"));
	assert.equal(auth.commandcode, undefined, "a rejected key must not be stored");
});

test("an unknown provider names every provider that is available", async () => {
	const unknown = loginWith(["--login-provider", "notaprovider"], "", await scratch());
	assert.notEqual(unknown.status, 0);
	assert.match(unknown.stderr, /Available: tokenharbor, river, explabs, commandcode/);
});
