import assert from "node:assert/strict";
import test from "node:test";
import { RemoteConsole, formatStatusLine, statusFields, toolTarget } from "../lib/remote/console.mjs";

/** A write() that records every chunk, so escape sequences can be asserted. */
function capture() {
	const chunks = [];
	return { write: (text) => chunks.push(text), chunks, text: () => chunks.join("") };
}

test("toolTarget names the file for an editor tool", () => {
	assert.equal(toolTarget("edit", { file_path: "src/app.js" }), "src/app.js");
	assert.equal(toolTarget("write", { path: "notes/todo.md" }), "notes/todo.md");
});

test("toolTarget keeps the last two path segments so a long path still reads", () => {
	assert.equal(toolTarget("read", { file_path: "/home/ada/projects/homework-3/src/app.js" }), "…/src/app.js");
});

test("toolTarget names the command for bash, and redacts a secret in it", () => {
	assert.equal(toolTarget("bash", { command: "npm test" }), "npm test");
	const redacted = toolTarget("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" });
	assert.match(redacted, /\[redacted\]/);
	assert.doesNotMatch(redacted, /abcdefghijklmnop/);
});

test("toolTarget is empty when there is nothing worth showing", () => {
	assert.equal(toolTarget("questionnaire", {}), "");
	assert.equal(toolTarget(undefined, undefined), "");
});

test("the status line leads with the dot and the activity, so it survives narrowing", () => {
	const wide = formatStatusLine(
		{ online: true, activity: "running edit …/src/app.js", folder: "homework-3", model: "TLC-Spark", phones: 1, queued: 2 },
		100,
	);
	assert.match(wide, /● running edit …\/src\/app\.js/);
	assert.match(wide, /homework-3/);
	assert.match(wide, /1 phone/);
	assert.match(wide, /\+2 queued/);

	const narrow = formatStatusLine({ online: true, activity: "running edit …/src/app.js", folder: "homework-3" }, 20);
	assert.match(narrow, /running edit/, "the activity is the field that must not drop");
	assert.doesNotMatch(narrow, /homework-3/, "the folder drops before the activity");
	assert.ok(narrow.length <= 20);
});

test("offline shows reconnecting, not a stale activity", () => {
	const fields = statusFields({ online: false, activity: "running edit x", folder: "homework-3" });
	assert.equal(fields[0], "○ reconnecting");
	assert.doesNotMatch(fields.join(" "), /running edit/);
});

test("RemoteConsole paints a status line in place and scrolls log lines above it", () => {
	const out = capture();
	const screen = new RemoteConsole({ write: out.write, tty: true, width: 100 });
	screen.setState({ online: true, phones: 1, folder: "homework-3", model: "TLC-Spark", activity: "idle" });
	assert.match(out.text(), /● idle/);
	assert.ok(out.text().includes("\r\x1b[2K"), "the status row is repainted, not appended");

	out.chunks.length = 0;
	screen.log("✓ read …/src/app.js");
	const afterLog = out.text();
	assert.match(afterLog, /✓ read …\/src\/app\.js/, "the log line is written");
	assert.match(afterLog, /● idle/, "the status line is repainted below it");
});

test("RemoteConsole logs a connection change once, not on every presence frame", () => {
	const out = capture();
	const screen = new RemoteConsole({ write: out.write, tty: false });
	screen.onStatus({ online: true, phones: 0 });
	screen.onStatus({ online: true, phones: 1 });
	screen.onStatus({ online: true, phones: 2 });
	assert.equal(out.text().match(/connected/g)?.length, 1, "one connect line for three frames");

	out.chunks.length = 0;
	screen.onStatus({ online: false, phones: 0 });
	assert.match(out.text(), /disconnected, reconnecting/);
});

test("RemoteConsole on a pipe writes plain lines with no cursor codes", () => {
	const out = capture();
	const screen = new RemoteConsole({ write: out.write, tty: false });
	screen.setState({ online: true, activity: "idle" });
	assert.equal(out.text(), "", "no status line without a TTY");
	screen.log("hello");
	assert.equal(out.text(), "hello\n");
});

test("RemoteConsole remembers a tool's target from start to finish", () => {
	const out = capture();
	const screen = new RemoteConsole({ write: out.write, tty: false });
	screen.onEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { file_path: "/a/b/src/app.js" } });
	screen.onEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" });
	screen.onEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "npm test" } });
	screen.onEvent({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", isError: true });
	const text = out.text();
	assert.match(text, /✓ read …\/src\/app\.js/);
	assert.match(text, /✗ bash npm test/);
});

test("the console names a helper on the finish line and shows its one-line result", () => {
	const out = capture();
	const screen = new RemoteConsole({ write: out.write, tty: false });
	screen.onEvent({
		type: "tool_execution_start",
		toolCallId: "h1",
		toolName: "subagent",
		args: { agent: "scout", task: "look around" },
	});
	screen.onEvent({
		type: "tool_execution_end",
		toolCallId: "h1",
		toolName: "subagent",
		result: { details: { mode: "single", runs: [{ agent: "scout", ok: true, text: "found the tests" }] } },
	});
	const text = out.text();
	assert.match(text, /✓ scout/, "the helper is named");
	assert.doesNotMatch(text, /subagent/, "not the bare tool name");
	assert.match(text, /✓ scout: found the tests/, "the helper's own first line is shown");
});
