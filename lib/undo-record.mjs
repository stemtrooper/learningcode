import { UNDO_SESSION_ENV, agentDir } from "./config.mjs";
import { recordChange } from "./undo-journal.mjs";

/**
 * Recording a file's pre-state just before an `edit`/`write` tool changes it.
 *
 * Shared by the parent's checkpoint extension and the child-only undo-record
 * extension so the two cannot drift. A helper runs as a separate `--no-session`
 * process with no session id of its own, so the parent passes its id in the
 * environment; the helper's edits then land in the same journal the parent's
 * `/undo` reads.
 */

/**
 * The session id whose journal this process should write: the parent's when
 * bridged through the environment, otherwise our own session's.
 */
export function journalSessionId(ctx) {
	return process.env[UNDO_SESSION_ENV] || ctx?.sessionManager?.getSessionId?.() || null;
}

/** Record the pre-state of a file the agent is about to edit or write. */
export async function recordToolCall(event, ctx) {
	const name = event?.toolName;
	if (name !== "edit" && name !== "write") return;
	const path = event?.input?.path;
	if (typeof path !== "string" || !path) return;
	const dir = agentDir();
	const sessionId = journalSessionId(ctx);
	if (!dir || !sessionId) return;
	await recordChange(dir, sessionId, ctx?.cwd, path);
}
