import { activeModelId, activeProviderId } from "../active-model.mjs";
import { AgentConfigError, describeAgents, findAgent, loadAgents } from "./agents.mjs";
import { MAX_CONCURRENCY, MAX_TASKS, assistantText, planChild, runBounded, runChild, runFailed } from "./child.mjs";
import { gateRun, refusalText } from "./gate.mjs";
import { contentText, partialText } from "./render.mjs";

/**
 * Orchestrating a helper call.
 *
 * This is the whole of the `subagent` tool's logic, kept out of the extension
 * so it can be tested without Pi's runtime: pass in fake deps and no process is
 * ever spawned. The extension is a thin shell over this that adds the tool
 * schema and the rendering.
 *
 * Modes (exactly one per call):
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, …] }, up to MAX_TASKS, MAX_CONCURRENCY at once
 *   - chain:    { chain: [{ agent, task }, …] }, each step's `{previous}` is the last output
 */

const result = (text, details, isError = false) => {
	const out = { content: [{ type: "text", text }], details };
	if (isError) out.isError = true;
	return out;
};
const idle = (mode, reason) => ({ mode, runs: [], reason });

export async function executeSubagent(params, ctx, deps = {}) {
	const spawnChild = deps.runChild ?? runChild;
	const load = deps.loadAgents ?? loadAgents;
	const providerId = deps.providerId ?? activeProviderId(ctx);
	const activeModel = deps.model ?? activeModelId(ctx);
	const onUpdate = deps.onUpdate;

	let agents;
	try {
		agents = load();
	} catch (err) {
		if (err instanceof AgentConfigError) {
			return result(`Helpers aren't set up correctly in this install. (${err.message})`, idle("single", "config"), true);
		}
		throw err;
	}
	if (!agents.length) {
		return result("No helpers are available in this install.", idle("single", "none"), true);
	}

	// Exactly one mode.
	const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
	const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) {
		return result(
			`Give me exactly one job: one helper, several at once, or a chain — not a mix. Available helpers: ${describeAgents(agents)}`,
			idle("single", "shape"),
			true,
		);
	}

	let mode;
	let steps;
	if (hasSingle) {
		mode = "single";
		steps = [{ agent: params.agent, task: params.task }];
	} else if (hasTasks) {
		mode = "parallel";
		steps = params.tasks.map((t) => ({ agent: t.agent, task: t.task }));
	} else {
		mode = "chain";
		steps = params.chain.map((t) => ({ agent: t.agent, task: t.task }));
	}

	if (steps.length > MAX_TASKS) {
		return result(
			`That is ${steps.length} jobs; the most I run at once is ${MAX_TASKS}. Split it into smaller calls.`,
			idle(mode, "too-many"),
			true,
		);
	}

	// Resolve each step's agent up front, so an unknown name fails the whole call
	// before anything is spawned.
	const resolved = [];
	for (const step of steps) {
		if (typeof step.task !== "string" || !step.task.trim()) {
			return result(`The job for "${step.agent}" was empty.`, idle(mode, "empty"), true);
		}
		const agent = findAgent(agents, step.agent);
		if (!agent) {
			return result(
				`There is no helper called "${step.agent}". Available helpers: ${describeAgents(agents)}`,
				idle(mode, "unknown-agent"),
				true,
			);
		}
		resolved.push({ agent, task: step.task });
	}

	// The gate, re-checked at call time: the model can switch mid-session.
	const childModels = resolved.map((r) => r.agent.model).filter(Boolean);
	const gate = gateRun({ providerId, childModels });
	if (!gate.allowed) {
		return result(refusalText(gate.reason), idle(mode, gate.reason));
	}

	const undoSession = deps.undoSession ?? ctx.sessionManager?.getSessionId?.() ?? undefined;
	const thinking = ctx.thinkingLevel;

	const makePlan = (agent) =>
		planChild(agent, {
			model: agent.model ?? activeModel,
			thinking,
			cwd: ctx.cwd,
			undoSession,
			dir: deps.dir,
			piEntry: deps.piEntry,
		});

	const runs = resolved.map((step, index) => ({
		index,
		agent: step.agent.name,
		task: step.task,
		ok: null,
		text: "",
		aborted: false,
		running: true,
	}));

	const emit = () => onUpdate?.({ content: [{ type: "text", text: partialText(runs) }], details: { mode, runs } });

	const runOne = async (step, index, task) => {
		const plan = makePlan(step.agent);
		const state = await spawnChild(plan, task, { signal: deps.signal, onEvent: () => emit() });
		const ok = !runFailed(state);
		const done = {
			index,
			agent: step.agent.name,
			task,
			ok,
			text: assistantText(state.messages),
			aborted: state.aborted,
			running: false,
		};
		runs[index] = done;
		emit();
		return done;
	};

	if (mode === "chain") {
		let previous = "";
		for (let i = 0; i < resolved.length; i += 1) {
			const task = resolved[i].task.replace(/\{previous\}/g, previous);
			const done = await runOne(resolved[i], i, task);
			previous = done.text;
		}
	} else if (mode === "parallel") {
		await runBounded(resolved, MAX_CONCURRENCY, (step, index) => runOne(step, index, step.task));
	} else {
		await runOne(resolved[0], 0, resolved[0].task);
	}

	return result(contentText(runs), { mode, runs });
}
