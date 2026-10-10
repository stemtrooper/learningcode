import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
	PLAN_READ_TOOLS,
	addTodoItem,
	cleanStepText,
	completeTodoItem,
	extractTodoItems,
	isBlockedInPlanMode,
	isSafeCommand,
	markCompletedSteps,
	planToolSet,
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
