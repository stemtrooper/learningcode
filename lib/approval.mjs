/**
 * Commands a student should confirm before they run. Matched against the shell
 * command text, since Pi's built-in tools carry no destructiveHint annotation.
 * Kept in plain JS so the patterns can be tested without Pi's runtime.
 */
export const DESTRUCTIVE_PATTERNS = [
	{ re: /\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b/i, why: "deletes files" },
	{ re: /\bdel\s+\/[sq]/i, why: "deletes files (Windows)" },
	{ re: /\bremove-item\b.*-recurse/i, why: "deletes files (PowerShell)" },
	{ re: /\brmdir\s+\/s/i, why: "deletes a folder tree (Windows)" },
	{ re: /\bgit\s+push\b.*(--force|-f\b|--force-with-lease)/i, why: "force-pushes" },
	{ re: /\bgit\s+reset\s+--hard\b/i, why: "discards uncommitted changes" },
	{ re: /\bgit\s+clean\b.*-[a-z]*f/i, why: "deletes untracked files" },
	{ re: /\bgit\s+checkout\s+--\s/i, why: "discards file changes" },
	{ re: /\bnpm\s+publish\b/i, why: "publishes a package" },
	{ re: /\bsudo\b/i, why: "runs as administrator" },
	{ re: /\b(chmod|chown)\b.*\b777\b/i, why: "opens file permissions" },
	{ re: /\bformat\s+[a-z]:/i, why: "formats a drive" },
	{ re: /\b(shutdown|reboot)\b/i, why: "restarts or shuts down the computer" },
];

/** The reason a command needs confirmation, or null when it looks safe. */
export function destructiveReason(command) {
	if (typeof command !== "string" || !command.trim()) return null;
	const hit = DESTRUCTIVE_PATTERNS.find((p) => p.re.test(command));
	return hit ? hit.why : null;
}