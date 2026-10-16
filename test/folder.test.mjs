import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { folderLabel } from "../lib/folder.mjs";

test("the label is the last path segment, on either separator style", () => {
	assert.equal(folderLabel("/home/ada/projects/homework-3"), "homework-3");
	assert.equal(folderLabel("C:\\Users\\ada\\projects\\homework-3"), "homework-3");
});

test("a trailing separator does not change the label", () => {
	assert.equal(folderLabel("/home/ada/projects/homework-3/"), "homework-3");
});

test("the home directory reads as a tilde, but a folder under it keeps its name", () => {
	assert.equal(folderLabel(homedir()), "~");
	assert.equal(folderLabel(homedir() + "/"), "~");
	// A project under home is distinguished by its own name, not collapsed to ~.
	assert.equal(folderLabel(join(homedir(), "homework-3")), "homework-3");
});

test("a root path keeps what there is instead of going blank", () => {
	assert.equal(folderLabel("/"), "/");
});

test("a long name is left-truncated so the distinguishing tail survives", () => {
	const label = folderLabel("x".repeat(40), 10);
	assert.equal(label.length, 10);
	assert.ok(label.startsWith("\u2026"), "truncation is marked");
	assert.ok(label.endsWith("x".repeat(9)), "the tail is kept");
});

test("nothing in, nothing out", () => {
	assert.equal(folderLabel(""), "");
	assert.equal(folderLabel(undefined), "");
	assert.equal(folderLabel(null), "");
});
