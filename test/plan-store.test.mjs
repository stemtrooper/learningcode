import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadPlanState, loadPlanTodos, normalizeTodos, planStorePath, savePlanState, savePlanTodos } from "../lib/plan-store.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-plan-store-"));
const TODOS = [
	{ step: 1, text: "Survey the code", completed: true },
	{ step: 2, text: "Fix the bug", completed: false },
];

test("a saved checklist loads back exactly", async () => {
	const dir = await scratch();
	await savePlanTodos(dir, "session-a", TODOS);
	assert.deepEqual(await loadPlanTodos(dir, "session-a"), TODOS);
});

test("the approval flag is remembered with the checklist", async () => {
	const dir = await scratch();
	await savePlanState(dir, "session-a", { todos: TODOS, approved: true });
	const state = await loadPlanState(dir, "session-a");
	assert.deepEqual(state.todos, TODOS);
	assert.equal(state.approved, true);
	// Absent file, and a file written before the flag existed, both read clean.
	assert.deepEqual(await loadPlanState(dir, "missing"), { todos: [], approved: false });
	await savePlanTodos(dir, "old", TODOS);
	assert.equal((await loadPlanState(dir, "old")).approved, false, "approval defaults to false");
});

test("an empty checklist removes the file, so nothing restores by surprise", async () => {
	const dir = await scratch();
	await savePlanTodos(dir, "session-a", TODOS);
	await savePlanTodos(dir, "session-a", []);
	assert.deepEqual(await loadPlanTodos(dir, "session-a"), []);
	await assert.rejects(readFile(planStorePath(dir, "session-a"), "utf-8"));
});

test("a missing or corrupt file loads as an empty checklist, never throws", async () => {
	const dir = await scratch();
	assert.deepEqual(await loadPlanTodos(dir, "never-saved"), []);
	await savePlanTodos(dir, "broken", TODOS);
	await writeFile(planStorePath(dir, "broken"), "{ not json", "utf-8");
	assert.deepEqual(await loadPlanTodos(dir, "broken"), []);
});

test("junk entries are dropped and the rest renumbered", async () => {
	// This feeds the footer and the widget, so a hand-edited file must not render
	// blank rows or a NaN step.
	const dir = await scratch();
	await mkdir(join(dir, "plans"), { recursive: true });
	await writeFile(
		planStorePath(dir, "s"),
		JSON.stringify({
			todos: [
				{ step: 1, text: "keep me" },
				{ step: 2, text: "   " },
				null,
				"a string",
				{ text: "no step number", completed: "yes" },
			],
		}),
		"utf-8");
	const loaded = await loadPlanTodos(dir, "s");
	assert.deepEqual(loaded, [
		{ step: 1, text: "keep me", completed: false },
		{ step: 2, text: "no step number", completed: true },
	]);
});

test("normalizeTodos rejects anything that is not a list of steps", () => {
	assert.deepEqual(normalizeTodos(null), []);
	assert.deepEqual(normalizeTodos("nope"), []);
	assert.deepEqual(normalizeTodos([{ step: 0, text: "x" }]), [{ step: 1, text: "x", completed: false }]);
});

test("the store path is sanitised so a session id cannot escape the folder", () => {
	const path = planStorePath("/agent", "../../etc/passwd");
	assert.equal(dirname(path), join("/agent", "plans"), "stays inside the plans folder");
	assert.ok(!path.includes("/etc/"), path);
	assert.ok(!basename(path).includes("/"), path);
	assert.equal(planStorePath("/agent", ""), join("/agent", "plans", "session.json"));
});

test("a storage failure never throws", async () => {
	// Point the store at a path whose parent is a file, so mkdir fails.
	const dir = await scratch();
	const blocker = join(dir, "not-a-folder");
	await writeFile(blocker, "x", "utf-8");
	await savePlanTodos(join(blocker, "nested"), "session", TODOS);
	await rm(dir, { recursive: true, force: true });
});
