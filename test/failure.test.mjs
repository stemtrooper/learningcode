import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fixStaleToken,
	isAuthFailure,
	quotaErrorLine,
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
