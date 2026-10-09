import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeExtensionUi } from "../lib/remote/sanitize.mjs";
import { PiRpcAdapter } from "../lib/remote/agent.mjs";
import { AGENT_COMMANDS, PHONE_FRAMES, PHONE_EVENTS } from "../lib/remote/protocol.mjs";

test("an approval dialog reaches the phone with its id and plain options", () => {
	const note = sanitizeExtensionUi({
		method: "select",
		id: "req-1",
		title: "This command deletes files:\n\n  rm -rf build\n\nAllow it?",
		options: ["Yes", "No"],
	});
	assert.equal(note.type, "approval");
	assert.equal(note.id, "req-1");
	assert.deepEqual(note.options, ["Yes", "No"]);
	assert.match(note.title, /rm -rf build/);
});

test("approval options are capped in count and length", () => {
	const note = sanitizeExtensionUi({
		method: "select",
		id: "x",
		title: "t",
		options: ["a", "b", "c", "d", "e", "f", "g".repeat(200)],
	});
	assert.equal(note.options.length, 4);
	assert.ok(note.options.every((o) => o.length <= 60));
});

test("a malformed select is ignored rather than shown", () => {
	assert.equal(sanitizeExtensionUi({ method: "select", id: "x", options: ["Yes"] }), null);
});

test("the approval answer and frame types are part of the protocol", () => {
	assert.ok(AGENT_COMMANDS.includes("approval_answer"));
	assert.ok(PHONE_FRAMES.includes("approval"));
	assert.ok(PHONE_EVENTS.includes("approval"));
});

test("the agent adapter answers a dialog with the id Pi asked about", () => {
	const written = [];
	const adapter = new PiRpcAdapter({ cliPath: "x", cwd: ".", env: {}, args: [] });
	adapter.child = {
		exitCode: null,
		stdin: { writable: true, write: (line) => written.push(line) },
	};
	assert.equal(adapter.answerExtensionUi("req-9", { value: "Yes" }), true);
	const sent = JSON.parse(written[0]);
	assert.equal(sent.type, "extension_ui_response");
	assert.equal(sent.id, "req-9");
	assert.equal(sent.value, "Yes");
});

test("an answer is refused when the agent is not running", () => {
	const adapter = new PiRpcAdapter({ cliPath: "x", cwd: ".", env: {}, args: [] });
	assert.equal(adapter.answerExtensionUi("req-9", { value: "Yes" }), false);
});