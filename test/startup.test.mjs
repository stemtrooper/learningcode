import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	CHECK_TIMEOUT_MS,
	STARTUP_BUDGET_MS,
	STARTUP_HEALTH_BUDGET_MS,
	withinBudget,
} from "../lib/startup.mjs";

/**
 * Latency is the experience (WS6). These are the budgets the launcher is held
 * to, asserted the way installer.test.mjs asserts the Node floor: a number in
 * code, checked here so a regression fails the suite rather than a student.
 */

const launcher = fileURLToPath(new URL("../bin/learningcode.mjs", import.meta.url));

const runColdStart = () =>
	new Promise((resolve, reject) => {
		const started = Date.now();
		execFile(process.execPath, [launcher, "--version"], { timeout: STARTUP_BUDGET_MS * 2 }, (error, stdout) => {
			if (error) return reject(error);
			resolve({ ms: Date.now() - started, stdout });
		});
	});

test("the launcher reaches its own output inside the cold-start budget", async () => {
	// --version is the shortest path through the launcher: module load, arg
	// parse, and nothing else. A regression that imports something heavy at
	// startup, or hits the network on the way, shows up here as a number.
	const { ms, stdout } = await runColdStart();
	assert.match(stdout, /^\d+\.\d+\.\d+/, "still prints the version");
	assert.ok(ms < STARTUP_BUDGET_MS, `cold start took ${ms}ms, budget is ${STARTUP_BUDGET_MS}ms`);
});

test("the Spark preflight cannot hold up startup", async () => {
	// The probe earns a warning, not a delay. It must be bounded well below the
	// request timeout, because every millisecond of it lands before a prompt.
	assert.ok(
		STARTUP_HEALTH_BUDGET_MS < CHECK_TIMEOUT_MS,
		"the preflight budget must be below the request timeout it wraps",
	);
	assert.ok(STARTUP_HEALTH_BUDGET_MS <= 500, `preflight budget ${STARTUP_HEALTH_BUDGET_MS}ms is too generous`);
});

test("a slow preflight is abandoned, not waited on", async () => {
	const slow = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200));
	assert.equal(await withinBudget(slow, 20), null, "a probe slower than the budget yields nothing");

	const fast = Promise.resolve({ ok: false, reason: "down" });
	assert.deepEqual(await withinBudget(fast, 200), { ok: false, reason: "down" }, "a fast probe keeps its answer");

	const rejected = withinBudget(Promise.reject(new Error("no")), 200);
	assert.equal(await rejected, null, "a failed probe is no worse than a slow one");
});

test("the launcher goes through the budget for its only network preflight", async () => {
	// Structural: a bare `await checkEndpoint(...)` here is exactly the
	// regression this workstream exists to prevent, so the pattern is banned.
	const source = await readFile(launcher, "utf-8");
	assert.match(source, /withinBudget\(checkEndpoint\(/, "the preflight runs under a budget");
	assert.doesNotMatch(source, /await checkEndpoint\(/, "and is never awaited unbounded");
});
