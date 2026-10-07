import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { ensureSparkProvider, modelsPath, providerDefinition, retargetProvider } from "../lib/models.mjs";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "learningcode.mjs");

const scratch = () => mkdtemp(join(tmpdir(), "learningcode-"));

test("seeds TLC-Spark with the compat flags Spark requires", async () => {
	const dir = await scratch();
	const result = await ensureSparkProvider(dir);

	assert.equal(result.created, true);

	const models = JSON.parse(await readFile(modelsPath(dir), "utf-8"));
	const provider = models.providers["tlc-spark"];

	assert.equal(provider.baseUrl, "https://spark.learning.com.my/v1");
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, "$SPARK_API_KEY");

	// Spark's message union has no "developer" role, and v1.ts reads only
	// max_tokens. Losing either one silently breaks every turn.
	assert.equal(provider.compat.supportsDeveloperRole, false);
	assert.equal(provider.compat.maxTokensField, "max_tokens");
	assert.equal(provider.compat.supportsReasoningEffort, false);

	const model = provider.models[0];
	assert.equal(model.id, "TLC-Spark");
	assert.equal(model.contextWindow, 32768);
	assert.equal(model.maxTokens, 4096);
	// Spark bills chain-of-thought but never forwards it, so thinking is off.
	assert.equal(model.reasoning, false);
});

test("is idempotent and never clobbers student edits", async () => {
	const dir = await scratch();
	await ensureSparkProvider(dir);

	// Simulate a student pointing at their local bench by hand.
	const path = modelsPath(dir);
	const models = JSON.parse(await readFile(path, "utf-8"));
	models.providers["tlc-spark"].baseUrl = "http://localhost:3000/v1";
	models.providers["ollama"] = { name: "Ollama", baseUrl: "http://localhost:11434/v1" };
	await writeFile(path, JSON.stringify(models, null, 2));

	const second = await ensureSparkProvider(dir);
	assert.equal(second.created, false, "re-running must not rewrite the file");

	const after = JSON.parse(await readFile(path, "utf-8"));
	assert.equal(after.providers["tlc-spark"].baseUrl, "http://localhost:3000/v1");
	assert.ok(after.providers.ollama, "unrelated providers must survive");
});

test("--base-url retargets in place", async () => {
	const dir = await scratch();
	await ensureSparkProvider(dir);

	const updated = await retargetProvider(dir, "http://localhost:3000/v1/");
	assert.equal(updated, "http://localhost:3000/v1", "trailing slash is stripped");

	const models = JSON.parse(await readFile(modelsPath(dir), "utf-8"));
	assert.equal(models.providers["tlc-spark"].baseUrl, "http://localhost:3000/v1");
	assert.equal(models.providers["tlc-spark"].compat.supportsDeveloperRole, false);
});

test("refuses to retarget a provider it never wrote", async () => {
	const dir = await scratch();
	await assert.rejects(() => retargetProvider(dir, "http://localhost:3000/v1"));
});

test("provider definition tracks the env override", () => {
	const original = process.env.LEARNINGCODE_SPARK_BASE_URL;
	process.env.LEARNINGCODE_SPARK_BASE_URL = "http://localhost:3000/v1";
	try {
		assert.equal(providerDefinition().baseUrl, "http://localhost:3000/v1");
	} finally {
		if (original === undefined) delete process.env.LEARNINGCODE_SPARK_BASE_URL;
		else process.env.LEARNINGCODE_SPARK_BASE_URL = original;
	}
});

test("the quota extension registers /quota, /seats and a session_start hook", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/spark-quota.ts");
	const factory = mod.default;
	assert.equal(typeof factory, "function", "extension must default-export a factory");

	const commands = new Map();
	const handlers = new Map();
	factory({
		registerCommand: (name, spec) => commands.set(name, spec),
		on: (event, handler) => handlers.set(event, handler),
	});

	assert.deepEqual([...commands.keys()].sort(), ["quota", "seats"]);

	for (const spec of commands.values()) {
		assert.equal(typeof spec.description, "string");
		assert.equal(typeof spec.handler, "function");
	}

	assert.ok(handlers.has("session_start"), "startup quota check must be wired");

	// Both commands must degrade to a notification, never throw, when Spark is
	// unreachable or the token is missing.
	for (const [name, spec] of commands) {
		const notices = [];
		await spec.handler("", { ui: { notify: (m, level) => notices.push([m, level]) } });
		assert.equal(notices.length, 1, `${name} should notify exactly once`);
		assert.equal(notices[0][1], "warning", `${name} should warn when Spark is unreachable`);
	}
});
/** Run the launcher with a clean environment, returning stdout+stderr. */
const launch = (args, env = {}) =>
  run(process.execPath, [launcher, ...args], {
    cwd: repoRoot,
    // PI_OFFLINE stops Pi refreshing provider catalogs over the network, which
    // would otherwise leave a subprocess test waiting on a socket.
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      LEARNINGCODE_DIR: env.LEARNINGCODE_DIR ?? (globalThis.__lcDir ??= ""),
      ...env,
    },
  });

test("a non-Spark --model needs no Spark token and skips the Spark health check", async () => {
  const dir = await scratch();
  globalThis.__lcDir = dir;
  const { stdout } = await launch(["--model", "opencode-go/glm-5.3-flash", "--show-config"]);

  assert.match(stdout, /model\s+opencode-go\/glm-5\.3-flash/);
  assert.match(stdout, /spark token\s+not required/);
  // The regression: this used to block on the token prompt.
  assert.doesNotMatch(stdout, /Paste your Spark API token/);
});

test("--list-models never demands a token, even with Spark down", async () => {
  const dir = await scratch();
  globalThis.__lcDir = dir;
  const { stdout } = await launch(["--list-models", "opencode-go"], {
    LEARNINGCODE_SPARK_BASE_URL: "http://127.0.0.1:9/v1",
    // Pi lists models only for providers it holds credentials for, so the Go
    // provider needs a key even though no request is made.
    OPENCODE_API_KEY: "sk-test-not-a-real-key",
  });

  assert.doesNotMatch(stdout, /Paste your Spark API token/);
  assert.match(stdout, /opencode-go\s+glm-5\.3-flash/);
});

test("the Spark default still requires its token", async () => {
  const dir = await scratch();
  globalThis.__lcDir = dir;
  // No token in env and no TTY: the launcher must not silently proceed.
  await assert.rejects(() => launch(["-p", "hi"]));
});

test("--token is ignored, with a warning, for a non-Spark model", async () => {
  const dir = await scratch();
  globalThis.__lcDir = dir;
  const { stderr } = await launch(
    ["--model", "opencode-go/glm-5.3-flash", "--token", "spark_live_x", "--show-config"],
  );
  assert.match(stderr, /only applies to tlc-spark/);
});
