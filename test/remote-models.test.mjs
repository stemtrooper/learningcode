import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { RemoteServer } from "../lib/remote/server.mjs";
import { RemoteBridge } from "../lib/remote/bridge.mjs";

const ENROLL = "model-test-key";
const TOKEN = "model-test-token";

function fakeAgent(models = [{ provider: "tlc-spark", id: "TLC-Spark", name: "TLC-Spark" }]) {
	const state = { current: null, switched: [] };
	return {
		state,
		prompt: async () => "accepted",
		abort: async () => {},
		getMessages: async () => [],
		stop: async () => {},
		onEvent: () => () => {},
		onExtensionUi: () => () => {},
		getAvailableModels: async () => models,
		setModel: async (provider, modelId) => {
			state.switched.push([provider, modelId]);
			state.current = { provider, modelId };
			return { provider, id: modelId };
		},
	};
}

/** Wait for the next frame of a type on a socket. */
const next = (socket, type, timeout = 4000) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeout);
		socket.on("message", function onMessage(raw) {
			const frame = JSON.parse(raw.toString());
			if (frame.type !== type) return;
			clearTimeout(timer);
			socket.off("message", onMessage);
			resolve(frame);
		});
	});

const send = (socket, frame) => socket.send(JSON.stringify({ protocol: 1, ...frame }));

async function setup(agent) {
	const server = new RemoteServer({ port: 0, enrollKey: ENROLL, stateFile: null });
	await server.listen();
	const { agentUrl, uiUrl } = server.address();
	const bridge = new RemoteBridge({
		serverUrl: agentUrl,
		sessionId: "s-models",
		token: TOKEN,
		enrollKey: ENROLL,
		meta: { name: "robot" },
		agent,
		WebSocketImpl: WebSocket,
		log: () => {},
	});
	await bridge.start();
	const phone = new WebSocket(uiUrl.replace(/^http/, "ws").replace(/\/ui$/, "/phone"));
	await new Promise((resolve) => phone.on("open", resolve));
	send(phone, { type: "attach", sessionId: "s-models", token: TOKEN });
	await next(phone, "attached");
	return { server, bridge, phone };
}

test("the phone sees exactly the models the computer reports", async () => {
	const models = [
		{ provider: "tlc-spark", id: "TLC-Spark", name: "TLC-Spark" },
		{ provider: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
	];
	const { server, bridge, phone } = await setup(fakeAgent(models));
	try {
		send(phone, { type: "models" });
		const reply = await next(phone, "models");
		assert.deepEqual(reply.models, models);
	} finally {
		phone.close();
		bridge.stop();
		await server.close();
	}
});

test("a phone can switch to an offered model, and gets a confirmation", async () => {
	const agent = fakeAgent([
		{ provider: "tlc-spark", id: "TLC-Spark", name: "TLC-Spark" },
		{ provider: "opencode-go", id: "glm-5.3-flash", name: "GLM" },
	]);
	const { server, bridge, phone } = await setup(agent);
	try {
		send(phone, { type: "set_model", provider: "opencode-go", modelId: "glm-5.3-flash" });
		const confirmed = await next(phone, "model_changed");
		assert.equal(confirmed.ok, true);
		assert.equal(confirmed.modelId, "glm-5.3-flash");
		assert.deepEqual(agent.state.switched, [["opencode-go", "glm-5.3-flash"]]);
	} finally {
		phone.close();
		bridge.stop();
		await server.close();
	}
});

test("a phone cannot select a model the computer did not offer", async () => {
	const agent = fakeAgent([{ provider: "tlc-spark", id: "TLC-Spark", name: "TLC-Spark" }]);
	const { server, bridge, phone } = await setup(agent);
	try {
		send(phone, { type: "set_model", provider: "evil-provider", modelId: "anything" });
		const refused = await next(phone, "model_changed");
		assert.equal(refused.ok, false);
		assert.match(refused.error, /not available/);
		assert.deepEqual(agent.state.switched, [], "the agent was never asked");
	} finally {
		phone.close();
		bridge.stop();
		await server.close();
	}
});
