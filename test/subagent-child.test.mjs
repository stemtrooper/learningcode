import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_TASKS,
	applyEvent,
	assistantText,
	emptyUsage,
	planChild,
	runBounded,
	runChild,
	runFailed,
} from "../lib/subagent/child.mjs";

/**
 * The child invocation. The argv is asserted exactly: no TUI extension may ever
 * leak into a `--mode json -p` child, and the undo bridge is set only when the
 * helper can change files.
 */

const scout = { name: "scout", tools: ["read", "grep", "find", "ls"], systemPrompt: "look", model: undefined };
const worker = { name: "worker", tools: ["read", "grep", "find", "ls", "bash", "edit", "write"], systemPrompt: "do", model: undefined };
const PI = "/fake/pi/cli.js";

const plan = (agent, opts = {}) => planChild(agent, { piEntry: PI, dir: "/fake/agent", ...opts });

test("the base argv is json print no-session", () => {
	const { command, baseArgs } = plan(scout);
	assert.equal(command, process.execPath);
	assert.equal(baseArgs[0], PI);
	assert.deepEqual(baseArgs.slice(1, 5), ["--mode", "json", "-p", "--no-session"]);
});

test("model, thinking and tools are passed through", () => {
	const { baseArgs } = plan(scout, { model: "opencode-go/kimi", thinking: "low" });
	assert.ok(baseArgs.includes("--model"));
	assert.equal(baseArgs[baseArgs.indexOf("--model") + 1], "opencode-go/kimi");
	assert.equal(baseArgs[baseArgs.indexOf("--thinking") + 1], "low");
	assert.equal(baseArgs[baseArgs.indexOf("--tools") + 1], "read,grep,find,ls");
});

test("no TUI extension ever reaches a child", () => {
	const { baseArgs } = plan(worker);
	const extensions = baseArgs.filter((arg, i) => baseArgs[i - 1] === "--extension");
	assert.deepEqual(extensions.length, 2);
	for (const banned of ["footer.ts", "banner.ts", "orange-cat.ts", "whats-new.ts", "spark-quota.ts", "intro.ts", "done-sound.ts", "checkpoint.ts", "plan-mode.ts"]) {
		assert.equal(baseArgs.some((a) => a.includes(banned)), false, `${banned} must not load in a child`);
	}
	assert.ok(extensions.some((p) => p.endsWith("approval.ts")));
	assert.ok(extensions.some((p) => p.endsWith("undo-record.ts")));
});

test("a read-only helper gets no child extensions", () => {
	const { baseArgs } = plan(scout);
	assert.equal(baseArgs.includes("--extension"), false);
});

test("approval rides with any destructive helper, undo-record only with editors", () => {
	const basher = { name: "b", tools: ["read", "bash"], systemPrompt: "" };
	const basherExt = plan(basher).baseArgs;
	assert.ok(basherExt.some((p) => p.endsWith("approval.ts")), "bash helper gets approval");
	assert.equal(basherExt.some((p) => p.endsWith("undo-record.ts")), false, "bash-only helper has nothing to journal");
});

test("the undo bridge carries the parent session id, and only then", () => {
	const withBridge = plan(worker, { undoSession: "parent-9" });
	assert.equal(withBridge.env.LEARNINGCODE_UNDO_SESSION, "parent-9");
	const without = plan(worker);
	assert.equal(without.env.LEARNINGCODE_UNDO_SESSION, undefined);
});

test("a missing Pi runtime is a plain error", () => {
	assert.throws(() => planChild(scout, { piEntry: null, dir: "/x" }), /Cannot find the Pi runtime/);
});

test("events accumulate usage, model and errors from message_end", () => {
	const state = { messages: [], usage: emptyUsage(), model: undefined, stopReason: null, errorMessage: null, turns: 0 };
	applyEvent({ type: "session", id: "x" }, state);
	applyEvent({ type: "tool_execution_end", toolName: "bash" }, state);
	applyEvent({ type: "message_end", message: { role: "user", content: "hi" } }, state);
	applyEvent(
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], model: "m", stopReason: "stop", usage: { input: 5, output: 7, totalTokens: 12, cost: { total: 0.1 } } } },
		state,
	);
	assert.equal(state.turns, 1);
	assert.equal(state.usage.input, 5);
	assert.equal(state.usage.output, 7);
	assert.equal(state.usage.contextTokens, 12);
	assert.equal(state.usage.cost, 0.1);
	assert.equal(state.model, "m");
	assert.equal(state.stopReason, "stop");
	assert.equal(assistantText(state.messages), "done");
});

test("assistantText reads string and block content", () => {
	assert.equal(assistantText([{ role: "assistant", content: "hello" }]), "hello");
	assert.equal(assistantText([{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]), "ab");
	assert.equal(assistantText([]), "");
});

test("runFailed catches exits, aborts and errors", () => {
	assert.equal(runFailed({ exitCode: 0 }), false);
	assert.equal(runFailed({ exitCode: 1 }), true);
	assert.equal(runFailed({ exitCode: 0, aborted: true }), true);
	assert.equal(runFailed({ exitCode: 0, errorMessage: "boom" }), true);
	assert.equal(runFailed({ exitCode: 0, stopReason: "error" }), true);
});

test("runBounded keeps input order and respects the concurrency cap", async () => {
	let live = 0;
	let peak = 0;
	const order = [];
	const worker = async (item) => {
		live += 1;
		peak = Math.max(peak, live);
		await new Promise((r) => setTimeout(r, 5));
		order.push(item);
		live -= 1;
		return item * 2;
	};
	const results = await runBounded([1, 2, 3, 4, 5], 2, worker);
	assert.deepEqual(results, [2, 4, 6, 8, 10], "results are in input order");
	assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed the cap`);
	assert.equal(MAX_TASKS, 6);
});

test("runChild parses a JSON-lines stream from a stub process", async () => {
	const script = `
		console.log(JSON.stringify({ type: "session", id: "s" }));
		console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the answer" }], stopReason: "stop" } }));
		console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
	`;
	const stub = { command: process.execPath, baseArgs: ["-e", script], env: process.env, cwd: process.cwd(), prompt: "", agent: "scout", model: undefined };
	const state = await runChild(stub, "do it");
	assert.equal(state.exitCode, 0);
	assert.equal(assistantText(state.messages), "the answer");
	assert.equal(runFailed(state), false);
});

test("runChild survives a crashing stub without rejecting", async () => {
	const stub = { command: process.execPath, baseArgs: ["-e", "process.exit(3)"], env: process.env, cwd: process.cwd(), prompt: "", agent: "scout" };
	const state = await runChild(stub, "do it");
	assert.equal(state.exitCode, 3);
	assert.equal(runFailed(state), true);
});
