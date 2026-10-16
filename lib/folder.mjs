import { homedir } from "node:os";

/**
 * A short, human label for the folder a session is working in.
 *
 * The tab title and the footer both show this, and they exist for the same
 * reason: a student with several terminals open needs to tell them apart at a
 * glance. The full path is mostly noise once the last segment is visible, so the
 * label is the folder name, `~` for the home directory, and a left-truncated
 * `…name` when even that will not fit (the tail is the part worth keeping).
 */

/** Trim trailing separators, so "docs/" and "docs" compare equal. */
const stripTrailing = (path) => String(path).replace(/[\\/]+$/, "");

/** The last path segment, or "" for a root path ("/" or "C:\"). */
function lastSegment(path) {
	const trimmed = stripTrailing(path);
	if (!trimmed) return "";
	const parts = trimmed.split(/[\\/]+/);
	return parts[parts.length - 1] ?? "";
}

export function folderLabel(cwd, max = 24) {
	const raw = String(cwd ?? "").trim();
	if (!raw) return "";
	// Home reads best as the familiar tilde; a folder *under* home still shows
	// its own name, which is what distinguishes one project from another.
	const home = stripTrailing(homedir());
	if (home && stripTrailing(raw) === home) return "~";
	// A root path has no final segment of its own: keep the path as-is.
	const display = lastSegment(raw) || raw;
	if (max > 0 && display.length > max) return `…${display.slice(-(max - 1))}`;
	return display;
}
