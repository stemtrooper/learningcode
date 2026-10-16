/**
 * Plan templates: pre-shaped prompts that teach a student *how* to plan a
 * common school task, for `/plan <name> [subject]`.
 *
 * Wording lives here, away from Pi, so it can be tested and edited without
 * touching the extension. Every template ends under a `Plan:` header and asks
 * for no edits, which is exactly what the existing checklist parser and
 * `/approve` flow already understand — so a template is a lesson, not a new
 * mechanism.
 */

/**
 * The closing instruction shared by every template. Kept in one place so a
 * new template cannot forget the two things the rest of plan mode depends on:
 * the `Plan:` header (for the checklist) and "don't edit yet" (for approval).
 */
const EPILOGUE = [
	"",
	'Put the numbered plan under a "Plan:" header, and do not edit or write any',
	"files yet — I will approve it first.",
].join("\n");

/**
 * Each template's `body` carries a `{{subject}}` token, replaced with whatever
 * the student typed after the template name. A template with no subject falls
 * back to its own `placeholder`, so the prompt still reads as a sentence.
 */
export const PLAN_TEMPLATES = [
	{
		name: "explain-bug",
		summary: "Work out why something is broken before changing it",
		placeholder: "(describe the bug in your own words)",
		body: [
			"Help me understand a bug before I change anything.",
			"",
			"What is broken: {{subject}}",
			"",
			"Plan it the way a careful engineer would:",
			"1. Restate what the code is supposed to do.",
			"2. List the files you need to read to understand it.",
			"3. Give the most likely causes first, and say which file or line would confirm each one.",
			"4. Propose the smallest test that would tell those causes apart.",
		].join("\n"),
	},
	{
		name: "implement-fn",
		summary: "Plan a new function: interface, edges, then code",
		placeholder: "(describe the function in your own words)",
		body: [
			"Help me plan a new function before I write it.",
			"",
			"What it should do: {{subject}}",
			"",
			"Plan it step by step:",
			"1. State the function's name, inputs, and outputs.",
			"2. Sketch the algorithm in plain sentences.",
			"3. List the edge cases, and what should happen for each.",
			"4. Say how we will test it.",
		].join("\n"),
	},
];

/** The template with this name (case-insensitive), or undefined. */
export function findTemplate(name) {
	const wanted = String(name ?? "").trim().toLowerCase();
	return PLAN_TEMPLATES.find((template) => template.name === wanted);
}

/** Name and one-line summary per template, for completions and listings. */
export function listTemplates() {
	return PLAN_TEMPLATES.map(({ name, summary }) => ({ name, summary }));
}

/**
 * The prompt for `/plan <name> [subject]`, or null when the name is unknown so
 * the command can say so instead of sending a stray message to the model.
 */
export function expandTemplate(name, subject) {
	const template = findTemplate(name);
	if (!template) return null;
	const detail = String(subject ?? "").trim() || template.placeholder;
	return `${template.body.replaceAll("{{subject}}", detail)}\n${EPILOGUE}`;
}
