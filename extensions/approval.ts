import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Approval prompts: a destructive shell command waits for a yes before it runs.
 *
 * The patterns live in lib/approval.mjs so they can be tested. With a UI the
 * student is asked; without one (print or remote-less runs) the command is
 * blocked, the same fail-safe Pi's own permission-gate example uses.
 */
import { destructiveReason } from "../lib/approval.mjs";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: string }).command ?? "");
		const why = destructiveReason(command);
		if (!why) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked: this command ${why}, and there is no one to confirm it.` };
		}

		const choice = await ctx.ui.select(`This command ${why}:\n\n  ${command}\n\nAllow it?`, ["Yes", "No"]);
		if (choice !== "Yes") {
			return { block: true, reason: "Not approved by the student." };
		}
		return undefined;
	});
}