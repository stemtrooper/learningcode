import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantText, planChild, runChild, runFailed } from "../lib/subagent/child.mjs";
import { resolvePiEntry } from "../lib/pi.mjs";

/**
 * Opt-in end-to-end check of the child invocation, against a real Pi process.
 *
 *   planChild -> spawn pi --mode json -p --no-session -> mock OpenAI provider
 *             -> JSON lines -> runChild -> assistantText
 *
 * Gated on LEARNINGCODE_SUBAGENT_E2E=1 (like the remote e2e) because it spawns a
 * real Pi process. It stands a mock OpenAI provider in for the network, so it
 * needs no real key and is deterministic: the one thing being verified is that
 * our argv and our JSON-lines parser match what Pi 1.3.0 actually does. That is
 * the surface most likely to break on a Pi upgrade.
 *
 * The parent-side orchestration (gate, modes, undo bridge) is covered by
 * test/subagent-run.test.mjs with a stub spawn.
 */

const GATED = process.env.LEARNINGCODE_SUBAGENT_E2E === "1";
const skip = GATED ? (name, fn) => test(name, fn) : (name) => test.skip(name, () => {});

const REPLY = "the config lives in spark.config.yaml";

/** An OpenAI-compatible endpoint that streams one completion. */
async function startMockProvider() {
	const server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "answer", object: "model" }] }));
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			const chunk = (delta, finish = null) =>
				response.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			for (const word of REPLY.split(" ")) chunk({ content: `${word} ` });
			chunk({}, "stop");
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

/** A minimal agent dir whose only provider is the mock, off the Spark id. */
async function writeAgentDir(baseUrl) {
	const dir = await mkdtemp(join(tmpdir(), "lc-subagent-e2e-"));
	const models = {
		providers: {
			"lc-e2e": {
				name: "LC E2E",
				baseUrl,
				api: "openai-completions",
				apiKey: "$LC_E2E_KEY",
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					maxTokensField: "max_tokens",
					supportsStore: false,
				},
				models: [
					{
						id: "answer",
						name: "answer",
						reasoning: false,
						input: ["text"],
						contextWindow: 32768,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	await writeFile(join(dir, "models.json"), JSON.stringify(models), "utf-8");
	return dir;
}

skip("a scout child runs a real Pi process and its answer is parsed", async () => {
	const provider = await startMockProvider();
	const dir = await writeAgentDir(provider.url);
	process.env.LC_E2E_KEY = "not-a-real-key";

	const agent = { name: "scout", tools: ["read", "grep", "find", "ls"], systemPrompt: "Look and report." };
	const plan = planChild(agent, {
		model: "lc-e2e/answer",
		piEntry: resolvePiEntry(),
		dir,
		cwd: process.cwd(),
	});

	const state = await runChild(plan, "where is the Spark config?");
	try {
		assert.equal(runFailed(state), false, `child failed: ${state.stderr?.slice(0, 400)}`);
		assert.equal(state.exitCode, 0);
		assert.equal(assistantText(state.messages), REPLY.trim());
		assert.ok(state.turns >= 1, "the child took at least one turn");
	} finally {
		await new Promise((resolve) => provider.server.close(resolve));
	}
});
