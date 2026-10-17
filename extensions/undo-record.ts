import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordToolCall } from "../lib/undo-record.mjs";

/**
 * Records a helper's file changes into its parent's undo journal.
 *
 * A helper runs as a separate `--no-session` process, so without this its edits
 * would be invisible to `/undo` — a "never lose a student's work" regression.
 * The parent passes its session id in LEARNINGCODE_UNDO_SESSION, and the shared
 * recorder resolves it there (see lib/undo-record.mjs).
 *
 * Only file-changing helpers get this extension (see lib/subagent/child.mjs).
 * There is no `/undo` command here: undoing is the parent's job.
 */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		await recordToolCall(event as never, ctx as never);
		return undefined;
	});
}
