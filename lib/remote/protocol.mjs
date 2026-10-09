/**
 * The LearningCode Remote wire protocol.
 *
 * Two rules keep this from rotting:
 *
 *   1. The wire is NOT Pi's event union. The phone receives an allowlisted,
 *      size-bounded subset, so Pi can move its internals underneath us without
 *      breaking the UI or widening what a phone can see.
 *   2. Unknown frame types are rejected, never ignored. A client and server
 *      that disagree must fail loudly rather than silently dropping messages
 *      that a student is waiting for.
 */

export const PROTOCOL_VERSION = 1;

/** Ceilings so a hostile or broken peer cannot flood the other side. */
export const LIMITS = {
	/** One chat message from a phone. */
	message: 8000,
	/** Any single string field on the wire. */
	field: 4096,
	/** Frames accepted per socket per second (generous; real use is a few). */
	frameRate: 60,
};

export const AGENT_FRAMES = ["hello", "event", "snapshot", "pong", "agent_message", "snapshot_request"];
export const AGENT_COMMANDS = ["welcome", "phone_message", "control", "ping", "history_request"];
export const PHONE_FRAMES = ["attach", "message", "abort", "history"];
export const PHONE_EVENTS = ["attached", "event", "history", "presence", "error"];

const ALL_FRAMES = new Set([
	...AGENT_FRAMES,
	...AGENT_COMMANDS,
	...PHONE_FRAMES,
	...PHONE_EVENTS,
]);

const isPlainObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const bounded = (value, max) =>
	typeof value === "string" && value.length <= max;

class ProtocolError extends Error {}

/**
 * Validate one frame. Returns the frame unchanged so callers can pipe it
 * straight to `send`. Throws ProtocolError, which the caller turns into a close
 * or an `error` frame - never a silent drop.
 */
export function parseFrame(raw, maxLength = 256 * 1024) {
	if (typeof raw !== "string" || raw.length === 0) throw new ProtocolError("empty frame");
	if (raw.length > maxLength) throw new ProtocolError("frame too large");

	let frame;
	try {
		frame = JSON.parse(raw);
	} catch {
		throw new ProtocolError("frame is not JSON");
	}
	if (!isPlainObject(frame)) throw new ProtocolError("frame is not an object");

	const { type } = frame;
	if (typeof type !== "string" || !ALL_FRAMES.has(type)) {
		throw new ProtocolError(`unknown frame type: ${String(type)}`);
	}
	return frame;
}

/** Frame factory: tags the protocol version onto every outgoing frame. */
export function frame(type, fields = {}) {
	return { protocol: PROTOCOL_VERSION, type, ...fields };
}

/**
 * Guard a phone's chat text. Kept deliberately small: the agent will do the
 * real work, and a giant paste from a phone is either a mistake or an attack.
 */
export function normalizeMessage(text) {
	if (!bounded(text, LIMITS.message) || typeof text !== "string") {
		throw new ProtocolError(`message must be a string under ${LIMITS.message} characters`);
	}
	const trimmed = text.trim();
	if (!trimmed) throw new ProtocolError("message is empty");
	return trimmed;
}

/** A human-facing line for the phone UI, or undefined for events it ignores. */
export function describeAgentEvent(event) {
	if (!isPlainObject(event) || typeof event.type !== "string") return undefined;

	switch (event.type) {
		case "agent_start":
			return "Thinking…";
		case "agent_end":
			return "Done";
		case "agent_settled":
			return event.aborted ? "Stopped" : undefined;
		case "message_update": {
			// Only text deltas are worth forwarding; Pi also streams tool-call
			// fragments here that would render as noise on a phone. The increment
			// arrives in `delta`, not `text`.
			const delta = event.assistantMessageEvent;
			if (!isPlainObject(delta) || delta.type !== "text_delta") return undefined;
			const text = typeof delta.delta === "string" ? delta.delta : delta.text;
			return typeof text === "string" ? { text } : undefined;
		}
		case "tool_execution_start":
			return { running: event.toolName ?? "tool" };
		case "tool_execution_end":
			return { ran: event.toolName ?? "tool", ok: event.error ? false : true };
		case "compaction_start":
			return { note: "Compacting conversation…" };
		case "auto_retry_start":
			return { note: `Retrying (attempt ${event.attempt ?? "?"})…` };
		case "error":
			return { error: String(event.error ?? event.message ?? "agent error") };
		default:
			return undefined;
	}
}

export { ProtocolError, bounded, isPlainObject };
