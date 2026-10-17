/**
 * Quota pacing — pure math and wording. No Pi, no network, no disk.
 *
 * A "step" is one assistant turn. Spark's quota is a daily token budget, so the
 * honest answer a student can act on is not tokens but *about how many more
 * steps today*. Everything here is approximate on purpose: the number rounds
 * down and every rendered line says "about", so it can never read as a promise.
 *
 * Dollars do not appear here. On Spark a student cannot act on a price; the
 * off-Spark spend already lives in lib/spend.mjs, where the model catalog has
 * rates.
 */

/**
 * What one step costs when the session has no history to measure. Deliberately
 * pessimistic — a fresh session should under-promise, not flatter the student
 * into spending a step they do not have.
 */
export const DEFAULT_TOKENS_PER_STEP = 12000;

/** A reserve is a small non-negative whole number of steps. */
function toReserve(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.floor(n);
}

/** Parse a reserve pin, or null when the value is not a usable number/word. */
function parsePin(text) {
	const raw = String(text ?? "").trim().toLowerCase();
	if (!raw) return null;
	if (["off", "none", "0", "false", "no"].includes(raw)) return 0;
	if (!/^\d+$/.test(raw)) return null;
	return Math.floor(Number(raw));
}

/**
 * Tokens still available today, or null when there is no ceiling to measure
 * against. Null is *never* zero: an absent cap, a zero cap, or Spark's explicit
 * exemption all mean "no daily limit", and the client must say that rather than
 * invent a ceiling.
 */
export function remainingTokens(quota) {
	if (!quota || quota.quotaExempt === true) return null;
	const limit = quota.dailyTokenLimit;
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
	const used = Number(quota.tokensUsed);
	return Math.max(0, limit - (Number.isFinite(used) ? used : 0));
}

/** Measured tokens per assistant step, or null when there is nothing to divide. */
export function observedTokensPerStep(tokens, steps) {
	const t = Number(tokens);
	const s = Number(steps);
	if (!Number.isFinite(t) || !Number.isFinite(s) || t <= 0 || s <= 0) return null;
	return t / s;
}

/** The measured rate, or the conservative default when history is empty. */
export function tokensPerStep(tokens, steps, fallback = DEFAULT_TOKENS_PER_STEP) {
	const observed = observedTokensPerStep(tokens, steps);
	return observed ?? fallback;
}

/**
 * About how many more steps today, after keeping `reserve` back. Rounds down.
 * Returns null when there is no daily limit (see remainingTokens) and 0 when
 * the ceiling is reached — a real, plannable zero, unlike the null above.
 */
export function stepsLeft({ remainingTokens: remaining, tokensPerStep: perStep = DEFAULT_TOKENS_PER_STEP, reserve = 0 } = {}) {
	if (remaining === null || remaining === undefined) return null;
	const rem = Number(remaining);
	if (!Number.isFinite(rem)) return null;
	const per = Number(perStep) > 0 ? Number(perStep) : DEFAULT_TOKENS_PER_STEP;
	return Math.max(0, Math.floor(rem / per) - toReserve(reserve));
}

/** True when the agent has reached the reserve and should stop before changing files. */
export function holdsAtReserve({ steps, reserve } = {}) {
	return toReserve(reserve) > 0 && steps === 0;
}

/** "about N more steps today" — the student-facing estimate, always approximate. */
export function formatSteps(steps) {
	return `about ${steps} more step${steps === 1 ? "" : "s"} today`;
}

/** "the last N step(s) for later", singular-safe. */
function keptForLater(n) {
	return `the last ${n} step${n === 1 ? "" : "s"} for later`;
}

/**
 * The one place the estimate is turned into a sentence. `reset` is an optional
 * tail (e.g. "resets Fri 00:00") the caller supplies so this stays pure.
 */
export function paceLine({ steps, reserve = 0, reset = "" } = {}) {
	if (steps === null || steps === undefined) return "No daily limit on this model — nothing to pace.";
	const tail = reset ? ` It ${reset}.` : "";
	if (steps === 0) {
		if (toReserve(reserve) > 0) {
			return `You're keeping ${keptForLater(toReserve(reserve))}, and today's quota is spent. Run /pace reserve off to keep going.${tail}`;
		}
		return `No steps left today.${tail}`;
	}
	const keep = toReserve(reserve) > 0 ? ` (keeping ${keptForLater(toReserve(reserve))})` : "";
	return `${formatSteps(steps)}${keep}.${tail}`;
}

/** Footer-sized fragment, no trailing period. */
export function paceSegment({ steps, reserve = 0 } = {}) {
	if (steps === null || steps === undefined) return "";
	const keep = toReserve(reserve) > 0 ? ` · keep ${toReserve(reserve)}` : "";
	return `${formatSteps(steps)}${keep}`;
}

/** The reason a tool call is refused at the reserve. It must tell the *model* to stop. */
export function stopReason(reserve) {
	const n = toReserve(reserve);
	return `You are saving the last ${n} step${n === 1 ? "" : "s"} for later. Stop now and tell the student what is finished and what is left. They can run /pace reserve off to keep going.`;
}

/** The same stop, in student language, for the screen. */
export function stoppedMessage(reserve) {
	const n = toReserve(reserve);
	return `You asked to keep ~${n} step${n === 1 ? "" : "s"} for later, so I stopped before changing files. Run /pace reserve off to keep going, or /pace to see where you are.`;
}

/** Tools that change files, plus the shells judged per command. */
export const MUTATING_TOOLS = new Set(["edit", "write", "powershell"]);

/**
 * Whether a tool call should be stopped at the reserve. `edit`/`write` always
 * change files; a shell is judged per command so read-only wrap-up (`git
 * status`, `npm test`) stays allowed. Matches plan mode's rule for the same
 * reason: a reserve that also blocks "show me what changed" is not a kindness.
 */
export function blocksAtReserve(toolName, command, isSafeBash = () => false) {
	if (MUTATING_TOOLS.has(toolName)) return true;
	if (toolName === "bash") return !isSafeBash(command);
	return false;
}

/**
 * Resolve the student's reserve against a lab pin, mirroring
 * resolveStrictPreset. `envValue` names a floor: a number pins a minimum the
 * student may raise but not undercut, and `reserve off` is refused while it
 * holds. "off"/"0" pins nothing and keeps the student free.
 */
export function resolveReserve(settingsValue, envValue) {
	const setting = toReserve(settingsValue);
	const raw = String(envValue ?? "").trim();
	const pinned = parsePin(raw);
	if (pinned === null || pinned === 0) return { reserve: setting, floor: pinned ?? 0, locked: false };
	return { reserve: Math.max(setting, pinned), floor: pinned, locked: true };
}
