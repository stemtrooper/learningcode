import { unlink } from "node:fs/promises";
import { tokenPath } from "./token.mjs";

/**
 * Student-language failure messages. Every Spark failure must say three
 * things: what happened, what to do, how long to wait. A bare status code
 * is never the message. Pure functions (except fixStaleToken), tested
 * without network. Plain JS: lib/ is .mjs, so no type annotations.
 */

const LOGIN_FIX = "Exit and run:  learningcode --login";

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
