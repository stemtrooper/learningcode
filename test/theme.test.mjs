import assert from "node:assert/strict";
import test from "node:test";
import { inverseBox, safeFg } from "../lib/theme.mjs";

/** A theme that only knows one token, like a student's hand-edited theme. */
const picky = (known, color = "\u001b[34m") => ({
	fg(token, text) {
		if (token !== known) throw new Error(`Unknown theme color: ${token}`);
		return `${color}${text}\u001b[0m`;
	},
});

test("safeFg colours a known token and degrades an unknown one to plain text", () => {
	// The whole point: a render loop must never throw because a theme lacks a
	// token. Pi's own theme.fg() does throw, and that used to crash the agent.
	const theme = picky("accent");
	assert.match(safeFg(theme, "accent", "hi"), /hi/);
	assert.equal(safeFg(theme, "nonexistent", "hi"), "hi");
});

test("safeFg tolerates a theme with no fg at all", () => {
	assert.equal(safeFg({}, "accent", "hi"), "hi");
	assert.equal(safeFg({ fg: null }, "accent", "hi"), "hi");
});

test("inverseBox prefers the theme's inverse()", () => {
	const theme = { ...picky("accent"), inverse: (text) => `<inv>${text}</inv>` };
	assert.equal(inverseBox(theme, "accent", " x "), "<inv>\u001b[34m x \u001b[0m</inv>");
});

test("inverseBox falls back to raw SGR and never throws on an unknown token", () => {
	// A minimal theme (and the tests) still get a box, and the text is uncoloured
	// rather than a crash when the token is missing.
	assert.equal(inverseBox(picky("accent"), "missing", " x "), "\u001b[7m x \u001b[27m");
});
