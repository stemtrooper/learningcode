/**
 * Friendly names for tool calls, shared by the phone and the computer console.
 *
 * A bare `subagent` tells a student nothing, and the phone's activity line —
 * the one place remote shows what the agent is doing — was showing exactly
 * that. These turn a helper call into the helper's name, or a count, from
 * either the call arguments (on start) or the resolved run details (on finish).
 *
 * Pure and dependency-free on purpose: the relay loads this, so it must not
 * drag the sub-agent runtime in behind it.
 */

/** `3 helpers`, `1 helper`. */
function count(n, one, many) {
	return `${n} ${n === 1 ? one : many}`;
}

function firstLine(text) {
	return (
		String(text ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** A helper call's arguments → a short noun: `scout`, `3 helpers`, `chain of 2`. */
export function subagentLabel(args = {}) {
	const value = args && typeof args === "object" ? args : {};
	if (Array.isArray(value.chain) && value.chain.length > 0) return `chain of ${value.chain.length}`;
	if (Array.isArray(value.tasks) && value.tasks.length > 0) return count(value.tasks.length, "helper", "helpers");
	if (typeof value.agent === "string" && value.agent.trim()) return value.agent.trim();
	return "helpers";
}

/** The finished result's details (which carry the resolved runs) → a noun. */
function labelFromResult(result) {
	const details = result?.details;
	if (!details || !Array.isArray(details.runs)) return null;
	if (details.mode === "chain") return `chain of ${details.runs.length}`;
	if (details.mode === "parallel") return count(details.runs.length, "helper", "helpers");
	return details.runs[0]?.agent ? String(details.runs[0].agent) : null;
}

/**
 * A short, friendly name for a tool call. Known tools with no friendlier name
 * return the tool name unchanged, so callers can pass every tool through here.
 */
export function toolLabel(toolName, { args, result } = {}) {
	if (toolName === "subagent") {
		return labelFromResult(result) ?? subagentLabel(args ?? {});
	}
	return String(toolName ?? "tool");
}

/**
 * A one-line digest of a helper's result for the phone and the console, or ""
 * for any other tool. Mirrors the TUI's student-language lines: a tick and the
 * helper's own first words, or a plain failure sentence. Never a diagnostic.
 */
export function toolSummary(toolName, result) {
	if (toolName !== "subagent") return "";
	const runs = result?.details?.runs;
	if (!Array.isArray(runs) || runs.length === 0) return "";
	return runs
		.map((run) => {
			const agent = String(run?.agent ?? "helper");
			if (run?.aborted) return `${agent} was stopped`;
			if (run?.ok) {
				const first = firstLine(run?.text);
				return `✓ ${agent}: ${first || "finished"}`;
			}
			return `✗ ${agent} couldn't finish`;
		})
		.join("; ");
}
