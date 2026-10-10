import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	extractTodoItems,
	isBlockedInPlanMode,
	isSafeCommand,
	markCompletedSteps,
	planToolSet,
} from "../lib/plan-mode.mjs";

/**
 * Plan / Build mode. Shift+Tab (or /plan, the phone path) toggles between:
 *
 * - Build (default): today's behaviour, every tool available.
 * - Plan: the model can look but not touch. Writers are hidden from it and
 *   blocked with a reason; bash outside a read-only allowlist is blocked too.
 *
 * The footer owns the mode indicator (it reads the `plan-mode` status this
 * extension sets). The checklist widget shows above the editor, wide windows
 * only. No persistence: every session starts in Build.
 */

type Todo = { step: number; text: string; completed: boolean };

/** Below this width the checklist widget renders nothing. */
export const PLAN_WIDGET_MIN_WIDTH = 100;

const STATUS_KEY = "plan-mode";

function statusFor(ctx: ExtensionContext, mode: string, todos: Todo[]): void {
	// Footer parses this: "plan" or "plan done/total".
	if (mode !== "plan") {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const done = todos.filter((t) => t.completed).length;
	ctx.ui.setStatus(STATUS_KEY, todos.length > 0 ? `plan ${done}/${todos.length}` : "plan");
}

function todoLines(todos: Todo[], theme: { fg(token: string, text: string): string }): string[] {
	// Single row: the current step plus the count. Full list is one /todos away.
	const done = todos.filter((t) => t.completed).length;
	const current = todos.find((t) => !t.completed);
	const step = current ? `  ● ${current.text}` : "  ✓ all done";
	return [theme.fg("muted", `Plan ${done}/${todos.length}`) + theme.fg("dim", step)];
}

export default function planMode(pi: ExtensionAPI) {
	let mode: "build" | "plan" = "build";
	let todos: Todo[] = [];
	let toolsBefore: string[] | undefined;

	const refresh = (ctx: ExtensionContext) => {
		statusFor(ctx, mode, todos);
		if (mode === "plan" && todos.length > 0) {
			ctx.ui.setWidget("plan-todos", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					if (width < PLAN_WIDGET_MIN_WIDTH) return [];
					return todoLines(todos, theme as unknown as { fg(token: string, text: string): string });
				},
			}));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
		if (mode === "plan") pi.setActiveTools(planToolSet(toolsBefore ?? pi.getActiveTools()));
	};

	const setMode = (next: "build" | "plan", ctx: ExtensionContext, silent = false) => {
		if (next === "plan" && mode !== "plan") toolsBefore = pi.getActiveTools();
		mode = next;
		if (next === "plan") {
			todos = [];
			pi.setActiveTools(planToolSet(toolsBefore ?? pi.getActiveTools()));
			if (!silent) ctx.ui.notify("Plan mode — research only. Shift+Tab (or /plan) for Build to edit.", "info");
		} else {
			pi.setActiveTools(toolsBefore ?? pi.getActiveTools());
			toolsBefore = undefined;
			todos = [];
			if (!silent) ctx.ui.notify("Build mode — full access restored.", "info");
		}
		refresh(ctx);
	};

	pi.registerCommand("plan", {
		description: "Toggle Plan / Build mode (Shift+Tab)",
		handler: async (_args, ctx) => {
			setMode(mode === "plan" ? "build" : "plan", ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current plan checklist",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("No plan steps yet. Ask for a plan first.", "info");
				return;
			}
			ctx.ui.notify(
				todos.map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`).join("\n"),
				"info",
			);
		},
	});

	// Shift+Tab is a valid KeyId; TUI-only (RPC has no keyboard — /plan covers it).
	try {
		pi.registerShortcut(Key.shift("tab"), {
			description: "Toggle Plan / Build mode",
			handler: async (ctx) => {
				setMode(mode === "plan" ? "build" : "plan", ctx);
			},
		});
	} catch {
		/* RPC mode: /plan remains the toggle. */
	}

	pi.on("tool_call", async (event) => {
		if (mode !== "plan") return undefined;
		const name = (event as { toolName?: string }).toolName ?? "";
		const safe = name === "bash" && isSafeCommand((event as { input?: { command?: string } }).input?.command);
		if (!isBlockedInPlanMode(name, safe)) return undefined;
		return {
			block: true,
			reason: "Plan mode is on — research only. Press Shift+Tab (or /plan) for Build mode to edit.",
		};
	});

	pi.on("before_agent_start", async () => {
		if (mode !== "plan") return undefined;
		return {
			message: {
				customType: "plan-mode-context",
				content:
					"[PLAN MODE ACTIVE]\nYou are in plan mode: research the codebase and propose a numbered plan under a \"Plan:\" header. Do NOT edit, write, or run mutating commands — those tools are disabled.",
				display: false,
			},
		} as unknown as void;
	});

	// Pull numbered steps out of the model's plan; track [DONE:n] checkoffs.
	pi.on("agent_end", async (event, ctx) => {
		if (mode !== "plan") return undefined;
		const messages = (event as { messages?: { message?: { role?: string; content?: unknown } }[] }).messages ?? [];
		const texts: string[] = [];
		for (const entry of messages) {
			const content = entry.message?.content;
			if (entry.message?.role !== "assistant" || content == null) continue;
			if (typeof content === "string") texts.push(content);
			else if (Array.isArray(content)) {
				for (const block of content as { type?: string; text?: string }[]) {
					if (block?.type === "text" && block.text) texts.push(block.text);
				}
			}
		}
		const all = texts.join("\n");
		if (todos.length === 0) {
			const found = extractTodoItems(all);
			if (found.length > 0) {
				todos = found;
				refresh(ctx);
			}
			return undefined;
		}
		if (markCompletedSteps(all, todos) > 0) refresh(ctx);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		// Always start in Build, including resume/fork.
		mode = "build";
		todos = [];
		toolsBefore = undefined;
		if (ctx.hasUI) refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		mode = "build";
		todos = [];
		toolsBefore = undefined;
	});
}

export const _internals = { PLAN_WIDGET_MIN_WIDTH, todoLines };
