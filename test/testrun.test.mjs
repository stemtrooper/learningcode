import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { summariseTestOutput } from "../lib/testrun.mjs";
import { PI_EXTENSIONS } from "../lib/pi.mjs";

test("a passing run reports all tests passed, with no failures", () => {
	const s = summariseTestOutput("ok 1 - adds\nok 2 - subtracts\n# pass 2\n# fail 0", 0);
	assert.equal(s.passed, true);
	assert.equal(s.failureCount, 0);
	assert.equal(s.report, "All tests passed.");
});

test("failures are listed by name with the message that follows", () => {
	const out = "ok 1 - adds\nnot ok 2 - subtracts\n  error: expected 3 got 2\n# fail 1";
	const s = summariseTestOutput(out, 1);
	assert.equal(s.passed, false);
	assert.equal(s.failureCount, 1);
	assert.match(s.report, /FAILED: subtracts/);
	assert.match(s.report, /expected 3 got 2/);
});

test("pytest and Jest style FAILED lines are picked up too", () => {
	const s = summariseTestOutput("FAILED tests/test_x.py::test_add - AssertionError\nFAIL src/a.test.js", 1);
	assert.equal(s.failureCount, 2);
});

test("a failing run with no recognised lines shows the tail of the output", () => {
	const s = summariseTestOutput("boom\nstack line\nfinal line", 2);
	assert.equal(s.passed, false);
	assert.match(s.report, /exit 2/);
	assert.match(s.report, /final line/);
});

test("the report is capped so one bad run cannot flood the context", () => {
	const huge = Array.from({ length: 50 }, (_, i) => `not ok ${i} - test ${i}\n${"x".repeat(200)}`).join("\n");
	const s = summariseTestOutput(huge, 1);
	assert.ok(s.failureCount <= 8);
	assert.ok(s.report.length <= 2100);
});

test("the run-tests tool is registered and runs only npm test", async () => {
	assert.ok(PI_EXTENSIONS.includes("run-tests.ts"));
	const src = await readFile(new URL("../extensions/run-tests.ts", import.meta.url), "utf-8");
	assert.match(src, /\["test", "--silent"\]/);
	assert.doesNotMatch(src, /parameters: Type\.Object\(\{\s*command/);
});