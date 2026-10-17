import assert from "node:assert/strict";
import test from "node:test";
import { SPARK_REFUSAL } from "../lib/subagent/gate.mjs";
import { partialText } from "../lib/subagent/render.mjs";
import { executeSubagent } from "../lib/subagent/run.mjs";

/**
 * Orchestration, with a stubbed spawn: no process is ever started. This covers
 * mode selection, the gate, argument validation, chain substitution, ordering
 * and the undo-session bridge — everything except actually running Pi.
 */

const ctx = (over = {}) => ({
	cwd: "/proj",
	thinkingLevel: "low",
	model: { provider: "opencode-go", id: "kimi" },
	sessionManager: { getSessionId: () => "parent-1" },
	...over,
});

const okState = (text) => ({
	exitCode: 0,
	aborted: false,
	errorMessage: null,
	stopReason: "stop",
	messages: [{ role: "assistant", content: [{ type: "text", text }] }],
});

const fakeRunner = (map = {}) => {
	const calls = [];
	const runChild = async (plan, task, { onEvent } = {}) => {
		calls.push({ plan, task });
		onEvent?.();
		const value = map[plan.agent] ?? `answer from ${plan.agent}`;
		return okState(typeof value === "function" ? value(plan, task) : value);
	};
	return { runChild, calls };
};

const textOf = (result) => result.content.map((c) => c.text).join("\n");

test("single mode runs one helper and returns its answer", async () => {
	const { runChild, calls } = fakeRunner({ scout: "found the tests" });
	const result = await executeSubagent({ agent: "scout", task: "where are the tests" }, ctx(), { runChild });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.mode, "single");
	assert.match(textOf(result), /### scout/);
	assert.match(textOf(result), /found the tests/);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].task, "where are the tests");
});

test("on Spark the tool refuses and never spawns", async () => {
	const { runChild, calls } = fakeRunner();
	const result = await executeSubagent({ agent: "scout", task: "x" }, ctx({ model: { provider: "tlc-spark", id: "TLC-Spark" } }), { runChild });
	assert.equal(textOf(result), SPARK_REFUSAL);
	assert.equal(calls.length, 0);
});

test("a per-agent model that lands on Spark refuses the whole run", async () => {
	const { runChild, calls } = fakeRunner();
	const loadAgents = () => [{ name: "sneaky", description: "x", tools: ["read"], systemPrompt: "", model: "tlc-spark/TLC-Spark" }];
	const result = await executeSubagent({ agent: "sneaky", task: "x" }, ctx(), { runChild, loadAgents });
	assert.match(textOf(result), /TLC-Spark/);
	assert.equal(calls.length, 0);
});

test("an unknown helper is a plain error listing the real ones", async () => {
	const { runChild, calls } = fakeRunner();
	const loadAgents = () => [{ name: "scout", description: "look around", tools: ["read"], systemPrompt: "" }];
	const result = await executeSubagent({ agent: "ghost", task: "x" }, ctx(), { runChild, loadAgents });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /no helper called "ghost"/);
	assert.match(textOf(result), /scout/);
	assert.equal(calls.length, 0);
});

test("mixing modes is refused", async () => {
	const { runChild } = fakeRunner();
	const result = await executeSubagent({ agent: "scout", task: "x", tasks: [{ agent: "scout", task: "y" }] }, ctx(), { runChild });
	assert.equal(result.isError, true);
});

test("too many helpers is refused before anything runs", async () => {
	const { runChild, calls } = fakeRunner();
	const tasks = Array.from({ length: 7 }, () => ({ agent: "scout", task: "x" }));
	const result = await executeSubagent({ tasks }, ctx(), { runChild });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /the most I run at once is 6/);
	assert.equal(calls.length, 0);
});

test("parallel mode runs every helper and keeps order", async () => {
	const { runChild, calls } = fakeRunner({ scout: "S", worker: "W", reviewer: "R" });
	const result = await executeSubagent(
		{ tasks: [{ agent: "scout", task: "1" }, { agent: "worker", task: "2" }, { agent: "reviewer", task: "3" }] },
		ctx(),
		{ runChild },
	);
	assert.equal(result.details.mode, "parallel");
	assert.deepEqual(result.details.runs.map((r) => r.agent), ["scout", "worker", "reviewer"]);
	assert.equal(calls.length, 3);
});

test("chain mode feeds each answer into the next {previous}", async () => {
	const { runChild, calls } = fakeRunner({
		scout: "the layout is src/",
		planner: (plan, task) => `planned using: ${task}`,
	});
	await executeSubagent(
		{ chain: [{ agent: "scout", task: "map the repo" }, { agent: "planner", task: "plan with {previous}" }] },
		ctx(),
		{ runChild },
	);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].task, "plan with the layout is src/");
});

test("the child is told the parent's undo session", async () => {
	const { runChild, calls } = fakeRunner();
	await executeSubagent({ agent: "worker", task: "change a file" }, ctx(), { runChild });
	assert.equal(calls[0].plan.env.LEARNINGCODE_UNDO_SESSION, "parent-1");
});

test("partialText summarises a mixed running/done set", () => {
	const text = partialText([
		{ agent: "scout", running: false, ok: true, text: "done" },
		{ agent: "worker", running: true, ok: null, text: "" },
	]);
	assert.match(text, /✓ scout: done/);
	assert.match(text, /worker is working/);
});
