import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
	hashToken,
	keysMatch,
	newSessionId,
	newToken,
	pairingCode,
	tokensMatch,
} from "../lib/remote/tokens.mjs";
import { SessionStore } from "../lib/remote/sessions.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-remote-auth-"));

test("tokens are long, random and unique", () => {
	const seen = new Set();
	for (let i = 0; i < 200; i += 1) {
		const token = newToken();
		assert.ok(token.length >= 40, "256 bits base64url is at least 43 characters");
		assert.ok(!seen.has(token));
		seen.add(token);
	}
	assert.notEqual(newSessionId(), newSessionId());
});

test("a token only verifies against its own salted hash", () => {
	const token = newToken();
	const salt = randomBytes(16);
	const hash = hashToken(token, salt);
	assert.ok(tokensMatch(token, hash, salt));
	assert.ok(!tokensMatch(newToken(), hash, salt), "another token must not match");
	// Different salt, same token: a different hash, and the check must fail,
	// which is what stops two sessions sharing a rotated token by accident.
	assert.ok(!tokensMatch(token, hash, randomBytes(16)));
});

test("token comparison tolerates a wrong-length hash without throwing", () => {
	assert.equal(tokensMatch("a", "short", randomBytes(16)), false);
	assert.equal(tokensMatch("", "", randomBytes(16)), false);
});

test("the enrolment key comparison is constant-time and exact", () => {
	assert.ok(keysMatch("school-key", "school-key"));
	assert.ok(!keysMatch("school-key", "school-keY"));
	// Length mismatch must not throw, and must not match.
	assert.ok(!keysMatch("short", "a-much-longer-key"));
});

test("a pairing code is derived from the session, not the token", () => {
	const sessionId = newSessionId();
	const code = pairingCode(sessionId);
	assert.match(code, /^[0-9A-F]{4} [0-9A-F]{4}$/, "readable over a classroom");
	assert.equal(pairingCode(sessionId), pairingCode(sessionId), "stable for one session");
	const hash = createHash("sha256").update(sessionId).digest("hex").toUpperCase();
	assert.ok(code.startsWith(hash.slice(0, 4)));
});

test("the registry rejects a wrong enrolment key and nothing is created", () => {
	const store = new SessionStore({ enrollKey: "right" });
	assert.throws(() => store.enroll({ enrollKey: "wrong", sessionId: "s1" }), /enrolment/i);
	assert.equal(store.list().length, 0);
});

test("a phone token only opens its own session", () => {
	const store = new SessionStore({ enrollKey: "k" });
	store.enroll({ enrollKey: "k", sessionId: "a", meta: { name: "robot" } });
	store.enroll({ enrollKey: "k", sessionId: "b", meta: { name: "sensor" } });
	store.bindToken("a", "token-for-a");

	assert.ok(store.verifyToken("a", "token-for-a"));
	assert.ok(!store.verifyToken("a", "token-for-b"), "cross-session access must fail");
	assert.ok(!store.verifyToken("b", "token-for-a"), "the other direction too");
	assert.ok(!store.verifyToken("missing", "token-for-a"));
});

test("re-enrolling the same session id reuses it instead of duplicating", async () => {
	const dir = await scratch();
	const stateFile = join(dir, "registry.json");
	const first = new SessionStore({ stateFile, enrollKey: "k" });
	first.enroll({ enrollKey: "k", sessionId: "keep", meta: { name: "robot" } });
	first.bindToken("keep", "tok");
	assert.equal(first.enroll({ enrollKey: "k", sessionId: "keep", meta: { name: "renamed" } }).resumed, true);
	await first.flush();

	// A restarted server reads the same sessions, which is what lets a phone
	// wait for its computer instead of showing "no such session".
	const second = new SessionStore({ stateFile, enrollKey: "k" });
	await second.load();
	assert.equal(second.get("keep").meta.name, "renamed", "metadata survives restart");
	assert.ok(second.verifyToken("keep", "tok"), "token survives restart");
});

test("rotation invalidates the previous phone link immediately", () => {
	const store = new SessionStore({ enrollKey: "k" });
	store.enroll({ enrollKey: "k", sessionId: "s" });
	store.bindToken("s", "old-token");
	assert.ok(store.verifyToken("s", "old-token"));

	store.rotateToken("s", "new-token");
	assert.ok(!store.verifyToken("s", "old-token"), "old link must die");
	assert.ok(store.verifyToken("s", "new-token"));
});

test("failed attaches lock a peer out after a handful of tries", () => {
	const store = new SessionStore({ enrollKey: "k" });
	store.enroll({ enrollKey: "k", sessionId: "s" });
	store.bindToken("s", "right");
	const key = "10.0.0.5:s";

	for (let attempt = 1; attempt <= 5; attempt += 1) {
		if (attempt < 5) assert.equal(store.isLockedOut(key), false);
		store.noteFailedAttach(key);
	}
	assert.equal(store.isLockedOut(key), true, "the fifth failure locks out");
	store.clearFailedAttach(key);
	assert.equal(store.isLockedOut(key), false, "a success clears the slate");
});

test("the registry never hands out the token hash", async () => {
	const store = new SessionStore({ enrollKey: "k" });
	store.enroll({ enrollKey: "k", sessionId: "s" });
	store.bindToken("s", "secret-phone-token");
	const dir = await scratch();
	store.stateFile = join(dir, "r.json");
	await store.flush();
	const written = JSON.parse(await readFile(store.stateFile, "utf-8"));
	assert.ok(!JSON.stringify(written).includes("secret-phone-token"), "no cleartext token on disk");
	assert.ok(!("tokenHash" in store.list()[0]), "and none in the listing");
});
