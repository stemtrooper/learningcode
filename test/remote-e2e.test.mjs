import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

/**
 * Full-stack verification of the remote feature, through the real CLI.
 *
 *   phone -> remote server -> learningcode remote -> Pi RPC -> mock Spark
 *        -> Pi -> bridge -> server -> phone
 *
 * This is opt-in (LEARNINGCODE_REMOTE_E2E=1) rather than part of `npm test`
 * because it spawns the real agent and needs a model endpoint. In place of Spark
 * stands a mock that streams one OpenAI-compatible completion, which is exactly
 * what Spark's OpenAI layer returns, so the agent, the bridge and the phone all
 * behave as they do in class.
 *
 * The test is the definition of done from docs/remote.md: a phone message
 * reaches the agent, the agent answers, the phone sees it stream, and the
 * session survives a phone reconnect.
 */

const GATED = process.env.LEARNINGCODE_REMOTE_E2E === "1";
const skip = GATED ? (name, fn) => test(name, fn) : (name) => test.skip(name, () => {});

const ENROLL = "e2e-enrol-key";
const MODEL_REPLY = "The sketch now blinks every 500 milliseconds.";

/** An OpenAI-compatible endpoint that streams one completion. */
async function startMockSpark() {
	const server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "TLC-Spark", object: "model" }] }));
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
			for (const word of MODEL_REPLY.split(" ")) chunk({ content: `${word} ` });
			chunk({}, "stop");
			response.write("data: [DONE]\n\n");
			response.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

const waitFor = (socket, type, timeout = 30_000) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
		socket.on("message", function onMessage(raw) {
			let frame;
			try {
				frame = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (frame.type !== type) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(frame);
		});
	});

const send = (socket, frame) => socket.send(JSON.stringify({ protocol: 1, ...frame }));

skip("a phone message reaches the real agent and its reply streams back", async () => {
	const { RemoteServer } = await import("../lib/remote/server.mjs");
	const spark = await startMockSpark();
	const relay = new RemoteServer({ port: 0, host: "127.0.0.1", enrollKey: ENROLL, stateFile: null });
	await relay.listen();
	const { agentUrl } = relay.address();

	const agentDir = await mkdtemp(join(tmpdir(), "lc-e2e-agent-"));

	// The CLI process under test: everything it needs to run the real thing,
	// with Spark pointed at the mock.
	const child = spawn(process.execPath, ["bin/learningcode.mjs", "remote"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			PATH: process.env.PATH,
			LEARNINGCODE_DIR: agentDir,
			LEARNINGCODE_TOKEN: "spark_live_e2e_not_a_real_token",
			LEARNINGCODE_SPARK_BASE_URL: spark.url,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			LEARNINGCODE_REMOTE_SERVER: agentUrl,
			LEARNINGCODE_REMOTE_KEY: ENROLL,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});

	const cleanup = async () => {
		child.kill("SIGTERM");
		await relay.close();
		await new Promise((resolve) => spark.server.close(resolve));
	};

	try {
		// Wait for the process to print its phone link: that is the signal that
		// the agent started, enrolled, and is connected. Operator lines go to
		// stderr, the same place `learningcode` itself reports.
		const phoneUrl = await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`no phone link. output:\n${output}`)),
				45_000,
			);
			child.stdout.on("data", scanForLink);
			child.stderr.on("data", scanForLink);
			function scanForLink(chunk) {
				const match = chunk.toString().match(/https?:\/\/\S+\/s\/\S+\?t=\S+/);
				if (match) {
					clearTimeout(timer);
					resolve(match[0]);
				}
			}
		});

		// The phone: attach with the token the computer printed. The token rides
		// in the URL fragment, exactly as the browser reads it, so this exercises
		// the same parsing path the mobile UI uses.
		const url = new URL(phoneUrl);
		const hash = url.hash.replace(/^#\//, "");
		const [path, query = ""] = hash.split("?");
		const sessionId = path.replace(/^s\//, "");
		const token = new URLSearchParams(query).get("t") ?? "";
		assert.ok(sessionId && token, `could not read the link: ${phoneUrl}`);
		const phoneSocket = new WebSocket(`ws://127.0.0.1:${relay.port}/phone`);
		await new Promise((resolve, reject) => {
			phoneSocket.on("open", resolve);
			phoneSocket.on("error", reject);
		});
		send(phoneSocket, { type: "attach", sessionId, token });
		const attached = await waitFor(phoneSocket, "attached");
		assert.equal(attached.computer, "online", "the computer is connected");

		// Send the message a student would send.
		send(phoneSocket, { type: "message", text: "Make the LED blink every 500ms." });

		// The reply streams back through the whole chain.
		const streamed = [];
		const settled = new Promise((resolve) => {
			const handler = (raw) => {
				const frame = JSON.parse(raw.toString());
				if (frame.type !== "event") return;
				const event = frame.event ?? {};
				if (event.type === "message_update" && event.text) streamed.push(event.text);
				if (event.type === "agent_settled") {
					phoneSocket.off("message", handler);
					resolve();
				}
			};
			phoneSocket.on("message", handler);
		});
		await settled;
		const text = streamed.join("");
		assert.ok(text.includes(MODEL_REPLY.trim()), `phone received: ${JSON.stringify(text)}`);

		// Reconnect the phone: same session, same conversation.
		phoneSocket.close();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const again = new WebSocket(`ws://127.0.0.1:${relay.port}/phone`);
		await new Promise((resolve, reject) => {
			again.on("open", resolve);
			again.on("error", reject);
		});
		send(again, { type: "attach", sessionId, token });
		const reattached = await waitFor(again, "attached");
		assert.equal(reattached.session.sessionId, sessionId);
		assert.equal(reattached.computer, "online");
		const history = await waitFor(again, "history");
		assert.ok(
			history.messages.some((message) => message.text.includes("Make the LED blink")),
			"the conversation survived the reconnect",
		);
		again.close();
	} finally {
		await cleanup();
	}
});
