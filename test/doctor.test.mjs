import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorReport, processAlive } from "../lib/doctor.mjs";
import { credentialSources, saveProviderKey } from "../lib/auth.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-doctor-"));

test("doctor never prints a stored key value", async () => {
	const dir = await scratch();
	const secret = "oc_sk_SECRETVALUE_12345";
	await saveProviderKey(dir, "opencode-go", secret);
	const report = await doctorReport({ dir, env: {} , checkSpark: async () => ({ ok: true }) });
	assert.doesNotMatch(report, /SECRETVALUE/);
	assert.match(report, /opencode-go\s+logged in \(auth\.json\)/);
});

test("credential sources name the env var, never its value", async () => {
	const dir = await scratch();
	const sources = await credentialSources(dir, { OPENAI_API_KEY: "sk-live-value" });
	assert.deepEqual(sources.openai, ["env OPENAI_API_KEY"]);
	assert.equal(JSON.stringify(sources).includes("sk-live-value"), false);
});

test("TLC-Spark is always reported as offered, with no key", async () => {
	const dir = await scratch();
	const report = await doctorReport({ dir, env: {} });
	assert.match(report, /tlc-spark\s+always offered/);
});

test("a Spark check that fails is reported with its reason", async () => {
	const dir = await scratch();
	const report = await doctorReport({ dir, env: {}, checkSpark: async () => ({ ok: false, reason: "token rejected (401)" }) });
	assert.match(report, /not answering .*token rejected \(401\)/);
});

test("with no remote session, doctor says so", async () => {
	const dir = await scratch();
	const report = await doctorReport({ dir, env: {} });
	assert.match(report, /Remote\n {2}no session yet/);
});

test("a stale remote record reports not running", async () => {
	const dir = await scratch();
	await writeFile(
		join(dir, "remote.json"),
		JSON.stringify({ sessionId: "s", serverUrl: "ws://x", cwd: "/p", pid: 2147483646 }),
		"utf-8",
	);
	const report = await doctorReport({ dir, env: {}, remoteDir: dir });
	assert.match(report, /not running for \/p/);
});

test("processAlive rejects impossible pids", () => {
	assert.equal(processAlive(0), false);
	assert.equal(processAlive(-1), false);
	assert.equal(processAlive(process.pid), true);
});