import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The scripted first-run tour. Fixed script, not a conversation: one posted
 * opener, one guided model turn, student drives from there. Token cost is
 * disclosed up front because every turn spends quota — the footer exists
 * for the same reason.
 */

/** Marker file in the agent dir; present means the tour already ran. */
export const INTRO_MARKER = ".intro-seen";

/** Env var the launcher sets when `--no-intro` is passed. */
export const NO_INTRO_ENV = "LEARNINGCODE_NO_INTRO";

/** Env var the launcher sets only for a bare interactive first launch. */
export const AUTO_INTRO_ENV = "LEARNINGCODE_INTRO_AUTO";

export function hasSeenIntro(agentDir) {
	return existsSync(join(agentDir, INTRO_MARKER));
}

export async function markIntroSeen(agentDir) {
	await writeFile(join(agentDir, INTRO_MARKER), `${new Date().toISOString()}\n`, "utf-8");
}

/**
 * The fixed tour opener, posted as the student's first message. Short on
 * purpose: each line is a step the model walks through in a single guided
 * turn (~2 model turns total for the whole tour).
 */
export const INTRO_OPENER = [
	"Welcome to learningcode! This is a 5-minute guided tour (about 2k tokens, roughly 1% of a daily budget — just say skip anytime).",
	"",
	"Please walk me through these four steps, one at a time, keeping each reply short:",
	"1. Ask me what I want to build, then answer it and point out which tools you used.",
	"2. Ask me to press Shift+Tab to try Plan mode, and explain what changed.",
	"3. Ask me to run /quota so I can see my token spend in the footer.",
	"4. Congratulate me and tell me to type /todos whenever I want the plan checklist.",
].join("\n");

/**
 * Whether this launch should auto-start the tour: interactive TTY, first
 * run, no opt-out, and the student did not already type their own opening
 * message (never hijack a real request).
 */
export function shouldAutoIntro({ interactive, seen, noIntro, hasInitialPrompt }) {
	return Boolean(interactive && !seen && !noIntro && !hasInitialPrompt);
}
