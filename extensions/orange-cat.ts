import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";

/**
 * Owns the single working indicator and the `/cat` diagnostics probe.
 *
 * This used to render an animated orange cat above the editor. That row is
 * gone: the footer owns the working indicator (extensions/footer.ts), and two
 * working animations on screen read as two separate jobs. What remains is the
 * probe that reports which image protocol the terminal supports.
 */

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cat", {
		description: "Show which image renderer the terminal supports.",
		handler: async (_args, ctx) => {
			const caps = getCapabilities();
			ctx.ui.notify(
				"image renderer: " + (caps.images ? "true-pixel PNG (" + caps.images + ")" : "block fallback (no image protocol)"),
				"info",
			);
		},
	});

	// Single working indicator: the footer owns it (extensions/footer.ts).
	// Pi's built-in working row above the editor is hidden so "working"
	// never appears twice.
	pi.on("session_start", async (_e, ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWorkingVisible(false);
	});
}
