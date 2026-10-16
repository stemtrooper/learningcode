import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A per-session journal of the files the agent changes.
 *
 * `/undo` resets *tracked* files to the last commit, which does nothing for the
 * files the agent creates (they are untracked) and cannot bring back an
 * untracked file the agent overwrites. Students experiment — that is the point
 * of the tool — so the agent's own file changes are recorded before they happen
 * and can be put back.
 *
 * Only files the `edit`/`write` tools touch are journalled, captured once each
 * (the earliest pre-change state wins). Large files are skipped and reported
 * rather than copied. Everything is best-effort: a read-only home or a full disk
 * must never stop the agent, and a missing journal just means `/undo` falls back
 * to git alone.
 */

const MANIFEST = "manifest.json";
const BACKUPS = "backups";
/** Above this, copying the file to recover it costs more than it is worth. */
export const MAX_BACKUP_BYTES = 1024 * 1024;
/** A runaway agent must not fill the disk with pre-images. */
export const MAX_ENTRIES = 500;

/** Where one session's journal lives. */
export function journalDir(agentDir, sessionId) {
	const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "session";
	return join(agentDir, "undo", safe);
}

const backupName = (absPath) => createHash("sha1").update(absPath).digest("hex");

/** True when `target` is inside `base` (or is `base` itself). */
function within(base, target) {
	if (!base) return true; // no boundary recorded: do not invent one
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readManifest(dir) {
	try {
		const parsed = JSON.parse(await readFile(join(dir, MANIFEST), "utf-8"));
		if (!parsed || typeof parsed !== "object") return null;
		return {
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [],
		};
	} catch {
		return null;
	}
}

const isEntry = (e) =>
	e && typeof e === "object" && typeof e.path === "string" &&
	(e.kind === "created" || e.kind === "modified" || e.kind === "skipped");

/**
 * Record what `targetPath` looked like before a tool changes it. Called from the
 * `tool_call` handler, i.e. before the tool runs, so the pre-state is still on
 * disk. Best-effort and silent.
 */
export async function recordChange(agentDir, sessionId, cwd, targetPath) {
	try {
		if (!agentDir || !sessionId || !targetPath) return;
		const dir = journalDir(agentDir, sessionId);
		const manifest = (await readManifest(dir)) ?? { cwd: cwd ?? "", entries: [] };
		if (!manifest.cwd && cwd) manifest.cwd = cwd;
		const base = manifest.cwd || cwd || process.cwd();
		const abs = resolve(isAbsolute(targetPath) ? targetPath : join(base, targetPath));
		// The journal undoes the agent's work in *this* project. A path outside
		// it (an absolute target elsewhere) is not this journal's to put back.
		if (!within(base, abs)) return;
		if (manifest.entries.some((e) => e.path === abs)) return; // earliest pre-state wins
		if (manifest.entries.length >= MAX_ENTRIES) return;

		let info = null;
		try {
			info = await stat(abs);
		} catch {
			info = null;
		}

		let entry;
		if (!info) {
			entry = { path: abs, kind: "created" };
		} else if (!info.isFile()) {
			entry = { path: abs, kind: "skipped", reason: "not a regular file" };
		} else if (info.size > MAX_BACKUP_BYTES) {
			entry = { path: abs, kind: "skipped", reason: "too large to back up" };
		} else {
			const backup = backupName(abs);
			await mkdir(join(dir, BACKUPS), { recursive: true });
			await copyFile(abs, join(dir, BACKUPS, backup));
			entry = { path: abs, kind: "modified", backup };
		}

		manifest.entries.push(entry);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	} catch {
		/* best-effort: never block a tool on journal bookkeeping */
	}
}

/** Load the session's journal for display, or null when there is none. */
export async function loadJournal(agentDir, sessionId) {
	if (!agentDir || !sessionId) return null;
	return readManifest(journalDir(agentDir, sessionId));
}

/**
 * Put every recorded file back: restore the ones that existed, remove the ones
 * the agent created. Large/non-file entries it could not capture are reported as
 * skipped. The journal is then cleared, so a later `/undo` does not re-apply it.
 */
export async function restoreJournal(agentDir, sessionId) {
	const dir = journalDir(agentDir, sessionId);
	const manifest = await readManifest(dir);
	const result = { restored: [], removed: [], skipped: [] };
	if (!manifest) return result;
	for (const entry of manifest.entries) {
		try {
			// Defensive: a hand-edited or legacy manifest could name a path
			// outside the project. Refuse it rather than touch a stranger's file.
			if (!within(manifest.cwd, entry.path)) {
				result.skipped.push(entry.path);
				continue;
			}
			if (entry.kind === "created") {
				await rm(entry.path, { force: true });
				result.removed.push(entry.path);
			} else if (entry.kind === "modified" && entry.backup) {
				const data = await readFile(join(dir, BACKUPS, entry.backup));
				await mkdir(dirname(entry.path), { recursive: true });
				await writeFile(entry.path, data);
				result.restored.push(entry.path);
			} else {
				result.skipped.push(entry.path);
			}
		} catch {
			result.skipped.push(entry.path);
		}
	}
	await rm(dir, { recursive: true, force: true }).catch(() => {});
	return result;
}

/** Split a journal into cwd-relative lists for the confirm prompt. */
export function summarizeJournal(manifest, cwd) {
	const rel = (p) => {
		if (!cwd) return p;
		const r = relative(cwd, p);
		return r && !r.startsWith("..") ? r : p;
	};
	const out = { created: [], modified: [], skipped: [] };
	for (const entry of manifest?.entries ?? []) {
		if (entry.kind === "created") out.created.push(rel(entry.path));
		else if (entry.kind === "modified") out.modified.push(rel(entry.path));
		else out.skipped.push(rel(entry.path));
	}
	return out;
}
