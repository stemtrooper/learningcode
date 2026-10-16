import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/config.mjs";
import { destructiveMatch, formatApprovalPrompt } from "../lib/approval.mjs";
import { addAlwaysAllow, addAlwaysAllowKind, readAlwaysAllow, readAlwaysAllowKinds } from "../lib/settings.mjs";

/**
 * Approval prompts: a destructive shell command waits for a yes before it runs.
 *
 * The patterns live in lib/approval.mjs so they can be tested. With a UI the
 * student is asked; without one (print or remote-less runs) the command is
 * blocked, the same fail-safe Pi's own permission-gate example uses.
 *
 * The third choice remembers a destructive *kind* ("deletes files"), not the
 * command text: the agent rewrites a command on almost every run — temp paths,
 * echo lines — so a remembered string almost never matched again and the student
 * was re-prompted forever. The older exact-string list still counts, so settings
 * files written before kinds keep working.
 */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: string }).command ?? "");
		const match = destructiveMatch(command);
		if (!match) return undefined;

		// Never re-prompt something the student already said "always allow" to.
		const dir = agentDir();
		if (dir) {
			try {
				if ((await readAlwaysAllowKinds(dir)).includes(match.kind)) return undefined;
				if ((await readAlwaysAllow(dir)).includes(command.trim())) return undefined;
			} catch {
				// Best effort: if we cannot read the list, fall through and prompt.
			}
		}

		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked: this command ${match.why}, and there is no one to confirm it.` };
		}

		// The command echo is truncated inside formatApprovalPrompt: a long
		// command used to push the Yes/No options off screen, leaving a new
		// user with no visible choice (Enter still accepted Yes).
		const alwaysLabel = `Always allow: ${match.why}`;
		const choice = await ctx.ui.select(formatApprovalPrompt(command, match.why), ["Yes", "No", alwaysLabel]);
		// The phone bridge clips option text; match the prefix so a clipped label
		// still counts as "always allow" rather than silently blocking.
		if (choice === alwaysLabel || (typeof choice === "string" && choice.startsWith("Always allow"))) {
			if (dir) {
				try {
					await addAlwaysAllowKind(dir, match.kind);
				} catch {
					// Best effort: next time the command runs it will prompt again.
				}
			}
			return undefined;
		}
		if (choice !== "Yes") {
			return { block: true, reason: "Not approved by the student." };
		}
		return undefined;
	});
}
