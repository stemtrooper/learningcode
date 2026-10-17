import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/config.mjs";
import { loadJournal, restoreJournal, summarizeJournal } from "../lib/undo-journal.mjs";
import { recordToolCall } from "../lib/undo-record.mjs";

/**
 * Undo: puts back what the agent changed.
 *
 * Two layers, because neither is enough alone:
 *   - tracked files are reset to the last commit (`git checkout HEAD -- .`),
 *     which covers anything a shell command changed;
 *   - files the agent created are removed, and untracked files it overwrote are
 *     restored from the per-session journal (lib/undo-journal.mjs), which git
 *     cannot know about.
 *
 * It is blunt on purpose, and says so: tracked files also lose the student's own
 * uncommitted edits. A folder with no git commit is still undoable for the
 * files the agent touched. Without a UI the whole thing is refused, the same
 * fail-safe the approval gate uses.
 */
export default function (pi: ExtensionAPI) {
	// Record files just before the agent changes them, so the pre-state exists
	// when /undo asks for it. Only the structured file tools can be tracked;
	// shell effects are why the git layer is still here. The recorder is shared
	// with the child-only undo-record extension, so the two cannot drift.
	pi.on("tool_call", async (event, ctx) => {
		await recordToolCall(event as never, ctx as never);
		return undefined;
	});

	pi.registerCommand("undo", {
		description: "Undo the agent's file changes and reset tracked files to the last commit",
		handler: async (_args, ctx) => {
			const dir = agentDir();
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
			const manifest = sessionId ? await loadJournal(dir, sessionId) : null;
			const summary = summarizeJournal(manifest, ctx.cwd);
			const journalCount = summary.created.length + summary.modified.length;

			const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"]).catch(() => null);
			const hasGit = Boolean(head && head.code === 0);
			let gitChanges = false;
			if (hasGit) {
				const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=no"]).catch(() => null);
				gitChanges = Boolean(status && status.stdout.trim());
			}

			if (!journalCount && !gitChanges) {
				ctx.ui.notify(
					hasGit
						? "Nothing to undo: no uncommitted tracked changes, and the agent has not changed any files."
						: "Nothing to undo: this folder has no git commit, and the agent has not changed any files.",
					"info",
				);
				return;
			}

			const who = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
			const parts = [];
			if (summary.modified.length) parts.push(`restore ${who(summary.modified.length)} the agent changed`);
			if (summary.created.length) parts.push(`remove ${who(summary.created.length)} the agent created`);
			if (gitChanges) parts.push("reset tracked files to the last commit");
			const lines = [`Undo will ${parts.join(", and ")}.`];
			const preview = [...summary.created, ...summary.modified];
			if (preview.length) lines.push("", ...preview.slice(0, 8).map((p) => `  ${p}`));
			if (preview.length > 8) lines.push(`  … and ${preview.length - 8} more`);
			if (summary.skipped.length) lines.push("", `(${who(summary.skipped.length)} too large to restore will be left alone)`);
			lines.push("", "Tracked files lose ALL uncommitted changes, including your own unsaved edits. Continue?");

			const ok = ctx.hasUI
				? (await ctx.ui.select(lines.join("\n"), ["Yes", "No"])) === "Yes"
				: false;
			if (!ok) {
				ctx.ui.notify("Undo cancelled.", "info");
				return;
			}

			const restored = sessionId
				? await restoreJournal(dir, sessionId)
				: { restored: [], removed: [], skipped: [] };
			if (hasGit) await pi.exec("git", ["checkout", "HEAD", "--", "."]).catch(() => null);

			const bits = [];
			if (restored.restored.length) bits.push(`restored ${who(restored.restored.length)}`);
			if (restored.removed.length) bits.push(`removed ${who(restored.removed.length)} the agent created`);
			if (restored.skipped.length) bits.push(`could not restore ${who(restored.skipped.length)}`);
			if (hasGit) bits.push("tracked files reset to the last commit");
			ctx.ui.notify(bits.length ? `Undo done: ${bits.join(", ")}.` : "Undo done.", "info");
		},
	});
}
