import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import {
	AUTO_INTRO_ENV,
	INTRO_OPENER,
	NO_INTRO_ENV,
	hasSeenIntro,
	markIntroSeen,
	shouldAutoIntro,
} from "../lib/intro.mjs";

test("the opener discloses cost and lists four steps", () => {
	assert.match(INTRO_OPENER, /5-minute/);
	assert.match(INTRO_OPENER, /token/i); assert.match(INTRO_OPENER, /type skip/i);
	assert.match(INTRO_OPENER, /Shift\+Tab/);
	assert.match(INTRO_OPENER, /\/quota/);
});

test("auto-intro only on bare interactive first launches", () => {
	const base = { interactive: true, seen: false, noIntro: false, hasInitialPrompt: false };
	assert.equal(shouldAutoIntro(base), true);
	assert.equal(shouldAutoIntro({ ...base, interactive: false }), false);
	assert.equal(shouldAutoIntro({ ...base, seen: true }), false);
	assert.equal(shouldAutoIntro({ ...base, noIntro: true }), false);
	assert.equal(shouldAutoIntro({ ...base, hasInitialPrompt: true }), false, "never hijacks a typed message");
});

test("the marker round-trips", async () => {
	const dir = await mkdtemp(join(tmpdir(), "intro-"));
	try {
		assert.equal(hasSeenIntro(dir), false);
		await markIntroSeen(dir);
		assert.equal(hasSeenIntro(dir), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function harness() {
	const dirPromise = mkdtemp(join(tmpdir(), "intro-ext-"));
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		sendUserMessage: (content) => sent.push(content),
	};
	return { dirPromise, handlers, commands, sent, notices, ctx, pi };
}

test("the extension auto-posts once on a bare first launch", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/intro.ts");
	const h = harness();
	const dir = await h.dirPromise;
	const prevAuto = process.env[AUTO_INTRO_ENV];
	const prevNo = process.env[NO_INTRO_ENV];
	const prevDir = process.env.LEARNINGCODE_DIR;
	try {
		process.env[AUTO_INTRO_ENV] = "1";
		delete process.env[NO_INTRO_ENV];
		process.env.LEARNINGCODE_DIR = dir;

		mod.default(h.pi);
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 1, "opener posted");
		assert.equal(h.sent[0], INTRO_OPENER);

		// Second session: marker present, stays silent.
		h.sent.length = 0;
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 0, "no repeat tour");
	} finally {
		if (prevAuto === undefined) delete process.env[AUTO_INTRO_ENV];
		else process.env[AUTO_INTRO_ENV] = prevAuto;
		if (prevNo === undefined) delete process.env[NO_INTRO_ENV];
		else process.env[NO_INTRO_ENV] = prevNo;
		if (prevDir === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = prevDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("the extension stays silent without the auto env or with --no-intro", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/intro.ts");
	const h = harness();
	const dir = await h.dirPromise;
	const prevAuto = process.env[AUTO_INTRO_ENV];
	const prevNo = process.env[NO_INTRO_ENV];
	const prevDir = process.env.LEARNINGCODE_DIR;
	try {
		delete process.env[AUTO_INTRO_ENV];
		delete process.env[NO_INTRO_ENV];
		process.env.LEARNINGCODE_DIR = dir;

		mod.default(h.pi);
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 0, "no auto env means no tour");

		process.env[AUTO_INTRO_ENV] = "1";
		process.env[NO_INTRO_ENV] = "1";
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 0, "--no-intro wins");

		// /intro replays regardless.
		delete process.env[NO_INTRO_ENV];
		await h.commands.get("intro").handler("", h.ctx);
		assert.equal(h.sent.length, 1, "/intro reposts the opener");
	} finally {
		if (prevAuto === undefined) delete process.env[AUTO_INTRO_ENV];
		else process.env[AUTO_INTRO_ENV] = prevAuto;
		if (prevNo === undefined) delete process.env[NO_INTRO_ENV];
		else process.env[NO_INTRO_ENV] = prevNo;
		if (prevDir === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = prevDir;
		await rm(dir, { recursive: true, force: true });
	}
});

test("--no-intro records the opt-out so old users are asked once", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/intro.ts");
	const h = harness();
	const dir = await h.dirPromise;
	const prevAuto = process.env[AUTO_INTRO_ENV];
	const prevNo = process.env[NO_INTRO_ENV];
	const prevDir = process.env.LEARNINGCODE_DIR;
	try {
		process.env[AUTO_INTRO_ENV] = "1";
		process.env[NO_INTRO_ENV] = "1";
		process.env.LEARNINGCODE_DIR = dir;

		mod.default(h.pi);
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 0, "tour skipped");
		assert.equal(hasSeenIntro(dir), true, "skip recorded as decided");

		// Next bare launch without the flag: still silent.
		delete process.env[NO_INTRO_ENV];
		await h.handlers.get("session_start")({}, h.ctx);
		assert.equal(h.sent.length, 0, "never asked again");
	} finally {
		if (prevAuto === undefined) delete process.env[AUTO_INTRO_ENV];
		else process.env[AUTO_INTRO_ENV] = prevAuto;
		if (prevNo === undefined) delete process.env[NO_INTRO_ENV];
		else process.env[NO_INTRO_ENV] = prevNo;
		if (prevDir === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = prevDir;
		await rm(dir, { recursive: true, force: true });
	}
});
