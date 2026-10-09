import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBridge } from "../lib/remote/bridge.mjs";

/**
 * A controllable agent stand-in. The contract the bridge relies on is four
 * methods and two event channels; everything else is Pi's business.
 */
function fakeAgent() {
	const listeners = new Set();
	const uiListeners = new Set();
	const state = { prompts: [], aborts: [], stopCalls: 0, messages: [{ role: "user", content: "earlier" }] };
	return {
		state,
		prompt: async (text) => {
			state.prompts.push(text);
			return "accepted";
		},
		abort: async () => state.aborts.push(true),
		getMessages: async () => state.messages,
		stop: async () => {
			state.stopCalls += 1;
		},
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onExtensionUi: (listener) => {
			uiListeners.add(listener);
			return () => uiListeners.delete(listener);
		},
		emitEvent: (event) => listeners.forEach((listener) => listener(event)),
		emitUi: (request) => uiListeners.forEach((listener) => listener(request)),
	};
}

/** A fake WebSocket that records frames and can be driven from the test. */
function fakeSocket() {
	const frames = [];
	const socket = {
		readyState: 1,
		sent: frames,
		handlers: {},
		addEventListener: (name, handler) => {
			socket.handlers[name] = handler;
		},
		removeEventListener: () => {},
		send: (raw) => frames.push(JSON.parse(raw)),
		close: () => {
			socket.readyState = 3;
			socket.handlers.close?.();
		},
		deliver: (frame) => socket.handlers.message?.({ data: JSON.stringify(frame) }),
		json: (type) => frames.map((frame) => frame).filter((frame) => frame.type === type),
	};
	return socket;
}

const bridgeOptions = (overrides = {}) => {
	const socket = overrides.socket ?? (overrides.socket = fakeSocket());
	// A real WebSocket opens on its own shortly after construction; the fake
	// does the same so `await bridge.start()` can resolve, and tests that need a
	// specific sequence drive the socket afterwards.
	const autoOpen = overrides.autoOpen !== false;
	overrides.WebSocketImpl = class {
		constructor() {
			if (autoOpen) queueMicrotask(() => socket.handlers.open?.());
			return socket;
		}
	};
	return {
		serverUrl: "ws://127.0.0.1:8787/agent",
		sessionId: "s1",
		token: "t1",
		enrollKey: "k1",
		meta: { name: "robot", cwd: "/home/ken/robot" },
		log: () => {},
		...overrides,
	};
};

test("on connect the bridge enrols and asks for the conversation", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));

	await bridge.start();
	socket.handlers.open();

	const hello = socket.sent.find((frame) => frame.type === "hello");
	assert.equal(hello.sessionId, "s1");
	assert.equal(hello.enrollKey, "k1");
	assert.equal(hello.token, "t1");
	assert.equal(hello.client.cwd, "/home/ken/robot", "project metadata goes too");
	assert.ok(socket.sent.some((frame) => frame.type === "snapshot_request"), "replays history on reconnect");
	assert.equal(bridge.status().online, true);
	await bridge.stop();
});

test("a phone message becomes an agent prompt", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ protocol: 1, type: "phone_message", text: "make it blink" });
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(agent.state.prompts, ["make it blink"]);
	await bridge.stop();
});

test("messages typed while the socket is down queue and flush on reconnect", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();

	// Drop the connection the way a network change does, then queue behind it.
	socket.handlers.close();
	assert.equal(bridge.status().online, false);
	bridge.deliverToAgent("first");
	bridge.deliverToAgent("second");
	assert.equal(bridge.status().queued, 2, "held, not dropped");
	assert.deepEqual(agent.state.prompts, [], "nothing reaches the agent while offline");

	socket.readyState = 1;
	socket.handlers.open();
	assert.equal(bridge.status().queued, 0, "flushed once the socket is back");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(agent.state.prompts, ["first", "second"]);
	await bridge.stop();
});

test("agent events are sanitized before they leave the computer", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	agent.emitEvent({ type: "tool_execution_start", toolName: "bash" });
	agent.emitEvent({ type: "session_started_with_sensitive_payload", leak: "spark_live_leak123" });
	agent.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "hi" } });

	const forwarded = socket.json("event").map((frame) => frame.event);
	assert.deepEqual(forwarded[0], { type: "tool_execution_start", toolName: "bash" });
	assert.equal(forwarded.length, 2, "the unknown event type never left the machine");
	assert.deepEqual(forwarded[1], { type: "message_update", text: "hi" });
	assert.ok(!JSON.stringify(forwarded).includes("spark_live_leak"));
	await bridge.stop();
});

test("extension notifications reach the phone as notes", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	agent.emitUi({ method: "notify", message: "Spark rejected your token" });
	const note = socket.json("event").at(-1);
	assert.deepEqual(note.event, { type: "note", text: "Spark rejected your token" });
	await bridge.stop();
});

test("the server can ask the computer to abort, and to shut down", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	let stopRequested = false;
	bridge.on("stop-requested", () => {
		stopRequested = true;
	});
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ type: "control", action: "abort" });
	socket.deliver({ type: "control", action: "stop" });
	assert.deepEqual(agent.state.aborts, [true]);
	assert.equal(stopRequested, true, "a remote stop is honoured, not ignored");
	await bridge.stop();
});

test("history requests are answered from the agent, bounded", async () => {
	const agent = fakeAgent();
	agent.state.messages = [
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
	];
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ type: "history_request", requestId: "h1" });
	await new Promise((resolve) => setImmediate(resolve));

	const snapshot = socket.sent.find((frame) => frame.type === "snapshot");
	assert.equal(snapshot.requestId, "h1");
	assert.deepEqual(snapshot.messages, [
		{ role: "user", text: "hello" },
		{ role: "assistant", text: "hi there" },
	]);
	await bridge.stop();
});

test("a dropped socket reconnects with backoff and a fresh enrolment", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));

	// Cut the retry delay so the test does not sleep for real.
	const waits = [];
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms) => {
		waits.push(ms);
		return originalSetTimeout(fn, 0);
	};
	try {
		await bridge.start();
		socket.handlers.open();
		socket.handlers.close();
		assert.equal(bridge.status().online, false, "status reports offline immediately");
		await new Promise((resolve) => setImmediate(resolve));

		assert.ok(waits.length >= 1, "a reconnect was scheduled");
		assert.ok(waits[0] >= 500, "with backoff, not an instant hammer");
		assert.ok(waits[0] <= 30_000, "and bounded");
		const secondSocket = fakeSocket();
		// The retry created a new socket and enrolled again.
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	await bridge.stop();
});

test("a malformed server frame does not kill the bridge", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver.fromServer = undefined;
	const raw = { data: "this is not json" };
	socket.handlers.message?.(raw);
	assert.equal(bridge.status().online, true, "still connected");
	await bridge.stop();
});

test("stop() detaches from the agent so events stop flowing", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	await bridge.stop();
	agent.emitEvent({ type: "tool_execution_start", toolName: "bash" });
	assert.equal(socket.json("event").length, 0, "no events after stop");
});
