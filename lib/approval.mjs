/**
 * Commands a student should confirm before they run. Matched against the shell
 * command text, since Pi's built-in tools carry no destructiveHint annotation.
 * Kept in plain JS so the patterns can be tested without Pi's runtime.
 */
export const DESTRUCTIVE_PATTERNS = [
	{ kind: "delete-files", re: /\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, why: "deletes files" },
	{ kind: "delete-files-windows", re: /\bdel\s+\/[sq]/i, why: "deletes files (Windows)" },
	{ kind: "delete-tree-powershell", re: /\bremove-item\b.*-recurse/i, why: "deletes files (PowerShell)" },
	{ kind: "delete-tree-windows", re: /\brmdir\s+\/s/i, why: "deletes a folder tree (Windows)" },
	{ kind: "force-push", re: /\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/i, why: "force-pushes" },
	{ kind: "git-reset-hard", re: /\bgit\s+reset\s+--hard\b/i, why: "discards uncommitted changes" },
	{ kind: "git-clean", re: /\bgit\s+clean\b.*-[a-z]*f/i, why: "deletes untracked files" },
	{ kind: "git-discard", re: /\bgit\s+checkout\s+--\s/i, why: "discards file changes" },
	{ kind: "npm-publish", re: /\bnpm\s+publish\b/i, why: "publishes a package" },
	{ kind: "sudo", re: /\bsudo\b/i, why: "runs as administrator" },
	{ kind: "insecure-permissions", re: /\b(chmod|chown)\b.*\b777\b/i, why: "opens file permissions" },
	{ kind: "format-drive", re: /\bformat\s+[a-z]:/i, why: "formats a drive" },
	{ kind: "power", re: /\b(shutdown|reboot)\b/i, why: "restarts or shuts down the computer" },
];

/**
 * The destructive kind a command belongs to, with its plain reason, or null
 * when the command looks safe. `kind` is the stable identity: "Allow Always"
 * remembers it, so a later command of the same kind (a different `rm -rf`
 * target, a rewritten script) is recognised even though the text differs.
 */
export function destructiveMatch(command) {
	return destructiveMatches(command)[0] ?? null;
}

/**
 * Every destructive kind a command belongs to, in pattern order. A compound
 * command can be more than one danger (`sudo rm -rf /` both deletes files and
 * runs as administrator), and reporting only the first would understate it and
 * make "Always allow" remember less than the student just approved.
 */
export function destructiveMatches(command) {
	if (typeof command !== "string" || !command.trim()) return [];
	return DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(command)).map((p) => ({ kind: p.kind, why: p.why }));
}

/** The reason a command needs confirmation, or null when it looks safe. */
export function destructiveReason(command) {
	return destructiveMatch(command)?.why ?? null;
}

/**
 * Bounds for the command echo inside the approval prompt. The prompt is shown
 * through `ctx.ui.select(title, ["Yes", "No"])`, where a long title pushes the
 * Yes/No options off screen: the student sees a wall of command text with no
 * visible choice (Enter still accepts the default Yes, but a new user cannot
 * know that). The command is therefore truncated to a few lines / chars so the
 * trailing "Allow it?" and the options stay in view.
 *
 * Budget: header (~45 chars) + command (300) + footer (~25) stays under the
 * phone bridge's 400-char approval clip (see sanitizeExtensionUi), so the
 * question survives there too.
 */
export const APPROVAL_COMMAND_MAX_CHARS = 300;
export const APPROVAL_COMMAND_MAX_LINES = 6;

/** Shortened command text for the approval prompt, with an explicit marker. */
export function truncateApprovalCommand(command, maxChars = APPROVAL_COMMAND_MAX_CHARS, maxLines = APPROVAL_COMMAND_MAX_LINES) {
	const text = String(command ?? "").trim();
	if (!text) return "(empty command)";
	const lines = text.split("\n");
	const clippedLines = lines.slice(0, maxLines);
	const droppedLines = lines.length - clippedLines.length;
	let out = clippedLines.join("\n");
	if (droppedLines > 0) out += `\n… (+${droppedLines} more line${droppedLines === 1 ? "" : "s"})`;
	if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
	return out;
}

/**
 * Full approval prompt. The question leads (so a clipped view still shows it)
 * and repeats at the end next to the Yes/No options, with the Enter-hint a new
 * user needs: Enter accepts the default Yes, Esc answers No.
 */
export function formatApprovalPrompt(command, why) {
	const short = truncateApprovalCommand(command);
	return `This command ${why} — Allow it? (Enter = Yes):\n\n  ${short}\n\nAllow it?`;
}