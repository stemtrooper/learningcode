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

  // Every row must start flush left. An earlier paste of this art carried a
  // leading space on rows 2 to 6, which slid every letter's body one column
  // right of its own top bar. Nothing in a banner looks more broken than that,
  // so it is asserted rather than trusted.
  art.forEach((line, i) => {
    assert.ok(!line.startsWith(" "), "row " + i + " must start flush left");
  });
  assert.ok(art[0].startsWith("\u2588\u2588\u2557"), "row 0 opens with the L's top bar");
  assert.ok(art[1].startsWith("\u2588\u2588\u2551"), "row 1 continues the L's stem flush");
  assert.ok(art[art.length - 1].startsWith("\u255A"), "last row opens with the L's foot");

  // The art is wider than a classic 80 column terminal, which is why the
  // fallback exists. Pin the real number so a change is a deliberate decision.
  const width = mod.bannerWidth();
  assert.equal(width, 97, "art width changed; re-check the 80 column fallback");
  assert.ok(width > 80, "if this ever fits 80 columns the fallback can be widened");

  const theme = { fg: (_token, text) => text };
  const banner = mod.createBanner(theme);

  const wide = banner.render(120);
  assert.ok(wide.length > 8, "wide render includes art, rule, tagline and hints");
  // Compare against the art itself rather than counting matches: a character-class
  // count also matches the rule beneath the art. Strip colour first, since the
  // banner wraps each row in an escape and that prefix breaks a literal compare.
  const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const plainWide = wide.map(plain);
  for (const line of mod.bannerArt()) {
    assert.ok(
      plainWide.includes("  " + line),
      "art row missing from render: " + JSON.stringify(line),
    );
  }
  assert.ok(
    plainWide.every((line) => line.startsWith("  ") || line === ""),
    "everything is indented",
  );

  // 96 columns is one short of the art, so the wordmark shows instead.
  const narrow = banner.render(96);
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

test("the Node version floor is enforced before anything else runs", async () => {
  const { compareVersions, REQUIRED_NODE } = await import("../lib/config.mjs");

  assert.equal(REQUIRED_NODE, "22.19.0", "must match Pi's engines floor");

  // Numeric, not lexicographic: "22.9.0" is older than "22.19.0" and a string
  // compare would wave it through.
  assert.equal(compareVersions("22.9.0", "22.19.0"), -1);
  assert.equal(compareVersions("22.19.0", "22.19.0"), 0);
  assert.equal(compareVersions("22.23.2", "22.19.0"), 1);
  assert.equal(compareVersions("18.20.8", "22.19.0"), -1);
  assert.equal(compareVersions("24.21.0", "22.19.0"), 1);
  assert.equal(compareVersions("v22.23.2", "22.19.0"), 1, "tolerates a leading v");
  assert.equal(compareVersions("22.19", "22.19.0"), 0, "missing patch counts as zero");

  // This machine runs a supported Node, so the check must let a real launch
  // through rather than tripping on everyone. A non-Spark model is used so the
  // run does not stop at the missing Spark token.
  const dir = await scratch();
  globalThis.__lcDir = dir;
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
  const { stdout } = await launch(["--model", "opencode-go/glm-5.3-flash", "--show-config"]);
  assert.match(stdout, new RegExp("version\\s+" + pkg.version.replace(/\./g, "\\.")));
  assert.doesNotMatch(stdout, /Node .* or newer is required/, "supported Node passes the check");
});

test("engines advertises the floor so npm warns during install too", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
  assert.match(pkg.engines.node, /^>=22\./, "engines should mirror the runtime check");
});

test("TLC themes seed once and a student's edit is never overwritten", async () => {
  const { ensureThemes, themesDir, preferredTheme, THEME_NAMES } = await import("../lib/themes.mjs");

  const dir = await scratch();
  const first = await ensureThemes(dir);
  assert.deepEqual(first.sort(), [...THEME_NAMES].sort(), "both themes seeded on a fresh install");

  // Edit the seeded theme the way a student would, then re-run.
  const dark = join(themesDir(dir), "tlc-dark.json");
  const edited = JSON.parse(await readFile(dark, "utf-8"));
  edited.colors.accent = "#ff00ff";
  await writeFile(dark, JSON.stringify(edited, null, 2));

  const second = await ensureThemes(dir);
  assert.deepEqual(second, [], "nothing re-seeded when both themes already exist");

  const after = JSON.parse(await readFile(dark, "utf-8"));
  assert.equal(after.colors.accent, "#ff00ff", "the student's edit survives");

  // A missing theme is restored without touching the one that exists.
  const { rm } = await import("node:fs/promises");
  await rm(join(themesDir(dir), "tlc-light.json"));
  const third = await ensureThemes(dir);
  assert.deepEqual(third, ["tlc-light"], "only the missing theme is restored");
});

test("the theme is never forced over an explicit choice", async () => {
  const { preferredTheme } = await import("../lib/themes.mjs");

  assert.equal(preferredTheme({ LEARNINGCODE_THEME: "solarized" }), "solarized");
  assert.equal(preferredTheme({ LEARNINGCODE_LIGHT_THEME: "1" }), "tlc-light");
  assert.equal(preferredTheme({}), "tlc-dark");
});

/**
 * Pi's required colour tokens, inlined rather than read from Pi's schema file.
 * That file lives in Pi's src/ and is not shipped in its npm package, so a test
 * that reached for it would only pass on a machine with Pi checked out.
 */
const PI_REQUIRED_COLOUR_TOKENS = `accent border borderAccent borderMuted success error
warning muted dim text thinkingText selectedBg userMessageBg userMessageText
customMessageBg customMessageText customMessageLabel toolPendingBg toolSuccessBg
toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock
mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded
toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction
syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator
syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium
thinkingHigh thinkingXhigh bashMode`
  .split(/\s+/)
  .filter(Boolean);

test("both shipped themes satisfy Pi's colour schema", async () => {
  for (const mode of ["dark", "light"]) {
    const theme = JSON.parse(
      await readFile(new URL(`../assets/themes/tlc-${mode}.json`, import.meta.url), "utf-8"),
    );

    assert.ok(["dark", "light"].includes(theme.appearance), "appearance must be dark or light");

    const missing = PI_REQUIRED_COLOUR_TOKENS.filter((token) => !(token in theme.colors));
    assert.deepEqual(missing, [], `tlc-${mode} is missing colour tokens`);
    assert.deepEqual(Object.keys(theme.colors).sort(), Object.keys(theme.colors).sort());

    // Every colour must be a form Pi accepts: hex, okhsl, or a var reference.
    const forms = [/^#[0-9a-fA-F]{6}$/, /^#[0-9a-fA-F]{3}$/, /^okhsl\([\d.]+ [\d.]+% [\d.]+%\)$/];
    for (const [token, value] of Object.entries(theme.colors)) {
      assert.ok(
        forms.some((re) => re.test(value)) || value in theme.vars,
        `tlc-${mode} ${token} has unrecognised value ${value}`,
      );
    }
  }

  // The brand cyan, sampled from the logo pixels rather than eyeballed.
  const dark = JSON.parse(await readFile(new URL("../assets/themes/tlc-dark.json", import.meta.url), "utf-8"));
  const light = JSON.parse(await readFile(new URL("../assets/themes/tlc-light.json", import.meta.url), "utf-8"));
  assert.equal(dark.colors.accent, "#29c8f2", "cyan from the black-background logo");
  assert.equal(light.colors.accent, "#0dacd6", "the darker cyan for light backgrounds");
});

test("the footer renders quota as a bar and survives narrow terminals", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/footer.ts");

  // 10 cell meter, filled proportionally.
  assert.equal(mod._internals.meter(0, 100), "░".repeat(10));
  assert.equal(mod._internals.meter(100, 100), "█".repeat(10));
  assert.equal(mod._internals.meter(50, 100), "█".repeat(5) + "░".repeat(5));
  // Over budget must not overflow the bar.
  assert.equal(mod._internals.meter(150, 100), "█".repeat(10));

  assert.equal(mod._internals.pct(82, 100), "82%");
  assert.equal(mod._internals.pct(5, 0), "--", "an exempt account has no limit to show");

  const [bar, numbers] = mod._internals.format({ tokensUsed: 8200, dailyTokenLimit: 10000, aiEnabled: true });
  assert.match(bar, /[█░]/, "the meter is drawn");
  assert.ok(numbers.includes("8k/10k today"), `numbers were ${numbers}`);
});

test("the footer extension installs a footer and stops polling on shutdown", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/footer.ts");

  const handlers = new Map();
  let footerFactory;
  const ctx = { hasUI: true, mode: "tui", ui: { setFooter: (f) => (footerFactory = f) } };

  mod.default({ on: (event, fn) => handlers.set(event, fn) });
  assert.ok(handlers.has("session_start"), "must subscribe to session_start");
  assert.ok(handlers.has("session_shutdown"), "must clean up its timer on shutdown");

  await handlers.get("session_start")({}, ctx);
  assert.equal(typeof footerFactory, "function");

  const theme = { fg: (_t, text) => text };
  const component = footerFactory({}, theme);
  const line = component.render(80).join("");
  // No token in this test process, so the footer must say so rather than draw an
  // empty bar that reads as "you have spent nothing".
  assert.match(line, /not on Spark|unavailable/);

  await handlers.get("session_shutdown")();
});

test("the banner survives a theme that rejects non-token colours", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  /**
   * A faithful stand-in for Pi's Theme.fg. The earlier stub accepted any string,
   * which is exactly why a real bug slipped through: fg takes a theme *token*,
   * and Theme.tokenAnsi throws "Unknown theme color: #29c8f2" for anything else.
   * Printing the brand cyan through fg crashed the header at render time, in the
   * TUI only, so a print-mode smoke test never saw it.
   */
  const theme = {
    fg(token) {
      const tokens = new Set(["accent", "border", "dim", "muted", "text", "error"]);
      if (!tokens.has(token)) throw new Error(`Unknown theme color: ${token}`);
      return token;
    },
    appearance: "dark",
    getColorMode: () => "truecolor",
  };

  const lines = mod.createBanner(theme).render(120);
  assert.ok(lines.length > 8, "header renders without throwing");

  const art = lines.find((line) => line.includes("\u2588"));
  assert.ok(art, "art is present");
  // #29c8f2 as a real 24-bit escape, not routed through the theme.
  assert.match(art, /\x1b\[38;2;41;200;242m/, "TLC cyan emitted as truecolor");
});

test("appearance picks the cyan, getColorMode picks the encoding", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  const artFor = (overrides) =>
    mod
      .createBanner({ fg: (_t, text) => text, ...overrides })
      .render(120)
      .find((line) => line.includes("\u2588"));

  // theme.appearance is light or dark and decides the brand colour.
  assert.match(artFor({ appearance: "dark" }), /38;2;41;200;242/, "#29c8f2 on a dark theme");
  assert.match(artFor({ appearance: "light" }), /38;2;13;172;214/, "#0dacd6 on a light theme");

  // getColorMode is the terminal capability and must NOT be read as light/dark.
  assert.match(
    artFor({ appearance: "light", getColorMode: () => "256" }),
    /38;5;/,
    "a 256 colour terminal gets a 256 colour escape, not truecolor",
  );
  assert.match(
    artFor({ appearance: "dark", getColorMode: () => "256" }),
    /38;5;/,
    "capability does not change which cyan is chosen",
  );

  // Nothing reported at all: keep the primary cyan rather than losing colour.
  const bare = mod.createBanner({ fg: (_t, text) => text }).render(120);
  assert.match(
    bare.find((line) => line.includes("\u2588")),
    /38;2;41;200;242/,
    "defaults to the dark-theme cyan",
  );
});
