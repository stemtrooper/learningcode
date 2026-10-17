import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentConfigError,
	READ_ONLY_TOOLS,
	agentsDir,
	describeAgents,
	findAgent,
	loadAgents,
	needsApproval,
	needsUndoRecord,
} from "../lib/subagent/agents.mjs";

/**
 * Shipped-agent discovery. v1 reads only the package's own agents/ directory —
 * no project-local or user-local files — so a classroom repo cannot smuggle an
 * agent definition in.
 */

const writeAgent = (dir, name, frontmatter, body = "Do the thing.") =>
	writeFile(join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`, "utf-8");

test("the shipped set is exactly the four curated helpers", () => {
	const agents = loadAgents();
	assert.deepEqual(
		agents.map((a) => a.name),
		["planner", "reviewer", "scout", "worker"],
	);
	assert.equal(agentsDir().endsWith(join("learningcode", "agents")), true);
});

test("read-only is the default; worker alone may change files", () => {
	const byName = Object.fromEntries(loadAgents().map((a) => [a.name, a]));
	assert.deepEqual(byName.scout.tools, READ_ONLY_TOOLS);
	assert.deepEqual(byName.reviewer.tools, READ_ONLY_TOOLS);
	assert.deepEqual(byName.planner.tools, READ_ONLY_TOOLS);
	assert.deepEqual(byName.worker.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);

	assert.equal(needsApproval(byName.scout), false);
	assert.equal(needsApproval(byName.worker), true);
	assert.equal(needsUndoRecord(byName.scout), false);
	assert.equal(needsUndoRecord(byName.worker), true);
});

test("frontmatter is parsed: name, description, tools, and body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-agents-"));
	await writeAgent(dir, "helper.md", "name: helper\ndescription: helps\ntools: read, grep", "You help.");
	const [agent] = loadAgents(dir);
	assert.equal(agent.name, "helper");
	assert.equal(agent.description, "helps");
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.match(agent.systemPrompt, /You help\./);
	assert.equal(agent.source, "shipped");
});

test("an array tools list is accepted, and a missing one defaults to read-only", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-agents-"));
	await writeAgent(dir, "a.md", "name: a\ndescription: one\ntools: [read, ls]");
	await writeAgent(dir, "b.md", "name: b\ndescription: two");
	const byName = Object.fromEntries(loadAgents(dir).map((a) => [a.name, a]));
	assert.deepEqual(byName.a.tools, ["read", "ls"]);
	assert.deepEqual(byName.b.tools, READ_ONLY_TOOLS);
});

test("an unknown tool name is rejected loudly, not silently dropped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-agents-"));
	await writeAgent(dir, "bad.md", "name: bad\ndescription: oops\ntools: read, teleport");
	assert.throws(() => loadAgents(dir), (err) => {
		assert.ok(err instanceof AgentConfigError);
		assert.match(err.message, /teleport/);
		return true;
	});
});

test("a file without name/description is skipped, not loaded", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-agents-"));
	await writeFile(join(dir, "notes.md"), "# just notes\n", "utf-8");
	await writeAgent(dir, "ok.md", "name: ok\ndescription: good");
	assert.deepEqual(loadAgents(dir).map((a) => a.name), ["ok"]);
});

test("a missing directory yields no agents rather than throwing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lc-agents-"));
	assert.deepEqual(loadAgents(join(dir, "nope")), []);
});

test("findAgent and describeAgents describe the set for the model", () => {
	const agents = loadAgents();
	assert.equal(findAgent(agents, "scout")?.name, "scout");
	assert.equal(findAgent(agents, "ghost"), null);
	const described = describeAgents(agents);
	assert.match(described, /scout: /);
	assert.match(described, /worker: /);
});
