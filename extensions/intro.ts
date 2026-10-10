import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/config.mjs";
import { AUTO_INTRO_ENV, INTRO_OPENER, NO_INTRO_ENV, hasSeenIntro, markIntroSeen } from "../lib/intro.mjs";

/**
 * First-run tour. On the first interactive session the launcher leaves the
 * marker absent; this extension posts the fixed script opener as a user
 * message (one guided turn, ~2k tokens — price disclosed in the script).
 * `/intro` replays it any time. `--no-intro` skips silently.
 */

export default function intro(pi: ExtensionAPI) {
	const dir = () => {
		try {
			return agentDir();
		} catch {
			return undefined;
		}
	};

	pi.registerCommand("intro", {
		description: "Replay the 5-minute guided tour",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(INTRO_OPENER);
			if (!ctx.hasUI) return;
			ctx.ui.notify("Tour restarted — follow along above.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (process.env[NO_INTRO_ENV] === "1") return;
		// Auto-post only on a bare first launch (launcher sets the env after
		// confirming no typed message); /intro replays any time.
		if (process.env[AUTO_INTRO_ENV] !== "1") return;
		const d = dir();
		if (!d || hasSeenIntro(d)) return;
		try {
			pi.sendUserMessage(INTRO_OPENER);
			await markIntroSeen(d);
		} catch {
			/* Never break session start: the tour is optional, the session is not. */
		}
	});
}
