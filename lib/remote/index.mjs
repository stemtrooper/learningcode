import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
	PROVIDER_ID,
	MODEL_ID,
	UserError,
	agentDir,
} from "../config.mjs";
import { agentEnvironment, forcedPiArgs, resolvePiEntry } from "../pi.mjs";
import { resolveToken } from "../token.mjs";
import { GO_PROVIDER, loggedInProviders, saveProviderKey } from "../auth.mjs";
import { ensureSparkProvider } from "../models.mjs";
import { PiRpcAdapter } from "./agent.mjs";
import { RemoteBridge } from "./bridge.mjs";
import { RemoteServer } from "./server.mjs";
import {
	ensureRemoteIdentity,
	phoneUrl,
	projectName,
	readRemoteState,
	readRememberedModel,
	rememberModel,
	remoteEnrollKey,
	remoteServerUrl,
	rotateRemoteToken,
	writeRemoteState,
} from "./config.mjs";
import { ensureCloudflared } from "./cloudflared.mjs";
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
 * Print a link as a QR code a phone camera can read.
 *
 * The text link is printed too, under the code, because a camera can fail on
 * a dim screen or a glare, and a student must never be stuck with no way in.
 */
export async function printQr(text, log = (line) => process.stderr.write(`${line}\n`)) {
	try {
		const { default: qrcode } = await import("qrcode-terminal");
		await new Promise((resolve) => {
			qrcode.generate(text, { small: true }, (code) => {
				for (const line of code.split("\n")) log(`  ${line}`);
				resolve();
			});
		});
	} catch {
		log("  (QR code unavailable on this terminal; use the link below)");
	}
}

/**
 * Pick the address a phone on the same network can actually reach.
 *
 * First LAN address that is not carrier-grade NAT; loopback only when nothing
 * else exists, because a link the phone cannot open is worse than no link.
 */
export function publicIp(nets = networkInterfaces()) {
	const candidates = [];
	for (const addrs of Object.values(nets ?? {})) {
		for (const address of addrs ?? []) {
			if (address?.family !== "IPv4" || address.internal) continue;
			candidates.push(address.address);
		}
	}
	const lan = candidates.find((ip) => !ip.startsWith("100."));
	return lan ?? candidates[0] ?? "127.0.0.1";
}

/**
 * Open a Cloudflare quick tunnel to the relay, so a phone anywhere on the
 * internet reaches it without port forwarding, a public IP, or an account.
 *
 * cloudflared must be on PATH (`winget install --id Cloudflare.cloudflared`).
 * Resolves with the public https URL once cloudflared prints it.
 */
export async function startTunnel(port, log = () => {}, binary = null) {
	const { spawn } = await import("node:child_process");
	let program = binary;
	if (!program) {
		try {
			program = await ensureCloudflared({ onStatus: log });
		} catch (error) {
			throw new UserError(
				`could not set up cloudflared: ${error.message}\n` +
					"  Retry when you are online, or run without --tunnel: the phone link then works on your own wifi.",
			);
		}
	}
	return new Promise((resolve, reject) => {
		const child = spawn(program, ["tunnel", "--url", `http://127.0.0.1:${port}`], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let settled = false;
		const done = (error, url) => {
			if (settled) return;
			settled = true;
			if (error) {
				child.kill();
				reject(error);
			} else {
				resolve({ process: child, url });
			}
		};
		child.on("error", (error) => {
			done(new UserError(`cloudflared would not start: ${error.message}`));
		});
		child.stderr.on("data", (chunk) => {
			if (settled) return;
			output += chunk.toString();
			const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
			if (match) {
				log(`remote: tunnel is live at ${match[0]}`);
				done(null, match[0]);
			}
		});
		child.on("exit", (code) => {
			done(new UserError(`cloudflared exited (code ${code ?? "?"}). Last lines:\n${output.slice(-500)}`));
		});
		setTimeout(() => done(new UserError("cloudflared took too long to open the tunnel.")), 30_000).unref?.();
	});
}

/**
 * Run `learningcode remote`: start the agent, connect out to the server, and
 * stay connected until the student stops it.
 */
export async function runRemote(options = {}) {
	const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
	const dir = options.dir ?? agentDir();
	const cwd = options.cwd ?? process.cwd();
	let serverUrl = (options.serverUrl ?? remoteServerUrl()).replace(/\/agent\/?$/, "") + "/agent";
	let enrollKey = options.enrollKey ?? remoteEnrollKey();
	let publicBase = "";
	let embeddedServer = null;

	// --tunnel implies --serve: the tunnel only makes sense when the relay it
	// opens to the internet runs in this same process.
	const serve = options.serve || options.tunnel;
	if (serve) {
		// One process owns both sides, so the enrolment key never travels through
		// a terminal, a chat message, or a student's memory: it is generated here
		// and handed to the bridge in the same breath.
		const port = options.port ?? Number(process.env.LEARNINGCODE_REMOTE_PORT || 8787);
		const host = options.host ?? (process.env.LEARNINGCODE_REMOTE_HOST || "0.0.0.0");
		embeddedServer = new RemoteServer({ port, host, enrollKey, stateFile: null });
		await embeddedServer.listen();
		const address = embeddedServer.address();
		serverUrl = address.agentUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${address.port}`);
		enrollKey = embeddedServer.enrolmentKey();
		publicBase = `http://${publicIp()}:${address.port}`;
	}

	let tunnel = null;
	if (options.tunnel) {
		// The phone link points at the tunnel; the bridge keeps dialling the
		// relay on loopback, which never leaves this machine.
		tunnel = await startTunnel(new URL(serverUrl).port, log);
		publicBase = tunnel.url;
	} else if (serve && process.platform === "win32") {
		log("remote: if your phone cannot reach this computer, allow Node.js through Windows Firewall (private networks).");
	}

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
	if (!serve && options.enrollKey === undefined && !enrollKey) {
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

	// Only providers the student has logged in to appear on the phone. The set is
	// read once at start, so a key added while remote runs takes effect on restart.
	const loggedIn = await loggedInProviders(dir);
	const bridge = new RemoteBridge({
		modelVisible: (model) => loggedIn.has(model.provider) || model.provider === PROVIDER_ID,
		onModelChanged: (choice) => rememberModel(dir, choice).catch((error) => log(`could not remember the model: ${error.message}`)),
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
		await embeddedServer?.close().catch(() => {});
		tunnel?.process.kill();
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
	// Put back the model the phone last chose. The agent only accepts pairs it
	// reports as available, so a model that has since disappeared falls back to
	// the default instead of failing the start.
	const remembered = await readRememberedModel(dir);
	if (remembered && (remembered.provider !== PROVIDER_ID || remembered.modelId !== MODEL_ID)) {
		await agent
			.setModel(remembered.provider, remembered.modelId)
			.catch(() => log(`kept the default model: ${remembered.modelId} is not available`));
	}
	await bridge.start();

	const url = phoneUrl(serverUrl, identity.sessionId, identity.token, publicBase);
	const code = pairingCode(identity.sessionId);
	log("");
	log(`  learningcode remote is live: ${state.sessionName || projectName(cwd)}`);
	log("  Scan this with your phone camera:");
	log("");
	await printQr(url, log);
	log("");
	log(`  Or open: ${url}`);
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
