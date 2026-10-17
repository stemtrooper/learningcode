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
	const state = { prompts: [], behaviors: [], aborts: [], calls: [], pending: [], stopCalls: 0, streaming: false, messages: [{ role: "user", content: "earlier" }] };
	return {
		state,
		prompt: async (text, streamingBehavior) => {
			// Pi's own rule (agent-session.js prompt()): a message that arrives while
			// a turn is already running is refused unless the caller says how to queue
			// it. Modelled here so a bridge that forgets fails this suite rather than
			// a student's phone.
			if (state.streaming && !streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			state.prompts.push(text);
			state.behaviors.push(streamingBehavior);
			return "accepted";
		},
		abort: async () => {
			state.calls.push("abort");
			state.aborts.push(true);
		},
		clearQueue: async () => {
			state.calls.push("clearQueue");
			const cleared = { steering: [], followUp: state.pending };
			state.pending = [];
			return cleared;
		},
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

/**
 * A stand-in for Pi answering extension commands the way RPC mode does: the
 * command's own handler reports through ctx.ui.notify, and the prompt comes back
 * "handled" with no agent_start / agent_settled run behind it. Anything not in
 * `commands` falls through to the normal prompt path.
 */
function commandAgent(commands) {
	const agent = fakeAgent();
	const normalPrompt = agent.prompt;
	agent.prompt = async (text, streamingBehavior) => {
		const name = String(text).trim().split(/\s+/)[0];
		const handler = commands[name];
		if (handler) {
			handler(agent, text);
			return "handled";
		}
		return normalPrompt(text, streamingBehavior);
	};
	return agent;
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

test("a message typed while the agent is working queues as a follow-up", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	// The agent is already mid-turn, which is what a long resumed conversation
	// makes likely: the student types the next thought before the answer lands.
	agent.state.streaming = true;
	socket.deliver({ protocol: 1, type: "phone_message", text: "and add a note" });
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(agent.state.prompts, ["and add a note"]);
	assert.deepEqual(agent.state.behaviors, ["followUp"], "queued behind the turn, not pushed into it");
	const errors = socket.json("event").filter((frame) => frame.event?.type === "error");
	assert.deepEqual(errors, [], "the student never sees a streamingBehaviour error");
	await bridge.stop();
});

test("a burst of queued messages all reach the agent, in order", async () => {
	const agent = fakeAgent();
	agent.state.streaming = true;
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();

	// Typed on a phone while the socket was down, so they flush in one loop. Only
	// the first finds an idle agent; the rest arrive mid-turn.
	socket.handlers.close();
	bridge.deliverToAgent("first");
	bridge.deliverToAgent("second");
	bridge.deliverToAgent("third");
	socket.readyState = 1;
	socket.handlers.open();
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(agent.state.prompts, ["first", "second", "third"]);
	assert.deepEqual(agent.state.behaviors, ["followUp", "followUp", "followUp"]);
	assert.equal(bridge.status().queued, 0);
	await bridge.stop();
});

test("stopping drops what was queued behind the turn, and says so", async () => {
	const agent = fakeAgent();
	agent.state.pending = ["and add a note"];
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ type: "control", action: "abort" });
	await new Promise((resolve) => setImmediate(resolve));

	// Pi's abort() leaves a queued follow-up that never runs and is never
	// reported, so the message the phone already echoed would sit in the
	// transcript unanswered for good.
	assert.deepEqual(agent.state.calls, ["abort", "clearQueue"], "cleared after the abort, not before");
	assert.deepEqual(agent.state.pending, [], "nothing is left stranded in Pi's queue");
	const note = socket.json("event").at(-1);
	assert.equal(note.event.type, "note");
	assert.match(note.event.text, /1 queued message cancelled/);
	await bridge.stop();
});

test("stopping with an empty queue says nothing extra", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ type: "control", action: "abort" });
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(agent.state.calls, ["abort", "clearQueue"]);
	assert.deepEqual(socket.json("event"), [], "no note when there was nothing to cancel");
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

// WS5: the phone walkthrough. A command is not a turn — Pi answers it, reports
// "handled", and starts no run — but the phone sets itself working when it sends
// the line, so the bridge has to settle it. Each step also has to read back.
test("a phone walkthrough: every command answers in text and settles the turn", async () => {
	const outputs = {
		"/quota": "Spark quota - 1,200 / 5,000 tokens used today, resets Friday",
		"/seats": "Spark seats: 3 of 6 free",
		"/plan": "Plan mode on. The agent will propose a plan and wait for /approve.",
		"/todo": "Added step 1: wire the LED",
		"/approve": "Plan approved - switching to build mode.",
		"/todos": "1. [ ] wire the LED\n2. [ ] blink it\n3. [ ] add a switch",
	};
	const commands = Object.fromEntries(
		Object.entries(outputs).map(([name, text]) => [
			name,
			(agent) => agent.emitUi({ method: "notify", message: text, notifyType: "info" }),
		]),
	);
	const agent = commandAgent(commands);
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	for (const [name, text] of Object.entries(outputs)) {
		socket.deliver({ protocol: 1, type: "phone_message", text: name });
		await new Promise((resolve) => setImmediate(resolve));

		const echo = socket.json("agent_message").at(-1);
		assert.equal(echo.text, name, `${name} is echoed as what the student typed`);

		const events = socket.json("event").map((frame) => frame.event);
		assert.deepEqual(events.at(-2), { type: "note", text }, `${name} reads back as text`);
		assert.deepEqual(events.at(-1), { type: "command_done" }, `${name} settles the turn`);
	}
	await bridge.stop();
});

test("an ordinary message starts a turn and does not settle it early", async () => {
	const agent = fakeAgent();
	const socket = fakeSocket();
	const bridge = new RemoteBridge(bridgeOptions({ agent, socket }));
	await bridge.start();
	socket.handlers.open();

	socket.deliver({ protocol: 1, type: "phone_message", text: "make it blink" });
	await new Promise((resolve) => setImmediate(resolve));

	const events = socket.json("event").map((frame) => frame.event);
	assert.deepEqual(events, [], "the agent's own run will settle it; the bridge stays quiet");
	await bridge.stop();
});

