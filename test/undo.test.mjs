import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The checkpoint extension over a fake Pi and temp dirs. There is no git here
 * (the exec stub answers "no HEAD"), so these exercise the journal layer that
 * covers files the agent creates or overwrites and git cannot restore.
 */
async function loadExtension({ cwd, sessionId = "sess-1", select = "Yes" }) {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/checkpoint.ts");
	const handlers = new Map();
	const commands = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			select: async () => select,
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		exec: async () => ({ code: 1, stdout: "", stderr: "" }), // no git
	};
	mod.default(pi);
	return { handlers, commands, notices, ctx };
}

async function withAgentDir(dir, fn) {
	const saved = process.env.LEARNINGCODE_DIR;
	process.env.LEARNINGCODE_DIR = dir;
	try {
		return await fn();
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
	}
}

test("undo removes a file the agent created and reports it", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-ckpt-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-ckpt-cwd-"));
	await withAgentDir(agent, async () => {
		const { handlers, commands, notices, ctx } = await loadExtension({ cwd });
		// The agent is about to write new.txt; record the pre-state first.
		await handlers.get("tool_call")({ toolName: "write", input: { path: "new.txt", content: "x" } }, ctx);
		await writeFile(join(cwd, "new.txt"), "x", "utf-8"); // the tool runs

		await commands.get("undo").handler("", ctx);
		await assert.rejects(readFile(join(cwd, "new.txt"), "utf-8"));
		assert.match(notices.join("\n"), /removed 1 file the agent created/);
	});
});

test("undo restores an untracked file the agent overwrote", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-ckpt-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-ckpt-cwd-"));
	await withAgentDir(agent, async () => {
		const file = join(cwd, "notes.txt");
		await writeFile(file, "the student's own notes", "utf-8");

		const { handlers, commands, ctx } = await loadExtension({ cwd });
		await handlers.get("tool_call")({ toolName: "edit", input: { path: "notes.txt", edits: [] } }, ctx);
		await writeFile(file, "clobbered by the agent", "utf-8"); // the tool runs

		await commands.get("undo").handler("", ctx);
		assert.equal(await readFile(file, "utf-8"), "the student's own notes");
	});
});

test("the confirm lists what will be restored, and No cancels", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-ckpt-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-ckpt-cwd-"));
	await withAgentDir(agent, async () => {
		let prompt = "";
		const { handlers, commands, notices, ctx } = await loadExtension({ cwd, select: "No" });
		ctx.ui.select = async (title) => {
			prompt = title;
			return "No";
		};
		await handlers.get("tool_call")({ toolName: "write", input: { path: "made.txt", content: "x" } }, ctx);
		await writeFile(join(cwd, "made.txt"), "x", "utf-8");

		await commands.get("undo").handler("", ctx);
		assert.match(prompt, /remove 1 file the agent created/);
		assert.match(prompt, /made\.txt/);
		assert.match(prompt, /lose ALL uncommitted changes/);
		assert.equal(await readFile(join(cwd, "made.txt"), "utf-8"), "x", "No leaves the file alone");
		assert.match(notices.join("\n"), /Undo cancelled/);
	});
});

test("nothing recorded and no git reports nothing to undo", async () => {
	const agent = await mkdtemp(join(tmpdir(), "lc-ckpt-agent-"));
	const cwd = await mkdtemp(join(tmpdir(), "lc-ckpt-cwd-"));
	await withAgentDir(agent, async () => {
		const { commands, notices, ctx } = await loadExtension({ cwd });
		await commands.get("undo").handler("", ctx);
		assert.match(notices.join("\n"), /Nothing to undo/);
	});
});
