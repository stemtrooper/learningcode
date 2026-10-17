import assert from "node:assert/strict";
import test from "node:test";
import { subagentLabel, toolLabel, toolSummary } from "../lib/remote/labels.mjs";

test("a helper call is named by its helper, not by the tool", () => {
	assert.equal(toolLabel("subagent", { args: { agent: "scout", task: "look" } }), "scout");
	assert.equal(toolLabel("subagent", { args: { tasks: [{}, {}] } }), "2 helpers");
	assert.equal(toolLabel("subagent", { args: { tasks: [{}] } }), "1 helper");
	assert.equal(toolLabel("subagent", { args: { chain: [{}, {}, {}] } }), "chain of 3");
	assert.equal(toolLabel("subagent", { args: {} }), "helpers");
});

test("the finished result names the helper too, when the arguments are gone", () => {
	assert.equal(
		toolLabel("subagent", { result: { details: { mode: "single", runs: [{ agent: "worker" }] } } }),
		"worker",
	);
	assert.equal(
		toolLabel("subagent", { result: { details: { mode: "parallel", runs: [{}, {}] } } }),
		"2 helpers",
	);
	assert.equal(
		toolLabel("subagent", { result: { details: { mode: "chain", runs: [{}, {}] } } }),
		"chain of 2",
	);
});

test("every other tool keeps its own name", () => {
	for (const name of ["read", "bash", "edit", "write", "grep"]) {
		assert.equal(toolLabel(name, { args: {} }), name);
	}
	assert.equal(toolLabel(undefined, {}), "tool");
});

test("a helper's result becomes one student line", () => {
	assert.equal(
		toolSummary("subagent", { details: { runs: [{ agent: "scout", ok: true, text: "found 4 files\nmore" }] } }),
		"✓ scout: found 4 files",
	);
	assert.equal(
		toolSummary("subagent", { details: { runs: [{ agent: "worker", ok: false }] } }),
		"✗ worker couldn't finish",
	);
	assert.equal(
		toolSummary("subagent", { details: { runs: [{ agent: "scout", aborted: true }] } }),
		"scout was stopped",
	);
	assert.equal(
		toolSummary("subagent", { details: { runs: [{ agent: "scout", ok: true, text: "" }] } }),
		"✓ scout: finished",
	);
});

test("no summary leaks for other tools, or when there are no runs", () => {
	assert.equal(toolSummary("bash", { details: { runs: [{ agent: "scout", ok: true, text: "x" }] } }), "");
	assert.equal(toolSummary("subagent", { details: { runs: [] } }), "");
	assert.equal(toolSummary("subagent", undefined), "");
});

test("subagentLabel is defensive about malformed arguments", () => {
	assert.equal(subagentLabel(null), "helpers");
	assert.equal(subagentLabel("nope"), "helpers");
	assert.equal(subagentLabel({ agent: "   " }), "helpers");
});
