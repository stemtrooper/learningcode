import { PROVIDER_ID } from "../config.mjs";

/**
 * The sub-agent gate.
 *
 * TLC-Spark enforces one active generation per student. Fanning out to several
 * helpers at once would earn a wall of 429s and burn the student's time, so
 * helpers run on every provider *except* Spark. Everything here is plain data
 * so the rule can be tested without Pi's runtime.
 */

/** Shown when the gate refuses because the session is on Spark. */
export const SPARK_REFUSAL =
	"Helpers need a model that can run more than one answer at a time. " +
	"TLC-Spark runs one at a time, so helpers are off here. " +
	"Switch with /model to use them.";

/** Shown when a per-agent model would land a child on Spark after all. */
export const CHILD_SPARK_REFUSAL =
	"One of the helper settings points at TLC-Spark, which runs one answer at a " +
	"time. Use a different model with /model to run helpers.";

/**
 * True when helpers may run on this provider. Anything other than Spark is
 * allowed: the student is on their own provider key there, so the one-at-a-time
 * constraint does not apply.
 */
export function subagentsAllowed(providerId) {
	return providerId !== PROVIDER_ID;
}

/**
 * Whether a resolved child model string lands on Spark. This only ever needs to
 * recognise *our own* provider id, so it is an exact-prefix match rather than a
 * parse of an arbitrary `provider/id` string (ids like `river/deepseek-ai/…`
 * have more than one slash and cannot be split reliably).
 */
export function modelIsSpark(model) {
	if (typeof model !== "string") return false;
	return model === PROVIDER_ID || model.startsWith(`${PROVIDER_ID}/`);
}

/**
 * Decide whether a run may proceed.
 *
 * `providerId` is the active session provider, read live at call time.
 * `childModels` are the resolved model strings for every child that would
 * spawn. If any child would land on Spark the whole run is refused: a partial
 * or mixed run is more confusing to a student than a clean no.
 */
export function gateRun({ providerId, childModels = [] } = {}) {
	if (!subagentsAllowed(providerId)) return { allowed: false, reason: "spark" };
	if (childModels.some(modelIsSpark)) return { allowed: false, reason: "child-spark" };
	return { allowed: true, reason: null };
}

/** The student-language refusal for a gate result. */
export function refusalText(reason) {
	return reason === "child-spark" ? CHILD_SPARK_REFUSAL : SPARK_REFUSAL;
}
