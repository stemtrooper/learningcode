import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_TOKENS_PER_STEP,
	blocksAtReserve,
	holdsAtReserve,
	observedTokensPerStep,
	paceLine,
	paceSegment,
	remainingTokens,
	resolveReserve,
	stepsLeft,
	stopReason,
	stoppedMessage,
	tokensPerStep,
} from "../lib/pace.mjs";

test("no limit reads as null, never as zero steps", () => {
	assert.equal(remainingTokens({ tokensUsed: 5000, dailyTokenLimit: null }), null, "no cap");
	assert.equal(remainingTokens({ tokensUsed: 5000, dailyTokenLimit: 0 }), null, "zero cap");
	assert.equal(remainingTokens({ tokensUsed: 5000, dailyTokenLimit: 250000, quotaExempt: true }), null, "exempt");
	assert.equal(remainingTokens(undefined), null, "no quota at all");

	for (const quota of [{ dailyTokenLimit: null }, { dailyTokenLimit: 0 }, { quotaExempt: true }]) {
		const steps = stepsLeft({ remainingTokens: remainingTokens(quota) });
		assert.equal(steps, null, "no ceiling means no estimate");
		assert.match(paceLine({ steps }), /no daily limit/i);
		assert.doesNotMatch(paceLine({ steps }), /0 steps/, "never invents a zero");
	}
});

test("remaining tokens never goes negative and ignores a missing used count", () => {
	assert.equal(remainingTokens({ tokensUsed: 300000, dailyTokenLimit: 250000 }), 0);
	assert.equal(remainingTokens({ dailyTokenLimit: 250000 }), 250000, "missing usage means none spent");
	assert.equal(remainingTokens({ tokensUsed: "junk", dailyTokenLimit: 100 }), 100);
});

test("a fresh session falls back to the conservative default, never flattering", () => {
	assert.equal(observedTokensPerStep(0, 0), null);
	assert.equal(observedTokensPerStep(5000, 0), null, "no steps, no rate");
	assert.equal(tokensPerStep(0, 0), DEFAULT_TOKENS_PER_STEP);
	// A measured rate, once there is one.
	assert.equal(Math.round(tokensPerStep(24000, 2)), 12000);
	assert.equal(Math.round(observedTokensPerStep(9000, 3)), 3000);
});

test("steps round down and two histories give different estimates", () => {
	// 100_000 / 12_000 = 8.33 -> 8
	assert.equal(stepsLeft({ remainingTokens: 100000, tokensPerStep: 12000 }), 8);
	// A cheaper session buys more steps from the same budget.
	const cheap = stepsLeft({ remainingTokens: 100000, tokensPerStep: 5000 });
	const pricey = stepsLeft({ remainingTokens: 100000, tokensPerStep: 30000 });
	assert.equal(cheap, 20);
	assert.equal(pricey, 3);
	assert.ok(cheap > pricey);
});

test("the reserve is held back, and a reserve above the estimate clamps to zero", () => {
	assert.equal(stepsLeft({ remainingTokens: 60000, tokensPerStep: 12000 }), 5);
	assert.equal(stepsLeft({ remainingTokens: 60000, tokensPerStep: 12000, reserve: 3 }), 2);
	assert.equal(stepsLeft({ remainingTokens: 24000, tokensPerStep: 12000, reserve: 5 }), 0, "reserve > stepsLeft");
	assert.equal(holdsAtReserve({ steps: 0, reserve: 3 }), true);
	assert.equal(holdsAtReserve({ steps: 1, reserve: 3 }), false);
	assert.equal(holdsAtReserve({ steps: 0, reserve: 0 }), false, "no reserve means no stop");
});

test("a drained day says so in plain words, not a bare zero", () => {
	const steps = stepsLeft({ remainingTokens: 0, tokensPerStep: 12000 });
	assert.equal(steps, 0);
	assert.match(paceLine({ steps }), /No steps left today/);
	assert.doesNotMatch(paceLine({ steps }), /about 0/);
});

test("the reserve stop tells the model to stop and the student how to resume", () => {
	assert.match(stopReason(3), /Stop now/);
	assert.match(stopReason(3), /\/pace reserve off/);
	assert.match(stoppedMessage(1), /~1 step /, "singular");
	assert.match(stoppedMessage(2), /~2 steps /, "plural");
	assert.match(stoppedMessage(2), /\/pace reserve off/);
});

test("only file-changing tools are stopped: safe shell and readers pass", () => {
	const safeBash = (command) => String(command ?? "").startsWith("git status");
	assert.equal(blocksAtReserve("edit", undefined, safeBash), true);
	assert.equal(blocksAtReserve("write", undefined, safeBash), true);
	assert.equal(blocksAtReserve("powershell", undefined, safeBash), true, "a shell is a shell on Windows");
	assert.equal(blocksAtReserve("bash", "rm -rf build", safeBash), true);
	assert.equal(blocksAtReserve("bash", "git status", safeBash), false, "read-only wrap-up stays allowed");
	assert.equal(blocksAtReserve("read", undefined, safeBash), false);
	assert.equal(blocksAtReserve("grep", undefined, safeBash), false);
});

test("the rendered lines never mention money", () => {
	const lines = [
		paceLine({ steps: 4 }),
		paceLine({ steps: 0, reserve: 3 }),
		paceLine({ steps: null }),
		paceSegment({ steps: 4, reserve: 3 }),
		stopReason(3),
		stoppedMessage(3),
	];
	for (const line of lines) assert.doesNotMatch(line, /\$|dollar|cost/i, line);
});

test("the reserve pin parses, and nonsense is ignored", () => {
	assert.deepEqual(resolveReserve(false, undefined), { reserve: 0, floor: 0, locked: false });
	assert.deepEqual(resolveReserve(2, undefined), { reserve: 2, floor: 0, locked: false });
	// A lab pin is a floor: the student may raise it but not undercut it.
	assert.deepEqual(resolveReserve(1, "5"), { reserve: 5, floor: 5, locked: true });
	assert.deepEqual(resolveReserve(9, "5"), { reserve: 9, floor: 5, locked: true });
	assert.deepEqual(resolveReserve(4, "off"), { reserve: 4, floor: 0, locked: false });
	// Nonsense does not pin and does not throw.
	assert.deepEqual(resolveReserve(4, "banana"), { reserve: 4, floor: 0, locked: false });
	assert.deepEqual(resolveReserve(-2, "-1"), { reserve: 0, floor: 0, locked: false });
});
