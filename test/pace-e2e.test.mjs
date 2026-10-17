import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_AGENT_DIR_ENV } from "../lib/config.mjs";
import { resolvePiEntry } from "../lib/pi.mjs";

/**
 * Opt-in end-to-end check of the quota reserve, against a real Pi process.
 *
 *   mock OpenAI provider -> asks Pi to `write` a file
 *   LEARNINGCODE_PACE_RESERVE=3 + a tiny daily cap -> pace.ts blocks the write
 *   -> the file never appears, and Pi keeps going
 *
 * Gated on LEARNINGCODE_PACE_E2E=1 (like the remote and subagent e2e suites)
 * because it spawns a real Pi process. The mock stands in for the network, so
 * it needs no real key. The block decision itself is unit-tested with a stub
 * spawn in test/pace-extension.test.mjs; this verifies the extension loads
 * under real Pi 1.3.0 and its `tool_call` hook actually stops a write.
 */

const GATED = process.env.LEARNINGCODE_PACE_E2E === "1";
const skip = GATED ? (name, fn) => test(name, fn) : (name) => test.skip(name, () => {});

const here = dirname(fileURLToPath(import.meta.url));
const PACE_EXTENSION = join(here, "..", "extensions", "pace.ts");

/** A mock Spark/OpenAI endpoint: a tiny daily cap, then a write, then a stop. */
async function startMockProvider() {
	let completions = 0;
	const server = createServer((request, response) => {
		const url = request.url ?? "";
		if (url.includes("/me/quota")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ tokensUsed: 0, dailyTokenLimit: 100, quotaExempt: false, aiEnabled: true }));
			return;
		}
		if (url.includes("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "answer", object: "model" }] }));
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta, finish = null) =>
				response.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			completions += 1;
			if (completions === 1) {
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_write",
							type: "function",
							function: { name: "write", arguments: JSON.stringify({ path: "example.txt", content: "hello" }) },
						},
					],
				});
				chunk({}, "tool_calls");
			} else {
				chunk({ content: "Stopped to save steps for later." });
				chunk({}, "stop");
			}
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

/** A minimal agent dir whose only provider is the mock, under the Spark id. */
async function writeAgentDir(baseUrl) {
	const dir = await mkdtemp(join(tmpdir(), "lc-pace-e2e-"));
	const models = {
		providers: {
			"tlc-spark": {
				name: "TLC-Spark (mock)",
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

function runPi(args, env, cwd, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve) => {
		// stdin is "ignore", not a pipe: Pi in -p mode waits for EOF on an open
		// stdin, so leaving a pipe there would hang the run.
		const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

skip("the reserve blocks a real write and the run continues", async () => {
	const provider = await startMockProvider();
	const dir = await writeAgentDir(provider.url);
	const workspace = await mkdtemp(join(tmpdir(), "lc-pace-work-"));
	process.env.LC_E2E_KEY = "not-a-real-key";

	const entry = resolvePiEntry();
	assert.ok(entry, "the Pi runtime is resolvable");

	// --append-system-prompt takes a file path, not text.
	const promptPath = join(dir, "system.md");
	await writeFile(promptPath, "You must write the file example.txt.", "utf-8");

	const result = await runPi(
		[
			entry,
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", "tlc-spark/answer",
			"--tools", "read,write",
			"--extension", PACE_EXTENSION,
			"--append-system-prompt", promptPath,
			"Write example.txt with the word hello.",
		],
		{
			...process.env,
			[PI_AGENT_DIR_ENV]: dir,
			SPARK_API_KEY: "spark_live_test",
			SPARK_BASE_URL: provider.url,
			LEARNINGCODE_DIR: dir,
			LEARNINGCODE_PACE_RESERVE: "3",
		},
		workspace,
	);

	try {
		assert.equal(result.code, 0, `pi failed: ${result.stderr.slice(0, 400)}`);
		assert.equal(existsSync(join(workspace, "example.txt")), false, "the write was stopped at the reserve");
		assert.match(result.stdout, /"type":"message_end"/, "the run produced a turn");
	} finally {
		await new Promise((resolve) => provider.server.close(resolve));
	}
});
