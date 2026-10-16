import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fatalMessage,
	fixStaleToken,
	isAuthFailure,
	nextWeeklyReset,
	quotaErrorLine,
	quotaResetLine,
	queuePositionLine,
	seatsErrorLine,
	startupFailureLine,
} from "../lib/failure.mjs";
import { tokenPath } from "../lib/token.mjs";

test("every failure says what happened, what to do, and how long", () => {
	const dead = { ok: false, error: "HTTP 401", status: 401 };
	for (const line of [quotaErrorLine(dead, "https://x"), seatsErrorLine(dead, "https://x")]) {
		assert.match(line, /rotated/);
		assert.match(line, /learningcode --login/);
	}
	const missing = { ok: false, error: "no Spark token in the environment" };
	assert.match(quotaErrorLine(missing, "https://x"), /No Spark token loaded/);
	assert.match(seatsErrorLine(missing, "https://x"), /learningcode --login/);

	const down = { ok: false, error: "timed out after 5s" };
	assert.match(quotaErrorLine(down, "https://spark/x"), /Cannot reach Spark/);
	assert.match(quotaErrorLine(down, "https://spark/x"), /\/quota again/);
	assert.match(seatsErrorLine(down, "https://spark/x"), /\/seats again/);

	assert.equal(isAuthFailure({ ok: false, status: 403 }), true);
	assert.equal(isAuthFailure({ ok: false, error: "boom" }), false);
});

test("queue position never invents a wait time", () => {
	assert.match(queuePositionLine({ position: 3 }), /You are #3/);
	assert.match(queuePositionLine({ position: 3 }), /classmate/);
	assert.match(queuePositionLine({ position: 0 }), /free/);
	assert.equal(queuePositionLine({ active: 5 }), null, "no position, no fiction");
	assert.equal(queuePositionLine(null), null);
});

test("a fatal error is one line for a student, a stack only on request", () => {
	const boom = new Error("something went sideways");
	boom.stack = "Error: something went sideways\n    at /home/student/app.mjs:1:1";
	assert.equal(fatalMessage(boom, {}), "something went sideways");
	assert.doesNotMatch(fatalMessage(boom, {}), /at \/home\/student/, "no stack trace for a student");
	assert.match(fatalMessage(boom, { LEARNINGCODE_DEBUG: "1" }), /at \/home\/student/, "the trace is there for a developer");
	// A thrown string still reads as a sentence, never "[object Object]".
	assert.equal(fatalMessage("plain refusal", {}), "plain refusal");
});

test("the weekly reset is Friday 00:00, computed and never in the past", () => {
	// 2026-10-14 is a Wednesday; the next Friday 00:00 is the 16th.
	const wed = new Date(2026, 9, 14, 15, 0, 0);
	const reset = nextWeeklyReset(wed);
	assert.equal(reset.getDay(), 5, "Friday");
	assert.equal(reset.getHours(), 0);
	assert.equal(reset.getMinutes(), 0);
	assert.equal(reset.getDate(), 16);
	assert.match(quotaResetLine(wed), /resets Fri 00:00 \(in \d+d \d+h\)/);

	// On Friday itself the next reset is a week away, not this morning's 00:00.
	const fri = new Date(2026, 9, 16, 9, 0, 0);
	assert.equal(nextWeeklyReset(fri).getDate(), 23);

	// Under a day it reads in hours/minutes, never a misleading "0d".
	const thuLate = new Date(2026, 9, 15, 22, 0, 0);
	assert.match(quotaResetLine(thuLate), /resets Fri 00:00 \(in 2h 0m\)/);
});

test("startup failures surface dead tokens, stay silent otherwise", () => {
	assert.equal(startupFailureLine({ ok: true }, "https://x"), null);
	const dead = startupFailureLine({ ok: false, error: "HTTP 401", status: 401 }, "https://x");
	assert.match(dead, /token is dead/);
	assert.match(dead, /learningcode --login/);
	const down = startupFailureLine({ ok: false, error: "timed out" }, "https://x");
	assert.match(down, /not answering/);
	assert.doesNotMatch(down, /--login/, "network trouble is not a token problem");
});

test("doctor --fix clears only a rejected cache", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fix-"));
	try {
		// Rejected cache: cleared with the login pointer.
		await writeFile(tokenPath(dir), "spark_live_stale", "utf-8");
		const line = await fixStaleToken(
			dir,
			async () => ({ ok: false, status: 401 }),
			async () => "spark_live_stale",
		);
		assert.match(line, /Cleared the stale cached token/);
		assert.match(line, /learningcode --login/);
		await assert.rejects(readFile(tokenPath(dir), "utf-8"), "cache file gone");

		// Healthy token: hands off.
		await writeFile(tokenPath(dir), "spark_live_good", "utf-8");
		const kept = await fixStaleToken(
			dir,
			async () => ({ ok: true }),
			async () => "spark_live_good",
		);
		assert.equal(kept, null);
		assert.equal(await readFile(tokenPath(dir), "utf-8"), "spark_live_good");

		// No cache: nothing to do, never prompts.
		await rm(tokenPath(dir), { force: true });
		assert.equal(
			await fixStaleToken(dir, async () => ({ ok: false, status: 401 }), async () => null),
			null,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
