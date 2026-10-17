import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { loadJournal } from "../lib/undo-journal.mjs";
import { journalSessionId } from "../lib/undo-record.mjs";

/**
 * A helper runs as a separate `--no-session` process, so its edits would be
 * invisible to `/undo`. The parent bridges its session id in the environment and
 * the child's undo-record extension journals into that same session.
 */

async function loadExtension() {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/undo-record.ts");
	const handlers = new Map();
	const pi = { on: (event, fn) => handlers.set(event, fn) };
	mod.default(pi);
	return handlers.get("tool_call");
}

async function withEnv(vars, fn) {
	const saved = {};
	for (const key of Object.keys(vars)) {
		saved[key] = process.env[key];
		if (vars[key] === undefined) delete process.env[key];
		else process.env[key] = vars[key];
	}
	try {
		return await fn();
	} finally {
		for (const key of Object.keys(vars)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

test("with no bridge, the recorder falls back to the session's own id", async () => {
	await withEnv({ LEARNINGCODE_UNDO_SESSION: undefined }, async () => {
		assert.equal(journalSessionId({ sessionManager: { getSessionId: () => "child-1" } }), "child-1");
	});
});

test("a bridged child edit lands in the parent's journal", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-undo-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-undo-cwd-"));
	const handler = await loadExtension();

	await withEnv({ LEARNINGCODE_DIR: agent, LEARNINGCODE_UNDO_SESSION: "parent-9" }, async () => {
		await handler(
			{ toolName: "write", input: { path: "new.txt" } },
			{ cwd, sessionManager: { getSessionId: () => "child-7" } },
		);
		const parentJournal = await loadJournal(agent, "parent-9");
		const childJournal = await loadJournal(agent, "child-7");
		assert.ok(parentJournal, "the parent's journal was written");
		assert.equal(parentJournal.entries.length, 1);
		assert.equal(parentJournal.entries[0].kind, "created");
		assert.equal(childJournal, null, "nothing landed under the child's own id");
	});
});

test("a read-only tool call is ignored", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-undo-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-undo-cwd-"));
	const handler = await loadExtension();
	await withEnv({ LEARNINGCODE_DIR: agent, LEARNINGCODE_UNDO_SESSION: "parent-9" }, async () => {
		await handler({ toolName: "read", input: { path: "new.txt" } }, { cwd });
		assert.equal(await loadJournal(agent, "parent-9"), null);
	});
});

test("the environment session id wins when both are present", async () => {
	// Guard against the recorder ever preferring the child's own (absent) session.
	await withEnv({ LEARNINGCODE_UNDO_SESSION: "from-env" }, async () => {
		assert.equal(journalSessionId({ sessionManager: { getSessionId: () => "from-ctx" } }), "from-env");
	});
});
