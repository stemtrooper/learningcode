import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The plan checklist, remembered between runs.
 *
 * The checklist lived only in the extension's memory, so `learningcode -c`,
 * a crash, or a dropped lab Wi-Fi wiped the student's progress and left them
 * staring at an empty plan. Pi already checkpoints the transcript itself; this
 * is the one piece of session state we own, so it is checkpointed too.
 *
 * Keyed by session id: resuming a conversation restores its own checklist,
 * and a brand-new session starts clean. A corrupt or hand-edited file is
 * ignored rather than trusted, because this feeds straight into the UI.
 *
 * Every write is best-effort. A read-only home, a full disk, or a permissions
 * problem must never stop the agent from starting.
 */

/** Where one session's checklist is remembered. */
export function planStorePath(agentDir, sessionId) {
	const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "session";
	return join(agentDir, "plans", `${safe}.json`);
}

/**
 * Persist the checklist for a session. An empty list removes the file, so a
 * cleared or finished plan leaves nothing behind to restore by surprise.
 */
export async function savePlanTodos(agentDir, sessionId, todos) {
	try {
		const path = planStorePath(agentDir, sessionId);
		if (!Array.isArray(todos) || todos.length === 0) {
			await rm(path, { force: true });
			return;
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify({ todos: normalizeTodos(todos) }, null, 2)}\n`, "utf-8");
	} catch {
		/* best-effort: storage must never break the agent */
	}
}

/** Load a remembered checklist for a session; [] when there is none. */
export async function loadPlanTodos(agentDir, sessionId) {
	try {
		const parsed = JSON.parse(await readFile(planStorePath(agentDir, sessionId), "utf-8"));
		return normalizeTodos(parsed?.todos);
	} catch {
		return [];
	}
}

/**
 * Accept only well-formed steps with non-empty text, and renumber so the
 * numbers stay contiguous even if the file was edited. Anything else is
 * dropped rather than rendered.
 */
export function normalizeTodos(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const text = typeof item.text === "string" ? item.text.trim() : "";
		if (!text) continue;
		const step = Number.isInteger(item.step) && item.step > 0 ? item.step : out.length + 1;
		out.push({ step, text, completed: Boolean(item.completed) });
	}
	return out;
}
