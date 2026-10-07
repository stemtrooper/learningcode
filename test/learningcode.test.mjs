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

test("the banner keeps the figlet art intact and collapses when it cannot fit", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  const art = mod.bannerArt();
  assert.equal(art.length, 6, "the ANSI Shadow face is six rows tall");

  // Every row must be box characters, full blocks or padding. A stray latin
  // letter would mean the art got reflowed into something it is not.
  for (const line of art) {
    assert.match(line, /^[\u2588\u2550-\u255D ]+$/, "row must be art characters only");
  }

  // The face only lines up because each row keeps its exact offset: the L's top
  // row starts flush left, the rest are indented one column. Losing that makes
  // the whole banner look broken rather than merely misaligned.
  assert.ok(art[0].startsWith("\u2588\u2588\u2557"), "row 0 should start flush with L's top bar");
  assert.ok(art[1].startsWith(" \u2588\u2588\u2551"), "row 1 should be indented one column");
  assert.ok(art[art.length - 1].startsWith(" \u255A"), "last row should open with the L's foot");

  // The art is wider than a classic 80 column terminal, which is why the
  // fallback exists. Pin the real number so a change is a deliberate decision.
  const width = mod.bannerWidth();
  assert.equal(width, 101, "art width changed; re-check the 80 column fallback");
  assert.ok(width > 80, "if this ever fits 80 columns the fallback can be widened");

  const theme = { fg: (_token, text) => text };
  const banner = mod.createBanner(theme);

  const wide = banner.render(120);
  assert.ok(wide.length > 8, "wide render includes art, rule, tagline and hints");
  // Compare against the art itself rather than counting matches: a character-class
  // count also matches the rule beneath the art.
  for (const line of mod.bannerArt()) {
    assert.ok(wide.includes("  " + line), "art row missing from render: " + JSON.stringify(line));
  }
  assert.ok(wide.every((line) => line.startsWith("  ") || line === ""), "everything is indented");

  // 100 columns is one short of the art, so the wordmark shows instead.
  const narrow = banner.render(100);
  assert.match(narrow.join("\n"), /learningcode/);
  assert.doesNotMatch(narrow.join("\n"), /[\u2588\u2550-\u255D]/, "no art when it cannot fit");
  assert.ok(narrow.length < wide.length, "narrow terminals get the compact wordmark");
});

test("the banner extension installs a header from session_start", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  let handler;
  mod.default({ on: (event, fn) => event === "session_start" && (handler = fn) });
  assert.equal(typeof handler, "function", "must subscribe to session_start");

  // setHeader lives on the event's UI context, not on the ExtensionAPI itself.
  let headerFactory;
  await handler({}, { hasUI: true, mode: "tui", ui: { setHeader: (f) => (headerFactory = f) } });
  assert.equal(typeof headerFactory, "function", "setHeader must receive a factory");

  const component = headerFactory({}, { fg: (_t, text) => text });
  assert.equal(typeof component.render, "function");
  assert.ok(component.render(120).some((line) => line.includes("\u2588")));

  // Print and JSON runs load this extension too, but have no header to replace.
  for (const ctx of [
    { hasUI: true, mode: "print", ui: { setHeader: () => assert.fail("print mode must not set a header") } },
    { hasUI: false, mode: "tui", ui: { setHeader: () => assert.fail("no-UI runs must not set a header") } },
  ]) {
    await handler({}, ctx);
  }
});
