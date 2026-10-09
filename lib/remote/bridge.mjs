import { EventEmitter } from "node:events";
import { frame, normalizeMessage, parseFrame, ProtocolError } from "./protocol.mjs";
import { sanitizeAgentEvent, sanitizeExtensionUi, sanitizeMessages } from "./sanitize.mjs";
import { UserError } from "../config.mjs";

/**
 * The computer side of LearningCode Remote.
 *
 * Responsibilities, in order of importance:
 *
 *   1. Keep an outbound connection to the remote server. The computer always
 *      dials out; nothing is ever opened for inbound access.
 *   2. Carry phone messages into the agent and agent events back out, sanitized.
 *   3. Survive the network. The phone may vanish; the agent keeps working, and
 *      queued messages flush when the socket comes back.
 *
 * Deliberately not here: authentication policy, session registry, the UI. Those
 * belong to the server, so that a student running their own server gets the same
 * rules as the school one.
 */
export class RemoteBridge extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.serverUrl ws:// or wss:// endpoint for agents
	 * @param {string} options.sessionId local session identity
	 * @param {string} options.token per-session phone token (never logged)
	 * @param {string} options.enrollKey server enrolment key
	 * @param {object} options.meta { name, cwd, platform, version }
	 * @param {{ prompt: Function, abort: Function, getMessages: Function, onEvent: Function, stop: Function }} options.agent
	 * @param {typeof WebSocket} [options.WebSocketImpl] injectable for tests
	 * @param {(message: string) => void} [options.log]
	 */
	constructor({
		serverUrl,
		sessionId,
		token,
		enrollKey,
		meta,
		agent,
		WebSocketImpl = globalThis.WebSocket,
		log = () => {},
		onModelChanged = null,
		// Filters the model list to providers the student is logged in to.
		// Returns true for models that may be shown. Default: show everything.
		modelVisible = () => true,
	}) {
		super();
		this.serverUrl = serverUrl;
		this.sessionId = sessionId;
		this.token = token;
		this.enrollKey = enrollKey;
		this.meta = meta;
		this.agent = agent;
		this.WebSocketImpl = WebSocketImpl;
		this.log = log;
		// Called with { provider, modelId } after a phone switch succeeds.
		this.onModelChanged = onModelChanged;
		this.modelVisible = modelVisible;

		this.socket = null;
		this.phones = 0;
		this.online = false;
		this.stopped = false;
		this.attempt = 0;
		this.reconnectTimer = null;
		this.heartbeat = null;
		this.lastError = "";
		/** Messages typed on a phone while the socket was down. */
		this.outbox = [];
		this._agentEvents = [];
	}

	/** Connect and keep the connection alive until stop(). */
	async start() {
		this.stopped = false;
		this._agentEvents.push(
			this.agent.onEvent((event) => this.#forwardAgentEvent(event)),
			this.agent.onExtensionUi?.((request) => {
				const note = sanitizeExtensionUi(request);
				if (note) this.#send(frame("event", { event: note }));
			}) ?? (() => {}),
		);
		await this.#connect();
		this.#startHeartbeat();
	}

	/** Queue a message typed on a phone. Never throws: the phone already sent it. */
	deliverToAgent(text) {
		try {
			const message = normalizeMessage(text);
			this.outbox.push(message);
			this.#flushOutbox();
			return true;
		} catch (error) {
			if (error instanceof ProtocolError) {
				this.log(`ignored malformed phone message: ${error.message}`);
				return false;
			}
			throw error;
		}
	}

	async stop() {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const unsubscribe of this._agentEvents) unsubscribe();
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				/* already gone */
			}
			this.socket = null;
		}
		this.online = false;
	}

	status() {
		return {
			sessionId: this.sessionId,
			online: this.online,
			phones: this.phones,
			queued: this.outbox.length,
			lastError: this.lastError,
		};
	}

	#startHeartbeat() {
		// The server pings; if two pings go unanswered the socket is replaced.
		// A dead-but-open socket is the failure that looks like "the phone just
		// stopped working" from the student's side, so it is watched explicitly.
		this.heartbeat = setInterval(() => {
			if (!this.socket || this.socket.readyState !== 1) return;
			try {
				this.socket.send(JSON.stringify(frame("pong", { t: Date.now() })));
			} catch {
				/* the close handler will reconnect */
			}
		}, 20_000);
	}

	async #connect() {
		if (this.stopped) return;
		if (!this.WebSocketImpl) {
			throw new UserError(
				"No WebSocket client available. learningcode remote requires Node 22 or newer.",
			);
		}
		const socket = new this.WebSocketImpl(this.serverUrl);
		this.socket = socket;

		// message/close are bound once and stay attached for the life of the
		// socket: the connection attempt below only waits for "open", and tearing
		// the message listener down when it fires would leave a connected bridge
		// that can hear nothing.
		this.socket.addEventListener("message", this._onMessage);
		this.socket.addEventListener("close", this._onClose);

		await new Promise((resolve) => {
			const onOpen = () => {
				cleanup();
				this.online = true;
				this.attempt = 0;
				this.lastError = "";
				this.emit("status", this.status());
				this.#send(
					frame("hello", {
						sessionId: this.sessionId,
						enrollKey: this.enrollKey,
						token: this.token,
						client: this.meta,
					}),
				);
				// Re-attach replays the conversation, so a phone that was already
				// open sees the whole thread the moment we are back.
				this.#send(frame("snapshot_request", { reason: "reconnect" }));
				this.#flushOutbox();
				resolve();
			};
			const onFailure = (error) => {
				cleanup();
				this.lastError = String(error?.message ?? error);
				this.online = false;
				resolve();
			};
			const cleanup = () => {
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onFailure);
			};

			socket.addEventListener("open", onOpen);
			socket.addEventListener("error", onFailure);
		});
	}

	/** Bound once: frames from the server, whatever the connection state. */
	_onMessage = (raw) => {
		const data = raw?.data;
		if (typeof data !== "string") return; // ignore binary frames
		let parsed;
		try {
			parsed = parseFrame(data);
		} catch {
			return; // a malformed server frame is not worth dying over
		}
		this.#handle(parsed);
	};

	/** Bound once: the socket went away for any reason, including a refusal. */
	_onClose = () => {
		if (this.socket) {
			this.socket.removeEventListener("message", this._onMessage);
			this.socket.removeEventListener("close", this._onClose);
			this.socket = null;
		}
		this.online = false;
		this.emit("status", this.status());
		this.#scheduleReconnect();
	};

	#scheduleReconnect() {
		if (this.stopped) return;
		// Exponential backoff with jitter: 1s, 2s, 4s … capped at 30s. Without
		// jitter a whole lab reconnecting after a network blip synchronises and
		// hammers the server in lockstep.
		this.attempt += 1;
		const base = Math.min(30_000, 1000 * 2 ** (this.attempt - 1));
		const delay = Math.round(base * (0.5 + Math.random() * 0.5));
		this.reconnectTimer = setTimeout(() => {
			this.#connect().catch((error) => {
				this.lastError = String(error?.message ?? error);
			});
		}, delay);
		this.emit("status", this.status());
	}

	#handle(message) {
		switch (message.type) {
			case "welcome":
				this.phones = message.phones ?? 0;
				this.emit("status", this.status());
				break;

			case "presence":
				if (typeof message.phones === "number") this.phones = message.phones;
				this.emit("status", this.status());
				break;

			case "phone_message":
				this.deliverToAgent(message.text);
				break;

			case "history_request":
				this.#sendSnapshot(message.requestId);
				break;

			case "models_request":
				this.#sendModels(message.requestId);
				break;

			case "approval_answer":
				this.agent.answerExtensionUi?.(message.id, message.cancelled ? { cancelled: true } : { value: message.value });
				break;

			case "set_model":
				this.#applyModel(message.requestId, message.provider, message.modelId);
				break;

			case "control": {
				const action = message.action;
				if (action === "abort") this.agent.abort().catch(() => {});
				if (action === "stop") {
					this.emit("stop-requested");
				}
				break;
			}

			case "ping":
				this.#send(frame("pong", { t: message.t }));
				break;

			default:
				break;
		}
	}

	async #forwardAgentEvent(event) {
		const sanitized = sanitizeAgentEvent(event);
		if (sanitized) this.#send(frame("event", { event: sanitized }));
	}

	#sendModels(requestId) {
		Promise.all([
			Promise.resolve(this.agent.getAvailableModels?.() ?? []).then((list) => list.filter((m) => this.modelVisible(m))),
			Promise.resolve(this.agent.getCurrentModel?.() ?? null).catch(() => null),
		])
			.then(([models, current]) => this.#send(frame("models", { requestId, models, current })))
			.catch((error) => {
				this.log(`could not list models: ${error?.message ?? error}`);
				this.#send(frame("models", { requestId, models: [], error: "could not list models" }));
			});
	}

	/**
	 * Apply a model choice from the phone. Only pairs the agent itself reported
	 * are accepted, so a crafted request cannot select an arbitrary provider.
	 */
	#applyModel(requestId, provider, modelId) {
		Promise.resolve(this.agent.getAvailableModels?.() ?? [])
			.then((available) => {
				const allowed = available.some((model) => model.provider === provider && model.id === modelId && this.modelVisible(model));
				if (!allowed) throw new Error("that model is not available on this computer");
				return this.agent.setModel(provider, modelId);
			})
			.then(() => {
				this.onModelChanged?.({ provider, modelId });
				this.#send(frame("model_changed", { requestId, provider, modelId, ok: true }));
			})
			.catch((error) => {
				this.#send(frame("model_changed", { requestId, ok: false, error: String(error?.message ?? error) }));
			});
	}

	#sendSnapshot(requestId) {		Promise.resolve(this.agent.getMessages())
			.then((messages) => {
				this.#send(
					frame("snapshot", {
						requestId,
						messages: sanitizeMessages(messages),
					}),
				);
			})
			.catch((error) => {
				this.log(`could not read conversation: ${error?.message ?? error}`);
				this.#send(frame("snapshot", { requestId, messages: [] }));
			});
	}

	#flushOutbox() {
		if (!this.online || !this.outbox.length) return;
		for (const text of this.outbox) {
			this.#send(frame("agent_message", { text }));
			this.agent.prompt(text).catch((error) => {
				this.log(`agent rejected message: ${error?.message ?? error}`);
				this.#send(frame("event", { event: { type: "error", message: String(error?.message ?? error) } }));
			});
		}
		this.outbox = [];
		this.emit("status", this.status());
	}

	#send(payload) {
		if (typeof payload !== "object" || payload === null) return;
		if (JSON.stringify(payload).length > 256 * 1024) return; // frames stay small
		if (!this.socket || this.socket.readyState !== 1) return;
		try {
			this.socket.send(JSON.stringify(payload));
		} catch (error) {
			this.log(`send failed: ${error?.message ?? error}`);
		}
	}
}

