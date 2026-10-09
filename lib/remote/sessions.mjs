import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashToken, keysMatch, newSalt, tokensMatch } from "./tokens.mjs";

/**
 * The server-side session registry.
 *
 * This is the only stateful piece in the whole design, and it is behind a small
 * interface on purpose: today it is a Map with a JSON file beside it, tomorrow
 * it can be Redis without the protocol noticing.
 *
 * Authorization lives here rather than in socket handlers so that every rule
 * (token check, lockout, one computer per session) is in one reviewable place.
 */

const LOCKOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export class SessionStore {
	/**
	 * @param {object} options
	 * @param {string} [options.stateFile] JSON file; omit for memory-only (tests)
	 * @param {() => string} [options.enrollKey] current enrolment key
	 * @param {number} [options.maxSessions] registration ceiling
	 */
	constructor({ stateFile = null, enrollKey = "", maxSessions = 500 } = {}) {
		this.stateFile = stateFile;
		this.enrollKey = enrollKey;
		this.maxSessions = maxSessions;
		/** @type {Map<string, any>} */
		this.sessions = new Map();
		/** @type {Map<string, { count: number, until: number }>} */
		this.attempts = new Map();
		this.dirty = false;
	}

	async load() {
		if (!this.stateFile) return;
		try {
			const parsed = JSON.parse(await readFile(this.stateFile, "utf-8"));
			if (Array.isArray(parsed?.sessions)) {
				for (const record of parsed.sessions) {
					if (record?.sessionId) this.sessions.set(record.sessionId, record);
				}
			}
		} catch {
			/* A missing or corrupt state file means "start empty", not "fail" */
		}
	}

	/**
	 * Register (or re-register) a session from the enrolling computer.
	 *
	 * Re-registration is deliberately allowed and is what makes the agent
	 * recoverable: the computer comes back after a crash or a network drop and
	 * re-attaches to the same session id, so the phone's history survives.
	 */
	enroll({ enrollKey, sessionId, meta = {} }) {
		if (this.enrollKey && !keysMatch(enrollKey, this.enrollKey)) {
			const error = new Error("enrolment key rejected");
			error.status = 401;
			throw error;
		}
		if (typeof sessionId !== "string" || !sessionId) {
			const error = new Error("session id required");
			error.status = 400;
			throw error;
		}

		const existing = this.sessions.get(sessionId);
		if (existing) {
			existing.meta = { ...existing.meta, ...sanitizeMeta(meta) };
			existing.lastSeen = new Date().toISOString();
			this.#touch();
			return { session: existing, resumed: true };
		}

		if (this.sessions.size >= this.maxSessions) {
			const error = new Error("session registry is full");
			error.status = 503;
			throw error;
		}

		const salt = newSalt().toString("base64");
		const record = {
			sessionId,
			meta: sanitizeMeta(meta),
			createdAt: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
			// The computer supplies the hash of the phone token; the server never
			// sees the token itself in the clear.
			tokenHash: null,
			salt,
		};
		this.sessions.set(sessionId, record);
		this.#touch();
		return { session: record, resumed: false };
	}

	/**
	 * Bind the phone-token hash to a session the computer just enrolled. The
	 * cleartext token is hashed here and never written to the state file, so a
	 * leaked registry file does not hand out phone access.
	 */
	bindToken(sessionId, token) {
		const record = this.sessions.get(sessionId);
		if (!record || typeof token !== "string" || !token) return null;
		record.tokenHash = hashToken(token, Buffer.from(record.salt, "base64"));
		record.tokenRotatedAt = new Date().toISOString();
		this.#touch();
		return record;
	}

	/** Rotate: drop the old hash so a leaked link dies immediately. */
	rotateToken(sessionId, token) {
		const record = this.sessions.get(sessionId);
		if (!record) return null;
		record.salt = newSalt().toString("base64");
		return this.bindToken(sessionId, token);
	}

	get(sessionId) {
		return this.sessions.get(sessionId) ?? null;
	}

	list() {
		return [...this.sessions.values()].map(({ tokenHash, ...rest }) => rest);
	}

	remove(sessionId) {
		const removed = this.sessions.delete(sessionId);
		if (removed) this.#touch();
		return removed;
	}

	/** True when this peer has failed too many attach attempts recently. */
	isLockedOut(key) {
		const attempt = this.attempts.get(key);
		if (!attempt) return false;
		if (attempt.until < Date.now()) {
			this.attempts.delete(key);
			return false;
		}
		return attempt.count >= MAX_ATTEMPTS;
	}

	noteFailedAttach(key) {
		const now = Date.now();
		const attempt = this.attempts.get(key) ?? { count: 0, until: now + LOCKOUT_MS };
		attempt.count += 1;
		this.attempts.set(key, attempt);
		return attempt.count;
	}

	clearFailedAttach(key) {
		this.attempts.delete(key);
	}

	/**
	 * Verify a phone's token against a session. Called on every attach, and
	 * only the salted hash is ever compared.
	 */
	verifyToken(sessionId, token) {
		const record = this.sessions.get(sessionId);
		if (!record?.tokenHash) return false;
		return tokensMatch(token, record.tokenHash, Buffer.from(record.salt, "base64"));
	}

	#touch() {
		this.dirty = true;
	}

	/** Persist if anything changed. Cheap and race-free enough for one writer. */
	async flush() {
		if (!this.stateFile || !this.dirty) return;
		const payload = JSON.stringify(
			{ savedAt: new Date().toISOString(), sessions: [...this.sessions.values()] },
			null,
			2,
		);
		await mkdir(dirname(this.stateFile), { recursive: true });
		const temp = `${this.stateFile}.tmp`;
		await writeFile(temp, payload, { encoding: "utf-8", mode: 0o600 });
		await rename(temp, this.stateFile);
		this.dirty = false;
	}
}

/**
 * Metadata bounds: the phone shows these, so they are text, length-capped, and
 * stripped of anything that is not a string. A student's home directory path is
 * fine; a stray environment dump is not.
 */
function sanitizeMeta(meta) {
	const clean = {};
	for (const key of ["name", "cwd", "platform", "version"]) {
		const value = meta?.[key];
		if (typeof value === "string") clean[key] = value.slice(0, 200);
	}
	return clean;
}
