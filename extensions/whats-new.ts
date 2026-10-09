import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Shows the "What's new" notice once after an update, inside the session.
 *
 * The launcher decides whether a notice is due (lib/changelog.mjs) and passes the
 * formatted text in LEARNINGCODE_NOTICE. This runs on session_start, after the
 * banner has drawn, so the notice lands in the chat history instead of being
 * painted over by the TUI. Nothing is shown when the variable is empty.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const notice = process.env.LEARNINGCODE_NOTICE ?? "";
		if (!notice) return;
		ctx.ui.notify(notice, "info");
	});
}