import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Undo: restores the tracked files to the last commit.
 *
 * This discards every uncommitted change to tracked files, including the
 * student's own unsaved work, so the confirm prompt says so. New untracked files
 * are not removed. A folder that is not a git repository has nothing to restore.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("undo", {
		description: "Discard uncommitted changes to tracked files and restore the last commit",
		handler: async (_args, ctx) => {
			const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"]).catch(() => null);
			if (!head || head.code !== 0) {
				ctx.ui.notify("Nothing to undo: this folder has no git commit.", "warning");
				return;
			}

			const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=no"]).catch(() => null);
			if (!status || !status.stdout.trim()) {
				ctx.ui.notify("Nothing to undo: no uncommitted changes to tracked files.", "info");
				return;
			}

			const ok = ctx.hasUI
				? (await ctx.ui.select(
						"This discards ALL uncommitted changes to tracked files, including your own unsaved edits, and restores the last commit. Continue?",
						["Yes", "No"],
					)) === "Yes"
				: false;
			if (!ok) {
				ctx.ui.notify("Undo cancelled.", "info");
				return;
			}

			const restored = await pi.exec("git", ["checkout", "HEAD", "--", "."]).catch(() => null);
			if (restored && restored.code === 0) {
				ctx.ui.notify("Restored the last commit. New untracked files are still there.", "info");
			} else {
				ctx.ui.notify("Could not restore: git reported an error.", "error");
			}
		},
	});
}