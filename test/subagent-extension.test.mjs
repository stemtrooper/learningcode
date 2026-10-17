import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { PROVIDER_ID } from "../lib/config.mjs";

/**
 * The extension over a fake Pi: registration, the Spark gate on the active set,
 * and the renderers. Nothing here spawns a child (the gate refuses, or the
 * runner is never reached).
 */

async function load() {
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/subagent.ts");
	const tools = [];
	const handlers = new Map();
	let active = ["read", "bash", "subagent"];
	const pi = {
		on: (event, fn) => handlers.set(event, fn),
		registerTool: (def) => tools.push(def),
		getActiveTools: () => active.slice(),
		setActiveTools: (names) => {
			active = names.slice();
		},
	};
	mod.default(pi);
	return { tools, handlers, getActive: () => active.slice() };
}

const theme = { fg: (_token, text) => text, bold: (text) => text };

test("the tool is registered model-only with parameters and renderers", async () => {
	const { tools } = await load();
	assert.equal(tools.length, 1);
	const tool = tools[0];
	assert.equal(tool.name, "subagent");
	assert.equal(tool.exposure, "model-only");
	assert.ok(tool.parameters && tool.parameters.type === "object");
	assert.equal(typeof tool.execute, "function");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
});

test("Spark is removed from the active set at session start", async () => {
	const { handlers, getActive } = await load();
	await handlers.get("session_start")({}, { model: { provider: PROVIDER_ID } });
	assert.equal(getActive().includes("subagent"), false);
	assert.equal(getActive().includes("read"), true, "other tools are untouched");
});

test("a non-Spark provider keeps the tool available", async () => {
	const { handlers, getActive } = await load();
	await handlers.get("session_start")({}, { model: { provider: "opencode-go" } });
	assert.equal(getActive().includes("subagent"), true);
});

test("a mid-session model switch keeps the active set in step", async () => {
	const { handlers, getActive } = await load();
	await handlers.get("model_select")({ model: { provider: PROVIDER_ID } });
	assert.equal(getActive().includes("subagent"), false);
	await handlers.get("model_select")({ model: { provider: "river" } });
	assert.equal(getActive().includes("subagent"), true);
});

test("calling on Spark returns the refusal, not a throw", async () => {
	const { tools } = await load();
	const result = await tools[0].execute("id", { agent: "scout", task: "x" }, undefined, undefined, {
		model: { provider: PROVIDER_ID },
		cwd: "/proj",
	});
	const text = result.content.map((c) => c.text).join("");
	assert.match(text, /TLC-Spark runs one at a time/);
});

test("the renderers draw student lines without throwing", async () => {
	const { tools } = await load();
	const tool = tools[0];
	const call = tool.renderCall({ agent: "scout", task: "look around" }, theme, {});
	assert.ok(call);
	const parallel = tool.renderCall({ tasks: [{ agent: "scout", task: "a" }, { agent: "worker", task: "b" }] }, theme, {});
	assert.ok(parallel);
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "x" }], details: { mode: "single", runs: [{ agent: "scout", task: "t", ok: true, text: "ok", running: false }] } },
		{ expanded: false },
		theme,
		{},
	);
	assert.ok(result);
	const expanded = tool.renderResult(
		{ content: [], details: { mode: "single", runs: [{ agent: "worker", task: "t", ok: false, text: "", running: false }] } },
		{ expanded: true },
		theme,
		{},
	);
	assert.ok(expanded);
});
