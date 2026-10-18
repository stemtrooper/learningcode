import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAlwaysAllow, addAlwaysAllowKind, ALWAYS_ALLOW_KEY, ALWAYS_ALLOW_KINDS_KEY, extendModelScope, PACE_RESERVE_KEY, readAlwaysAllow, readAlwaysAllowKinds, readPaceReserve, readPlanStrict, scopedProviders, SCOPED_PROVIDERS_KEY, setPaceReserve, setPlanStrict } from "../lib/settings.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-settings-"));

test("the strict plan preset reads false by default and round-trips", async () => {
	const dir = await scratch();
	try {
		assert.equal(await readPlanStrict(dir), false, "absent file means off");
		assert.equal(await setPlanStrict(dir, true), true, "first change reports a change");
		assert.equal(await readPlanStrict(dir), true);
		assert.equal(await setPlanStrict(dir, true), false, "repeat is a no-op");
		assert.equal(await setPlanStrict(dir, false), true);
		assert.equal(await readPlanStrict(dir), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the pace reserve reads 0 by default and round-trips", async () => {
	const dir = await scratch();
	try {
		assert.equal(PACE_RESERVE_KEY, "paceReserve");
		assert.equal(await readPaceReserve(dir), 0, "absent file means off");
		assert.equal(await setPaceReserve(dir, 3), true, "first change reports a change");
		assert.equal(await readPaceReserve(dir), 3);
		assert.equal(await setPaceReserve(dir, 3), false, "repeat is a no-op");
		assert.equal(await setPaceReserve(dir, 0), true);
		assert.equal(await readPaceReserve(dir), 0, "off clears it");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a junk pace reserve reads as off rather than throwing", async () => {
	const dir = await scratch();
	try {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ [PACE_RESERVE_KEY]: -4 }), "utf-8");
		assert.equal(await readPaceReserve(dir), 0);
		assert.equal(await setPaceReserve(dir, "banana"), true, "junk normalises to off");
		assert.equal(await readPaceReserve(dir), 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

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

test("always-allow kinds are recorded, idempotent, and kept alongside commands", async () => {
	const dir = await scratch();
	try {
		await addAlwaysAllow(dir, "rm -rf build"); // the old exact-string list
		assert.equal(await addAlwaysAllowKind(dir, "delete-files"), true);
		assert.equal(await addAlwaysAllowKind(dir, "delete-files"), false, "repeat add reports no change");
		assert.equal(await addAlwaysAllowKind(dir, ""), false);
		assert.deepEqual(await readAlwaysAllowKinds(dir), ["delete-files"]);
		// The two lists do not clobber each other.
		assert.deepEqual(await readAlwaysAllow(dir), ["rm -rf build"]);
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
		assert.deepEqual(raw[ALWAYS_ALLOW_KINDS_KEY], ["delete-files"]);
		assert.equal(ALWAYS_ALLOW_KINDS_KEY, "alwaysAllowKinds");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAlwaysAllowKinds tolerates a missing key and junk entries", async () => {
	const dir = await scratch();
	try {
		assert.deepEqual(await readAlwaysAllowKinds(dir), []);
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ [ALWAYS_ALLOW_KINDS_KEY]: ["sudo", 7, null, "delete-files"] }, null, 2)}\n`,
			"utf-8",
		);
		assert.deepEqual(await readAlwaysAllowKinds(dir), ["sudo", "delete-files"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the scoped-providers key is exported", () => {
	assert.equal(SCOPED_PROVIDERS_KEY, "scopedProviders");
});

test("scopedProviders reads the recorded ids and tolerates junk", async () => {
	const dir = await scratch();
	try {
		assert.deepEqual([...(await scopedProviders(dir))], [], "absent means none");
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ [SCOPED_PROVIDERS_KEY]: ["orcarouter", 5, null, "tlc-spark"] }, null, 2)}\n`,
			"utf-8",
		);
		assert.deepEqual([...(await scopedProviders(dir))].sort(), ["orcarouter", "tlc-spark"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extendModelScope folds patterns in once and records providers", async () => {
	const dir = await scratch();
	try {
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ enabledModels: ["tlc-spark/TLC-Spark"] }, null, 2)}\n`,
			"utf-8",
		);
		assert.equal(
			await extendModelScope(dir, { patterns: ["orcarouter/openai/gpt-4o-mini"], providers: ["orcarouter"] }),
			true,
			"first extension writes",
		);
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
		assert.deepEqual(raw.enabledModels, ["tlc-spark/TLC-Spark", "orcarouter/openai/gpt-4o-mini"]);
		assert.deepEqual(raw[SCOPED_PROVIDERS_KEY], ["orcarouter"]);
		assert.equal(
			await extendModelScope(dir, { patterns: ["orcarouter/openai/gpt-4o-mini"], providers: ["orcarouter"] }),
			false,
			"repeat is a no-op",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extendModelScope never seeds an absent scope on its own", async () => {
	const dir = await scratch();
	try {
		// Recording a provider with no patterns must not invent an enabledModels
		// key — seeding is the launcher's job, and only when a scope exists is
		// the student's curated list authoritative.
		assert.equal(await extendModelScope(dir, { providers: ["tlc-spark"] }), true);
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
		assert.equal(raw.enabledModels, undefined);
		assert.deepEqual(raw[SCOPED_PROVIDERS_KEY], ["tlc-spark"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
