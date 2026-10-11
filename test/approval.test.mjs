import assert from "node:assert/strict";
import test from "node:test";
import { destructiveReason, formatApprovalPrompt, truncateApprovalCommand } from "../lib/approval.mjs";

test("destructive commands are caught with a plain reason", () => {
	assert.equal(destructiveReason("rm -rf build"), "deletes files");
	assert.equal(destructiveReason("git push --force origin main"), "force-pushes");
	assert.equal(destructiveReason("git reset --hard HEAD"), "discards uncommitted changes");
	assert.equal(destructiveReason("Remove-Item -Recurse foo"), "deletes files (PowerShell)");
	assert.equal(destructiveReason("npm publish"), "publishes a package");
	assert.equal(destructiveReason("sudo apt install x"), "runs as administrator");
});

test("ordinary commands pass without a prompt", () => {
	for (const cmd of ["git status", "npm test", "ls -la", "node app.js", "git add ."]) {
		assert.equal(destructiveReason(cmd), null, cmd);
	}
});

test("an empty or missing command is not flagged", () => {
	assert.equal(destructiveReason(""), null);
	assert.equal(destructiveReason(undefined), null);
});

test("long commands are truncated for the approval prompt", () => {
	const long = `rm -rf ${"a".repeat(500)}`;
	const short = truncateApprovalCommand(long);
	assert.ok(short.length <= 301, `truncated to budget, got ${short.length}`);
	assert.match(short, /…/);

	const manyLines = `rm -rf a\n${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}`;
	const clipped = truncateApprovalCommand(manyLines);
	assert.match(clipped, /\(\+.*more lines?\)/);
	assert.ok(clipped.split("\n").length <= 8, clipped);
});

test("the approval prompt keeps the question and Enter hint visible", () => {
	const prompt = formatApprovalPrompt("rm -rf build", "deletes files");
	assert.match(prompt, /Allow it\?/);
	assert.match(prompt, /Enter = Yes/);
	assert.ok(prompt.endsWith("Allow it?"), "question repeats at the end, next to Yes/No");
	// Short commands are shown in full.
	assert.match(prompt, /rm -rf build/);
});

test("a very long command still leaves a short prompt", () => {
	const huge = `rm -rf ${"x".repeat(5000)}\n${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}`;
	const prompt = formatApprovalPrompt(huge, "deletes files");
	// Must fit the phone bridge's 400-char approval clip so the question survives.
	assert.ok(prompt.length <= 400, `prompt is ${prompt.length} chars`);
	assert.match(prompt, /Enter = Yes/);
	assert.ok(prompt.endsWith("Allow it?"));
});