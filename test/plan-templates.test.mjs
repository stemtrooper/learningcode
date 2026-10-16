import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_TEMPLATES, expandTemplate, findTemplate, listTemplates } from "../lib/plan-templates.mjs";

test("every template is well formed and uniquely named", () => {
	assert.ok(PLAN_TEMPLATES.length >= 2, "ships at least the two named in the roadmap");
	const names = PLAN_TEMPLATES.map((t) => t.name);
	assert.equal(new Set(names).size, names.length, "names are unique");
	for (const t of PLAN_TEMPLATES) {
		assert.match(t.name, /^[a-z][a-z0-9-]*$/, `${t.name} is a plain command token`);
		assert.ok(t.summary.length > 0, `${t.name} has a summary for completions`);
		assert.ok(t.placeholder.length > 0, `${t.name} has a subject placeholder`);
		assert.ok(t.body.includes("{{subject}}"), `${t.name} shows where the subject goes`);
	}
});

test("the roadmap's two templates are present", () => {
	assert.ok(findTemplate("explain-bug"));
	assert.ok(findTemplate("implement-fn"));
});

test("lookup is case-insensitive and trims, and misses return undefined", () => {
	assert.equal(findTemplate("  Explain-Bug ")?.name, "explain-bug");
	assert.equal(findTemplate("nope"), undefined);
	assert.equal(findTemplate(""), undefined);
});

test("listTemplates exposes name and summary for completions", () => {
	const items = listTemplates();
	assert.equal(items.length, PLAN_TEMPLATES.length);
	for (const item of items) {
		assert.deepEqual(Object.keys(item).sort(), ["name", "summary"]);
	}
});

test("an expanded template is a plan request, never an edit request", () => {
	for (const { name } of PLAN_TEMPLATES) {
		const prompt = expandTemplate(name, "the login page");
		assert.ok(prompt.includes("the login page"), `${name} carries the student's subject`);
		assert.match(prompt, /Plan:/, `${name} asks for the Plan: header the checklist parses`);
		assert.match(prompt, /do not edit or write/i, `${name} asks to hold off editing until approval`);
	}
});

test("an empty subject falls back to the template's placeholder", () => {
	const prompt = expandTemplate("explain-bug", "");
	assert.ok(prompt.includes(findTemplate("explain-bug").placeholder), "placeholder fills the blank");
	assert.doesNotMatch(prompt, /\{\{subject\}\}/, "no raw token is left behind");
});

test("an unknown template expands to null so the command can refuse it", () => {
	assert.equal(expandTemplate("does-not-exist", "x"), null);
});
