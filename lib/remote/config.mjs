import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError, agentDir } from "../config.mjs";
import { newSessionId, newToken } from "./tokens.mjs";

/**
 * Remote configuration and the local session record.
 *
 * The conventions are the ones learningcode already uses everywhere else:
 * LEARNINGCODE_* environment variables for the connection, and a file under the
 * agent directory for anything secret, written with mode 0600 exactly like the
 * Spark token in lib/token.mjs.
 */

export const DEFAULT_REMOTE_SERVER = "ws://127.0.0.1:8787/agent";

export function remoteServerUrl(env = process.env) {
	return (env.LEARNINGCODE_REMOTE_SERVER || DEFAULT_REMOTE_SERVER).replace(/\/+$/, "");
}

export function remoteEnrollKey(env = process.env) {
	return env.LEARNINGCODE_REMOTE_KEY || "";
}

/** Where the computer keeps the identity of its remote session. */
export function remoteStatePath(agentDirectory = agentDir()) {
	return join(agentDirectory, "remote.json");
}

/** Where the computer keeps the per-session phone token. Never sent anywhere but the attach frame. */
export function remoteTokenPath(agentDirectory = agentDir()) {
	return join(agentDirectory, "remote-token");
}

/**
 * The record that lets `learningcode remote` rejoin the *same* session after a
 * restart, which is the difference between "your conversation continues on the
 * phone" and "your conversation quietly restarted".
 */
export async function readRemoteState(agentDirectory = agentDir()) {
	try {
		const parsed = JSON.parse(await readFile(remoteStatePath(agentDirectory), "utf-8"));
		if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") return parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") {
			throw new UserError(
				`Could not parse ${remoteStatePath(agentDirectory)}: ${error.message}\nFix or delete the file, then rerun.`,
			);
		}
	}
	return null;
}

/**
 * Mint the session identity on first use, or return the existing one.
 *
 * Both files are 0600: the token file because it is a bearer credential, the
 * state file because it names the session the token belongs to.
 */
export async function ensureRemoteIdentity(agentDirectory = agentDir(), env = process.env) {
	const existing = await readRemoteState(agentDirectory);
	if (existing?.sessionId && existing.token) return existing;

	const sessionId = newSessionId();
	const token = newToken();
	const record = {
		sessionId,
		serverUrl: remoteServerUrl(env),
		createdAt: new Date().toISOString(),
	};
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(remoteStatePath(agentDirectory), `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	await writeFile(remoteTokenPath(agentDirectory), `${token}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	await chmod(remoteStatePath(agentDirectory), 0o600).catch(() => {});
	await chmod(remoteTokenPath(agentDirectory), 0o600).catch(() => {});
	return { ...record, token };
}

/**
 * Write the local session record, so `learningcode remote` can rejoin the same
 * session after a restart instead of silently starting a new conversation.
 */
export async function writeRemoteState(agentDirectory, record) {
	const path = remoteStatePath(agentDirectory);
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	await chmod(path, 0o600).catch(() => {});
}

export async function readRemoteToken(agentDirectory = agentDir()) {
	try {
		return (await readFile(remoteTokenPath(agentDirectory), "utf-8")).trim() || "";
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return "";
	}
}

/**
 * Replace the phone token. The old one stops working everywhere at once, which
 * is the whole point of rotating: a link pasted into a class chat channel dies
 * rather than living forever.
 */
export async function rotateRemoteToken(agentDirectory = agentDir()) {
	const state = await readRemoteState(agentDirectory);
	if (!state) throw new UserError("No remote session yet. Run `learningcode remote` once first.");
	const token = newToken();
	await writeFile(remoteTokenPath(agentDirectory), `${token}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	await chmod(remoteTokenPath(agentDirectory), 0o600).catch(() => {});
	return { ...state, token, rotatedAt: new Date().toISOString() };
}

/** The URL a phone opens. The token rides in the fragment, never the query. */
export function phoneUrl(serverUrl, sessionId, token, publicBase = "") {
	const base = (publicBase || serverUrl.replace(/^ws/, "http")).replace(/\/agent\/?$/, "");
	const separator = base.includes("?") ? "&" : "?";
	return `${base}/#/s/${sessionId}${separator}t=${encodeURIComponent(token)}`;
}

/** Project name shown on the phone: the directory, not the whole path. */
export function projectName(cwd) {
	return (String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "project").slice(0, 80);
}
