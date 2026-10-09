import assert from "node:assert/strict";
import test from "node:test";
import { destructiveReason } from "../lib/approval.mjs";

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