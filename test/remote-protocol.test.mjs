import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_FRAMES,
	AGENT_COMMANDS,
	PHONE_FRAMES,
	PHONE_EVENTS,
	LIMITS,
	describeAgentEvent,
	frame,
	normalizeMessage,
	parseFrame,
	ProtocolError,
} from "../lib/remote/protocol.mjs";

const ALL = new Set([...AGENT_FRAMES, ...AGENT_COMMANDS, ...PHONE_FRAMES, ...PHONE_EVENTS]);

test("every frame type on the wire is declared in the protocol module", () => {
	// The whitelists and the parser must agree, or a legal frame gets rejected.
	for (const type of AGENT_FRAMES.concat(AGENT_COMMANDS, PHONE_FRAMES, PHONE_EVENTS)) {
		const parsed = parseFrame(JSON.stringify({ type }));
		assert.equal(parsed.type, type);
	}
});

test("unknown frame types are rejected, not ignored", () => {
	// A silent drop is the failure mode where a student types a message and
	// nothing happens. Failing loudly is the fix.
	assert.throws(() => parseFrame(JSON.stringify({ type: "install_a_backdoor" })), ProtocolError);
	assert.throws(() => parseFrame("not json"), ProtocolError);
	assert.throws(() => parseFrame(JSON.stringify([1, 2, 3])), ProtocolError);
	assert.throws(() => parseFrame("x".repeat(300 * 1024)), ProtocolError);
});

test("phone messages are bounded and trimmed", () => {
	assert.equal(normalizeMessage("  hello  "), "hello");
	assert.throws(() => normalizeMessage(""), ProtocolError);
	assert.throws(() => normalizeMessage("   "), ProtocolError);
	assert.throws(() => normalizeMessage("x".repeat(LIMITS.message + 1)), ProtocolError);
	assert.equal(normalizeMessage(`@file photo ok`), "@file photo ok", "file mentions are text");
});

test("every outgoing frame carries the protocol version", () => {
	assert.equal(frame("ping").protocol, 1);
	assert.equal(frame("phone_message", { text: "hi" }).text, "hi");
});

test("the phone UI's description of an agent event stays useful", () => {
	// Only these shapes drive the UI; anything else is deliberately dropped so a
	// new Pi event cannot flood a phone with noise.
	assert.deepEqual(describeAgentEvent({ type: "agent_start" }), "Thinking…");
	assert.equal(describeAgentEvent({ type: "agent_end" }), "Done");
	assert.deepEqual(describeAgentEvent({ type: "tool_execution_start", toolName: "bash" }), {
		running: "bash",
	});
	assert.equal(describeAgentEvent({ type: "tool_execution_end", toolName: "bash" }).ran, "bash");
	assert.equal(describeAgentEvent({ type: "queue_update" }), undefined);
	assert.equal(describeAgentEvent({ type: "made_up_event" }), undefined);
	assert.equal(
		describeAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "hi" } })
			.text,
		"hi",
	);
});
