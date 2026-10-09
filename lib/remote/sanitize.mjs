import { LIMITS } from "./protocol.mjs";

/**
 * The outbound sanitizer.
 *
 * Everything the phone sees passes through here first. The rule is allowlist, not
 * denylist: a Pi event is forwarded only if this file names its fields, and any
 * value that looks like a credential is rewritten before it can reach a phone.
 *
 * That matters more than it sounds. The agent runs student shell commands, and
 * "run `env` to check your Arduino settings" is a perfectly reasonable request;
 * a tool event echoing its full command line would otherwise ship whatever the
 * command printed straight to the browser.
 */

/** Credential shapes that must never appear on the wire. */
const SECRETS = [
	/spark_live_[A-Za-z0-9_-]{4,}/g, // TLC Spark tokens
	/Bearer\s+[A-Za-z0-9._-]{16,}/gi, // Authorization headers
	/(?:api[_-]?key|token|secret)\s*[=:]\s*\S{8,}/gi, // obvious key=value pairs
];

const MAX_FIELD = LIMITS.field;

/** Clip to a hard ceiling, leaving room for the ellipsis so length stays bounded. */
const clip = (value, max = MAX_FIELD) =>
	typeof value === "string" && value.length > max ? `${value.slice(0, max - 1)}…` : value;

export function redact(text) {
	if (typeof text !== "string") return text;
	let out = text;
	for (const pattern of SECRETS) out = out.replace(pattern, "[redacted]");
	return clip(out);
}

/** Bounded copy of an agent event, or null when the UI has no use for it. */
export function sanitizeAgentEvent(event) {
	if (!event || typeof event !== "object" || typeof event.type !== "string") return null;

	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };

		case "agent_end":
			return { type: "agent_end" };

		case "agent_settled":
			return { type: "agent_settled", aborted: Boolean(event.aborted) };

		case "message_update": {
			// Pi's stream event carries the increment in `delta`. Reading `text`
			// here silently forwarded nothing, which looks exactly like a broken
			// model from the phone's side.
			const delta = event.assistantMessageEvent;
			if (delta?.type !== "text_delta") return null;
			const text = typeof delta.delta === "string" ? delta.delta : delta.text;
			if (typeof text !== "string") return null;
			return { type: "message_update", text: redact(text) };
		}

		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolName: clip(String(event.toolName ?? "tool"), 80),
			};

		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolName: clip(String(event.toolName ?? "tool"), 80),
				ok: !event.error,
				error: event.error ? redact(String(event.error)) : undefined,
			};

		case "compaction_start":
			return { type: "compaction_start" };

		case "compaction_end":
			return { type: "compaction_end", aborted: Boolean(event.aborted) };

		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				reason: redact(clip(String(event.errorMessage ?? ""))),
			};

		case "queue_update":
			return {
				type: "queue_update",
				pending: Array.isArray(event.steering) ? event.steering.length : 0,
			};

		case "extension_error":
			return { type: "error", message: redact(clip(String(event.error ?? "extension error"))) };

		// Defensive: an agent that reports failure generically still has to be
		// visible on the phone, and the message is the useful part.
		case "error":
			return { type: "error", message: redact(clip(String(event.error ?? event.message ?? "agent error"))) };

		default:
			return null;
	}
}

/**
 * Conversation history for a freshly attached phone.
 *
 * Pi's `get_messages` returns the full conversation, including tool results with
 * whole file contents. The phone gets text and a one-line summary of tool
 * activity, which is what a student glancing at a phone actually needs.
 */
export function sanitizeMessages(messages, maxMessages = 100) {
	if (!Array.isArray(messages)) return [];
	const out = [];
	for (const message of messages.slice(-maxMessages)) {
		const role = message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(message.content);
		if (!text) continue;
		out.push({ role, text: redact(clip(text, 4000)) });
	}
	return out;
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Extension UI notifications (quota warnings, Spark notices) as phone notes. */
export function sanitizeExtensionUi(request) {
	if (request?.method === "notify" && typeof request.message === "string") {
		return { type: "note", text: redact(clip(request.message, 300)) };
	}
	// A dialog the phone can answer: the approval prompt. Options are plain text.
	if (request?.method === "select" && typeof request.title === "string" && Array.isArray(request.options)) {
		return {
			type: "approval",
			id: String(request.id ?? ""),
			title: redact(clip(request.title, 400)),
			options: request.options.slice(0, 4).map((o) => redact(clip(String(o), 60))),
		};
	}
	if (request?.method === "setStatus" && typeof request.statusText === "string") {
		return { type: "status", text: redact(clip(request.statusText, 120)) };
	}
	return null;
}

