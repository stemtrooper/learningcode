import assert from "node:assert/strict";
import test from "node:test";
import {
	agentIcon,
	clip,
	contentText,
	expandedText,
	firstLine,
	partialText,
	runningLine,
	summaryLine,
} from "../lib/subagent/render.mjs";

/**
 * Student language. The one hard rule: usage and cost never appear. The Pi
 * example prints `3 turns ↑input ↓output $cost ctx:…` — that is exactly what a
 * student must not see.
 */

const NO_USAGE = /[$↑↓]|\bturns?\b|\bcost\b|\bctx:|\btokens?\b/i;
const run = (over = {}) => ({ agent: "scout", task: "look", ok: true, text: "found 4 files", ...over });

test("the live line names the helper and says it is working", () => {
	assert.match(runningLine("scout"), /scout is working/);
	assert.match(runningLine("scout"), /🔎/);
	assert.match(runningLine("mystery"), /🤖/, "an unknown helper still gets an icon");
});

test("a finished helper shows a tick and its own first words", () => {
	const line = summaryLine(run({ text: "found 4 files\nsecond line" }));
	assert.match(line, /^✓ scout: found 4 files$/);
});

test("a failed helper is one sentence, with no diagnostic", () => {
	const line = summaryLine(run({ ok: false, text: "boom", errorMessage: "exit 1" }));
	assert.match(line, /^✗ scout couldn't finish — it hit an error\.$/);
	assert.equal(line.includes("exit 1"), false);
});

test("an aborted helper says it was stopped", () => {
	assert.match(summaryLine(run({ aborted: true })), /scout was stopped/);
});

test("nothing rendered carries usage or cost", () => {
	const sample = run({ text: "answer", usage: { input: 100, output: 200, cost: 0.5 } });
	for (const text of [summaryLine(sample), expandedText(sample), contentText([sample]), partialText([sample])]) {
		assert.doesNotMatch(text, NO_USAGE);
	}
});

test("content sent to the parent model is per-helper and capped", () => {
	const long = "x".repeat(5000);
	const text = contentText([run({ agent: "scout", text: long }), run({ agent: "worker", ok: false })], 100);
	assert.match(text, /### scout/);
	assert.match(text, /### worker/);
	assert.match(text, /hit an error/);
	assert.ok(text.length < 400, "the cap keeps the parent's context small");
});

test("expanded text shows the task and the answer", () => {
	const text = expandedText({ agent: "scout", task: "find the tests", ok: true, text: "they are in test/" });
	assert.match(text, /Task: find the tests/);
	assert.match(text, /they are in test\//);
});

test("helpers", () => {
	assert.equal(firstLine("\n\n  hi \n there"), "hi");
	assert.equal(clip("abcdef", 4), "abc…");
	assert.equal(clip("ab", 4), "ab");
	assert.equal(agentIcon("worker"), "🔧");
});
