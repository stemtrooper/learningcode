import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { agentDir } from "../lib/config.mjs";
import {
	addTodoItem,
	completeTodoItem,
	extractTodoItems,
	isBlockedInPlanMode,
	isSafeCommand,
	markCompletedSteps,
	planToolSet,
	resolveStrictPreset,
	strictLockReason,
} from "../lib/plan-mode.mjs";
import { expandTemplate, listTemplates } from "../lib/plan-templates.mjs";
import { loadPlanState, savePlanState } from "../lib/plan-store.mjs";
import { readPlanStrict, setPlanStrict } from "../lib/settings.mjs";
import { safeFg } from "../lib/theme.mjs";

/**
 * Plan / Build mode. Shift+Tab (or /plan, the phone path) toggles between:
 *
 * - Build (default): today's behaviour, every tool available.
 * - Plan: the model can look but not touch. Writers are hidden from it and
 *   blocked with a reason; bash outside a read-only allowlist is blocked too.
 *
 * The footer owns the mode indicator (it reads the `plan-mode` status this
 * extension sets). The checklist widget shows above the editor, wide windows
 * only.
 *
 * The checklist is checkpointed per session (lib/plan-store.mjs): resuming a
 * conversation brings the student's progress back. The mode itself is not
 * restored — every session still starts in Build, so a resume can never leave
 * a student blocked from editing by surprise.
 *
 * An optional strict preset (off by default) changes that last part: when it is
 * on, Build starts locked until a plan exists and has been approved. The lab can
 * force it through the environment; the student controls it with
 * `/plan strict on|off`.
 */

type Todo = { step: number; text: string; completed: boolean };

/** Below this width the checklist widget renders nothing. */
export const PLAN_WIDGET_MIN_WIDTH = 100;

const STATUS_KEY = "plan-mode";

function statusFor(
	ctx: ExtensionContext,
	mode: string,
	todos: Todo[],
	strict: boolean,
	approved: boolean,
): void {
	// Footer parses this: "plan" or "plan done/total" in Plan mode,
	// "build done/total" in Build mode while a checklist is active, and
	// "strict" while the strict preset is holding Build locked.
	const done = todos.filter((t) => t.completed).length;
	if (mode === "plan") {
		ctx.ui.setStatus(STATUS_KEY, todos.length > 0 ? `plan ${done}/${todos.length}` : "plan");
		return;
	}
	if (strict && !(approved && todos.length > 0)) {
		ctx.ui.setStatus(STATUS_KEY, "strict");
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, todos.length > 0 ? `build ${done}/${todos.length}` : undefined);
}

function todoLines(todos: Todo[], theme: { fg(token: string, text: string): string }): string[] {
	// Single row: the current step plus the count. Full list is one /todos away.
	const done = todos.filter((t) => t.completed).length;
	const current = todos.find((t) => !t.completed);
	const step = current ? `  ● ${current.text}` : "  ✓ all done";
	return [safeFg(theme, "muted", `Plan ${done}/${todos.length}`) + safeFg(theme, "dim", step)];
}

export default function planMode(pi: ExtensionAPI) {
	let mode: "build" | "plan" = "build";
	let todos: Todo[] = [];
	let toolsBefore: string[] | undefined;
	// Strict preset state. `approved` is per-session (checkpointed with the
	// checklist); `strict` is resolved at session start from env + settings.
	let approved = false;
	let strict = false;
	let strictLockedByEnv = false;

	// The session whose checklist we are editing. Pi keeps the id stable across
	// `-c` / `--resume`. The extension tests pass a ctx with no sessionManager,
	// so the lookup is optional and persistence simply no-ops there.
	const sessionIdOf = (ctx: ExtensionContext): string | null =>
		ctx.sessionManager?.getSessionId?.() ?? null;

	/** Checkpoint the checklist and approval flag for this session. Never throws. */
	const persist = (ctx: ExtensionContext): Promise<void> => {
		const id = sessionIdOf(ctx);
		if (!id) return Promise.resolve();
		return savePlanState(agentDir(), id, { todos, approved });
	};

	const refresh = (ctx: ExtensionContext) => {
		statusFor(ctx, mode, todos, strict, approved);
		// setWidget is TUI-only; under RPC (phone) it may be inert or throw —
		// the phone gets the text checklist through /todos notifies instead.
		try {
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
		} catch {
			/* RPC mode: no widgets — /todos notifies carry the checklist. */
		}
		if (mode === "plan") pi.setActiveTools(planToolSet(toolsBefore ?? pi.getActiveTools()));
		// Every checklist/mode change goes through refresh(), so the checkpoint is
		// always current — a crash or a dropped Wi-Fi never costs more than the step
		// in flight. Returned so a command that must be durable can await it.
		return persist(ctx);
	};

	const setMode = (next: "build" | "plan", ctx: ExtensionContext, silent = false) => {
		if (next === "plan" && mode !== "plan") toolsBefore = pi.getActiveTools();
		mode = next;
		if (next === "plan") {
			// A fresh planning round: the previous approval no longer covers it.
			todos = [];
			approved = false;
			pi.setActiveTools(planToolSet(toolsBefore ?? pi.getActiveTools()));
			if (!silent) ctx.ui.notify("Plan mode — research only. Shift+Tab (or /plan) for Build to edit.", "info");
		} else {
			pi.setActiveTools(toolsBefore ?? pi.getActiveTools());
			toolsBefore = undefined;
			// Keep the checklist: progress stays visible as BUILD done/total.
			// A fresh Plan session (or /todo clear) resets it.
			if (!silent) ctx.ui.notify("Build mode — full access restored.", "info");
		}
		refresh(ctx);
	};

	/**
	 * Turn the strict preset on/off from `/plan strict`. Persisted so it
	 * survives restarts; the env override is handled by the caller.
	 */
	const setStrict = async (value: boolean, ctx: ExtensionContext) => {
		strict = value;
		const dir = agentDir();
		if (dir) {
			try {
				await setPlanStrict(dir, value);
			} catch {
				/* best effort: the in-memory toggle still applies this session */
			}
		}
		refresh(ctx);
	};

	const handleStrict = async (arg: string, ctx: ExtensionContext) => {
		const want = arg.trim().toLowerCase();
		if (want === "") {
			ctx.ui.notify(
				`Strict plan mode is ${strict ? "ON" : "OFF"}${strictLockedByEnv ? " (fixed by your lab)" : ""}. Use /plan strict on|off.`,
				"info",
			);
			return;
		}
		if (want !== "on" && want !== "off") {
			ctx.ui.notify("Usage: /plan strict on | /plan strict off", "info");
			return;
		}
		if (strictLockedByEnv) {
			ctx.ui.notify(
				`Strict plan mode is set by your lab and cannot be changed here (it is ${strict ? "on" : "off"}).`,
				"warning",
			);
			return;
		}
		await setStrict(want === "on", ctx);
		ctx.ui.notify(
			want === "on"
				? "Strict plan mode on — make a plan and /approve before editing."
				: "Strict plan mode off — editing is free again.",
			"info",
		);
	};

	pi.registerCommand("plan", {
		description:
			"Toggle Plan / Build mode (Shift+Tab), start a guided plan (/plan <template> [about]), or set the strict preset (/plan strict on|off)",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = String(argumentPrefix ?? "");
			// Only the first token is a template name; after the space it is the
			// student's own subject text, which is free-form.
			if (prefix.includes(" ")) return null;
			const options = [
				...listTemplates().map((t) => ({ value: t.name, label: t.name, description: t.summary })),
				{ value: "strict", label: "strict", description: "Turn the strict plan preset on or off" },
			];
			const p = prefix.trim().toLowerCase();
			return options.filter((o) => o.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			// Bare /plan keeps its original job: flip between Plan and Build.
			if (text === "") {
				setMode(mode === "plan" ? "build" : "plan", ctx);
				return;
			}
			const space = text.indexOf(" ");
			const name = (space === -1 ? text : text.slice(0, space)).toLowerCase();
			const subject = space === -1 ? "" : text.slice(space + 1).trim();
			if (name === "strict") {
				await handleStrict(subject, ctx);
				return;
			}
			const prompt = expandTemplate(name, subject);
			if (!prompt) {
				const names = listTemplates()
					.map((t) => t.name)
					.join(", ");
				ctx.ui.notify(
					`Unknown plan template "${name}". Try one of: ${names}. (Or /plan with no name to toggle Plan/Build.)`,
					"warning",
				);
				return;
			}
			// A template is a planning aid: enter Plan mode silently (one notice
			// is enough), then send the lesson as the student's own message. Pi's
			// turn, the checklist parse, and /approve all follow from there.
			if (mode !== "plan") setMode("plan", ctx, true);
			ctx.ui.notify(
				`Plan template "${name}" — planning now. Run /approve when the plan looks right.`,
				"info",
			);
			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("approve", {
		description: "Approve the plan: switch to Build and start executing",
		handler: async (_args, ctx) => {
			if (mode === "plan") {
				if (todos.length === 0) {
					ctx.ui.notify("No checklist yet. Ask for a plan first, then /approve it.", "info");
					return;
				}
				const total = todos.length;
				approved = true;
				setMode("build", ctx, true);
				ctx.ui.notify(`Plan approved — ${total} steps. Building: /todo done <n> as you go.`, "info");
				return;
			}
			// Strict mode can leave Build locked with a plan that was never
			// approved (e.g. a resume). /approve is the way out without wiping it.
			if (strict && !approved && todos.length > 0) {
				approved = true;
				await refresh(ctx);
				ctx.ui.notify("Plan approved — editing is unlocked.", "info");
				return;
			}
			ctx.ui.notify("Nothing to approve — you are already in Build mode.", "info");
		},
	});

	pi.registerCommand("todo", {
		description: "Manage the plan checklist: /todo add <text> | /todo done <n> | /todo clear",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = String(argumentPrefix ?? "");
			const space = prefix.indexOf(" ");
			if (space === -1) {
				return ["add", "done", "clear"]
					.filter((sub) => sub.startsWith(prefix.toLowerCase()))
					.map((sub) => ({
						value: sub,
						label: sub,
						description:
							sub === "add"
								? "Add a checklist step"
								: sub === "done"
									? "Complete a step by number"
									: "Clear the checklist",
					}));
			}
			const sub = prefix.slice(0, space).toLowerCase();
			const rest = prefix.slice(space + 1);
			if (sub === "done") {
				return todos
					.filter((t) => !t.completed && String(t.step).startsWith(rest.trim()))
					.map((t) => ({ value: String(t.step), label: `${t.step}. ${t.text}` }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			const space = text.indexOf(" ");
			const sub = (space === -1 ? text : text.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : text.slice(space + 1).trim();
			if (sub === "add" && rest.length > 0) {
				const item = addTodoItem(todos, rest);
				await refresh(ctx);
				ctx.ui.notify(`Added step ${item.step}: ${item.text}`, "info");
			} else if (sub === "done" && rest.length > 0) {
				if (!completeTodoItem(todos, rest)) {
					ctx.ui.notify(`No step ${rest}. /todos lists the checklist.`, "info");
					return;
				}
				await refresh(ctx);
				ctx.ui.notify(`Step ${rest} done.`, "info");
			} else if (sub === "clear") {
				todos = [];
				approved = false;
				await refresh(ctx);
				ctx.ui.notify("Checklist cleared.", "info");
			} else {
				ctx.ui.notify("Usage: /todo add <text> | /todo done <n> | /todo clear", "info");
			}
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
		const name = (event as { toolName?: string }).toolName ?? "";
		const safe = name === "bash" && isSafeCommand((event as { input?: { command?: string } }).input?.command);
		if (mode === "plan") {
			if (!isBlockedInPlanMode(name, safe)) return undefined;
			return {
				block: true,
				reason: "Plan mode is on — research only. Press Shift+Tab (or /plan) for Build mode to edit.",
			};
		}
		// Strict preset: Build stays locked until a plan exists and is approved.
		const reason = strictLockReason({ strict, mode, approved, todoCount: todos.length });
		if (!reason) return undefined;
		if (!isBlockedInPlanMode(name, safe)) return undefined;
		return { block: true, reason };
	});

	pi.on("before_agent_start", async (event) => {
		// Pi 1.2 fires this for custom runs too; the plan context belongs only
		// on a student's own prompt, not on a tour/custom turn.
		if (event.messageType !== "user") return undefined;
		if (mode !== "plan") return undefined;
		return {
			message: {
				customType: "plan-mode-context",
				content:
					"[PLAN MODE ACTIVE]\nYou are in plan mode: research the codebase and propose a numbered plan under a \"Plan:\" header. Do NOT edit, write, or run mutating commands — those tools are disabled.",
				display: false,
			},
		};
	});

	// Pull numbered steps out of the model's plan; track [DONE:n] checkoffs.
	// Runs in both modes so BUILD done/total climbs as steps complete.
	pi.on("agent_end", async (event, ctx) => {
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const texts: string[] = [];
		for (const item of messages) {
			// AgentMessage carries role/content directly; accept a { message } wrapper just in case.
			const entry = (item as { message?: { role?: string; content?: unknown } })?.message
				?? (item as { role?: string; content?: unknown });
			const content = entry?.content;
			if (entry?.role !== "assistant" || content == null) continue;
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
		// Always start in Build, including resume/fork. The checklist, though,
		// belongs to the conversation and is brought back from its checkpoint.
		mode = "build";
		toolsBefore = undefined;
		approved = false;
		// The lab's environment variable (if any) wins over the student's setting.
		const dir = agentDir();
		try {
			const saved = dir ? await readPlanStrict(dir) : false;
			const preset = resolveStrictPreset(saved, process.env.LEARNINGCODE_PLAN_STRICT);
			strict = preset.strict;
			strictLockedByEnv = preset.locked;
		} catch {
			// A corrupt settings file must never stop startup.
			strict = false;
			strictLockedByEnv = false;
		}
		const id = sessionIdOf(ctx);
		const state = id && dir ? await loadPlanState(dir, id) : { todos: [] as Todo[], approved: false };
		todos = state.todos;
		approved = state.approved;
		if (ctx.hasUI) {
			refresh(ctx);
			if (todos.length > 0) {
				const done = todos.filter((t) => t.completed).length;
				ctx.ui.notify(
					`Restored your plan checklist — ${todos.length} step${todos.length === 1 ? "" : "s"}${done ? `, ${done} done` : ""}.`,
					"info",
				);
			}
			if (strict && !(approved && todos.length > 0)) {
				ctx.ui.notify("Strict plan mode is on — make a plan and /approve before editing.", "warning");
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Final flush before the in-memory state is dropped, so a step marked a
		// moment ago is never lost to a quit or a session switch.
		await persist(ctx);
		mode = "build";
		todos = [];
		toolsBefore = undefined;
		approved = false;
		strict = false;
		strictLockedByEnv = false;
	});
}

export const _internals = { PLAN_WIDGET_MIN_WIDTH, todoLines };
