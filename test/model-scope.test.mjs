import assert from "node:assert/strict";
import test from "node:test";
import { modelScopePlan } from "../lib/model-scope.mjs";

const LISTING = [
	"provider     model                            context",
	"tlc-spark    TLC-Spark                        32K",
	"orcarouter   openai/gpt-4o-mini              128K",
	"orcarouter   deepseek/deepseek-v4.1-flash-free 128K",
].join("\n");

/** A `listModels` thunk that fails the test if the plan reaches for it. */
const unusedListing = () => assert.fail("the listing was not needed");

test("an unseeded scope is seeded from the providers logged in now", () => {
	const plan = modelScopePlan({
		enabledModels: null,
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: () => LISTING,
	});
	assert.equal(plan.seed, true);
	assert.deepEqual(plan.enabledModels, ["tlc-spark/TLC-Spark", "orcarouter/openai/gpt-4o-mini", "orcarouter/deepseek/deepseek-v4.1-flash-free"]);
	assert.deepEqual(plan.patterns, plan.enabledModels);
	assert.deepEqual(plan.providers.sort(), ["orcarouter", "tlc-spark"]);
});

test("nothing logged in leaves no scope to seed", () => {
	assert.equal(
		modelScopePlan({ enabledModels: null, loggedIn: [], listModels: () => LISTING }),
		null,
		"an empty listing seeds nothing rather than an empty picker",
	);
});

test("a settled scope with no new provider needs no change and no listing", () => {
	const plan = modelScopePlan({
		enabledModels: ["tlc-spark/TLC-Spark", "orcarouter/openai/gpt-4o-mini"],
		scopedProviders: ["tlc-spark", "orcarouter"],
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: unusedListing,
	});
	assert.equal(plan, null);
});

test("a provider signed into after the seed has its models folded in once", () => {
	const plan = modelScopePlan({
		enabledModels: ["tlc-spark/TLC-Spark"],
		scopedProviders: ["tlc-spark"],
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: () => LISTING,
	});
	assert.equal(plan.seed, false);
	assert.equal(plan.enabledModels, null);
	assert.deepEqual(plan.patterns, ["orcarouter/openai/gpt-4o-mini", "orcarouter/deepseek/deepseek-v4.1-flash-free"]);
	assert.deepEqual(plan.providers.sort(), ["orcarouter", "tlc-spark"]);
});

test("a provider the student emptied is never re-added once it is recorded", () => {
	// The student unchecked every OrcaRouter model; it is recorded as
	// considered, so a later launch must leave the scope alone even though
	// OrcaRouter is logged in and absent from it.
	const plan = modelScopePlan({
		enabledModels: ["tlc-spark/TLC-Spark"],
		scopedProviders: ["tlc-spark", "orcarouter"],
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: unusedListing,
	});
	assert.equal(plan, null);
});

test("a pre-bookkeeping scope infers its providers from what it contains", () => {
	// No scopedProviders key yet: tlc-spark is represented, orcarouter is not,
	// so orcarouter is the one new provider to fold in.
	const plan = modelScopePlan({
		enabledModels: ["tlc-spark/TLC-Spark"],
		scopedProviders: new Set(),
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: () => LISTING,
	});
	assert.deepEqual(plan.patterns, ["orcarouter/openai/gpt-4o-mini", "orcarouter/deepseek/deepseek-v4.1-flash-free"]);
	assert.deepEqual(plan.providers.sort(), ["orcarouter", "tlc-spark"]);
});

test("a pre-bookkeeping scope with nothing new still records its baseline", () => {
	// Both providers are represented already, so nothing is added — but the
	// inferred baseline is persisted so the next launch can tell a genuinely
	// new provider apart from one already considered.
	const plan = modelScopePlan({
		enabledModels: ["tlc-spark/TLC-Spark", "orcarouter/openai/gpt-4o-mini"],
		scopedProviders: new Set(),
		loggedIn: ["tlc-spark", "orcarouter"],
		listModels: () => LISTING,
	});
	assert.equal(plan.seed, false);
	assert.deepEqual(plan.patterns, []);
	assert.deepEqual(plan.providers.sort(), ["orcarouter", "tlc-spark"]);
});
