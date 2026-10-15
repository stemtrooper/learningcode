import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAlwaysAllow, ALWAYS_ALLOW_KEY, readAlwaysAllow } from "../lib/settings.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-settings-"));

test("readAlwaysAllow returns an empty list when there is no settings file", async () => {
	const dir = await scratch();
	try {
		assert.deepEqual(await readAlwaysAllow(dir), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAlwaysAllow returns an empty list when settings.json has no always-allow key", async () => {
	const dir = await scratch();
	try {
		await writeFile(join(dir, "settings.json"), "{}\n", "utf-8");
		assert.deepEqual(await readAlwaysAllow(dir), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("addAlwaysAllow records a command and readAlwaysAllow returns it", async () => {
	const dir = await scratch();
	try {
		const changed = await addAlwaysAllow(dir, "rm -rf build");
		assert.equal(changed, true, "first add should report a change");
		assert.deepEqual(await readAlwaysAllow(dir), ["rm -rf build"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("addAlwaysAllow is idempotent and does not duplicate", async () => {
	const dir = await scratch();
	try {
		assert.equal(await addAlwaysAllow(dir, "rm -rf build"), true);
		assert.equal(await addAlwaysAllow(dir, "rm -rf build"), false, "repeat add reports no change");
		assert.deepEqual(await readAlwaysAllow(dir), ["rm -rf build"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("addAlwaysAllow trims whitespace and ignores empty commands", async () => {
	const dir = await scratch();
	try {
		assert.equal(await addAlwaysAllow(dir, "  rm -rf build  "), true);
		assert.equal(await addAlwaysAllow(dir, ""), false);
		assert.equal(await addAlwaysAllow(dir, "   "), false);
		assert.deepEqual(await readAlwaysAllow(dir), ["rm -rf build"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("addAlwaysAllow keeps previously persisted commands across calls", async () => {
	const dir = await scratch();
	try {
		await writeFile(join(dir, "settings.json"), `${JSON.stringify({ [ALWAYS_ALLOW_KEY]: ["git reset --hard"] }, null, 2)}\n`, "utf-8");
		assert.deepEqual(await readAlwaysAllow(dir), ["git reset --hard"]);
		assert.equal(await addAlwaysAllow(dir, "rm -rf build"), true);
		const allowed = await readAlwaysAllow(dir);
		assert.deepEqual(allowed.sort(), ["git reset --hard", "rm -rf build"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAlwaysAllow ignores non-string entries in the list", async () => {
	const dir = await scratch();
	try {
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ [ALWAYS_ALLOW_KEY]: ["rm -rf build", 42, null, true, "git reset --hard"] }, null, 2)}\n`,
			"utf-8",
		);
		assert.deepEqual(await readAlwaysAllow(dir), ["rm -rf build", "git reset --hard"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the always-allow settings key is exported", () => {
	assert.equal(ALWAYS_ALLOW_KEY, "alwaysAllowCommands");
});
