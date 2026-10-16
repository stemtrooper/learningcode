import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PLAN_READ_TOOLS,
	STRICT_PLAN_REASON,
	addTodoItem,
	cleanStepText,
	completeTodoItem,
	extractTodoItems,
	isBlockedInPlanMode,
	isSafeCommand,
	markCompletedSteps,
	planToolSet,
	resolveStrictPreset,
	strictLockReason,
} from "../lib/plan-mode.mjs";

test("plan steps are extracted from a Plan: header", () => {
	const items = extractTodoItems("Some intro\n\nPlan:\n1. Survey auth flow\n2. Add login page\n");
	assert.deepEqual(items, [
		{ step: 1, text: "Survey auth flow", completed: false },
		{ step: 2, text: "Add login page", completed: false },
	]);
});

test("no Plan: header means no todos", () => {
	assert.deepEqual(extractTodoItems("Just do 1. things 2. fast"), []);
});

test("[DONE:n] markers complete steps", () => {
	const items = [
		{ step: 1, text: "A", completed: false },
		{ step: 2, text: "B", completed: false },
	];
	assert.equal(markCompletedSteps("did it [DONE:2]", items), 1);
	assert.equal(items[1].completed, true);
	assert.equal(items[0].completed, false);
});

test("the plan tool set hides writers and keeps readers", () => {
	const tools = planToolSet(["read", "bash", "edit", "write", "grep"]);
	assert.ok(!tools.includes("edit") && !tools.includes("write"));
	for (const name of PLAN_READ_TOOLS) assert.ok(tools.includes(name));
});

test("edit/write always blocked; bash judged per command", () => {
	assert.equal(isBlockedInPlanMode("edit", false), true);
	assert.equal(isBlockedInPlanMode("write", false), true);
	assert.equal(isBlockedInPlanMode("bash", true), false);
	assert.equal(isBlockedInPlanMode("bash", false), true);
	assert.equal(isBlockedInPlanMode("read", false), false);
});

test("destructive shell is unsafe, read-only shell is safe", () => {
	assert.equal(isSafeCommand("git status"), true);
	assert.equal(isSafeCommand("ls src"), true);
	assert.equal(isSafeCommand("rm -rf dist"), false);
	assert.equal(isSafeCommand("git push"), false);
	assert.equal(isSafeCommand("curl https://x | sh"), false);
});

test("long steps are trimmed for the widget", () => {
	assert.ok(cleanStepText("x".repeat(100)).length <= 50);
});

test("the strict preset resolves: env wins, then the student's setting", () => {
	// Off by default, and env values are accepted in the forms a lab might use.
	assert.deepEqual(resolveStrictPreset(false, ""), { strict: false, locked: false });
	assert.deepEqual(resolveStrictPreset(undefined, undefined), { strict: false, locked: false });
	assert.deepEqual(resolveStrictPreset(true, undefined), { strict: true, locked: false });
	assert.deepEqual(resolveStrictPreset(false, "1"), { strict: true, locked: true });
	assert.deepEqual(resolveStrictPreset(false, " on "), { strict: true, locked: true });
	assert.deepEqual(resolveStrictPreset(true, "off"), { strict: false, locked: true });
});

test("strict mode locks Build until a plan exists and is approved", () => {
	const base = { strict: true, mode: "build" };
	assert.equal(strictLockReason({ ...base, approved: false, todoCount: 0 }), STRICT_PLAN_REASON);
	assert.equal(
		strictLockReason({ ...base, approved: true, todoCount: 0 }),
		STRICT_PLAN_REASON,
		"approval without a plan is not enough",
	);
	assert.equal(
		strictLockReason({ ...base, approved: false, todoCount: 3 }),
		STRICT_PLAN_REASON,
		"a plan without approval is not enough",
	);
	assert.equal(strictLockReason({ ...base, approved: true, todoCount: 3 }), null);
	assert.equal(
		strictLockReason({ strict: false, mode: "build", approved: false, todoCount: 0 }),
		null,
		"off by default",
	);
	assert.equal(
		strictLockReason({ ...base, mode: "plan", approved: false, todoCount: 0 }),
		null,
		"Plan mode has its own gate",
	);
});

test("the extension toggles modes and blocks writers only in plan", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let shortcutCount = 0;
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const widgets = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: (k, v) => (v === undefined ? widgets.delete(k) : widgets.set(k, v)),
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {
			shortcutCount += 1;
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	assert.equal(shortcutCount, 1, "shift+tab registered once");
	assert.ok(commands.has("plan"), "/plan toggle for the phone path");

	await handlers.get("session_start")({}, ctx);
	assert.equal(statuses.has("plan-mode"), false, "sessions start in Build");

	// Enter plan mode: writers hidden, status set.
	await commands.get("plan").handler("", ctx);
	assert.ok(statuses.has("plan-mode"));
	assert.ok(!activeTools.includes("edit") && !activeTools.includes("write"));

	const toolCall = handlers.get("tool_call");
	assert.deepEqual(await toolCall({ toolName: "edit", input: {} }), {
		block: true,
		reason: "Plan mode is on — research only. Press Shift+Tab (or /plan) for Build mode to edit.",
	});
	assert.equal(await toolCall({ toolName: "read", input: {} }), undefined);
	assert.equal(
		await toolCall({ toolName: "bash", input: { command: "git status" } }),
		undefined,
		"read-only shell passes",
	);

	// Back to build: everything restored.
	await commands.get("plan").handler("", ctx);
	assert.equal(statuses.has("plan-mode"), false);
	assert.ok(activeTools.includes("edit"));
	assert.equal(await toolCall({ toolName: "edit", input: {} }), undefined);
});

test("the checklist widget stays hidden on narrow windows", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const { PLAN_WIDGET_MIN_WIDTH, _internals } = mod;
	const theme = { fg: (_t, text) => text };
	const lines = _internals.todoLines(
		[
			{ step: 1, text: "A", completed: true },
			{ step: 2, text: "B", completed: false },
		],
		theme,
	);
	assert.equal(lines.length, 1, "one row, not the whole list");
	assert.match(lines.join("\n"), /Plan 1\/2/);
	assert.match(lines.join("\n"), /B/, "shows the current step, not the done one");
	assert.ok(PLAN_WIDGET_MIN_WIDTH >= 80, "only shown when wide enough");
});

test("manual todo add/done helpers", () => {
	const items = [];
	const first = addTodoItem(items, "Survey auth flow");
	assert.equal(first.step, 1);
	addTodoItem(items, "Add login page");
	assert.equal(items.length, 2);
	assert.equal(completeTodoItem(items, 1), true);
	assert.equal(items[0].completed, true);
	assert.equal(completeTodoItem(items, 99), false);
});

test("the /todo command manages the checklist", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);
	await commands.get("plan").handler("", ctx);

	const todo = commands.get("todo").handler;
	await todo("add Survey auth flow", ctx);
	await todo("add Add login page", ctx);
	assert.equal(statuses.get("plan-mode"), "plan 0/2");
	await todo("done 1", ctx);
	assert.equal(statuses.get("plan-mode"), "plan 1/2");
	await todo("done 99", ctx);
	assert.match(notices.at(-1), /No step 99/);
	await todo("done 2", ctx);
	assert.equal(statuses.get("plan-mode"), "plan 2/2");
	await commands.get("todos").handler("", ctx);
	assert.match(notices.at(-1), /✓[\s\S]*✓/);
	await todo("clear", ctx);
	assert.equal(statuses.get("plan-mode"), "plan");
	await todo("bogus", ctx);
	assert.match(notices.at(-1), /Usage/);
});

test("the /todo command completes subcommands and step numbers", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);
	const complete = commands.get("todo").getArgumentCompletions;
	assert.ok(complete, "/todo offers completions");
	assert.deepEqual(
		complete("").map((c) => c.value),
		["add", "done", "clear"],
	);
	assert.deepEqual(complete("d").map((c) => c.value), ["done"]);

	await commands.get("todo").handler("add Survey auth flow", ctx);
	await commands.get("todo").handler("add Add login page", ctx);
	await commands.get("todo").handler("done 1", ctx);
	assert.deepEqual(
		complete("done ").map((c) => c.value),
		["2"],
		"only incomplete steps are suggested",
	);
	assert.equal(complete("add "), null, "free text after add");
});

test("the /approve command carries the checklist into Build", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);

	// No plan, no approval.
	await commands.get("approve").handler("", ctx);
	assert.match(notices.at(-1), /already in Build/);

	await commands.get("plan").handler("", ctx);
	await commands.get("approve").handler("", ctx);
	assert.match(notices.at(-1), /No checklist yet/);

	await commands.get("todo").handler("add Survey auth flow", ctx);
	await commands.get("todo").handler("add Add login page", ctx);
	await commands.get("approve").handler("", ctx);
	assert.equal(statuses.get("plan-mode"), "build 0/2", "checklist carried into Build");
	assert.ok(activeTools.includes("edit"), "full tools restored");
	assert.match(notices.at(-1), /Plan approved — 2 steps/);
});

test("checklist survives into Build and tracks [DONE:n] there", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);
	await commands.get("plan").handler("", ctx);
	await commands.get("todo").handler("add Survey auth flow", ctx);
	await commands.get("todo").handler("add Add login page", ctx);
	assert.equal(statuses.get("plan-mode"), "plan 0/2");

	// Flip to Build: checklist preserved, footer reads BUILD counts.
	await commands.get("plan").handler("", ctx);
	assert.equal(statuses.get("plan-mode"), "build 0/2");
	assert.ok(activeTools.includes("edit"), "full tools restored");

	// [DONE:n] markers advance the count in Build mode too.
	await handlers.get("agent_end")({ messages: [{ role: "assistant", content: "done [DONE:1]" }] }, ctx);
	assert.equal(statuses.get("plan-mode"), "build 1/2");

	// A fresh Plan session resets the checklist.
	await commands.get("plan").handler("", ctx);
	assert.equal(statuses.get("plan-mode"), "plan");
});

test("agent_end parses real-shaped AgentMessage entries into footer counts", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: () => {},
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);
	await commands.get("plan").handler("", ctx);
	assert.equal(statuses.get("plan-mode"), "plan", "no counts before the plan");

	// Real AgentEndEvent shape: messages are AgentMessage entries with role/content directly.
	await handlers.get("agent_end")(
		{ messages: [{ role: "assistant", content: "Intro\n\nPlan:\n1. Survey auth flow\n2. Add login page\n" }] },
		ctx,
	);
	assert.equal(statuses.get("plan-mode"), "plan 0/2", "footer shows parsed counts");
});

/**
 * Build a fresh extension instance around a fixed session id, backed by a temp
 * agent dir. Each call is a new "process": its own closure state, same session.
 */
function startExtension(mod, sessionId) {
	const handlers = new Map();
	const commands = new Map();
	const statuses = new Map();
	const notices = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"],
		setActiveTools: () => {},
	};
	mod.default(pi);
	return { handlers, commands, statuses, notices, ctx };
}

test("a resumed session brings the checklist back, in Build, with a confirm", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-plan-resume-"));
	const saved = process.env.LEARNINGCODE_DIR;
	process.env.LEARNINGCODE_DIR = dir;
	try {
		// Session A: plan three steps, complete one, then quit.
		const a = startExtension(mod, "session-a");
		await a.handlers.get("session_start")({ reason: "startup" }, a.ctx);
		await a.commands.get("plan").handler("", a.ctx);
		await a.commands.get("todo").handler("add Survey the code", a.ctx);
		await a.commands.get("todo").handler("add Fix the bug", a.ctx);
		await a.commands.get("todo").handler("done 1", a.ctx);
		await a.handlers.get("session_shutdown")({ reason: "quit" }, a.ctx);

		// Session A resumes in a fresh process: the checklist is back, in Build.
		const b = startExtension(mod, "session-a");
		await b.handlers.get("session_start")({ reason: "resume", previousSessionFile: "x" }, b.ctx);
		assert.equal(b.statuses.get("plan-mode"), "build 1/2", "progress restored into Build");
		assert.match(b.notices.join("\n"), /Restored your plan checklist/);

		// A different session starts clean — the checkpoint is per conversation.
		const c = startExtension(mod, "session-b");
		await c.handlers.get("session_start")({ reason: "startup" }, c.ctx);
		assert.equal(c.statuses.has("plan-mode"), false, "a new session has no checklist");
		assert.doesNotMatch(c.notices.join("\n"), /Restored/);
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
	}
});

test("clearing the checklist leaves nothing to restore", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-plan-clear-"));
	const saved = process.env.LEARNINGCODE_DIR;
	process.env.LEARNINGCODE_DIR = dir;
	try {
		const a = startExtension(mod, "session-c");
		await a.handlers.get("session_start")({ reason: "startup" }, a.ctx);
		await a.commands.get("plan").handler("", a.ctx);
		await a.commands.get("todo").handler("add Something", a.ctx);
		await a.commands.get("todo").handler("clear", a.ctx);

		const b = startExtension(mod, "session-c");
		await b.handlers.get("session_start")({ reason: "resume" }, b.ctx);
		assert.equal(b.statuses.has("plan-mode"), false, "a cleared checklist does not come back");
	} finally {
		if (saved === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = saved;
	}
});

test("the /plan command runs a guided template, or refuses an unknown one", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");

	const handlers = new Map();
	const commands = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const statuses = new Map();
	const notices = [];
	const sent = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: (k, v) => (v === undefined ? statuses.delete(k) : statuses.set(k, v)),
			setWidget: () => {},
			notify: (m) => notices.push(m),
		},
	};
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
		sendUserMessage: (content) => sent.push(content),
	};

	mod.default(pi);
	await handlers.get("session_start")({}, ctx);

	// Completions offer the template names, with their summaries.
	const complete = commands.get("plan").getArgumentCompletions;
	assert.deepEqual(
		complete("").map((c) => c.value),
		["explain-bug", "implement-fn", "strict"],
	);
	assert.deepEqual(complete("exp").map((c) => c.value), ["explain-bug"]);
	assert.deepEqual(complete("s").map((c) => c.value), ["strict"], "the strict preset is offerable too");
	assert.ok(complete("exp")[0].description, "each template carries a summary");
	assert.equal(complete("explain-bug "), null, "after the name it is free subject text");

	// An unknown name is refused: nothing is sent, the mode does not move.
	await commands.get("plan").handler("nope", ctx);
	assert.match(notices.at(-1), /Unknown plan template/);
	assert.equal(sent.length, 0);
	assert.equal(statuses.has("plan-mode"), false, "a typo does not change the mode");

	// A real template enters Plan mode and sends the lesson as a user message.
	await commands.get("plan").handler("explain-bug login is broken", ctx);
	assert.equal(statuses.get("plan-mode"), "plan", "switched to Plan mode");
	assert.ok(!activeTools.includes("edit") && !activeTools.includes("write"), "writers hidden");
	assert.equal(sent.length, 1);
	assert.match(sent[0], /login is broken/, "the subject rides along");
	assert.match(sent[0], /Plan:/, "the prompt asks for the header the checklist parses");
	assert.match(notices.at(-1), /Plan template "explain-bug"/);
});

/** Run `fn` with the agent dir (and optional strict env) set, then restore both. */
async function withEnv(dir, planStrict, fn) {
	const savedDir = process.env.LEARNINGCODE_DIR;
	const savedStrict = process.env.LEARNINGCODE_PLAN_STRICT;
	process.env.LEARNINGCODE_DIR = dir;
	if (planStrict === undefined) delete process.env.LEARNINGCODE_PLAN_STRICT;
	else process.env.LEARNINGCODE_PLAN_STRICT = planStrict;
	try {
		return await fn();
	} finally {
		if (savedDir === undefined) delete process.env.LEARNINGCODE_DIR;
		else process.env.LEARNINGCODE_DIR = savedDir;
		if (savedStrict === undefined) delete process.env.LEARNINGCODE_PLAN_STRICT;
		else process.env.LEARNINGCODE_PLAN_STRICT = savedStrict;
	}
}

test("strict preset: Build is locked until a plan is approved", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-strict-"));
	await writeFile(join(dir, "settings.json"), JSON.stringify({ planStrict: true }), "utf-8");
	await withEnv(dir, undefined, async () => {
		const app = startExtension(mod, "strict-s");
		await app.handlers.get("session_start")({ reason: "startup" }, app.ctx);
		assert.equal(app.statuses.get("plan-mode"), "strict", "Build is locked and says so");
		assert.match(app.notices.join("\n"), /Strict plan mode is on/);

		const toolCall = app.handlers.get("tool_call");
		const edit = await toolCall({ toolName: "edit", input: {} });
		assert.equal(edit.block, true, "edits blocked while locked");
		assert.match(edit.reason, /Strict plan mode/);
		assert.equal(await toolCall({ toolName: "read", input: {} }), undefined, "reads still work");
		assert.equal(await toolCall({ toolName: "bash", input: { command: "git status" } }), undefined, "safe shell still works");
		assert.equal((await toolCall({ toolName: "bash", input: { command: "rm -rf dist" } })).block, true, "mutating shell blocked");

		// A plan plus an approval is the way through.
		await app.commands.get("plan").handler("", app.ctx);
		await app.commands.get("todo").handler("add Fix the bug", app.ctx);
		await app.commands.get("approve").handler("", app.ctx);
		assert.equal(app.statuses.get("plan-mode"), "build 0/1", "unlocked after approval");
		assert.equal(await toolCall({ toolName: "edit", input: {} }), undefined, "edits allowed now");

		// Clearing the checklist takes the plan away, so the lock returns.
		await app.commands.get("todo").handler("clear", app.ctx);
		assert.equal(app.statuses.get("plan-mode"), "strict", "no plan, locked again");
	});
});

test("the student can toggle strict mode, and it persists", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-strict-toggle-"));
	await withEnv(dir, undefined, async () => {
		const a = startExtension(mod, "toggle-s");
		await a.handlers.get("session_start")({ reason: "startup" }, a.ctx);
		assert.equal(a.statuses.has("plan-mode"), false, "off by default");

		await a.commands.get("plan").handler("strict", a.ctx);
		assert.match(a.notices.at(-1), /Strict plan mode is OFF/);
		await a.commands.get("plan").handler("strict bogus", a.ctx);
		assert.match(a.notices.at(-1), /Usage: \/plan strict/);

		await a.commands.get("plan").handler("strict on", a.ctx);
		assert.equal(a.statuses.get("plan-mode"), "strict");
		assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf-8")).planStrict, true);

		// A new process reads the setting back.
		const b = startExtension(mod, "toggle-s");
		await b.handlers.get("session_start")({ reason: "startup" }, b.ctx);
		assert.equal(b.statuses.get("plan-mode"), "strict", "the toggle survived");

		await b.commands.get("plan").handler("strict off", b.ctx);
		assert.equal(b.statuses.has("plan-mode"), false);
		assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf-8")).planStrict, false);
	});
});

test("a lab can pin strict mode through the environment", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-strict-env-"));
	await withEnv(dir, "1", async () => {
		const app = startExtension(mod, "env-s");
		await app.handlers.get("session_start")({ reason: "startup" }, app.ctx);
		assert.equal(app.statuses.get("plan-mode"), "strict");

		await app.commands.get("plan").handler("strict off", app.ctx);
		assert.match(app.notices.at(-1), /set by your lab/);
		assert.equal(app.statuses.get("plan-mode"), "strict", "still locked");
	});
});

test("in strict mode an approved plan stays approved across a resume", async () => {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/plan-mode.ts");
	const dir = await mkdtemp(join(tmpdir(), "lc-strict-resume-"));
	await writeFile(join(dir, "settings.json"), JSON.stringify({ planStrict: true }), "utf-8");
	await withEnv(dir, undefined, async () => {
		const a = startExtension(mod, "resume-s");
		await a.handlers.get("session_start")({ reason: "startup" }, a.ctx);
		await a.commands.get("plan").handler("", a.ctx);
		await a.commands.get("todo").handler("add Fix the bug", a.ctx);
		await a.commands.get("approve").handler("", a.ctx);
		await a.handlers.get("session_shutdown")({ reason: "quit" }, a.ctx);

		const b = startExtension(mod, "resume-s");
		await b.handlers.get("session_start")({ reason: "resume" }, b.ctx);
		assert.equal(b.statuses.get("plan-mode"), "build 0/1", "restored and still approved");
		assert.equal(
			await b.handlers.get("tool_call")({ toolName: "edit", input: {} }),
			undefined,
			"edits stay unlocked after a resume",
		);
	});
});
