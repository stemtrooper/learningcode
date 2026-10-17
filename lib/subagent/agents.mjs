import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * The shipped helpers.
 *
 * v1 ships a fixed, curated set: there is no project-local or user-local agent
 * directory, so a classroom repo cannot smuggle an agent file in. That removes
 * Pi's whole prompt-injection surface for helpers. The definitions live in the
 * package's own `agents/` directory as Markdown with YAML frontmatter.
 *
 * Read-only is the default: `bash`, `edit` and `write` only reach a child when
 * the shipped definition names them.
 */

/** The tools every helper may use unless its frontmatter says otherwise. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
/** Every tool a helper definition may name. Anything else is a typo we reject. */
export const KNOWN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

const KNOWN = new Set(KNOWN_TOOLS);

/** A mistake in a shipped agent definition. Loud on purpose: it is our bug. */
export class AgentConfigError extends Error {}

/** The package's own `agents/` directory, resolved from this file. */
export function agentsDir() {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

/**
 * Normalize a frontmatter `tools` value. Both `read, grep` and `[read, grep]`
 * are valid YAML and both are in use, so accept either; anything else yields no
 * listed tools (and therefore the read-only default).
 */
function parseToolList(value) {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((t) => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Discover the shipped agents. A missing directory yields none (rather than
 * throwing), so a fresh checkout without `agents/` still loads the extension.
 */
export function loadAgents(dir = agentsDir()) {
	const agents = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);
		let content;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter?.name;
		const description = frontmatter?.description;
		if (typeof name !== "string" || !name.trim()) continue;
		if (typeof description !== "string" || !description.trim()) continue;

		const listed = parseToolList(frontmatter?.tools);
		const tools = listed.length ? listed : [...READ_ONLY_TOOLS];
		for (const tool of tools) {
			if (!KNOWN.has(tool)) {
				throw new AgentConfigError(
					`Helper "${name}" lists an unknown tool "${tool}". Known tools: ${KNOWN_TOOLS.join(", ")}.`,
				);
			}
		}

		const model = typeof frontmatter?.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
		agents.push({
			name: name.trim(),
			description: description.trim(),
			tools,
			model,
			systemPrompt: typeof body === "string" ? body : "",
			filePath,
			source: "shipped",
		});
	}

	agents.sort((a, b) => a.name.localeCompare(b.name));
	return agents;
}

/** Find one agent by name, or null. */
export function findAgent(agents, name) {
	return agents.find((a) => a.name === name) ?? null;
}

/** A one-line list for the model: `scout (read-only): look around and report`. */
export function describeAgents(agents) {
	if (!agents.length) return "none";
	return agents.map((a) => `${a.name}: ${a.description}`).join("; ");
}

/** Agents that may run destructive tools need the approval gate in the child. */
export function needsApproval(agent) {
	return agent.tools.some((t) => t === "bash" || t === "edit" || t === "write");
}

/** Agents that may change files need the undo recorder in the child. */
export function needsUndoRecord(agent) {
	return agent.tools.some((t) => t === "edit" || t === "write");
}
