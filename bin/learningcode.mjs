#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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
import { GO_PROVIDER, loggedInProviders, saveProviderKey, visibleModelPatterns } from "../lib/auth.mjs";
import { doctorReport } from "../lib/doctor.mjs";
import {
	TOKENHARBOR_PROVIDER,
	ensureTokenHarborProvider,
	looksLikeTokenHarborKey,
} from "../lib/tokenharbor.mjs";
import { ensureSparkProvider, modelsPath, retargetProvider } from "../lib/models.mjs";
import { ensureQuietStartup, persistedModelPrefs, scopeCoversProvider, seedModelPrefs, writeEnabledModels } from "../lib/settings.mjs";
import { ensureThemes, preferredTheme } from "../lib/themes.mjs";
import { hasToken, looksLikeToken, promptSecret, resolveToken, writeCachedToken } from "../lib/token.mjs";
import { agentEnvironment, forcedPiArgs, resolvePiEntry } from "../lib/pi.mjs";
import { remoteStatus, remoteStop, rotateRemote, runRemote, runRemoteServer } from "../lib/remote/index.mjs";
import { formatNotice, markNoticeShown, pendingNotice } from "../lib/changelog.mjs";

const require = createRequire(import.meta.url);

const OWN_FLAGS = new Set(["--help", "-h", "--version", "-v", "--login", "--show-config"]);
const OWN_FLAGS_WITH_VALUE = new Set(["--token", "--base-url", "--login-provider"]);
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
  learningcode --verbose              show Pi's startup header and resource list

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

Remote
  learningcode remote         continue this project's session from your phone
  learningcode remote help    how the phone side works
`;

/** Split our flags from the ones meant for Pi. */
function parseArgs(argv) {
	const own = { help: false, version: false, login: false, showConfig: false, loginProvider: null };
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
			if (arg === "--login-provider") own.loginProvider = value;
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

/** Extra Pi flags the student exports for their machine, on every launch. */
/**
 * The catalogue Pi knows, as `pi --list-models` prints it. No request is made.
 * Empty on failure, so the picker falls back to Pi's default rather than failing
 * the launch.
 */
function piModelListing(piEntry, dir) {
	const result = spawnSync(process.execPath, [piEntry, "--list-models"], {
		encoding: "utf-8",
		timeout: 20000,
		// Same agent folder as the real session, so models.json (TLC-Spark,
		// TokenHarbor) is visible to the listing.
		env: { ...process.env, ...agentEnvironment({ dir, token: null }) },
	});
	return result.status === 0 ? result.stdout : "";
}
function extraPiFlags() {
	const raw = process.env.LEARNINGCODE_PI_FLAGS;
	return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

const REMOTE_HELP = `learningcode remote - control this session from your phone

Usage
  learningcode remote [--resume]     run everything here and open the phone link
                                     through Cloudflare (the default)
  learningcode remote --server <url> --key <key>
                                     connect this directory to a hosted relay
  learningcode remote status         what is running, and where
  learningcode remote stop           stop the remote session
  learningcode remote rotate         invalidate every phone link, mint a new one
  learningcode remote-server         run the relay server for local development

Options
  --serve             start the relay inside this process, so there is no key
                      to copy and no second terminal. The phone link it prints
                      already points at this computer.
  --no-tunnel         keep the relay on your own wifi only (no Cloudflare)
  --tunnel            same as the default; kept so old instructions still work.
                      Needs cloudflared (winget install --id Cloudflare.cloudflared),
                      downloaded once on first run.
  --port <n>          relay port (default 8787)
  --resume            continue this project's most recent conversation instead
                      of starting a new one
  --server <url>      relay server, e.g. ws://school.example:8787/agent
                      (default: $LEARNINGCODE_REMOTE_SERVER)
  --key <key>         enrolment key from whoever runs the server
                      (default: $LEARNINGCODE_REMOTE_KEY)

The computer opens the connection to the server; nothing is exposed inbound.
The phone link, with a per-session token, is printed when you start.

Environment
  LEARNINGCODE_REMOTE_SERVER  relay server URL
  LEARNINGCODE_REMOTE_KEY     enrolment key
  LEARNINGCODE_REMOTE_HOST    server bind host (remote-server, default 127.0.0.1)
  LEARNINGCODE_REMOTE_PORT    server bind port (remote-server, default 8787)
  LEARNINGCODE_REMOTE_STATE   where the server keeps its registry
`;

/**
 * Parse `learningcode remote …` into a call.
 *
 * Returns null when the first argument is not a remote command, so the normal
 * launcher path is untouched for everything else. Subcommands are words
 * (`status`, `stop`) so a student typing `learningcode remote stop` does not
 * have to remember a flag.
 */
function parseRemoteCommand(argv) {
	if (argv[0] !== "remote" && argv[0] !== "remote-server") return null;

	const flags = {};
	const words = [];
	const rest = argv.slice(1);
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq > 0) {
				flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else if (rest[i + 1] && !rest[i + 1].startsWith("-")) {
				flags[arg.slice(2)] = rest[i + 1];
				i += 1;
			} else {
				flags[arg.slice(2)] = true;
			}
		} else {
			words.push(arg);
		}
	}
	return { command: argv[0], subcommand: words[0] ?? null, flags };
}

async function runRemoteCommand({ command, subcommand, flags }) {
	if (flags.help || flags.h || (command === "remote" && !subcommand && flags.server === undefined && false)) {
		process.stdout.write(REMOTE_HELP);
		return;
	}

	if (command === "remote-server") {
		await runRemoteServer({
			port: flags.port ? Number(flags.port) : undefined,
			host: flags.host,
		});
		return;
	}

	switch (subcommand) {
		case "help":
			process.stdout.write(REMOTE_HELP);
			return;
		case "status":
			await remoteStatus();
			return;
		case "stop":
			await remoteStop();
			return;
		case "rotate":
			await rotateRemote();
			return;
		case null: {
			// With no relay named anywhere, run the relay here and open it through
			// Cloudflare: one command, phone works from any network. A named relay
			// (--server/--key or the env vars) means the hosted path instead.
			const hostedRelay = Boolean(
				flags.server !== undefined ||
					flags.key !== undefined ||
					process.env.LEARNINGCODE_REMOTE_SERVER ||
					process.env.LEARNINGCODE_REMOTE_KEY,
			);
			const local = !hostedRelay && !flags.serve;
			const tunnel = Boolean(flags.tunnel) || (local && flags["no-tunnel"] !== true);
			await runRemote({
				cwd: process.cwd(),
				serverUrl: flags.server,
				enrollKey: flags.key,
				resume: Boolean(flags.resume),
				serve: Boolean(flags.serve) || local,
				tunnel,
				port: flags.port ? Number(flags.port) : undefined,
				host: flags.host,
			});
			return;
		}
		default:
			fail(`unknown remote subcommand: ${subcommand}\nRun \`learningcode remote help\`.`);
	}
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

	// Remote runs before the launcher's own flag parsing: it has its own
	// grammar, and everything it does happens instead of an interactive session.
	const remoteCommand = parseRemoteCommand(argv);
	if (remoteCommand) {
		await runRemoteCommand(remoteCommand);
		return;
	}

	// learningcode doctor: a read-only health check. Never prints a key.
	if (argv[0] === "doctor") {
		const checkSpark = async (url) => {
			const token = (await resolveToken(agentDir())).token;
			return checkEndpoint(url, token);
		};
		process.stdout.write(await doctorReport({ checkSpark }));
		return;
	}

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

	// Once per upgrade, and only for an interactive session. The notice is handed
	// to the TUI (extensions/whats-new.ts) so it lands in the chat after the
	// banner, where it can be read, instead of being printed before Pi draws over it.
	const interactive = process.stdout.isTTY && !toPi.includes("-p") && !toPi.includes("--print") && !toPi.includes("--mode");
	let whatsNew = "";
	if (interactive) {
		const notice = await pendingNotice(version, dir);
		if (notice) {
			whatsNew = formatNotice(notice);
			await markNoticeShown(version, dir);
		}
	}

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
	await ensureTokenHarborProvider(dir).catch(() => {});
	await ensureThemes(dir);
	await ensureQuietStartup(dir);

	// `--login` forces a fresh paste even when a token is already cached.
	const requestedModel = readModel(toPi);
	const persistedEarly = await persistedModelPrefs(dir);
	const effectiveModel = requestedModel ?? persistedEarly.defaultModel ?? `${PROVIDER_ID}/${MODEL_ID}`;
	// Default to the TLC theme without overriding an explicit CLI choice.
	// LEARNINGCODE_THEME flows through preferredTheme(), so it becomes the
	// forced value rather than suppressing it. NB: Pi's --theme loads a theme
	// *file or directory*, while --use-theme selects a theme *by name*.
	// Passing "tlc-dark" to --theme made Pi warn "[Theme conflicts] ...
	// theme path does not exist" on every login, so the name goes to
	// --use-theme.
	const userPickedTheme = toPi.some(
		(arg) =>
			arg === "--theme" ||
			arg.startsWith("--theme=") ||
			arg === "--use-theme" ||
			arg.startsWith("--use-theme="),
	);

	// Spark enforces one active generation per student, so subagents and parallel
	// tool calls would only earn 429s. Pi is serial by default; skills and rules
	// are pure prompt-token spend against a 32K ceiling, so they stay off.
	// The model, theme, skills and extension flags are shared with
	// `learningcode remote` through lib/pi.mjs, so a remote session cannot drift
	// from an interactive one.
	// Only providers with a stored key (or env var) appear in /model. A student who
	// passed their own --model or --models keeps exactly what they asked for.
	// Persisted prefs (`defaultModel` via `/model` Ctrl+S, `enabledModels` via
	// `/scoped-models`) win over our defaults: forcing `--model`/`--models` on
	// every launch is what made the picker forget the student's scope.
	const userPickedModels = toPi.some((arg) => arg === "--models" || arg.startsWith("--models="));
	const persisted = persistedEarly;
	const loggedIn = await loggedInProviders(dir);
	let scope = null;
	if (!requestedModel && !userPickedModels) {
		if (persisted.enabledModels) {
			// A newly logged-in provider would otherwise stay hidden behind the
			// old seed, so extend the persisted scope instead of overriding it.
			const uncovered = [...loggedIn].filter((p) => !scopeCoversProvider(persisted.enabledModels, p));
			if (uncovered.length) {
				const fresh = visibleModelPatterns(piModelListing(piEntry, dir), loggedIn);
				if (fresh) {
					const merged = [...persisted.enabledModels];
					for (const pattern of fresh) {
						if (uncovered.includes(pattern.split("/")[0]) && !merged.includes(pattern)) merged.push(pattern);
					}
					await writeEnabledModels(dir, merged);
				}
			}
		} else {
			scope = visibleModelPatterns(piModelListing(piEntry, dir), loggedIn);
			if (scope) await seedModelPrefs(dir, { enabledModels: scope });
		}
	}
	if (!requestedModel && !persisted.defaultModel) {
		await seedModelPrefs(dir, { defaultModel: `${PROVIDER_ID}/${MODEL_ID}` });
	}

	const forced = forcedPiArgs({
		model: undefined,
		scope,
		theme: userPickedTheme ? null : preferredTheme(),
		extraFlags: extraPiFlags(),
	});

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
		// Keep Pi's stored credential and the environment in step. See the note
		// beside saveProviderKey below.
		await saveProviderKey(dir, PROVIDER_ID, token);
		if (resolved.shouldCache) await writeCachedToken(dir, token);
	} else if (explicitToken) {
		process.stderr.write(
			`learningcode: --token only applies to ${PROVIDER_ID}; ignoring it for ${effectiveModel}.\n`,
		);
	}

	// `learningcode --login-provider tokenharbor`: store a provider key so its
	// models appear in the picker. Only providers with a stored key are shown.
	if (own.loginProvider) {
		const provider = own.loginProvider.toLowerCase();
		if (provider !== TOKENHARBOR_PROVIDER) {
			fail(`no login set up for "${own.loginProvider}". Available: ${TOKENHARBOR_PROVIDER}`);
		}
		await ensureTokenHarborProvider(dir);
		process.stdout.write("Get a thk_ key at https://tokenharbor.ai/dashboard/api-keys (a free account works).\n");
		const key = (await promptSecret("TokenHarbor key (thk_...): ")).trim();
		if (!looksLikeTokenHarborKey(key)) {
			fail("that does not look like a TokenHarbor key (they start with thk_). Nothing was saved.");
		}
		await saveProviderKey(dir, TOKENHARBOR_PROVIDER, key);
		process.stdout.write("Saved. TokenHarbor models now appear in /model.\n");
		return;
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

	// Pi prefers a stored credential in auth.json over the `$SPARK_API_KEY` the
	// provider config names, so leaving the token only in the environment lets the
	// two drift apart: Pi authenticates with whatever auth.json holds while the
	// /quota and /seats commands read the environment, and a stale entry then shows
	// up as a 401 on those two but not on completions. Writing the token to
	// auth.json as well makes every path use the same value whichever Pi prefers.
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
			// Shared with `learningcode remote`: the agent dir and the Spark
			// token travel the same way whichever mode starts the agent.
			...agentEnvironment({ dir, token }),
			LEARNINGCODE_NOTICE: whatsNew,
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
