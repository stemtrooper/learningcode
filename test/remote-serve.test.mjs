import assert from "node:assert/strict";
import test from "node:test";
import { publicIp, startTunnel } from "../lib/remote/index.mjs";
import { phoneUrl } from "../lib/remote/config.mjs";

const v4 = (address, internal = false) => ({ family: "IPv4", internal, address });

test("the phone link uses the LAN address, never loopback first", () => {
	assert.equal(publicIp({ Ethernet: [v4("192.168.1.23")] }), "192.168.1.23");
	assert.equal(publicIp({}), "127.0.0.1", "loopback only when nothing else exists");
});

test("carrier-grade NAT addresses lose to a real LAN address", () => {
	const nets = {
		wwan: [v4("100.64.0.5")],
		Ethernet: [v4("192.168.1.23")],
	};
	assert.equal(publicIp(nets), "192.168.1.23");
});

test("the printed link uses the public base, not the loopback the bridge dials", () => {
	const link = phoneUrl("ws://127.0.0.1:8787/agent", "abc123", "tok", "http://192.168.1.23:8787");
	assert.ok(link.startsWith("http://192.168.1.23:8787/#/s/abc123?"), link);
	assert.ok(link.includes("t=tok"), "the token still rides the fragment");
});

test("a tunnel link points at the tunnel, not the loopback", () => {
	const link = phoneUrl("ws://127.0.0.1:8787/agent", "abc123", "tok", "https://fine-walls.trycloudflare.com");
	assert.ok(link.startsWith("https://fine-walls.trycloudflare.com/#/s/abc123?"), link);
});

test("a tunnel that cannot start says what went wrong, with a way out", async () => {
	await assert.rejects(
		() => startTunnel(9, () => {}, "definitely-not-a-real-binary-xyz"),
		/cloudflared would not start/,
	);
});
