import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
	PLAN_READ_TOOLS,
	cleanStepText,
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
	assert.match(lines.join("\n"), /Plan 1\/2/);
	assert.match(lines.join("\n"), /✓ A/);
	assert.ok(PLAN_WIDGET_MIN_WIDTH >= 80, "only shown when wide enough");
});
