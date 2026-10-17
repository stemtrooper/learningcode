import { redact } from "./sanitize.mjs";
import { toolLabel, toolSummary } from "./labels.mjs";

/**
 * The computer-side screen for `learningcode remote`.
 *
 * In remote mode Pi runs headless (RPC, no TUI), so without this the machine
 * running the agent shows only "remote: connected". The person sitting at that
 * machine — a lab computer, or a student using the phone as a second screen —
 * has no idea what the phone is asking the agent to do. This module turns the
 * same agent events the phone already receives into a live one-line status plus
 * a short scrolling log.
 *
 * Everything is written to stderr: stdout carries Pi's RPC protocol. Rendering
 * is best-effort and never throws into the agent path.
 *
 * The formatters are pure and exported for tests; RemoteConsole is the thin
 * stateful shell around them.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
/** Carriage return plus erase-to-end-of-line: repaint a single status row. */
const CLEAR_LINE = "\r\x1b[2K";

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Keep the last two path segments: "app.js" barely helps, ".../src/app.js" does. */
function shortPath(path) {
	const normalized = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 2) return normalized || String(path);
	return `…/${parts.slice(-2).join("/")}`;
}

/**
 * A short, safe description of what a tool is acting on: the file path for
 * editors, the command for bash, the pattern otherwise. Redacted, because a bash
 * line can carry a token, and bounded, because this is one status line.
 */
export function toolTarget(toolName, args) {
	const record = args && typeof args === "object" ? args : {};
	const pick = (...keys) => {
		for (const key of keys) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
		return "";
	};
	const name = String(toolName ?? "");
	if (name === "bash" || name === "shell" || name === "sh") return clip(redact(pick("command")), 60);
	const path = pick("file_path", "path", "file", "notebook_path");
	if (path) return clip(shortPath(redact(path)), 60);
	const other = pick("pattern", "query", "url", "name");
	return other ? clip(redact(other), 40) : "";
}

/** The fields of the live status line, most important first. */
export function statusFields(state) {
	const activity = state.activity ? String(state.activity) : "";
	// The connection dot prefixes the activity, so the single most important
	// field — the dot plus what it is doing — is also the first, and survives a
	// narrow line intact. Offline, the stale activity is dropped for the truth.
	const fields = [state.online ? `● ${activity || "online"}` : "○ reconnecting"];
	if (state.folder) fields.push(String(state.folder));
	if (state.model) fields.push(String(state.model));
	if (state.online && Number(state.phones) > 0) {
		fields.push(`${state.phones} phone${Number(state.phones) === 1 ? "" : "s"}`);
	}
	if (Number(state.queued) > 0) fields.push(`+${state.queued} queued`);
	return fields;
}

/**
 * One line, filling with fields until the width runs out. The first field (the
 * dot and the activity) is always kept, clipped if it alone overflows; the
 * trailing counters are what drop away as the terminal narrows.
 */
export function formatStatusLine(state, width = 80) {
	const [head, ...rest] = statusFields(state);
	let line = head.length > width ? clip(head, width) : head;
	for (const field of rest) {
		const candidate = `${line}  ·  ${field}`;
		if (candidate.length > width) break;
		line = candidate;
	}
	return line;
}

export class RemoteConsole {
	#write;
	#tty;
	#width;
	#painted = false;
	/** toolCallId → { label, target }, so the finish line can name what the start line did. */
	#targets = new Map();

	constructor({ write, tty, width } = {}) {
		this.#write = write ?? ((text) => process.stderr.write(text));
		this.#tty = tty ?? process.stderr.isTTY === true;
		this.#width = width ?? (process.stderr.columns || 80);
		this.state = { online: false, phones: 0, queued: 0, folder: "", model: "", activity: "starting…" };
	}

	/** Merge new state and repaint the status line. */
	setState(patch) {
		Object.assign(this.state, patch);
		this.#paint();
	}

	/**
	 * Print a line that scrolls away, keeping the status line at the bottom.
	 * On a pipe (not a TTY) there is no status line to protect, so it is a plain
	 * write and the output stays readable in a log file.
	 */
	log(line) {
		if (this.#tty) this.#clear();
		this.#write(`${String(line ?? "")}\n`);
		this.#paint();
	}

	/** Connection truth from the bridge, with a log line only on a change. */
	onStatus(status) {
		const wasOnline = this.state.online;
		this.state.online = Boolean(status?.online);
		this.state.phones = Number(status?.phones ?? 0);
		this.state.queued = Number(status?.queued ?? 0);
		if (this.state.online && !wasOnline) {
			this.log(`remote: connected, ${this.state.phones} phone${this.state.phones === 1 ? "" : "s"} attached`);
		} else if (!this.state.online && wasOnline) {
			this.log("remote: disconnected, reconnecting");
		} else {
			this.#paint();
		}
	}

	/** Map a raw Pi agent event to a status update and/or a log line. */
	onEvent(event) {
		const type = event?.type;
		if (type === "agent_start") {
			this.setState({ activity: "thinking…" });
			return;
		}
		if (type === "tool_execution_start") {
			const label = toolLabel(event.toolName, { args: event.args });
			const target = toolTarget(event.toolName, event.args);
			if (event.toolCallId) this.#targets.set(event.toolCallId, { label, target });
			this.setState({ activity: `running ${label}${target ? ` ${target}` : ""}` });
			return;
		}
		if (type === "tool_execution_end") {
			const remembered = this.#targets.get(event.toolCallId) ?? {};
			this.#targets.delete(event.toolCallId);
			const label = remembered.label ?? toolLabel(event.toolName, { result: event.result });
			const target = remembered.target ?? "";
			const failed = event.isError === true || event.error != null;
			this.log(`${failed ? "✗" : "✓"} ${label}${target ? ` ${target}` : ""}`);
			const summary = toolSummary(event.toolName, event.result);
			if (summary) this.log(`  ${summary}`);
			this.setState({ activity: "thinking…" });
			return;
		}
		if (type === "agent_end" || type === "agent_settled") {
			this.setState({ activity: "idle" });
			return;
		}
		if (type === "auto_retry_start") {
			this.log(`retrying (attempt ${event.attempt}/${event.maxAttempts})`);
			return;
		}
		if (type === "error" || type === "extension_error") {
			this.log(`error: ${redact(String(event.error ?? event.message ?? "agent error"))}`);
		}
	}

	/** Extension UI requests forwarded by RPC: notes scroll, approvals wait. */
	onExtensionUi(request) {
		if (request?.method === "notify" && typeof request.message === "string") {
			this.log(`note: ${redact(request.message)}`);
			return;
		}
		if (request?.method === "select" && typeof request.title === "string") {
			this.setState({ activity: "waiting for approval" });
		}
	}

	close() {
		if (this.#tty && this.#painted) {
			this.#write("\n");
			this.#painted = false;
		}
	}

	#paint() {
		if (!this.#tty) return;
		this.#write(`${CLEAR_LINE}${DIM}${formatStatusLine(this.state, this.#width)}${RESET}`);
		this.#painted = true;
	}

	#clear() {
		if (this.#painted) this.#write(CLEAR_LINE);
	}
}
