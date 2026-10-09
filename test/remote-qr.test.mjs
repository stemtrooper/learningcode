import assert from "node:assert/strict";
import test from "node:test";
import { printQr } from "../lib/remote/index.mjs";

/** Render a link to the same text the terminal shows, for comparison. */
async function render(text) {
	const lines = [];
	await printQr(text, (line) => lines.push(line));
	return lines.join("\n");
}

test("the printed code is a QR block, drawn with the terminal characters", async () => {
	const art = await render("https://example.trycloudflare.com/#/s/abc?t=xyz");
	assert.ok(!art.includes("QR code unavailable"), "the encoder must load");
	assert.match(art, /[█▀▄]/, "block characters, the way a QR code is drawn in a terminal");
});

test("the same link always draws the same code, and a different link does not", async () => {
	const a1 = await render("https://one.trycloudflare.com/#/s/aaa?t=111");
	const a2 = await render("https://one.trycloudflare.com/#/s/aaa?t=111");
	const b = await render("https://two.trycloudflare.com/#/s/bbb?t=222");
	assert.equal(a1, a2, "deterministic");
	assert.notEqual(a1, b, "different links must not share a code");
});
