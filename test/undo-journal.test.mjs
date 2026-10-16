import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	journalDir,
	loadJournal,
	recordChange,
	restoreJournal,
	summarizeJournal,
} from "../lib/undo-journal.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-undo-"));

test("a file the agent creates is removed, not restored", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	await recordChange(agent, "s1", cwd, "new.txt");
	await writeFile(join(cwd, "new.txt"), "hello", "utf-8");

	const result = await restoreJournal(agent, "s1");
	assert.deepEqual(result.removed, [join(cwd, "new.txt")]);
	await assert.rejects(readFile(join(cwd, "new.txt"), "utf-8"));
});

test("an existing file is restored to its pre-change contents", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	const file = join(cwd, "code.js");
	await writeFile(file, "original", "utf-8");
	await recordChange(agent, "s1", cwd, "code.js");
	await writeFile(file, "the agent rewrote this", "utf-8");

	const result = await restoreJournal(agent, "s1");
	assert.deepEqual(result.restored, [file]);
	assert.equal(await readFile(file, "utf-8"), "original");
});

test("only the earliest pre-state is kept across repeated edits", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	const file = join(cwd, "f.txt");
	await writeFile(file, "v1", "utf-8");
	await recordChange(agent, "s1", cwd, "f.txt");
	await writeFile(file, "v2", "utf-8");
	await recordChange(agent, "s1", cwd, "f.txt"); // must not overwrite the v1 backup

	const manifest = await loadJournal(agent, "s1");
	assert.equal(manifest.entries.length, 1);
	await writeFile(file, "v3", "utf-8");
	await restoreJournal(agent, "s1");
	assert.equal(await readFile(file, "utf-8"), "v1");
});

test("a directory target is recorded as skipped, not copied", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	await mkdir(join(cwd, "adir"));
	await recordChange(agent, "s1", cwd, "adir");
	const manifest = await loadJournal(agent, "s1");
	assert.equal(manifest.entries[0].kind, "skipped");
	const result = await restoreJournal(agent, "s1");
	assert.deepEqual(result.skipped, [join(cwd, "adir")]);
});

test("the journal is cleared after a restore, so undo does not run twice", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	await recordChange(agent, "s1", cwd, "gone.txt");
	await restoreJournal(agent, "s1");
	assert.equal(await loadJournal(agent, "s1"), null);
});

test("summary paths are relative to the project cwd", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	await recordChange(agent, "s1", cwd, "src/app.js");
	const summary = summarizeJournal(await loadJournal(agent, "s1"), cwd);
	assert.deepEqual(summary.created, [join("src", "app.js")]);
});

test("no session or no journal is a clean no-op", async () => {
	const agent = await scratch();
	assert.equal(await loadJournal(agent, "missing"), null);
	const result = await restoreJournal(agent, "missing");
	assert.deepEqual(result, { restored: [], removed: [], skipped: [] });
	// A missing dir must not throw.
	await recordChange(agent, "", "/tmp", "x");
	assert.equal(journalDir(agent, ""), join(agent, "undo", "session"));
});

test("a target outside the project is never recorded", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	const outside = join(await scratch(), "elsewhere.txt");
	await writeFile(outside, "original", "utf-8");

	// Absolute path outside cwd, and a relative escape: both declined, and
	// nothing is written for a journal that has nothing to say.
	await recordChange(agent, "s1", cwd, outside);
	await recordChange(agent, "s1", cwd, join("..", "escape.txt"));
	assert.equal(await loadJournal(agent, "s1"), null);
});

test("restore skips a manifest entry outside the project", async () => {
	const agent = await scratch();
	const cwd = await scratch();
	const outside = join(await scratch(), "victim.txt");
	await writeFile(outside, "keep me", "utf-8");

	// A legacy or hand-edited manifest naming a stranger's file must not touch it.
	const dir = journalDir(agent, "legacy");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		`${JSON.stringify({ cwd, entries: [{ path: outside, kind: "modified", backup: "nope" }] })}\n`,
		"utf-8",
	);

	const result = await restoreJournal(agent, "legacy");
	assert.deepEqual(result.skipped, [outside]);
	assert.equal(await readFile(outside, "utf-8"), "keep me");
});
