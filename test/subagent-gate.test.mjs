import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_ID } from "../lib/config.mjs";
import { CHILD_SPARK_REFUSAL, SPARK_REFUSAL, gateRun, modelIsSpark, refusalText, subagentsAllowed } from "../lib/subagent/gate.mjs";

/**
 * The load-bearing rule: helpers run on every provider except TLC-Spark, which
 * runs one generation per student. These are pure checks — no Pi, no spawn.
 */

test("Spark is refused and every other provider is allowed", () => {
	assert.equal(subagentsAllowed(PROVIDER_ID), false);
	assert.equal(subagentsAllowed("opencode-go"), true);
	assert.equal(subagentsAllowed("river"), true);
	assert.equal(subagentsAllowed(undefined), true, "an unknown provider is not Spark");
});

test("a child model is Spark only when it is exactly ours", () => {
	assert.equal(modelIsSpark(PROVIDER_ID), true);
	assert.equal(modelIsSpark(`${PROVIDER_ID}/TLC-Spark`), true);
	assert.equal(modelIsSpark("river/deepseek-ai/deepseek-v3"), false);
	assert.equal(modelIsSpark("opencode-go/kimi"), false);
	assert.equal(modelIsSpark(undefined), false);
	assert.equal(modelIsSpark("not-tlc-spark/x"), false);
});

test("the active provider alone decides the gate", () => {
	assert.deepEqual(gateRun({ providerId: PROVIDER_ID }), { allowed: false, reason: "spark" });
	assert.deepEqual(gateRun({ providerId: "opencode-go" }), { allowed: true, reason: null });
});

test("one Spark child refuses the whole run, even beside good ones", () => {
	const gate = gateRun({ providerId: "opencode-go", childModels: [`${PROVIDER_ID}/TLC-Spark`] });
	assert.equal(gate.allowed, false);
	assert.equal(gate.reason, "child-spark");
});

test("refusals are student language, never a stack trace", () => {
	for (const reason of ["spark", "child-spark"]) {
		const text = refusalText(reason);
		assert.doesNotMatch(text, /\bError\b|node_modules/);
		assert.doesNotMatch(text, /\n\s+at\s/);
		assert.match(text, /\bmodel\b/i);
	}
	assert.equal(refusalText("spark"), SPARK_REFUSAL);
	assert.equal(refusalText("child-spark"), CHILD_SPARK_REFUSAL);
});
