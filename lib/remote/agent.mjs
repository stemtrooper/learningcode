import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

/**
 * The agent adapter: a thin, testable wrapper around Pi's RPC mode.
 *
 * Pi speaks JSON lines - one command object per line on stdin, one response or
 * event per line on stdout. This module knows that and nothing else; the bridge
 * above it only sees prompt/abort/messages/events.
 *
 * It exists instead of using the exported `RpcClient` for one reason, documented
 * in docs/remote.md: RpcClient's bundle spawns the literal program name "node",
 * which fails on Windows whenever Node is not on PATH. Spawning
 * `process.execPath` with the resolved bundle path is the same trick
 * bin/learningcode.mjs already uses, and it is the difference between working
 * and not on a lab machine.
 *
 * Method names mirror RpcClient on purpose, so swapping the implementation is a
 * one-line change if upstream fixes the spawn.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export class AgentError extends Error {}

export class PiRpcAdapter extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.cliPath Absolute path to Pi's bundle/cli.js
	 * @param {string} options.cwd Project directory the agent works in
	 * @param {NodeJS.ProcessEnv} options.env Environment for the child
	 * @param {string[]} [options.args] Extra Pi CLI arguments
	 * @param {(file: string, args: string[], opts: object) => any} [options.spawnImpl]
	 */
	constructor({ cliPath, cwd, env, args = [], spawnImpl = spawn }) {
		super();
		this.cliPath = cliPath;
		this.cwd = cwd;
		this.env = env;
		this.args = ["--mode", "rpc", ...args];
		this.spawnImpl = spawnImpl;
		this.child = null;
		this.pending = new Map();
		this.nextId = 0;
		this.buffer = "";
		this.stderr = "";
		this.ready = false;
	}

	/** Spawn the agent and resolve once it is accepting commands. */
	async start() {
		if (this.child) throw new AgentError("adapter already started");

		this.child = this.spawnImpl(process.execPath, [this.cliPath, ...this.args], {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child.stdout.setEncoding("utf-8");
		this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		this.child.stderr.setEncoding("utf-8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});

		this.child.on("error", (error) => this.#onExit(new AgentError(`agent process failed: ${error.message}`)));
		this.child.on("exit", (code, signal) => {
			this.#onExit(
				code === 0
					? new AgentError("agent process exited")
					: new AgentError(`agent process exited (code=${code ?? "?"} signal=${signal ?? "?"})`),
			);
		});

		// Pi prints nothing on startup, so the cheapest readiness proof is that
		// a command round-trips. get_state also tells us which session we landed
		// in, which the bridge reports to the phone.
		const state = await this.#send("get_state", {});
		this.ready = true;
		this.emit("ready", state);
		return state;
	}

	/** Subscribe to agent events. Returns an unsubscribe function. */
	onEvent(listener) {
		this.on("event", listener);
		return () => this.off("event", listener);
	}

	/** Extension UI requests (notify/setStatus) that RPC mode forwards. */
	onExtensionUi(listener) {
		this.on("extension_ui", listener);
		return () => this.off("extension_ui", listener);
	}

	async prompt(message, streamingBehavior) {
		return this.#data(await this.#send("prompt", { message, streamingBehavior }), "disposition");
	}

	async steer(message) {
		return this.#data(await this.#send("steer", { message }), "disposition");
	}

	async abort() {
		await this.#send("abort", {});
	}

	async getMessages() {
		return this.#data(await this.#send("get_messages", {}), "messages");
	}

	async getState() {
		return this.#data(await this.#send("get_state", {}), "state");
	}

	async setSessionName(name) {
		await this.#send("set_session_name", { name });
	}

	/**
	 * Models the agent can reach right now, as { provider, id, name }. The phone
	 * only ever offers these, so a student cannot pick something that will fail.
	 */
	async getAvailableModels() {
		const models = await this.#data(await this.#send("get_available_models", {}), "models");
		return (models ?? []).map((model) => ({
			provider: String(model.provider ?? ""),
			id: String(model.id ?? ""),
			name: String(model.name ?? model.id ?? ""),
		}));
	}

	/** Switch the active model. Rejects an unknown provider/id pair. */
	async setModel(provider, modelId) {
		const response = await this.#send("set_model", { provider, modelId });
		if (!response?.success) {
			throw new AgentError(response?.error ?? `could not switch to ${provider}/${modelId}`);
		}
		return response.data;
	}

	async switchSession(sessionPath) {
		return this.#data(await this.#send("switch_session", { sessionPath }), "cancelled");
	}

	async stop() {
		const child = this.child;
		this.child = null;
		this.ready = false;
		if (!child) return;
		// Closing stdin makes RPC mode shut down cleanly, which flushes the
		// session file. SIGTERM is the fallback for a wedged agent.
		child.stdin?.end();
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	get alive() {
		return Boolean(this.child && this.child.exitCode === null);
	}

	#onStdout(chunk) {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.#handleLine(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	#handleLine(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			// Pi may print a banner line before taking over stdout. Ignore
			// anything that is not one of ours rather than dying.
			return;
		}

		if (message.type === "response" && message.id && this.pending.has(message.id)) {
			const { resolve } = this.pending.get(message.id);
			this.pending.delete(message.id);
			resolve(message);
			return;
		}
		if (message.type === "extension_ui_request") {
			this.emit("extension_ui", message);
			return;
		}
		if (message.type === "extension_error") {
			this.emit("event", message);
			return;
		}
		if (typeof message.type === "string") {
			this.emit("event", message);
		}
	}

	#send(type, fields) {
		const child = this.child;
		if (!child || child.exitCode !== null || !child.stdin?.writable) {
			return Promise.reject(new AgentError("agent is not running"));
		}
		const id = `req_${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new AgentError(`timed out waiting for ${type}.${this.stderr ? ` stderr: ${this.stderr.slice(-400)}` : ""}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			try {
				child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new AgentError(`could not send ${type}: ${error.message}`));
			}
		});
	}

	#data(response, key) {
		if (!response?.success) {
			throw new AgentError(response?.error ?? `agent rejected the ${key} request`);
		}
		return response.data?.[key];
	}

	#onExit(error) {
		for (const { reject } of this.pending.values()) {
			reject(error);
		}
		this.pending.clear();
		if (this.child) {
			this.ready = false;
			this.child = null;
			this.emit("exit", error);
		}
	}
}
