import { PER_TASK_TEXT_CAP } from "./child.mjs";

/**
 * Turning helper runs into student language.
 *
 * A helper is a tool call, and tool output is shown to a student who has never
 * seen a token counter. The Pi example's usage line (`3 turns ↑input ↓output
 * Rcache Wcache $cost ctx:…`) is exactly what must not appear here: no usage,
 * no cost, no exit codes, no stderr, no JSON. A failure is one sentence naming
 * the helper.
 */

const ICON = { scout: "🔎", reviewer: "🧐", planner: "🗺️", worker: "🔧" };
const FALLBACK_ICON = "🤖";

export function agentIcon(agent) {
	return ICON[agent] ?? FALLBACK_ICON;
}

/** Trim text to `max` characters with an ellipsis. */
export function clip(text, max) {
	const value = String(text ?? "");
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** The first non-empty line of some text. */
export function firstLine(text) {
	return (
		String(text ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** The live line while a helper is working. */
export function runningLine(agent) {
	return `${agentIcon(agent)} ${agent} is working…`;
}

/** The one-line result: a tick and the helper's own first words. */
export function summaryLine(run) {
	if (run.aborted) return `${agentIcon(run.agent)} ${run.agent} was stopped.`;
	if (!run.ok) return `✗ ${run.agent} couldn't finish — it hit an error.`;
	const first = firstLine(run.text);
	return `✓ ${run.agent}: ${clip(first || "finished", 80)}`;
}

/** A parallel/chain headline: "2 of 3 done". */
export function aggregateLine(runs, done) {
	const total = runs.length;
	return `${done}/${total} done`;
}

/**
 * The text handed back to the parent model. One section per helper, capped so a
 * chatty helper cannot blow up the parent's context. Never includes usage/cost.
 */
export function contentText(runs, cap = PER_TASK_TEXT_CAP) {
	const parts = [];
	for (const run of runs) {
		const body = run.ok ? run.text || "(no output)" : "(this helper hit an error and stopped)";
		parts.push(`### ${run.agent}\n${clip(body, cap)}`);
	}
	return parts.join("\n\n");
}

/** The full task and answer for one helper, used in the expanded view. */
export function expandedText(run) {
	const lines = [`Task: ${run.task}`, ""];
	lines.push(run.ok ? run.text || "(no output)" : "The helper hit an error and stopped.");
	return lines.join("\n");
}

/** The student-language failure sentence, without any child diagnostic. */
export function failureSentence(agent) {
	return `${agent} couldn't finish — it hit an error.`;
}

/** The plain-text rendering of a still-running set of helpers. */
export function partialText(runs) {
	return runs
		.filter((run) => run)
		.map((run) => (run.running ? runningLine(run.agent) : summaryLine(run)))
		.join("\n");
}
