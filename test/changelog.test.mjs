import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGELOG, formatNotice, isNewer, markNoticeShown, pendingNotice } from "../lib/changelog.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-changelog-"));

test("version comparison is numeric, so 0.10.0 is newer than 0.9.0", () => {
	assert.equal(isNewer("0.5.0", "0.4.12"), true);
	assert.equal(isNewer("0.10.0", "0.9.0"), true, "not a string compare");
	assert.equal(isNewer("0.4.12", "0.4.12"), false);
	assert.equal(isNewer("0.4.11", "0.5.0"), false);
});

test("a student who has never run learningcode sees the notice for this version", async () => {
	const notice = await pendingNotice("0.5.0", await scratch());
	assert.ok(notice, "a fresh install shows what the tool can do");
	assert.equal(notice.version, "0.5.0");
});

test("the notice is shown once: after it is marked, the same version shows nothing", async () => {
	const dir = await scratch();
	assert.ok(await pendingNotice("0.5.0", dir));
	await markNoticeShown("0.5.0", dir);
	assert.equal(await pendingNotice("0.5.0", dir), null);
});

test("an upgrade shows the new notice even after an older one was seen", async () => {
	const dir = await scratch();
	await writeFile(join(dir, "last-seen-version"), "0.4.12\n");
	const notice = await pendingNotice("0.5.0", dir);
	assert.ok(notice, "0.4.12 -> 0.5.0 is an upgrade");
});

test("a downgrade or a re-run of an older version does not show the notice again", async () => {
	const dir = await scratch();
	await writeFile(join(dir, "last-seen-version"), "0.5.0\n");
	assert.equal(await pendingNotice("0.4.12", dir), null);
});

test("a version with no changelog entry shows nothing rather than a blank box", async () => {
	const dir = await scratch();
	assert.equal(await pendingNotice("9.9.9", dir), null);
});

test("the notice tells students the command to type", () => {
	const text = formatNotice(CHANGELOG[0]);
	assert.match(text, /learningcode remote/);
	assert.match(text, /QR code/);
	assert.match(text, /--resume/);
});

test("an unwritable agent folder does not stop learningcode from starting", async () => {
	// Pointing the marker at a path under a file makes the write fail; the call
	// must still resolve, because a read-only home must never block a student.
	const dir = await scratch();
	const blocker = join(dir, "not-a-folder");
	await writeFile(blocker, "x");
	await markNoticeShown("0.5.0", join(blocker, "nested"));
	const kept = await readFile(blocker, "utf-8");
	assert.equal(kept, "x");
});
