import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { RemoteServer } from "../lib/remote/server.mjs";
import { remoteWebUi } from "../lib/remote/web-ui.mjs";

/**
 * End-to-end coverage of the relay over real sockets.
 *
 * Nothing here is mocked: a real HTTP server, real WebSocket connections on both
 * sides, and the real registry. The only stand-in is the agent itself, which in
 * this suite is a couple of lines of socket handling - the same shape the bridge
 * produces, minus Pi.
 */

const ENROLL = "test-enrol-key";
const PHONE_TOKEN = "phone-token-abc";

/** Wait for the next frame of a given type, or fail the test. */
function waitFor(socket, type, timeout = 4000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
		socket.on("message", function onMessage(raw) {
			let frame;
			try {
				frame = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (frame.type !== type) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(frame);
		});
	});
}

/** Every frame received, kept for later assertions. */
function record(socket) {
	const frames = [];
	socket.on("message", (raw) => {
		try {
			frames.push(JSON.parse(raw.toString()));
		} catch {
			/* keep going */
		}
	});
	return frames;
}

const send = (socket, frame) => socket.send(JSON.stringify({ protocol: 1, ...frame }));

async function startServer(overrides = {}) {
	// TEMP-BISECT
	const dir = null;
	const server = new RemoteServer({
		port: 0,
		enrollKey: ENROLL,
		stateFile: null,
		...overrides,
	});
	await server.listen();
	const { agentUrl, uiUrl } = server.address();
	return { server, agentUrl, uiUrl, dir };
}

/** Connect the computer side the way the bridge does. */
async function connectAgent(agentUrl, sessionId, token = PHONE_TOKEN) {
	const socket = new WebSocket(agentUrl);
	socket.on("message", (raw) => {
	});
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	send(socket, {
		type: "hello",
		sessionId,
		enrollKey: ENROLL,
		token,
		client: { name: "robot", cwd: "/home/ken/robot", platform: "linux", version: "0.4.12" },
	});
	await waitFor(socket, "welcome");
	return socket;
}

async function connectPhone(uiUrl, sessionId, token = PHONE_TOKEN) {
	const socket = new WebSocket(uiUrl.replace(/^http/, "ws").replace(/\/ui$/, "/phone"));
	await new Promise((resolve, reject) => {
		socket.on("open", resolve);
		socket.on("error", reject);
	});
	send(socket, { type: "attach", sessionId, token });
	return socket;
}

test("a phone message reaches the agent and its response comes back", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		const agent = await connectAgent(agentUrl, "s-route");
		const phone = await connectPhone(uiUrl, "s-route");
		await waitFor(phone, "attached");

		send(phone, { type: "message", text: "make the led blink" });

		const forwarded = await waitFor(agent, "phone_message");
		assert.equal(forwarded.text, "make the led blink");

		// The agent streams back; the phone must receive exactly what it sent.
		send(agent, { type: "event", event: { type: "tool_execution_start", toolName: "bash" } });
		const event = await waitFor(phone, "event");
		assert.equal(event.event.toolName, "bash");
	} finally {
		await server.close();
	}
});

test("history replays to a phone that reconnects to the same session", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		const agent = await connectAgent(agentUrl, "s-history");
		// The agent answers every history request, exactly like the bridge does,
		// so the test cannot race the request id.
		agent.on("message", (raw) => {
			const frame = JSON.parse(raw.toString());
			if (frame.type !== "history_request") return;
			// What the bridge actually sends: { role, text }, already reduced.
			// Sanitising is the computer's job, the server forwards verbatim.
			send(agent, {
				type: "snapshot",
				requestId: frame.requestId,
				messages: [{ role: "user", text: "earlier question" }],
			});
		});

		const first = await connectPhone(uiUrl, "s-history");
		const history = await waitFor(first, "history");
		assert.deepEqual(history.messages, [{ role: "user", text: "earlier question" }]);

		// Browser closed, reopened: same session, same conversation.
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = await connectPhone(uiUrl, "s-history");
		const attached = await waitFor(second, "attached");
		assert.equal(attached.session.sessionId, "s-history");
		assert.equal(attached.computer, "online", "the computer is still there");
		assert.equal(attached.session.meta.name, "robot");
		const again = await waitFor(second, "history");
		assert.deepEqual(again.messages, [{ role: "user", text: "earlier question" }], "and the conversation is still there");
	} finally {
		await server.close();
	}
});

test("a phone cannot attach with the wrong token, and is not told why", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		await connectAgent(agentUrl, "s-auth");
		const socket = await connectPhone(uiUrl, "s-auth", "wrong-token");
		const frames = record(socket);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const last = frames.at(-1);
		assert.equal(last.type, "error");
		// The same message as an unknown session: otherwise this endpoint tells
		// an attacker which session ids are real.
		assert.match(last.message, /No such session, or the wrong link\./);
		assert.equal(
			frames.some((frame) => frame.type === "attached"),
			false,
			"a wrong token must not attach",
		);
	} finally {
		await server.close();
	}
});

test("a phone cannot attach to a session that does not exist", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		const socket = await connectPhone(uiUrl, "no-such-session");
		const frames = record(socket);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(frames.at(-1).type, "error");
		// The message must not distinguish "unknown session" from "wrong token",
		// or the endpoint becomes a session-id oracle.
		assert.match(frames.at(-1).message, /No such session, or the wrong link\./);
	} finally {
		await server.close();
	}
});

test("an agent with the wrong enrolment key is refused", async () => {
	const { server, agentUrl } = await startServer();
	try {
		const socket = new WebSocket(agentUrl);
		await new Promise((resolve) => socket.on("open", resolve));
		send(socket, { type: "hello", sessionId: "s-reject", enrollKey: "not-the-key", token: PHONE_TOKEN });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(socket.readyState, WebSocket.CLOSED, "connection must be closed, not argued with");
	} finally {
		await server.close();
	}
});

test("a second phone on one session replaces the first", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		await connectAgent(agentUrl, "s-dupe");
		const first = await connectPhone(uiUrl, "s-dupe");
		await waitFor(first, "attached");

		const second = await connectPhone(uiUrl, "s-dupe");
		const attached = await waitFor(second, "attached");
		assert.equal(attached.computer, "online");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(first.readyState, WebSocket.CLOSED, "the first phone is disconnected, not ghosted");
	} finally {
		await server.close();
	}
});

test("a computer that drops out marks the session offline, and the phone waits", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		const agent = await connectAgent(agentUrl, "s-offline");
		const phone = await connectPhone(uiUrl, "s-offline");
		await waitFor(phone, "attached");

		agent.close();
		const presence = await waitFor(phone, "presence");
		assert.equal(presence.computer, "offline");

		// The registry keeps the session, so reconnecting the computer resumes it.
		// connectAgent already waits for `welcome`, which is the proof the
		// re-enrolment was accepted.
		const agentAgain = await connectAgent(agentUrl, "s-offline");
		const online = await waitFor(phone, "presence");
		assert.equal(online.computer, "online");
	} finally {
		await server.close();
	}
});

test("a restarted server still remembers the session", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-remote-restart-"));
	const stateFile = join(dir, "registry.json");
	const first = new RemoteServer({ port: 0, enrollKey: ENROLL, stateFile });
	await first.listen();
	try {
		const agent = await connectAgent(first.address().agentUrl, "s-restart");
		agent.close();
	} finally {
		await first.close();
	}

	const second = new RemoteServer({ port: 0, enrollKey: ENROLL, stateFile });
	await second.listen();
	try {
		// The session survived, so the phone is told "offline" rather than
		// "unknown session", and the computer can rejoin the same thread.
		const phone = await connectPhone(second.address().uiUrl, "s-restart");
		const attached = await waitFor(phone, "attached");
		assert.equal(attached.computer, "offline");
		assert.equal(attached.session.meta.name, "robot");
	} finally {
		await second.close();
	}
});

test("the UI is served over plain HTTP and is phone-shaped", async () => {
	const { server, uiUrl } = await startServer();
	try {
		const html = remoteWebUi();
		assert.match(html, /name="viewport"/, "mobile viewport");
		assert.match(html, /\/phone"/, "connects to the phone endpoint");

		const response = await fetch(`${uiUrl}`);
		assert.equal(response.status, 200);
		const served = await response.text();
		assert.match(served, /LearningCode Remote/);
	} finally {
		await server.close();
	}
});

test("health reports how many sessions are live", async () => {
	const { server, agentUrl, uiUrl } = await startServer();
	try {
		const before = await (await fetch(`${uiUrl.replace("/ui", "/healthz")}`)).json();
		assert.equal(before.ok, true);

		const agent = await connectAgent(agentUrl, "s-health");
		const after = await (await fetch(`${uiUrl.replace("/ui", "/healthz")}`)).json();
		assert.equal(after.sessions, 1);
		agent.close();
	} finally {
		await server.close();
	}
});
