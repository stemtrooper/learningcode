import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNDO_SESSION_ENV, agentDir } from "../config.mjs";
import { agentEnvironment, extensionsDir, resolvePiEntry } from "../pi.mjs";
import { needsApproval, needsUndoRecord } from "./agents.mjs";

/**
 * Running one helper.
 *
 * Each helper is a separate `pi` process in `-p --mode json --no-session` mode:
 * isolated context window, no entry in the session store, machine-readable
 * output. The argv is built here and deliberately does **not** reuse
 * `forcedPiArgs`: that loads the eleven TUI extensions (footer, banner, cat,
 * quota, …), none of which belong in a non-interactive child.
 *
 * The JSON-lines shape is pinned to what Pi 1.3.0 emits (docs/json.md):
 * `message_end` carries the authoritative message; `agent_settled` means Pi has
 * no more automatic work. Pi's own example still listens for `tool_result_end`,
 * which this version does not emit — so we do not.
 */

/** Total helpers in one call. */
export const MAX_TASKS = 6;
/** Helpers in flight at once. */
export const MAX_CONCURRENCY = 3;
/**
 * Bytes of a helper's final answer handed back to the parent model. The full
 * text always survives in the tool details (Ctrl+O). Pi's example caps at 50 KB;
 * a smaller cap keeps the parent's context — and the student's bill — small.
 */
export const PER_TASK_TEXT_CAP = 8 * 1024;

/** A fresh per-run token/usage accumulator. */
export function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Build the spawn plan for one helper. Pure apart from resolving the Pi entry,
 * which callers may inject (tests do).
 */
export function planChild(agent, {
	model,
	thinking,
	cwd,
	undoSession,
	dir,
	piEntry,
	resolveEntry = resolvePiEntry,
} = {}) {
	const entry = piEntry === undefined ? resolveEntry() : piEntry;
	if (!entry) throw new Error("Cannot find the Pi runtime to start a helper.");

	const args = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	// Only the extensions a given helper actually needs. This is the whole child
	// extension policy in one place.
	if (needsApproval(agent)) args.push("--extension", join(extensionsDir(), "approval.ts"));
	if (needsUndoRecord(agent)) args.push("--extension", join(extensionsDir(), "undo-record.ts"));

	const env = {
		...process.env,
		...agentEnvironment({ dir: dir ?? agentDir() }),
		// The child has no session of its own; this is how its file edits reach
		// the parent's journal so `/undo` can put them back.
		...(undoSession ? { [UNDO_SESSION_ENV]: undoSession } : {}),
	};

	return {
		command: process.execPath,
		baseArgs: [entry, ...args],
		env,
		cwd: cwd ?? process.cwd(),
		prompt: agent.systemPrompt ?? "",
		agent: agent.name,
		model,
	};
}

/** Update an accumulator from one parsed JSON event. Unknown events are ignored. */
export function applyEvent(event, state) {
	if (!event || typeof event !== "object") return;
	if (event.type !== "message_end" || !event.message) return;
	const msg = event.message;
	state.messages.push(msg);
	if (msg.role !== "assistant") return;

	state.turns += 1;
	const usage = msg.usage;
	if (usage) {
		state.usage.input += usage.input || 0;
		state.usage.output += usage.output || 0;
		state.usage.cacheRead += usage.cacheRead || 0;
		state.usage.cacheWrite += usage.cacheWrite || 0;
		state.usage.cost += usage.cost?.total || 0;
		state.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!state.model && msg.model) state.model = msg.model;
	if (msg.stopReason) state.stopReason = msg.stopReason;
	if (msg.errorMessage) state.errorMessage = msg.errorMessage;
}

/** The final assistant text of a run, concatenated from its text blocks. */
export function assistantText(messages) {
	const last = [...messages].reverse().find((m) => m?.role === "assistant");
	if (!last) return "";
	const content = last.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("")
			.trim();
	}
	return "";
}

/** Whether a run should be shown as a failure. */
export function runFailed(state) {
	return state.exitCode !== 0 || state.aborted === true || Boolean(state.errorMessage) || state.stopReason === "error";
}

const parseLine = (line) => {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	};
};

/**
 * Spawn one helper and resolve with its accumulated state. Never rejects: a
 * spawn error or a crash resolves with a non-zero exit code, which the renderer
 * turns into one plain sentence.
 */
export function runChild(plan, task, { signal, onEvent } = {}) {
	return new Promise((resolve) => {
		let tmpDir = null;
		let tmpPath = null;
		const args = [...plan.baseArgs];

		if (plan.prompt && plan.prompt.trim()) {
			try {
				tmpDir = mkdtempSync(join(tmpdir(), "lc-helper-"));
				tmpPath = join(tmpDir, "prompt.md");
				writeFileSync(tmpPath, plan.prompt, { mode: 0o600 });
				args.push("--append-system-prompt", tmpPath);
			} catch {
				/* not fatal: the helper runs with Pi's default system prompt */
			}
		}
		args.push(`Task: ${task}`);

		const state = {
			messages: [],
			usage: emptyUsage(),
			model: plan.model,
			stopReason: null,
			errorMessage: null,
			turns: 0,
			stderr: "",
			aborted: false,
			exitCode: 0,
			task,
			agent: plan.agent,
		};

		const cleanup = () => {
			if (tmpDir) {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		};

		let child;
		try {
			child = spawn(plan.command, args, {
				cwd: plan.cwd,
				env: plan.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			cleanup();
			resolve({ ...state, exitCode: 1 });
			return;
		}

		let buffer = "";
		const handleLine = (line) => {
			if (!line.trim()) return;
			const event = parseLine(line);
			applyEvent(event, state);
			if (onEvent) onEvent(event, state);
		};

		const onAbort = () => {
			state.aborted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		};

		child.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr.on("data", (data) => {
			state.stderr += data.toString();
		});
		child.on("close", (code) => {
			if (buffer.trim()) handleLine(buffer);
			state.exitCode = state.aborted ? 1 : code ?? 0;
			if (signal) signal.removeEventListener("abort", onAbort);
			cleanup();
			resolve(state);
		});
		child.on("error", () => {
			state.exitCode = 1;
			if (signal) signal.removeEventListener("abort", onAbort);
			cleanup();
			resolve(state);
		});

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Run up to MAX_TASKS helpers with at most MAX_CONCURRENCY in flight, preserving
 * input order in the result. Used for the parallel mode.
 */
export async function runBounded(tasks, limit, worker) {
	const results = new Array(tasks.length);
	let next = 0;
	const run = async () => {
		while (next < tasks.length) {
			const index = next;
			next += 1;
			results[index] = await worker(tasks[index], index);
		}
	};
	const pool = Array.from({ length: Math.min(limit, tasks.length) }, run);
	await Promise.all(pool);
	return results;
}
