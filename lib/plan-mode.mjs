/**
 * Plan mode pure logic: todo extraction/completion and the read-only tool set.
 * The TUI/RPC glue lives in extensions/plan-mode.ts; everything here is
 * testable without Pi.
 */

/** Tools that stay visible to the model in Plan mode. Bash is gated per-command. */
export const PLAN_READ_TOOLS = ["read", "grep", "find", "ls", "questionnaire"];

/** Writers that Plan mode always hides from the model and blocks. */
export const PLAN_BLOCKED_TOOLS = new Set(["edit", "write"]);

/**
 * The tool set to declare while planning: the student's current set minus
 * writers, plus the readers (in case the student turned one off).
 */
export function planToolSet(activeTools) {
	const kept = activeTools.filter((name) => !PLAN_BLOCKED_TOOLS.has(name));
	const merged = [...kept];
	for (const name of PLAN_READ_TOOLS) {
		if (!merged.includes(name)) merged.push(name);
	}
	return merged;
}

/** True for tool calls Plan mode must refuse. Bash is judged per command. */
export function isBlockedInPlanMode(toolName, isSafeBash) {
	if (PLAN_BLOCKED_TOOLS.has(toolName)) return true;
	if (toolName === "bash") return !isSafeBash;
	return false;
}

// Destructive commands blocked in plan mode (mirrors Pi's plan-mode example).
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*wc\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote)/i,
	/^\s*npm\s+(list|ls|view|outdated)/i,
	/^\s*node\s+--version/i,
	/^\s*rg\b/,
	/^\s*fd\b/,
];

/** A bash command is plan-safe when allowlisted and not destructive. */
export function isSafeCommand(command) {
	const text = String(command ?? "");
	return !DESTRUCTIVE_PATTERNS.some((p) => p.test(text)) && SAFE_PATTERNS.some((p) => p.test(text));
}

export function cleanStepText(text) {
	let cleaned = String(text)
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 50) cleaned = `${cleaned.slice(0, 47)}...`;
	return cleaned;
}

/** Numbered steps under a `Plan:` header become the progress checklist. */
export function extractTodoItems(message) {
	const items = [];
	const headerMatch = String(message).match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;
	const planSection = String(message).slice(String(message).indexOf(headerMatch[0]) + headerMatch[0].length);
	for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

/** Mark `[DONE:n]` steps complete. Returns how many markers were found. */
export function markCompletedSteps(text, items) {
	let count = 0;
	for (const match of String(text).matchAll(/\[DONE:(\d+)\]/gi)) {
		const item = items.find((t) => t.step === Number(match[1]));
		if (item && !item.completed) {
			item.completed = true;
			count += 1;
		} else if (item) {
			count += 1;
		}
	}
	return count;
}
