import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { LIMITS, frame, normalizeMessage, parseFrame, ProtocolError } from "./protocol.mjs";
import { SessionStore } from "./sessions.mjs";
import { remoteWebUi } from "./web-ui.mjs";

/**
 * The LearningCode Remote server.
 *
 * It is a relay with rules, and nothing more. It never talks to the agent, never
 * sees the filesystem, and cannot run a command on a student's machine: the only
 * thing it can do is pass a phone's message down an already-authenticated
 * connection that the computer opened.
 *
 * Endpoints:
 *   GET  /healthz       liveness
 *   GET  /ui            the mobile web client
 *   WS   /agent         computers connect here
 *   WS   /phone         phones connect here
 *
 * Every frame is validated by parseFrame, every socket is rate limited, and a
 * socket that misbehaves is closed rather than reasoned with.
 */
export class RemoteServer {
	/**
	 * @param {object} options
	 * @param {number} [options.port] 0 picks a free port
	 * @param {string} [options.host] loopback by default
	 * @param {string} [options.enrollKey] if empty, one is generated and returned by listen()
	 * @param {string} [options.stateFile] where the registry is persisted
	 * @param {boolean} [options.allowGeneratedKey] dev convenience: mint a key
	 */
	constructor({ port = 0, host = "127.0.0.1", enrollKey = "", stateFile = null, allowGeneratedKey = true } = {}) {
		this.port = port;
		this.host = host;
		this.generatedKey = "";
		this.enrollKey = enrollKey;
		this.store = new SessionStore({ stateFile, enrollKey });
		/** @type {Map<string, { agent: import("ws").WebSocket | null, phones: Set<import("ws").WebSocket>, lastHistoryRequest: string }>} */
		this.rooms = new Map();
		this.rateWindows = new Map();
		this.httpServer = null;
		this.wss = null;
	}

	async listen() {
		await this.store.load();

		if (!this.enrollKey && allowGeneratedKeyEnabled()) {
			// Local development must not require a shared secret, but it must not
			// silently disable the check either: generate one, print it, and let
			// the operator pass it to the computer.
			const { newToken } = await import("./tokens.mjs");
			this.generatedKey = newToken().slice(0, 12);
			this.enrollKey = this.generatedKey;
			this.store.enrollKey = this.generatedKey;
		}

		this.httpServer = createServer((request, response) => this.#onHttp(request, response));

		// One WebSocket server, routed by path. Two WebSocketServer instances
		// over one HTTP server both answer the upgrade event and corrupt each
		// other's handshake ("RSV1 must be clear"), so routing is done here.
		this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
		this.httpServer.on("upgrade", (request, socket, head) => {
			const { pathname } = new URL(request.url ?? "/", "http://localhost");
			if (pathname === "/agent") {
				this.wss.handleUpgrade(request, socket, head, (ws) => this.#onAgent(ws, request));
			} else if (pathname === "/phone") {
				this.wss.handleUpgrade(request, socket, head, (ws) => this.#onPhone(ws, request));
			} else {
				socket.destroy();
			}
		});

		await new Promise((resolve, reject) => {
			this.httpServer.once("error", reject);
			this.httpServer.listen(this.port, this.host, () => resolve());
		});
		this.port = this.httpServer.address().port;
		this.host = this.httpServer.address().address;
		return this;
	}

	address() {
		return {
			host: this.host,
			port: this.port,
			agentUrl: `ws://${this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host}:${this.port}/agent`,
			uiUrl: `http://${this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host}:${this.port}/ui`,
		};
	}

	/** For tests and `remote-server --check`: the key to give the computer. */
	enrolmentKey() {
		return this.enrollKey;
	}

	async close() {
		// Close every socket first. Both close() calls below wait for open
		// connections, and the phone's keep-alive HTTP connection counts as one,
		// so without this a `remote-server` with a phone attached never exits.
		for (const client of this.wss?.clients ?? []) {
			try { client.close(); } catch { /* already gone */ }
		}
		for (const room of this.rooms.values()) {
			room.agent?.close();
		}
		this.rooms.clear();
		this.httpServer?.closeAllConnections?.();
		await new Promise((resolve) => this.wss?.close(() => resolve()));
		await new Promise((resolve) => this.httpServer?.close(() => resolve()));
		await this.store.flush().catch(() => {});
	}

	#onHttp(request, response) {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, sessions: this.rooms.size }));
			return;
		}
		if (url.pathname === "/ui" || url.pathname === "/") {
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				// The page is generated per release and debugged from screenshots:
				// never let the tunnel, the browser, or WhatsApp's viewer cache it.
				"cache-control": "no-store",
			});
			response.end(remoteWebUi());
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	}

	// ---------------------------------------------------------------- agents

	#onAgent(socket, request) {
		const key = ipOf(request);
		if (!this.#rateOk(`agent:${key}`)) return socket.close(1008, "rate limited");

		socket.on("message", (raw) => {
			let parsed;
			try {
				parsed = parseFrame(raw.toString());
			} catch (error) {
				if (error instanceof ProtocolError) return socket.close(1008, "bad frame");
				throw error;
			}

			try {
				switch (parsed.type) {
				case "hello": {
						const { session, resumed } = this.store.enroll({
							enrollKey: parsed.enrollKey,
							sessionId: parsed.sessionId,
							meta: parsed.client,
						});
						// The token is hashed server-side and the cleartext is
						// never persisted, so a leaked registry file is not a
						// leaked door.
						if (parsed.token) this.store.bindToken(parsed.sessionId, parsed.token);
						this.#joinAgent(session.sessionId, socket, resumed);
						return;
					}
					case "event":
					case "snapshot":
					case "snapshot_request":
					case "agent_message":
					case "models":
					case "model_changed":
						this.#fromAgent(socket, parsed);
						return;
					default:
						return;
				}
			} catch (error) {
				this.#send(socket, frame("error", { message: String(error?.message ?? error) }));
				if (error?.status === 401 || error?.status === 400) socket.close(1008, "rejected");
			}
		});

		socket.on("close", () => this.#leaveAgent(socket));
	}

	#joinAgent(sessionId, socket, resumed) {
		let room = this.rooms.get(sessionId);
		if (room?.agent && room.agent !== socket) {
			// Two computers claiming one session: the newer one wins and the
			// older is told why, instead of both racing to run the same agent.
			try { room.agent.close(4000, "session claimed by another connection"); } catch { /* gone */ }
		}
		if (!room) {
			room = { agent: null, phones: new Set(), lastHistoryRequest: "" };
			this.rooms.set(sessionId, room);
		}
		room.agent = socket;

		const phones = room.phones.size;
		this.#send(socket, frame("welcome", { sessionId, phones, resumed }));
		for (const phone of room.phones) {
			this.#send(phone, frame("presence", { computer: "online", phone: phones }));
		}
		this.store.flush().catch(() => {});
	}

	#leaveAgent(socket) {
		for (const [sessionId, room] of this.rooms) {
			if (room.agent !== socket) continue;
			room.agent = null;
			for (const phone of room.phones) {
				this.#send(phone, frame("presence", { computer: "offline", phone: room.phones.size }));
			}
			this.store.get(sessionId); // keep the session so the phone can wait
		}
	}

	#fromAgent(socket, parsed) {
		const sessionId = this.#sessionOfAgent(socket);
		if (!sessionId) return;
		const room = this.rooms.get(sessionId);

		if (parsed.type === "event") {
			for (const phone of room.phones) this.#send(phone, frame("event", { event: parsed.event }));
			return;
		}
		if (parsed.type === "snapshot") {
			// The bridge already reduced these to { role, text }. Sanitising again
			// would look for a `content` field that is no longer there and quietly
			// hand the phone an empty conversation.
			for (const phone of room.phones) {
				if (phone.__requestId !== parsed.requestId) continue;
				this.#send(phone, frame("history", { messages: parsed.messages ?? [] }));
			}
			return;
		}
		if (parsed.type === "snapshot_request") {
			this.#requestHistory(room);
			return;
		}
		if (parsed.type === "models") {
			for (const phone of room.phones) {
				if (phone.__modelsRequestId !== parsed.requestId) continue;
				this.#send(phone, frame("models", { models: parsed.models ?? [], current: parsed.current ?? null, error: parsed.error }));
			}
			return;
		}
		if (parsed.type === "model_changed") {
			for (const phone of room.phones) {
				if (phone.__modelRequestId !== parsed.requestId) continue;
				this.#send(phone, frame("model_changed", { ok: parsed.ok, provider: parsed.provider, modelId: parsed.modelId, error: parsed.error }));
			}
			return;
		}
		if (parsed.type === "agent_message") {
			// The computer pipeline echoes the message it accepted, so the phone
			// can show it as sent even before the agent answers.
			for (const phone of room.phones) {
				this.#send(phone, frame("event", { event: { type: "message_echo", text: parsed.text } }));
			}
		}
	}

	#requestHistory(room) {
		const requestId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		for (const phone of room.phones) phone.__requestId = requestId;
		this.#send(room.agent, frame("history_request", { requestId }));
	}

	// ---------------------------------------------------------------- phones

	#onPhone(socket, request) {
		const key = ipOf(request);
		if (!this.#rateOk(`phone:${key}`)) return socket.close(1008, "rate limited");

		socket.on("message", (raw) => {
			let parsed;
			try {
				parsed = parseFrame(raw.toString());
			} catch (error) {
				if (error instanceof ProtocolError) return socket.close(1008, "bad frame");
				throw error;
			}

			try {
				switch (parsed.type) {
					case "attach": {
						const sessionId = String(parsed.sessionId ?? "");
						if (this.store.isLockedOut(`${key}:${sessionId}`)) {
							return this.#send(socket, frame("error", { message: "Too many attempts. Try again later." }));
						}
						const record = this.store.get(sessionId);
						if (!record) {
							this.store.noteFailedAttach(`${key}:${sessionId}`);
							// Deliberately the same message for "no such session"
							// and "wrong token": telling them apart turns the
							// endpoint into a session-id oracle.
							this.#send(socket, frame("error", { message: "No such session, or the wrong link." }));
							return;
						}
						if (!this.store.verifyToken(sessionId, parsed.token)) {
							this.store.noteFailedAttach(`${key}:${sessionId}`);
							this.#send(socket, frame("error", { message: "No such session, or the wrong link." }));
							return;
						}
						this.store.clearFailedAttach(`${key}:${sessionId}`);
						this.#joinPhone(sessionId, socket);
						return;
					}

					case "message": {
						const room = this.#roomOfPhone(socket);
						if (!room) return;
						try {
							const text = normalizeMessage(parsed.text);
							this.#send(room.agent, frame("phone_message", { text }));
						} catch (error) {
							if (error instanceof ProtocolError) {
								this.#send(socket, frame("error", { message: error.message }));
							} else throw error;
						}
						return;
					}

					case "models": {
						const room = this.#roomOfPhone(socket);
						if (!room) return;
						const requestId = `models_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
						socket.__modelsRequestId = requestId;
						this.#send(room.agent, frame("models_request", { requestId }));
						return;
					}

					case "set_model": {
						const room = this.#roomOfPhone(socket);
						if (!room) return;
						const provider = String(parsed.provider ?? "").slice(0, 80);
						const modelId = String(parsed.modelId ?? "").slice(0, 120);
						if (!provider || !modelId) {
							this.#send(socket, frame("error", { message: "choose a model first" }));
							return;
						}
						const requestId = `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
						socket.__modelRequestId = requestId;
						this.#send(room.agent, frame("set_model", { requestId, provider, modelId }));
						return;
					}

					case "abort":
					case "history": {
						const room = this.#roomOfPhone(socket);
						if (!room) return;
						if (parsed.type === "abort") {
							this.#send(room.agent, frame("control", { action: "abort" }));
						} else {
							this.#requestHistory(room);
						}
						return;
					}

					default:
						return;
				}
			} catch (error) {
				this.#send(socket, frame("error", { message: String(error?.message ?? error) }));
			}
		});

		socket.on("close", () => this.#leavePhone(socket));
	}

	#joinPhone(sessionId, socket) {
		const record = this.store.get(sessionId);
		let room = this.rooms.get(sessionId);
		if (!room) {
			// The computer is offline but the session is remembered, so the phone
			// can still attach and see "waiting for your computer" rather than an
			// error. That is the whole point of persisting the registry.
			room = { agent: null, phones: new Set(), lastHistoryRequest: "" };
			this.rooms.set(sessionId, room);
		}
		// A second phone on the same session kicks the first: two clients typing
		// into one agent is a worse failure than a surprise disconnect.
		for (const existing of room.phones) {
			try { existing.close(4001, "another phone connected"); } catch { /* gone */ }
		}
		room.phones.clear();
		room.phones.add(socket);

		this.#send(socket, frame("attached", { session: this.#publicSession(record), computer: room.agent ? "online" : "offline" }));
		if (room.agent) {
			this.#requestHistory(room);
			this.#send(room.agent, frame("presence", { phones: room.phones.size }));
		}
		this.store.flush().catch(() => {});
	}

	#leavePhone(socket) {
		for (const room of this.rooms.values()) {
			if (!room.phones.has(socket)) continue;
			room.phones.delete(socket);
			if (room.agent) this.#send(room.agent, frame("presence", { phones: room.phones.size }));
		}
	}

	// --------------------------------------------------------------- helpers

	#roomOfPhone(socket) {
		for (const room of this.rooms.values()) {
			if (room.phones.has(socket)) return room;
		}
		return null;
	}

	#sessionOfAgent(socket) {
		for (const [sessionId, room] of this.rooms) {
			if (room.agent === socket) return sessionId;
		}
		return null;
	}

	#publicSession(record) {
		if (!record) return null;
		const { tokenHash, ...rest } = record;
		return rest;
	}

	/** Cheap per-socket sliding window. Protects the shared agent, not the CPU. */
	#rateOk(key) {
		const now = Date.now();
		let window = this.rateWindows.get(key);
		if (!window || window.reset < now) {
			window = { count: 0, reset: now + 1000 };
			this.rateWindows.set(key, window);
		}
		window.count += 1;
		if (this.rateWindows.size > 10_000) {
			for (const [k, value] of this.rateWindows) if (value.reset < now) this.rateWindows.delete(k);
		}
		return window.count <= LIMITS.frameRate;
	}

	#send(socket, payload) {
		if (!socket || socket.readyState !== 1) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch {
			/* the close handler cleans up */
		}
	}
}

function allowGeneratedKeyEnabled() {
	// Defaults to on so `remote-server` works out of the box on a lab machine;
	// a production deployment passes its own key and this never fires.
	return process.env.LEARNINGCODE_REMOTE_GENERATE_KEY !== "0";
}

function ipOf(request) {
	const forwarded = request?.headers?.["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
	return request?.socket?.remoteAddress ?? "unknown";
}
