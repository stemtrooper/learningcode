import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The bug this guards against: "Allow Always" stored the exact command text, and
 * the agent rewrites a command on almost every run (temp paths, echo lines), so
 * the student was re-prompted forever. The extension now remembers the
 * destructive *kind*.
 */
async function loadExtension(agentDir, { hasUI = true } = {}) {
	process.env.LEARNINGCODE_DIR = agentDir;
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/approval.ts");
	const handlers = new Map();
	const prompts = [];
	const state = { answer: "Yes" };
	const ctx = {
		hasUI,
		ui: {
			select: async (title, options) => {
				prompts.push({ title, options });
				return state.answer;
			},
		},
	};
	const pi = { on: (event, fn) => handlers.set(event, fn) };
	mod.default(pi);
	const run = (command) => handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx);
	return { run, prompts, state };
}

test("Allow Always remembers the kind, so a rewritten command stops asking", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-always-"));
	const saved = process.env.LEARNINGCODE_DIR;
	try {
		const { run, prompts, state } = await loadExtension(dir);

		// The student approves a deleting script once.
		state.answer = "Always allow: deletes files";
		await run('rm -rf /tmp/angy-seed-test\ncd /tmp\necho "run 1"');
		assert.equal(prompts.length, 1, "the first command prompts");
		assert.deepEqual(prompts[0].options, ["Yes", "No", "Always allow: deletes files"]);

		// The agent re-runs the same intent with a different temp path and echo.
		state.answer = "Yes";
		await run('rm -rf /tmp/angy-seed-debug\ncd /tmp\necho "run 2 — different text"');
		assert.equal(prompts.length, 1, "the same kind does NOT prompt again");

		// A different danger still asks.
		await run("git push --force origin main");
		assert.equal(prompts.length, 2, "a different kind still prompts");

		// The remembered kind is on disk for the next session.
		const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
		assert.deepEqual(settings.alwaysAllowKinds, ["delete-files"]);
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
		await rm(dir, { recursive: true, force: true });
	}
});

test("a compound command shows and remembers every kind it carries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-always-multi-"));
	const saved = process.env.LEARNINGCODE_DIR;
	try {
		const { run, prompts, state } = await loadExtension(dir);

		// `sudo rm -rf /` is two dangers. Reporting only the first would both
		// understate it and remember less than the student just approved.
		state.answer = "Always allow: deletes files, runs as administrator";
		await run("sudo rm -rf /tmp/x");
		assert.equal(prompts.length, 1);
		assert.deepEqual(prompts[0].options, [
			"Yes",
			"No",
			"Always allow: deletes files, runs as administrator",
		]);

		const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
		assert.deepEqual([...settings.alwaysAllowKinds].sort(), ["delete-files", "sudo"]);

		// Each remembered kind stands on its own, so neither half re-prompts.
		state.answer = "Yes";
		await run("rm -rf /tmp/y");
		await run("sudo apt-get update");
		assert.equal(prompts.length, 1, "both kinds are pre-approved");
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
		await rm(dir, { recursive: true, force: true });
	}
});

test("a settings file from before kinds still honours the exact command", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-always-legacy-"));
	const saved = process.env.LEARNINGCODE_DIR;
	try {
		const command = "rm -rf build";
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ alwaysAllowCommands: [command] }, null, 2)}\n`,
			"utf-8",
		);
		const { run, prompts } = await loadExtension(dir);
		await run(command);
		assert.equal(prompts.length, 0, "the legacy exact match is still honoured");
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
		await rm(dir, { recursive: true, force: true });
	}
});

test("without a UI a destructive command is blocked, never silently allowed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-always-noui-"));
	const saved = process.env.LEARNINGCODE_DIR;
	try {
		const { run, prompts } = await loadExtension(dir, { hasUI: false });
		const result = await run("sudo rm -rf /");
		assert.equal(result.block, true);
		assert.match(result.reason, /no one to confirm/);
		assert.equal(prompts.length, 0);
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
		await rm(dir, { recursive: true, force: true });
	}
});
