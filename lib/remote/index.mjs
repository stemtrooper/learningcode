import { hostname } from "node:os";
import { createRequire } from "node:module";
import {
	PROVIDER_ID,
	MODEL_ID,
	UserError,
	agentDir,
} from "../config.mjs";
import { agentEnvironment, forcedPiArgs, resolvePiEntry } from "../pi.mjs";
import { resolveToken } from "../token.mjs";
import { GO_PROVIDER, saveProviderKey } from "../auth.mjs";
import { ensureSparkProvider } from "../models.mjs";
import { PiRpcAdapter } from "./agent.mjs";
import { RemoteBridge } from "./bridge.mjs";
import { RemoteServer } from "./server.mjs";
import {
	ensureRemoteIdentity,
	phoneUrl,
	projectName,
	readRemoteState,
	remoteEnrollKey,
	remoteServerUrl,
	rotateRemoteToken,
	writeRemoteState,
} from "./config.mjs";
import { pairingCode } from "./tokens.mjs";

/**
 * Orchestration for the remote feature: the three commands a student actually
 * types (`learningcode remote`, `remote status`, `remote stop`) plus the
 * development server. Each one is small on purpose; the real work lives in the
 * modules beside this file.
 */

// Resolved from this file rather than a cd-relative "..", so it works the same
// whether learningcode runs from a global prefix or a repo checkout.
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

/**
 * Options for runRemote:
 *   cwd         project directory the agent works in (default process.cwd())
 *   serverUrl   relay server ws:// endpoint (default LEARNINGCODE_REMOTE_SERVER)
 *   enrollKey   enrolment key from whoever runs the server
 *   dir         learningcode agent directory
 *   resume      continue this project's most recent Pi conversation
 *   log         where operator-facing lines go (default stderr)
 */

/**
 * Run `learningcode remote`: start the agent, connect out to the server, and
 * stay connected until the student stops it.
 */
export async function runRemote(options = {}) {
	const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
	const dir = options.dir ?? agentDir();
	const cwd = options.cwd ?? process.cwd();
	const serverUrl = (options.serverUrl ?? remoteServerUrl()).replace(/\/agent\/?$/, "") + "/agent";
	const enrollKey = options.enrollKey ?? remoteEnrollKey();

	// Same preparation the launcher does before spawning Pi, minus the TUI-only
	// bits: the provider must exist in models.json and the token must resolve.
	await ensureSparkProvider(dir).catch(() => {});
	const cliPath = resolvePiEntry();
	if (!cliPath) {
		throw new UserError(
			"could not locate @earendil-works/pi-coding-agent.\n" +
				"Reinstall with: npm i -g @stemtrooper/learningcode",
		);
	}

	const identity = await ensureRemoteIdentity(dir);
	if (options.enrollKey === undefined && !enrollKey) {
		// Say this once, clearly, instead of letting the server answer with a
		// 401 the student cannot act on.
		throw new UserError(
			"No remote server enrolment key configured.\n" +
				"  Ask whoever runs the server for the key, then:\n" +
				"    LEARNINGCODE_REMOTE_KEY=… learningcode remote\n" +
				"  or run your own: learningcode remote-server",
		);
	}

	// resolveToken returns { token, source }, not the token itself: the launcher
	// unpacks it for the same reason. Storing the whole object makes Pi read an
	// auth.json value it cannot parse, which fails the first turn rather than
	// the first command.
	const { token } = await resolveToken(dir);
	const model = `${PROVIDER_ID}/${MODEL_ID}`;

	// Same reasoning as the launcher (bin/learningcode.mjs): Pi prefers a stored
	// credential in auth.json over the $SPARK_API_KEY the provider config names,
	// so without this the remote agent authenticates with nothing and every turn
	// fails before it starts.
	await saveProviderKey(dir, PROVIDER_ID, token);

	const agent = new PiRpcAdapter({
		cliPath,
		cwd,
		env: agentEnvironment({ dir, token }),
		// RPC mode replaces the TUI; theme flags would be rejected there.
		args: [
			"--mode",
			"rpc",
			...forcedPiArgs({
				model,
				theme: null,
				extraFlags: options.resume ? ["--continue"] : [],
			}),
		],
	});

	const bridge = new RemoteBridge({
		serverUrl,
		sessionId: identity.sessionId,
		token: identity.token,
		enrollKey,
		meta: {
			name: projectName(cwd),
			cwd,
			platform: `${process.platform} ${hostname()}`.slice(0, 120),
			version,
		},
		agent,
		log,
	});

	// The state file is what status/stop read, so it exists before anything can
	// go wrong, and it names the session to rejoin on the next run.
	await writeRemoteState(dir, {
		sessionId: identity.sessionId,
		serverUrl,
		cwd,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await bridge.stop().catch(() => {});
		await agent.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Without this, ctrl+C during a prompt hangs a student waiting for a
	// terminal that will never return.
	bridge.on("stop-requested", () => shutdown());

	const state = await agent.start().catch((error) => {
		throw new UserError(`the agent would not start: ${error.message}`);
	});
	bridge.on("status", (status) => {
		if (status.online) {
			log(
				`remote: connected, ${status.phones} phone${status.phones === 1 ? "" : "s"} attached` +
					(status.queued ? `, ${status.queued} queued` : ""),
			);
		} else if (!status.lastError) {
			log("remote: disconnected, reconnecting");
		}
	});
	await bridge.start();

	const url = phoneUrl(serverUrl, identity.sessionId, identity.token);
	const code = pairingCode(identity.sessionId);
	log("");
	log(`  learningcode remote is live: ${state.sessionName || projectName(cwd)}`);
	log(`  Open on your phone: ${url}`);
	log(`  Pairing code:        ${code}`);
	log("  Ctrl+C to stop.");
	log("");

	return { bridge, agent, url, code, sessionId: identity.sessionId };
}

/** `learningcode remote status` — read the state file and say what is true. */
export async function remoteStatus() {
	const dir = agentDir();
	const state = await readRemoteState(dir);
	if (!state) {
		process.stdout.write("No remote session yet. Run `learningcode remote` first.\n");
		return null;
	}
	const running = processAlive(state.pid);
	process.stdout.write(
		[
			`session      ${state.sessionId}`,
			`project      ${projectName(state.cwd ?? "")}`,
			`directory    ${state.cwd ?? "?"}`,
			`server       ${state.serverUrl}`,
			`status       ${running ? `running (pid ${state.pid})` : "not running"}`,
			`started      ${state.startedAt ?? "?"}`,
			`phone link is printed when you run \`learningcode remote\``,
		].join("\n") + "\n",
	);
	return state;
}

/**
 * `learningcode remote stop`.
 *
 * Signals the process recorded in the state file rather than killing by name:
 * a student may have more than one learningcode running, and only the one that
 * wrote this state file owns the remote session.
 */
export async function remoteStop() {
	const dir = agentDir();
	const state = await readRemoteState(dir);
	if (!state) throw new UserError("No remote session to stop. Run `learningcode remote` first.");

	if (!processAlive(state.pid)) {
		process.stdout.write(`Remote session is not running (recorded pid ${state.pid} is gone).\n`);
		return false;
	}
	if (state.pid === process.pid) {
		// Called from inside the remote process: stop ourselves without
		// signalling our own pid.
		process.kill(process.pid, "SIGTERM");
	}
	try {
		process.kill(state.pid, "SIGTERM");
	} catch (error) {
		throw new UserError(`Could not stop pid ${state.pid}: ${error.message}`);
	}
	process.stdout.write(`Stopping remote session ${state.sessionId} (pid ${state.pid}).\n`);
	return true;
}

/** `learningcode remote --rotate` — invalidate every phone link at once. */
export async function rotateRemote() {
	const identity = await rotateRemoteToken(agentDir());
	process.stdout.write("A new phone token is in place; old links no longer work.\n");
	process.stdout.write("  Pairing code: " + pairingCode(identity.sessionId) + "\n");
	return identity;
}

/**
 * `learningcode remote-server` — the development server.
 *
 * Prints the key to pass to the computer, because a server that silently
 * accepts any enrolment is the kind of thing that gets deployed by accident.
 */
export async function runRemoteServer(options = {}) {
	const server = new RemoteServer({
		port: options.port ?? Number(process.env.LEARNINGCODE_REMOTE_PORT || 8787),
		host: options.host ?? (process.env.LEARNINGCODE_REMOTE_HOST || "127.0.0.1"),
		stateFile: options.stateFile ?? (process.env.LEARNINGCODE_REMOTE_STATE || join(process.cwd(), "remote-sessions.json")),
		enrollKey: process.env.LEARNINGCODE_REMOTE_KEY || "",
	});
	await server.listen();
	const { agentUrl, uiUrl } = server.address();

	process.stdout.write(`\n  learningcode remote server\n`);
	process.stdout.write(`    ui:    ${uiUrl}\n`);
	process.stdout.write(`    agent: ${agentUrl}\n`);
	process.stdout.write(`    key:   ${server.enrolmentKey()}\n\n`);
	process.stdout.write("  On the student's computer:\n");
	process.stdout.write(`    LEARNINGCODE_REMOTE_SERVER=${agentUrl} \\\n`);
	process.stdout.write(`    LEARNINGCODE_REMOTE_KEY=${server.enrolmentKey()} learningcode remote\n\n`);

	const shutdown = async () => {
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return server;
}

// State lives in lib/remote/config.mjs beside the reader, so the record's shape
// has exactly one home.

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
