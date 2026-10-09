import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TOKENHARBOR_BASE_URL,
	TOKENHARBOR_MODELS,
	ensureTokenHarborProvider,
	looksLikeTokenHarborKey,
} from "../lib/tokenharbor.mjs";
import { saveProviderKey, loggedInProviders, parseModelTable, visibleModelPatterns } from "../lib/auth.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-tokenharbor-"));

test("TokenHarbor is written to models.json with the documented endpoint and key command", async () => {
	const dir = await scratch();
	await ensureTokenHarborProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const provider = cfg.providers.tokenharbor;
	assert.equal(provider.baseUrl, "https://tokenharbor.ai/v1");
	assert.equal(provider.api, "openai-completions");
	assert.match(provider.apiKey, /^!node -e .*TOKENHARBOR_API_KEY/);
	assert.equal(provider.models.length, TOKENHARBOR_MODELS.length);
});

test("an existing TokenHarbor entry is left alone, so a student's edit survives", async () => {
	const dir = await scratch();
	await ensureTokenHarborProvider(dir);
	const again = await ensureTokenHarborProvider(dir);
	assert.equal(again.created, false);
});

test("only thk_ keys are accepted", () => {
	assert.equal(looksLikeTokenHarborKey("thk_abcdefgh12"), true);
	assert.equal(looksLikeTokenHarborKey("sk-ant-nope"), false);
	assert.equal(looksLikeTokenHarborKey("thk_"), false);
	assert.equal(TOKENHARBOR_BASE_URL, "https://tokenharbor.ai/v1");
});

test("a provider counts as logged in only with a stored key or its environment variable", async () => {
	const dir = await scratch();
	// TLC-Spark is always offered; nothing else is until a key is stored.
	assert.deepEqual([...(await loggedInProviders(dir, {}))], ["tlc-spark"]);
	await saveProviderKey(dir, "tokenharbor", "thk_TESTKEY12345");
	assert.ok((await loggedInProviders(dir, {})).has("tokenharbor"));
	assert.ok((await loggedInProviders(dir, { OPENAI_API_KEY: "x" })).has("openai"));
	assert.equal((await loggedInProviders(dir, {})).has("openai"), false);
});

test("the model picker hides providers the student is not logged in to", () => {
	const listing = [
		"provider     model                context",
		"anthropic    claude-fable-5       1M",
		"openai       gpt-5                400K",
		"tokenharbor  deepseek-v4.1-flash  200K",
	].join("\n");
	assert.deepEqual(parseModelTable(listing), [
		"anthropic/claude-fable-5",
		"openai/gpt-5",
		"tokenharbor/deepseek-v4.1-flash",
	]);
	assert.deepEqual(visibleModelPatterns(listing, new Set(["tokenharbor"])), ["tokenharbor/deepseek-v4.1-flash"]);
});

test("with nothing logged in, the filter returns null so Pi's default is kept", () => {
	const listing = "provider  model\nanthropic  claude-fable-5\n";
	assert.equal(visibleModelPatterns(listing, new Set()), null);
});

test("TLC-Spark stays visible with no key, and OpenCode Go appears once its key is stored", async () => {
	const dir = await scratch();
	const listing = "provider  model\ntlc-spark  TLC-Spark\nopencode-go  kimi-k2\nanthropic  claude-fable-5\n";
	assert.deepEqual(visibleModelPatterns(listing, await loggedInProviders(dir, {})), ["tlc-spark/TLC-Spark"]);
	await saveProviderKey(dir, "opencode-go", "oc_sk_TESTKEY123");
	assert.deepEqual(visibleModelPatterns(listing, await loggedInProviders(dir, {})), ["tlc-spark/TLC-Spark", "opencode-go/kimi-k2"]);
});