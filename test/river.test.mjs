import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RIVER_BASE_URL,
	RIVER_MODELS,
	RIVER_PROVIDER,
	ensureRiverProvider,
	looksLikeRiverKey,
} from "../lib/river.mjs";
import { saveProviderKey, loggedInProviders, visibleModelPatterns } from "../lib/auth.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-river-"));

test("River is written to models.json with the documented endpoint and key command", async () => {
	const dir = await scratch();
	await ensureRiverProvider(dir);
	const cfg = JSON.parse(await readFile(join(dir, "models.json"), "utf-8"));
	const provider = cfg.providers[RIVER_PROVIDER];
	assert.equal(provider.baseUrl, RIVER_BASE_URL);
	assert.equal(provider.baseUrl, "https://api.river.ai/v1");
	assert.equal(provider.api, "openai-completions");
	assert.match(provider.apiKey, /^!node -e .*RIVER_API_KEY/);
	assert.equal(provider.models.length, RIVER_MODELS.length);
});

test("an existing River entry is left alone, so a student's edit survives", async () => {
	const dir = await scratch();
	await ensureRiverProvider(dir);
	const again = await ensureRiverProvider(dir);
	assert.equal(again.created, false);
});

test("only rv_ keys are accepted", () => {
	assert.equal(looksLikeRiverKey("rv_abcdefgh12"), true);
	assert.equal(looksLikeRiverKey("sk-ant-nope"), false);
	assert.equal(looksLikeRiverKey("rv_"), false);
});

test("a stored River key makes the provider logged in, and the picker shows it", async () => {
	const dir = await scratch();
	await saveProviderKey(dir, RIVER_PROVIDER, "rv_TESTKEY12345");
	const loggedIn = await loggedInProviders(dir, {});
	assert.ok(loggedIn.has(RIVER_PROVIDER));

	const listing = [
		"provider     model                            context",
		"river        deepseek-ai/DeepSeek-V4.1-Flash  1M",
		"anthropic    claude-fable-5                   1M",
	].join("\n");
	assert.deepEqual(visibleModelPatterns(listing, loggedIn), ["river/deepseek-ai/DeepSeek-V4.1-Flash"]);
});

test("the RIVER_API_KEY environment variable also counts as a credential", async () => {
	const dir = await scratch();
	assert.ok((await loggedInProviders(dir, { RIVER_API_KEY: "rv_from_env" })).has(RIVER_PROVIDER));
	assert.equal((await loggedInProviders(dir, {})).has(RIVER_PROVIDER), false);
});