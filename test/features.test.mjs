import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PI_EXTENSIONS } from "../lib/pi.mjs";

test("the new features are registered as launch extensions", () => {
	for (const name of ["approval.ts", "done-sound.ts", "checkpoint.ts"]) {
		assert.ok(PI_EXTENSIONS.includes(name), `${name} is loaded on every launch`);
	}
});

test("the approval extension asks before a destructive command and blocks without a UI", async () => {
	const src = await readFile(new URL("../extensions/approval.ts", import.meta.url), "utf-8");
	assert.match(src, /ctx\.ui\.select\(/);
	assert.match(src, /block: true/);
	assert.match(src, /ctx\.hasUI/);
});

test("the done sound rings once per turn, on agent_settled, in the terminal only", async () => {
	const src = await readFile(new URL("../extensions/done-sound.ts", import.meta.url), "utf-8");
	assert.match(src, /pi\.on\("agent_settled"/);
	assert.match(src, /\[console\]::Beep\(800, 300\)/);
	assert.doesNotMatch(src, /detached: true/);
	assert.match(src, /ctx\.hasUI/);
});

test("undo restores tracked files to HEAD, and warns before discarding work", async () => {
	const src = await readFile(new URL("../extensions/checkpoint.ts", import.meta.url), "utf-8");
	assert.match(src, /"checkout", "HEAD", "--", "\."/);
	assert.match(src, /ALL uncommitted changes/);
	assert.match(src, /registerCommand\("undo"/);
});

test("the phone plays the done chime on settle and unlocks audio on a tap", async () => {
	const { remoteWebUi } = await import("../lib/remote/web-ui.mjs");
	const html = remoteWebUi();
	assert.match(html, /function playDoneChime/);
	assert.match(html, /if \(event\.type === "agent_settled"\) \{[\s\S]*playDoneChime\(\)/);
	assert.match(html, /pointerdown", unlockAudio/);
});