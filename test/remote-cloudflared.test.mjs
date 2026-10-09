import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflaredAsset, cloudflaredBinaryName, ensureCloudflared } from "../lib/remote/cloudflared.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "lc-cloudflared-"));

test("each platform maps to the release asset cloudflared publishes", () => {
	assert.equal(cloudflaredAsset("win32", "x64"), "cloudflared-windows-amd64.exe");
	assert.equal(cloudflaredAsset("linux", "x64"), "cloudflared-linux-amd64");
	assert.equal(cloudflaredAsset("linux", "arm64"), "cloudflared-linux-arm64");
	assert.equal(cloudflaredAsset("darwin", "arm64"), "cloudflared-darwin-arm64.tgz");
	assert.equal(cloudflaredAsset("darwin", "x64"), "cloudflared-darwin-amd64.tgz");
});

test("a platform without a build is reported, not guessed", () => {
	assert.equal(cloudflaredAsset("win32", "arm64"), null);
	assert.equal(cloudflaredAsset("freebsd", "x64"), null);
});

test("the Windows binary is named .exe", () => {
	assert.equal(cloudflaredBinaryName("win32"), "cloudflared.exe");
	assert.equal(cloudflaredBinaryName("linux"), "cloudflared");
});

test("an explicit path from the environment wins over everything", async () => {
	const path = await ensureCloudflared({
		env: { LEARNINGCODE_CLOUDFLARED: "C:\\labs\\cloudflared.exe" },
		hasOnPath: async () => true,
		fetchImpl: () => assert.fail("must not download when a path is given"),
	});
	assert.equal(path, "C:\\labs\\cloudflared.exe");
});

test("a copy already in ~/.learningcode/bin is used without a download", async () => {
	const dir = await scratch();
	await mkdir(join(dir, "bin"));
	await writeFile(join(dir, "bin", "cloudflared"), "binary");
	const path = await ensureCloudflared({
		dir,
		env: {},
		platform: "linux",
		arch: "x64",
		fetchImpl: () => assert.fail("must not download when a copy exists"),
		hasOnPath: async () => false,
	});
	assert.equal(path, join(dir, "bin", "cloudflared"));
});

test("a copy on PATH is used before downloading", async () => {
	const path = await ensureCloudflared({
		dir: await scratch(),
		env: {},
		platform: "linux",
		arch: "x64",
		hasOnPath: async (name) => name === "cloudflared",
		fetchImpl: () => assert.fail("must not download when PATH has one"),
	});
	assert.equal(path, "cloudflared");
});

test("a missing copy is downloaded once, from the pinned release, into the agent dir", async () => {
	const dir = await scratch();
	const requested = [];
	const payload = Buffer.from("fake-binary");
	const path = await ensureCloudflared({
		dir,
		env: {},
		platform: "linux",
		arch: "x64",
		hasOnPath: async () => false,
		fetchImpl: async (url) => {
			requested.push(url);
			return { ok: true, arrayBuffer: async () => payload };
		},
	});
	assert.equal(requested.length, 1);
	assert.match(requested[0], /releases\/download\/\d{4}\.\d+\.\d+\/cloudflared-linux-amd64$/, "pinned tag, not latest");
	assert.equal(path, join(dir, "bin", "cloudflared"));
});

test("a failed download is reported with the status, not swallowed", async () => {
	const dir = await scratch();
	await assert.rejects(
		() =>
			ensureCloudflared({
				dir,
				env: {},
				platform: "linux",
				arch: "x64",
				hasOnPath: async () => false,
				fetchImpl: async () => ({ ok: false, status: 503 }),
			}),
		/HTTP 503/,
	);
});
