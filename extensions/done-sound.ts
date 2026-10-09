import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

/**
 * Done sound: a short tone when the agent finishes a turn, so a student can
 * leave the desk and come back when they hear it.
 *
 * On Windows the tone is [console]::Beep(800, 300). The child shares Pi's console
 * (a detached process has none, and Beep needs one), and is unref'd so it never
 * holds up the prompt. Elsewhere it is the terminal bell. Remote sessions
 * play their own chime on the phone (lib/remote/web-ui.mjs), so this only
 * sounds in the terminal, and only when there is a UI.
 */
function playTone() {
	if (process.platform === "win32") {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "[console]::Beep(800, 300)"],
			{ stdio: "ignore", windowsHide: true },
		);
		child.on("error", () => {
			process.stdout.write("\x07");
		});
		child.unref();
		return;
	}
	process.stdout.write("\x07");
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		playTone();
	});
}