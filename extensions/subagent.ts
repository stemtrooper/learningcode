import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activeProviderId } from "../lib/active-model.mjs";
import { PROVIDER_ID } from "../lib/config.mjs";
import { describeAgents, loadAgents } from "../lib/subagent/agents.mjs";
import { clip, expandedText, runningLine, summaryLine } from "../lib/subagent/render.mjs";
import { executeSubagent } from "../lib/subagent/run.mjs";

/**
 * Helpers — delegate a task to a separate Pi process with its own context window.
 *
 * A model-only tool (no `/` command). The orchestration lives in
 * lib/subagent/run.mjs so it can be tested without Pi; this file adds the tool
 * schema (the model's interface) and the student-language rendering.
 *
 * TLC-Spark is gated out: it runs one generation per student, so fanning out
 * would only earn 429s. The gate is enforced twice — the tool is removed from
 * the active set while Spark is the model, and re-checked at call time so a
 * mid-session `/model` switch cannot slip past it.
 */

const TOOL_NAME = "subagent";

/** Guarded theme colour: an unknown token must not break a render. */
function fg(theme: any, token: string, text: string): string {
	try {
		return theme.fg(token, text);
	} catch {
		return text;
	}
}

/** A compact preview of one task line. */
function taskPreview(task: unknown): string {
	return clip(String(task ?? "").replace(/\{previous\}/g, "").trim(), 60);
}

export default function subagent(pi: ExtensionAPI) {
	// Keep the tool in the active set exactly when the current model may use it.
	const syncActive = (provider: string | null | undefined) => {
		const active = pi.getActiveTools();
		const has = active.includes(TOOL_NAME);
		const should = provider !== PROVIDER_ID;
		if (should && !has) pi.setActiveTools([...active, TOOL_NAME]);
		else if (!should && has) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	};

	pi.on("session_start", async (_event, ctx) => {
		syncActive(activeProviderId(ctx as unknown));
	});
	pi.on("model_select", async (event) => {
		syncActive((event as { model?: { provider?: string } }).model?.provider);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Helpers",
		description: [
			"Ask one or more helper agents to work in a fresh, separate context and return a short result.",
			"Modes (exactly one): single = {agent, task}; parallel = {tasks};",
			"chain = {chain}, where a later task may use {previous} for the step before it.",
			`Helpers available: ${describeAgents(loadAgents())}.`,
		].join(" "),
		promptGuidelines: [
			"Reach for a helper when a job would fill your context with reading you do not need to keep.",
			"Say what you want back, not how to search — the helper chooses its own steps.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Helper to run (single mode)" })),
			task: Type.Optional(Type.String({ description: "What to ask that helper to do (single mode)" })),
			tasks: Type.Optional(
				Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
					description: "Helpers to run at the same time (parallel mode)",
				}),
			),
			chain: Type.Optional(
				Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
					description: "Helpers to run in order; use {previous} for the last step's answer (chain mode)",
				}),
			),
		}),
		exposure: "model-only",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return (await executeSubagent(params, ctx, { signal, onUpdate })) as never;
		},

		renderCall(args, theme, _context) {
			const f = (token: string, text: string) => fg(theme, token, text);
			if (Array.isArray(args.chain) && args.chain.length > 0) {
				let text = f("accent", "🤖 helper chain") + f("muted", ` (${args.chain.length} steps)`);
				for (const step of args.chain) {
					text += `\n  ${f("text", step.agent)} ${f("dim", taskPreview(step.task))}`;
				}
				return new Text(text, 0, 0);
			}
			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				let text = f("accent", `🤖 asking ${args.tasks.length} helpers`) + f("muted", " at once");
				for (const step of args.tasks) {
					text += `\n  ${f("text", step.agent)} ${f("dim", taskPreview(step.task))}`;
				}
				return new Text(text, 0, 0);
			}
			const agent = args.agent || "a helper";
			const line = f("accent", `🤖 asking ${agent}`);
			const body = args.task ? `\n  ${f("dim", taskPreview(args.task))}` : "";
			return new Text(line + body, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const f = (token: string, text: string) => fg(theme, token, text);
			const details = result.details as { runs?: Array<Record<string, unknown>> } | undefined;
			const runs = details?.runs ?? [];
			if (!runs.length) {
				const first = result.content?.[0] as { type?: string; text?: string } | undefined;
				return new Text(first?.type === "text" ? (first.text ?? "(no result)") : "(no result)", 0, 0);
			}

			if (expanded) {
				const blocks = runs.map((run) => {
					const header = f("accent", String(run.agent));
					const body = f("muted", expandedText(run as never));
					return `${header}\n${body}`;
				});
				return new Text(blocks.join("\n\n"), 0, 0);
			}

			const lines = runs.map((run) =>
				run.running
					? f("muted", runningLine(String(run.agent)))
					: f(run.ok ? "success" : "error", summaryLine(run as never)),
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
