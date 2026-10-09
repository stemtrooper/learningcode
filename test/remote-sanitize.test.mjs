import assert from "node:assert/strict";
import test from "node:test";
import { redact, sanitizeAgentEvent, sanitizeMessages } from "../lib/remote/sanitize.mjs";

/** The two secrets that must never reach a phone. */
const SPARK_TOKEN = "spark_live_abcd1234efgh5678";
const ENROLL_KEY = "school-enrolment-key-2026";

test("a Spark token can never leave the machine", () => {
	// The agent runs student shell commands, so "run env" is a realistic
	// request and a tool event echoing its command would ship the environment.
	for (const carrier of [
		`SPARK_API_KEY=${SPARK_TOKEN}`,
		`Authorization: Bearer ${SPARK_TOKEN}`,
		{ type: "error", error: `failed with token ${SPARK_TOKEN}` },
	]) {
		const result = sanitizeAgentEvent(
			carrier?.type === "error"
				? carrier
				: { type: "tool_execution_end", toolName: "bash", ok: false, error: carrier },
		);
		assert.ok(result, "event survives sanitising");
		assert.ok(
			!JSON.stringify(result).includes("abcd1234"),
			"token must be redacted: " + JSON.stringify(result),
		);
	}
	assert.ok(!redact(`key=${SPARK_TOKEN}`).includes("abcd1234"));
});

test("the enrolment key is redacted wherever it appears", () => {
	const event = sanitizeAgentEvent({
		type: "tool_execution_end",
		toolName: "bash",
		ok: false,
		error: `curl -H "Authorization: Bearer ${ENROLL_KEY}" failed`,
	});
	assert.ok(!JSON.stringify(event).includes(ENROLL_KEY));
	assert.match(JSON.stringify(event), /redacted/);
});

test("unknown event types are dropped, not forwarded", () => {
	assert.equal(sanitizeAgentEvent({ type: "session_started_with_sensitive_payload", leak: "x" }), null);
	assert.equal(sanitizeAgentEvent(null), null);
	assert.equal(sanitizeAgentEvent("nonsense"), null);
});

test("only text deltas of a stream are forwarded", () => {
	// Pi also streams tool-call fragments through message_update; forwarding
	// those renders as garbled JSON on a phone.
	const text = sanitizeAgentEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", text: "Looking at your sketch…" },
	});
	assert.deepEqual(text, { type: "message_update", text: "Looking at your sketch…" });
	assert.equal(
		sanitizeAgentEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } }),
		null,
	);
});

test("tool events arrive as a name plus a bounded outcome", () => {
	const started = sanitizeAgentEvent({ type: "tool_execution_start", toolName: "bash" });
	assert.deepEqual(started, { type: "tool_execution_start", toolName: "bash" });

	const ended = sanitizeAgentEvent({
		type: "tool_execution_end",
		toolName: "bash",
		error: "exit code 1",
	});
	assert.equal(ended.ok, false);
	assert.equal(ended.error, "exit code 1");
	assert.equal(sanitizeAgentEvent({ type: "tool_execution_end", toolName: "bash" }).ok, true);
});

test("oversized fields are clipped, not truncated mid-surprise", () => {
	const huge = "x".repeat(10_000);
	const event = sanitizeAgentEvent({ type: "auto_retry_start", errorMessage: huge });
	assert.ok(event.reason.length <= 4096);
});

test("history keeps the conversation and drops whole file contents", () => {
	// Pi's get_messages includes tool results with entire files. The phone gets
	// text, plus tool calls reduced to a label.
	const messages = sanitizeMessages([
		{ role: "user", content: "make the led blink" },
		{
			role: "assistant",
			content: [{ type: "text", text: "I will edit the sketch." }],
		},
		{
			role: "tool",
			content: [{ type: "text", text: "entire contents of a file that must not arrive" }],
		},
	]);
	assert.deepEqual(messages, [
		{ role: "user", text: "make the led blink" },
		{ role: "assistant", text: "I will edit the sketch." },
	]);
});

test("history is bounded to the recent tail", () => {
	const messages = Array.from({ length: 300 }, (_, i) => ({ role: "user", content: `m${i}` }));
	const trimmed = sanitizeMessages(messages);
	assert.ok(trimmed.length <= 100, `was ${trimmed.length}`);
	assert.equal(trimmed.at(-1).text, "m299", "the newest messages are kept");
});
