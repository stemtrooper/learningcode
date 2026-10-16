import { unlink } from "node:fs/promises";
import { tokenPath } from "./token.mjs";

/**
 * Student-language failure messages. Every Spark failure must say three
 * things: what happened, what to do, how long to wait. A bare status code
 * is never the message. Pure functions (except fixStaleToken), tested
 * without network. Plain JS: lib/ is .mjs, so no type annotations.
 */

const LOGIN_FIX = "Exit and run:  learningcode --login";

/**
 * The one line the launcher prints for a fatal error. A student gets the
 * message and never a stack trace (docs/plan-0.8.md); a developer debugging a
 * genuine bug asks for the trace with LEARNINGCODE_DEBUG=1. Pure, so the rule
 * is tested rather than buried in the launcher's catch block.
 */
export function fatalMessage(error, env = process.env) {
	const message = error?.message || String(error);
	if (env?.LEARNINGCODE_DEBUG === "1" && error?.stack) return error.stack;
	return message;
}


export function isAuthFailure(result) {
	return result.status === 401 || result.status === 403;
}

/** /quota error path: dead token, missing token, or unreachable Spark. */
export function quotaErrorLine(result, baseUrl) {
	if (isAuthFailure(result)) {
		return "Spark rejected your token (it was probably rotated). " + LOGIN_FIX;
	}
	if (result.error === "no Spark token in the environment") {
		return "No Spark token loaded. " + LOGIN_FIX;
	}
	return `Cannot reach Spark at ${baseUrl} (${result.error}). Check your network, then try /quota again.`;
}

/** /seats error path, same three-part shape. */
export function seatsErrorLine(result, baseUrl) {
	if (isAuthFailure(result)) {
		return "Spark rejected your token (it was probably rotated). " + LOGIN_FIX;
	}
	if (result.error === "no Spark token in the environment") {
		return "No Spark token loaded. " + LOGIN_FIX;
	}
	return `Cannot reach Spark at ${baseUrl} (${result.error}). Check your network, then try /seats again.`;
}

/**
 * Queue position in student language. No invented ETAs: a seat frees when a
 * classmate's turn ends, and anything more precise would be fiction.
 */
export function queuePositionLine(body) {
	if (!body || typeof body !== "object") return null;
	const record = body;
	const position = record.position ?? record.queued ?? record.waiting;
	if (typeof position === "number" && Number.isFinite(position)) {
		if (position <= 0) return "A seat is free — send your message.";
		return `You are #${position} in the seat queue. A seat frees when a classmate's turn ends.`;
	}
	return null;
}

/**
 * Spark's quota window resets weekly, at Friday 00:00 local time. No API field
 * carries it, so it is computed here rather than guessed at each call site.
 * Pure and injectable (`now`) so tests do not depend on the wall clock.
 */
export const WEEKLY_RESET_WEEKDAY = 5; // Friday (Date.getDay(): 0 = Sunday)

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The next Friday 00:00 strictly after `now` (or `now` itself at exactly 00:00). */
export function nextWeeklyReset(now = new Date(), weekday = WEEKLY_RESET_WEEKDAY) {
	const reset = new Date(now);
	reset.setHours(0, 0, 0, 0);
	reset.setDate(reset.getDate() + ((weekday - reset.getDay() + 7) % 7));
	if (reset.getTime() < now.getTime()) reset.setDate(reset.getDate() + 7);
	return reset;
}

/**
 * "resets Fri 00:00 (in 3d 4h)" — the student's answer to "when do I get more?".
 * Under a day it reads in hours/minutes so it never says a misleading "0d".
 */
export function quotaResetLine(now = new Date(), weekday = WEEKLY_RESET_WEEKDAY) {
	const reset = nextWeeklyReset(now, weekday);
	const minutes = Math.max(0, Math.floor((reset.getTime() - now.getTime()) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	const wait = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
	return `resets ${WEEKDAY_NAMES[weekday]} 00:00 (in ${wait})`;
}

/**
 * Startup failure notice (session_start). Returns null when silent is
 * correct so callers stay one line.
 */
export function startupFailureLine(result, baseUrl) {
	if (result.ok) return null;
	if (isAuthFailure(result)) {
		return "Your Spark token is dead (probably rotated). " + LOGIN_FIX + " — nothing here will work until then.";
	}
	return `Spark is not answering (${result.error ?? baseUrl}). Work will fail until the network is back.`;
}

/**
 * The one safe automatic repair: a cached token Spark rejects is stale, so
 * delete the cache and point at --login (which re-prompts and re-saves the
 * provider key). Returns the report line, or null when nothing applied.
 * readToken must never prompt; check probes the token without side effects.
 */
export async function fixStaleToken(dir, check, readToken) {
	const cached = await readToken().catch(() => null);
	if (!cached) return null;
	const probe = await check(cached).catch(() => null);
	if (!probe || probe.ok || !isAuthFailure(probe)) return null;
	await unlink(tokenPath(dir)).catch(() => {});
	return "Cleared the stale cached token. " + LOGIN_FIX;
}
