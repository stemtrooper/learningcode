import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("the Spark extension registers its commands and a session_start hook", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/spark-quota.ts");
  assert.equal(typeof mod.default, "function", "extension must default-export a factory");

  const commands = new Map();
  const handlers = new Map();
  mod.default({
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, handler) => handlers.set(event, handler),
  });

  assert.deepEqual([...commands.keys()].sort(), ["quota", "seats", "spark-login"]);

  for (const spec of commands.values()) {
    assert.equal(typeof spec.description, "string");
    assert.equal(typeof spec.handler, "function");
  }

  assert.ok(handlers.has("session_start"), "startup quota check must be wired");

  // Every command must degrade to a notification, never throw, when Spark is
  // unreachable or no token is loaded.
  for (const [name, spec] of commands) {
    const notices = [];
    await spec.handler("", { ui: { notify: (message, level) => notices.push([message, level]) } });
    assert.equal(notices.length, 1, name + " should notify exactly once");
    assert.equal(notices[0][1], "warning", name + " should warn when Spark is unreachable");
  }
});

test("the Spark extension never accepts or echoes a pasted token", async () => {
  const jiti = createJiti(import.meta.url);
  const source = readFileSync(
    new URL("../extensions/spark-quota.ts", import.meta.url),
    "utf-8",
  );

  // The point of /spark-login is to verify and guide, not to collect a secret.
  // Pi's input dialog cannot mask, so a token typed there would sit in scrollback,
  // and Pi caches resolved env values so a mid-session change would not apply.
  assert.ok(!source.includes("ui.input"), "must not prompt for a token in the TUI");
  assert.ok(!source.includes("promptSecret"), "must not reuse the raw-mode secret prompt");
  // It must not read the full cached token, only a prefix for display.
  assert.ok(source.includes("cachedTokenPrefix"), "uses the prefix helper");
  assert.ok(!/readCachedToken/.test(source), "must not read the raw token");
});

test("/spark-login explains what to do when no token is loaded", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/spark-quota.ts");

  // This test process has no SPARK_API_KEY, which is the interesting path: the
  // student has launched without a token and needs to be told the next step.
  const commands = new Map();
  mod.default({ registerCommand: (name, spec) => commands.set(name, spec), on: () => {} });

  const notices = [];
  await commands.get("spark-login").handler("", {
    ui: { notify: (message, level) => notices.push([message, level]) },
  });

  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], "warning");
  assert.match(notices[0][0], /learningcode --login/, "points at the masked login command");
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

test("the banner steps down through three tiers as the terminal narrows", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  const theme = { fg: (_t, text) => text, appearance: "dark", getColorMode: () => "truecolor" };
  const banner = mod.createBanner(theme);
  const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

  const full = mod.bannerWidth();
  const small = mod.condensedWidth();
  assert.equal(full, 97, "full face is 97 columns");
  assert.equal(small, 47, "condensed face is 47 columns");

  // Wide: the figlet face, all six rows, verbatim, plus the rule beneath it.
  const wide = banner.render(full + 2).map(plain);
  for (const line of mod.bannerArt()) {
    assert.ok(wide.includes("  " + line), "full art row missing: " + JSON.stringify(line));
  }
  assert.ok(wide.join("\n").includes("\u2550"), "the rule appears under the full art");
  assert.ok(wide.join("\n").includes("/hotkeys"), "the hint line appears under the full art");

  // A phone will never have 97 columns, so the middle tier still has to spell the
  // word rather than collapsing straight to the wordmark.
  const phone = banner.render(small + 2).map(plain);
  assert.equal(phone.length, 7, "condensed tier is four art rows plus framing");
  for (const line of mod.condensedArt_()) {
    assert.ok(phone.includes("  " + line), "condensed row missing: " + JSON.stringify(line));
  }
  assert.ok(
    !phone.join("\n").includes("\u2550"),
    "the 97 wide rule must not be drawn on a narrow terminal",
  );

  // Too narrow for even the condensed face: the wordmark.
  const tiny = banner.render(small).map(plain).join("\n");
  assert.match(tiny, /learningcode/);
  assert.doesNotMatch(tiny, /[\u2588\u2550-\u255D]/, "no art when nothing fits");

  // Every tier keeps the tagline, so the branding survives at any width.
  for (const width of [full + 2, small + 2, small]) {
    assert.match(
      banner.render(width).map(plain).join("\n"),
      /The Learning Curve/,
      "tagline present at width " + width,
    );
  }
});

test("the condensed face is block art and loses no glyph to trimming", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  const art = mod.condensedArt_();
  assert.equal(art.length, 4, "condensed face is four rows tall");
  art.forEach((line, i) => {
    assert.match(line, /^[\u2588 ]+$/, "row " + i + " must be blocks and spaces only");
  });

  // Rows are trimmed at build time, so one ending in its last glyph's own padding
  // is shorter than the widest. The invariant is that padding a row back out adds
  // spaces only, which is what would fail if a glyph were cut instead.
  const widest = Math.max(...art.map((line) => line.length));
  assert.equal(widest, 47, "widest condensed row is 47");
  art.forEach((line, i) => {
    const padding = line.padEnd(47).slice(line.length);
    assert.ok(/^ *$/.test(padding), "row " + i + " must be short only by trailing spaces");
  });

  // Twelve letters at three columns each, plus eleven single-space gaps.
  assert.equal(art[0].length, 12 * 3 + 11);
});

test("the full face keeps its verbatim rows and flush-left offsets", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/banner.ts");

  const art = mod.bannerArt();
  assert.equal(art.length, 6, "the ANSI Shadow face is six rows tall");

  for (const line of art) {
    assert.match(line, /^[\u2588\u2550-\u255D ]+$/, "row must be art characters only");
  }

  // Every row starts flush left. An earlier paste of this art carried a leading
  // space on rows two to six, sliding every letter one column right of its own top
  // bar. Nothing in a banner looks more broken than that, so it is asserted.
  art.forEach((line, i) => {
    assert.ok(!line.startsWith(" "), "row " + i + " must start flush left");
  });
  assert.ok(art[0].startsWith("\u2588\u2588\u2557"), "row 0 opens with the L's top bar");
  assert.ok(art[1].startsWith("\u2588\u2588\u2551"), "row 1 continues the L's stem flush");
  assert.ok(art[art.length - 1].startsWith("\u255A"), "last row opens with the L's foot");
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

test("the launcher quiets Pi's startup header without overwriting a student's choice", async () => {
  const dir = await scratch();
  globalThis.__lcDir = dir;

  await launch(["--model", "opencode-go/glm-5.3-flash", "--show-config"]);
  const settingsPath = join(dir, "settings.json");
  const seeded = JSON.parse(await readFile(settingsPath, "utf-8"));
  assert.equal(seeded.quietStartup, true, "Pi's logo should not flash before the TLC banner");

  seeded.quietStartup = false;
  seeded.theme = "tlc-dark";
  await writeFile(settingsPath, JSON.stringify(seeded, null, 2));

  await launch(["--model", "opencode-go/glm-5.3-flash", "--show-config"]);
  const preserved = JSON.parse(await readFile(settingsPath, "utf-8"));
  assert.equal(preserved.quietStartup, false, "an explicit user preference wins");
  assert.equal(preserved.theme, "tlc-dark", "other Pi settings are preserved");
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

test("unlimited and no-daily-cap accounts are not rendered as zero allowance", async () => {
  const jiti = createJiti(import.meta.url);
  const footer = await jiti.import("../extensions/footer.ts");
  const quota = await jiti.import("../extensions/spark-quota.ts");

  // Only the explicit exemption means unlimited. A null daily cap can still
  // have the weekly quota, so the client must not say "unlimited" or "/0K".
  const exempt = { tokensUsed: 12345, dailyTokenLimit: null, quotaExempt: true, aiEnabled: true };
  assert.equal(footer._internals.isUnlimited(exempt), true);
  assert.match(footer._internals.format(exempt)[0], /unlimited/);
  assert.match(quota._internals.quotaLine(exempt), /unlimited/);

  const noDaily = { tokensUsed: 12345, dailyTokenLimit: null, quotaExempt: false, aiEnabled: true };
  assert.equal(footer._internals.isUnlimited(noDaily), false);
  const [noDailyFooter] = footer._internals.format(noDaily);
  assert.match(noDailyFooter, /no daily token cap/);
  assert.doesNotMatch(noDailyFooter, /\/\s*0k/);
  const noDailyCommand = quota._internals.quotaLine(noDaily);
  assert.match(noDailyCommand, /no daily token cap/);
  assert.doesNotMatch(noDailyCommand, /\/0 tokens/);

  const capped = { tokensUsed: 12345, dailyTokenLimit: 250000, quotaExempt: false, aiEnabled: true };
  assert.equal(footer._internals.isUnlimited(capped), false);
  assert.match(footer._internals.format(capped)[0], /5%/);
  assert.match(quota._internals.quotaLine(capped), /12,345\/250,000 tokens \(5%\)/);
});

test("the footer meter still behaves for capped accounts", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/footer.ts");
  const block = String.fromCodePoint(0x2588);
  const shade = String.fromCodePoint(0x2591);
  assert.equal(mod._internals.meter(0, 100), shade.repeat(10));
  assert.equal(mod._internals.meter(100, 100), block.repeat(10));
  assert.equal(mod._internals.meter(50, 100), block.repeat(5) + shade.repeat(5));
  assert.equal(mod._internals.meter(150, 100), block.repeat(10));
  assert.equal(mod._internals.pct(82, 100), "82%");
  assert.equal(mod._internals.pct(5, 0), "--", "a zero limit has no percentage");
  const [bar, numbers] = mod._internals.format({ tokensUsed: 8200, dailyTokenLimit: 10000, quotaExempt: false, aiEnabled: true });
  assert.match(bar, new RegExp("[" + block + shade + "]"));
  assert.ok(numbers.includes("8k/10k today"));
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
  // ...and every footer state ends with the exit hint.
  assert.match(line, /ctrl\+c.*exit/);
  assert.match(line, /esc.*interrupt/);

  await handlers.get("session_shutdown")();
});

test("the footer swaps its hint line for a working indicator while the agent runs", async () => {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("../extensions/footer.ts");

  const handlers = new Map();
  let footerFactory;
  const ctx = { hasUI: true, mode: "tui", ui: { setFooter: (f) => (footerFactory = f) } };

  mod.default({ on: (event, fn) => handlers.set(event, fn) });
  assert.ok(handlers.has("agent_start"), "must track when work begins");
  assert.ok(handlers.has("agent_end"), "must track when work ends");

  await handlers.get("session_start")({}, ctx);
  const theme = { fg: (_t, text) => text };
  const component = footerFactory({}, theme);

  assert.match(component.render(80).join(""), /ctrl\+c.*exit/);

  await handlers.get("agent_start")();
  const working = component.render(80).join("");
  assert.match(working, /working…/, "motion plus a label while the agent runs");
  assert.match(working, /esc to interrupt/);
  assert.doesNotMatch(working, /ctrl\+c/, "the exit hint steps aside while working");

  await handlers.get("agent_end")();
  assert.match(component.render(80).join(""), /ctrl\+c.*exit/, "hints return when done");

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

test("the Spark token reaches Pi by both routes, so they cannot drift", async () => {
  /**
   * The regression this locks down: Pi prefers a stored credential in auth.json over
   * the "$SPARK_API_KEY" the provider config names. Leaving the token only in the
   * environment let the two diverge, so Pi authenticated completions with a stale
   * auth.json entry while /quota and /seats read the environment and got a 401.
   */
  const dir = await scratch();
  const token = "spark_live_consistencetest01";
  const { saveProviderKey } = await import("../lib/auth.mjs");

  await saveProviderKey(dir, "tlc-spark", token);

  const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8"));
  assert.equal(auth["tlc-spark"].key, token, "Pi's stored credential is the token");
  assert.equal(auth["tlc-spark"].type, "api_key");

  // The value Pi would use and the value the extensions read must be the same
  // string, which is the whole point.
  assert.equal(
    auth["tlc-spark"].key,
    process.env.SPARK_API_KEY ?? token,
    "stored credential and environment agree",
  );
});

test("only a spark_live_ value is treated as a cached Spark token", async () => {
  /**
   * A leftover OpenCode key in the cache slot would be sent to Spark, rejected, and
   * reported as a 401 that looks like a revoked token. The prefix check is what stops
   * that, and it is tested here as a pure function because exercising it through
   * resolveToken would reach the interactive prompt and hang the suite.
   */
  const { isSparkToken, looksLikeToken } = await import("../lib/token.mjs");

  assert.equal(isSparkToken("spark_live_abc123"), true);
  assert.equal(looksLikeToken("spark_live_abc123"), true);

  for (const wrong of [
    "oc_sk_5ab64146dd6a_Q_6njm",
    "sk-ant-api03-whatever",
    "",
    "   ",
    "spark_live_",
    undefined,
    null,
    42,
  ]) {
    assert.equal(isSparkToken(wrong), false, "must reject " + JSON.stringify(wrong));
  }
});

test("quiet startup is seeded so the TLC header does not flash after Pi's", async () => {
  const { ensureQuietStartup } = await import("../lib/settings.mjs");
  const dir = await scratch();

  assert.equal(await ensureQuietStartup(dir), true, "fresh settings get quietStartup");
  const path = join(dir, "settings.json");
  const seeded = JSON.parse(await readFile(path, "utf-8"));
  assert.equal(seeded.quietStartup, true);

  // It is seeded only when absent, preserving any choice the student made.
  assert.equal(await ensureQuietStartup(dir), false, "existing setting is left alone");
  seeded.theme = "tlc-dark";
  seeded.quietStartup = false;
  await writeFile(path, JSON.stringify(seeded, null, 2));
  assert.equal(await ensureQuietStartup(dir), false);
  const preserved = JSON.parse(await readFile(path, "utf-8"));
  assert.equal(preserved.quietStartup, false);
  assert.equal(preserved.theme, "tlc-dark");

  // Pi's "header" mode is also an explicit preference and must survive.
  preserved.quietStartup = "header";
  await writeFile(path, JSON.stringify(preserved, null, 2));
  assert.equal(await ensureQuietStartup(dir), false);
  assert.equal(JSON.parse(await readFile(path, "utf-8")).quietStartup, "header");
});

test("quiet startup strips a BOM but reports malformed settings clearly", async () => {
  const { ensureQuietStartup } = await import("../lib/settings.mjs");
  const dir = await scratch();
  const path = join(dir, "settings.json");

  await writeFile(path, `\uFEFF{"theme":"tlc-dark"}`, "utf-8");
  assert.equal(await ensureQuietStartup(dir), true);
  assert.equal(JSON.parse(await readFile(path, "utf-8")).quietStartup, true);

  await writeFile(path, "{broken", "utf-8");
  await assert.rejects(() => ensureQuietStartup(dir), /Could not parse Pi settings/);
});
