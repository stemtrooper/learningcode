#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MODEL_ID,
	PI_AGENT_DIR_ENV,
	PROVIDER_ID,
	REQUIRED_NODE,
	TOKEN_ENV,
	UserError,
	agentDir,
	compareVersions,
	sparkBaseUrl,
} from "../lib/config.mjs";
import { GO_PROVIDER, saveProviderKey } from "../lib/auth.mjs";
import { ensureSparkProvider, modelsPath, retargetProvider } from "../lib/models.mjs";
import { ensureThemes, preferredTheme } from "../lib/themes.mjs";
import { hasToken, looksLikeToken, resolveToken, writeCachedToken } from "../lib/token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const OWN_FLAGS = new Set(["--help", "-h", "--version", "-v", "--login", "--show-config"]);
const OWN_FLAGS_WITH_VALUE = new Set(["--token", "--base-url"]);

const HELP = `learningcode - TLC Spark coding agent

Usage
  learningcode [options] [pi options] [@files...] [message...]

Setup
  --token <tok>      Use this Spark token instead of the cached one
  --base-url <url>   Point TLC-Spark at a different Spark deployment
  --login            Re-enter and cache your Spark token
  --show-config      Print resolved paths and settings, then exit
  -h, --help         Show this help
  -v, --version      Show version

Everything else is passed straight through to Pi, so the usual flags work:

  learningcode -c                     continue the last session
  learningcode -p "explain main.py"   one-shot, non-interactive
  learningcode --mode json            machine-readable event stream
  learningcode --list-models          every model Pi can reach

Other providers
  Any --model other than tlc-spark/... skips the Spark token and the Spark
  health check, so you can work without a token or while Spark is down:

  export OPENCODE_API_KEY=...
  learningcode --model opencode-go/glm-5.3-flash
  learningcode --list-models opencode

Environment
  LEARNINGCODE_DIR            agent directory (default ~/.learningcode/agent)
  LEARNINGCODE_SPARK_BASE_URL default https://spark.learning.com.my/v1
  LEARNINGCODE_TOKEN          Spark token, skips the cached file
  LEARNINGCODE_PI_FLAGS       extra flags appended to every Pi launch
  OPENCODE_API_KEY            auth for the opencode-go / opencode-zen providers
  ${PI_AGENT_DIR_ENV}  set automatically; points Pi at the learningcode agent dir
`;

/** Split our flags from the ones meant for Pi. */
function parseArgs(argv) {
	const own = { help: false, version: false, login: false, showConfig: false };
	const toPi = [];
	let explicitToken;
	let baseUrl;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (OWN_FLAGS.has(arg)) {
			if (arg === "--help" || arg === "-h") own.help = true;
			if (arg === "--version" || arg === "-v") own.version = true;
			if (arg === "--login") own.login = true;
			if (arg === "--show-config") own.showConfig = true;
			continue;
		}

		if (OWN_FLAGS_WITH_VALUE.has(arg)) {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) {
				fail(`${arg} requires a value.`);
			}
			i += 1;
			if (arg === "--token") explicitToken = value;
			if (arg === "--base-url") baseUrl = value;
			continue;
		}

		// Support --token=value / --base-url=value.
		const eq = arg.indexOf("=");
		if (arg.startsWith("--") && eq > 0) {
			const name = arg.slice(0, eq);
			if (OWN_FLAGS_WITH_VALUE.has(name)) {
				if (name === "--token") explicitToken = arg.slice(eq + 1);
				if (name === "--base-url") baseUrl = arg.slice(eq + 1);
				continue;
			}
		}

		toPi.push(arg);
	}

	return { own, toPi, explicitToken, baseUrl };
}

/** The model spec the caller asked for, in either `--model X` or `--model=X` form. */
function readModel(toPi) {
	for (let i = 0; i < toPi.length; i += 1) {
		if (toPi[i] === "--model" && toPi[i + 1]) return toPi[i + 1];
		if (toPi[i].startsWith("--model=")) return toPi[i].slice("--model=".length);
	}
	return undefined;
}

/**
 * Fail early and legibly on an unsupported Node.
 *
 * `engines` in package.json only makes npm warn, and a warning scrolls past on
 * a lab machine. The install then succeeds and Pi dies somewhere deep in its own
 * start-up with a stack trace, which tells a student nothing. Set
 * LEARNINGCODE_SKIP_NODE_CHECK=1 to bypass if the machine genuinely works.
 */
function checkNodeVersion() {
	if (process.env.LEARNINGCODE_SKIP_NODE_CHECK === "1") return;
	const running = process.versions.node;
	if (compareVersions(running, REQUIRED_NODE) >= 0) return;

	throw new UserError(
		`Node ${REQUIRED_NODE} or newer is required; this is Node ${running}.\n` +
			"  winget upgrade --id OpenJS.NodeJS.22\n" +
			"  (or download the LTS build from nodejs.org)\n" +
			"  Then reinstall: npm i -g @stemtrooper/learningcode",
	);
}

function fail(message, code = 1) {
	process.stderr.write(`learningcode: ${message}\n`);
	process.exit(code);
}

/**
 * Locate Pi's bundled CLI entry. Going through the resolved package entry keeps
 * this working on Windows, where the .bin shim is a .cmd file that cannot be
 * spawned directly without a shell.
 *
 * Must use `import.meta.resolve`: the published package declares only an
 * `import` condition in its exports map, so `require.resolve` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
function resolvePiEntry() {
	const candidates = [];

	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		candidates.push(join(dirname(entry), "bundle", "cli.js"));
	} catch {
		/* fall through to the node_modules walk below */
	}

	// Walk up from this file in case resolution was blocked (odd global layouts,
	// pnpm-style stores, a bundled single-file install).
	let dir = here;
	for (let depth = 0; depth < 8; depth += 1) {
		candidates.push(
			join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
		);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Non-fatal reachability probe so students get a useful message, not a stack trace. */
async function checkEndpoint(baseUrl, token) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (response.ok) return { ok: true };
		if (response.status === 401) return { ok: false, reason: "token rejected (401)" };
		return { ok: false, reason: `HTTP ${response.status}` };
	} catch (error) {
		const reason = error?.name === "AbortError" ? "timed out after 5s" : error?.message;
		return { ok: false, reason };
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const { own, toPi, explicitToken, baseUrl } = parseArgs(argv);

	if (own.help) {
		process.stdout.write(HELP);
		return;
	}

	const { version } = require("../package.json");
	if (own.version) {
		process.stdout.write(`${version}\n`);
		return;
	}

	checkNodeVersion();

	const dir = agentDir();
	const piEntry = resolvePiEntry();
	if (!piEntry) {
		fail(
			"could not locate @earendil-works/pi-coding-agent.\n" +
				"Reinstall with: npm i -g @stemtrooper/learningcode",
		);
	}

	if (baseUrl) {
		await ensureSparkProvider(dir).catch(() => {});
		await retargetProvider(dir, baseUrl);
	}
	await ensureSparkProvider(dir);
	await ensureThemes(dir);

	// `--login` forces a fresh paste even when a token is already cached.
	const forced = [];
	const requestedModel = readModel(toPi);
	const effectiveModel = requestedModel ?? `${PROVIDER_ID}/${MODEL_ID}`;
	if (!requestedModel) forced.push("--model", effectiveModel);

	// Default to the TLC theme, but never override an explicit choice: --theme on
	// the command line, or LEARNINGCODE_THEME in the environment.
	const userPickedTheme = toPi.some(
		(arg) => arg === "--theme" || arg.startsWith("--theme="),
	);
	if (!userPickedTheme && !process.env.LEARNINGCODE_THEME) {
		forced.push("--theme", preferredTheme());
	}

	// Spark enforces one active generation per student, so subagents and parallel
	// tool calls would only earn 429s. Pi is serial by default; skills and rules
	// are pure prompt-token spend against a 32K ceiling, so they stay off.
	forced.push("--no-skills");
	forced.push("--extension", join(here, "..", "extensions", "spark-quota.ts"));
	forced.push("--extension", join(here, "..", "extensions", "footer.ts"));
	forced.push("--extension", join(here, "..", "extensions", "banner.ts"));
	if (process.env.LEARNINGCODE_PI_FLAGS) {
		forced.push(...process.env.LEARNINGCODE_PI_FLAGS.split(/\s+/).filter(Boolean));
	}

	// Everything Spark-specific is skipped when another provider is selected, so
	// `learningcode --model opencode-go/...` keeps working while Spark or your RunPod
	// is down, and without holding a token. `--list-models` only enumerates what Pi
	// can reach and makes no request, so it never needs a Spark token either.
	const listsModels = toPi.includes("--list-models") || toPi.some((arg) => arg.startsWith("--list-models="));
	const usesSpark = !listsModels && effectiveModel.startsWith(`${PROVIDER_ID}/`);
	let token;
	let tokenSource = "not required";

	if (usesSpark) {
		// With no token anywhere, a bare `learningcode` opens a prompt that looks like a
		// dead end. Name the hosted escape hatch before asking.
		if (!(await hasToken(dir, own.login ? undefined : explicitToken))) {
			process.stderr.write(
				"No Spark token configured, defaulting to " +
					`${PROVIDER_ID}/${MODEL_ID}.\n` +
					"  Using OpenCode Go instead?  learningcode --model opencode-go/glm-5.3-flash\n" +
					"  Full list:               learningcode --list-models opencode-go\n",
			);
		}

		const resolved = await resolveToken(dir, own.login ? undefined : explicitToken);
		token = resolved.token;
		tokenSource = resolved.source;

		if (!looksLikeToken(token)) {
			process.stderr.write(
				'learningcode: warning - token does not start with "spark_live_"; ' +
					"it may not be a Spark token.\n",
			);
		}
		if (resolved.shouldCache) await writeCachedToken(dir, token);
	} else if (explicitToken) {
		process.stderr.write(
			`learningcode: --token only applies to ${PROVIDER_ID}; ignoring it for ${effectiveModel}.\n`,
		);
	}

	if (own.showConfig) {
		process.stdout.write(
			`version      ${version}\n` +
				`agent dir    ${dir}\n` +
				`models.json  ${modelsPath(dir)}\n` +
				`model        ${effectiveModel}\n` +
				`spark base   ${sparkBaseUrl()}\n` +
				`spark token  ${token ? `${token.slice(0, 12)}... (from ${tokenSource})` : "not required"}\n` +
				`pi entry     ${piEntry}\n`,
		);
		return;
	}

	if (usesSpark) {
		const health = await checkEndpoint(sparkBaseUrl(), token);
		if (!health.ok) {
			process.stderr.write(
				`learningcode: warning - Spark at ${sparkBaseUrl()} is not answering (${health.reason}).\n` +
					"Continuing anyway; check your network or token if the first request fails.\n",
			);
		}
	}

	const childEnv = { ...process.env };

	// Pi reads provider credentials from auth.json before the environment, and
	// auth.json is keyed per provider. Storing the key under opencode-go alone
	// authenticates Go while leaving Zen credential-less, so its 111 pay-per-use
	// models never register. Zen and Go otherwise share OPENCODE_API_KEY, so
	// leaving the env var in place would expose both.
	const goKey = process.env.LEARNINGCODE_GO_KEY || process.env.OPENCODE_API_KEY;
	if (goKey && process.env.LEARNINGCODE_ALLOW_ZEN !== "1") {
		await saveProviderKey(dir, GO_PROVIDER, goKey);
		delete childEnv.OPENCODE_API_KEY;
		delete childEnv.LEARNINGCODE_GO_KEY;
	} else if (goKey) {
		process.stderr.write(
			"learningcode: LEARNINGCODE_ALLOW_ZEN=1 exposes OpenCode Zen, which bills per token.\n",
		);
	}

	const child = spawn(process.execPath, [piEntry, ...forced, ...toPi], {
		stdio: "inherit",
		env: {
			...childEnv,
			[PI_AGENT_DIR_ENV]: dir,
			SPARK_BASE_URL: sparkBaseUrl(),
			// Unset rather than empty when not on Spark: Pi treats an empty key as
			// configured for some providers, which would shadow the Go credential.
			...(token ? { [TOKEN_ENV]: token } : {}),
		},
	});

	// Forward interrupts so Ctrl+C in the terminal reaches Pi rather than
	// orphaning it behind this wrapper.
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => child.kill(signal));
	}

	child.on("error", (error) => fail(`failed to start Pi: ${error.message}`));
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

main().catch((error) => {
	// Anything the user can act on gets one line. A stack trace is noise for a
	// student who mistyped a token; keep it for genuine bugs.
	fail(error instanceof UserError ? error.message : error?.stack || String(error));
});