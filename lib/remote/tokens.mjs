import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

/**
 * Remote authentication primitives.
 *
 * The phone token is the only thing standing between a stranger and a student's
 * machine, so it is handled the way lib/token.mjs handles the Spark token:
 * random at rest, never logged, and compared without an early exit.
 */

/** 256 bits, URL-safe. Enough that online guessing is not a threat model. */
export function newToken() {
	return randomBytes(32).toString("base64url");
}

/** Session ids are random too: nothing about a student may be guessable. */
export function newSessionId() {
	return randomBytes(16).toString("base64url");
}

export function newSalt() {
	return randomBytes(16);
}

/**
 * Salted SHA-256 of a token. Not a password hash: the token is already 256 bits
 * of entropy, so a KDF would add latency without adding safety. The salt keeps
 * two students' identical tokens (never, but) and rainbow tables apart.
 */
export function hashToken(token, salt) {
	const digest = createHash("sha256");
	if (salt) digest.update(salt);
	digest.update(Buffer.from(String(token), "utf-8"));
	return digest.digest("base64");
}

/**
 * Constant-time comparison, and deliberately tolerant of length mismatches:
 * timingSafeEqual throws on unequal lengths, and throwing is itself an oracle
 * ("this token had the wrong shape").
 */
export function tokensMatch(presented, storedHashBase64, salt) {
	if (typeof presented !== "string" || typeof storedHashBase64 !== "string") return false;
	const presentedHash = Buffer.from(hashToken(presented, salt), "base64");
	const storedHash = Buffer.from(storedHashBase64, "base64");
	if (presentedHash.length !== storedHash.length) return false;
	return timingSafeEqual(presentedHash, storedHash);
}

/**
 * The enrolment key that gates session registration on the server. Compared the
 * same way, so a wrong key cannot be found byte by byte.
 */
export function keysMatch(presented, expected) {
	if (typeof presented !== "string" || typeof expected !== "string") return false;
	const a = Buffer.from(presented, "utf-8");
	const b = Buffer.from(expected, "utf-8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Short, unambiguous handle for humans to read aloud or type: "TLC 4FQ7 2K". */
export function pairingCode(sessionId) {
	const hex = createHash("sha256").update(sessionId).digest("hex").toUpperCase();
	return `${hex.slice(0, 4)} ${hex.slice(4, 8)}`;
}

/** Correlation id for requests that expect a matching response. */
export function newRequestId() {
	return randomUUID();
}
