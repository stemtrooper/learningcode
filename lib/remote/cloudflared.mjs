import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "../config.mjs";

/**
 * Finding or fetching cloudflared, so students never install it themselves.
 *
 * Resolution order:
 *   1. LEARNINGCODE_CLOUDFLARED, an explicit path (for labs with their own copy)
 *   2. a copy the installer or an earlier run put in ~/.learningcode/bin
 *   3. cloudflared already on PATH
 *   4. download the official release into ~/.learningcode/bin, once
 *
 * The download is pinned to a release tag rather than "latest", for the same
 * reason the installer pins Node: an upstream change must not break every
 * student's tunnel on the same day.
 */

export const CLOUDFLARED_VERSION = "2026.10.0";

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/download";

/**
 * The release asset for this machine. Returns null on platforms cloudflared
 * does not ship a binary for, so the caller can say so plainly.
 */
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
	const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
	if (!cpu) return null;
	if (platform === "win32") return cpu === "amd64" ? "cloudflared-windows-amd64.exe" : null;
	if (platform === "linux") return `cloudflared-linux-${cpu}`;
	if (platform === "darwin") return `cloudflared-darwin-${cpu}.tgz`;
	return null;
}

export function cloudflaredBinaryName(platform = process.platform) {
	return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

const exists = async (path) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * Locate a usable cloudflared binary, downloading it only when none exists.
 * `spawnProbe` is injectable so the PATH check can be tested without a network.
 */
export async function ensureCloudflared({
	dir = agentDir(),
	env = process.env,
	platform = process.platform,
	arch = process.arch,
	fetchImpl = globalThis.fetch,
	onStatus = () => {},
	hasOnPath = defaultHasOnPath,
} = {}) {
	if (env.LEARNINGCODE_CLOUDFLARED) return env.LEARNINGCODE_CLOUDFLARED;

	const bin = join(dir, "bin", cloudflaredBinaryName(platform));
	if (await exists(bin)) return bin;

	if (await hasOnPath("cloudflared")) return "cloudflared";

	const asset = cloudflaredAsset(platform, arch);
	if (!asset) {
		throw new Error(
			`cloudflared has no build for ${platform}/${arch}. ` +
				"Run the relay on a server instead: learningcode remote-server",
		);
	}

	onStatus(`downloading cloudflared ${CLOUDFLARED_VERSION} (one time)`);
	const url = `${RELEASES}/${CLOUDFLARED_VERSION}/${asset}`;
	const response = await fetchImpl(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`could not download cloudflared (HTTP ${response.status})`);
	const bytes = Buffer.from(await response.arrayBuffer());

	await mkdir(join(dir, "bin"), { recursive: true });
	const staging = `${bin}.download`;

	if (asset.endsWith(".tgz")) {
		// macOS ships a tarball. Extract with the system tar, which every
		// supported Mac has, rather than adding an archive library.
		const { execFile } = await import("node:child_process");
		const archive = `${staging}.tgz`;
		await writeFile(archive, bytes);
		await new Promise((resolve, reject) =>
			execFile("tar", ["-xzf", archive, "-C", join(dir, "bin")], (error) =>
				error ? reject(error) : resolve(),
			),
		);
		await rm(archive, { force: true });
		// The tarball's member is named "cloudflared"; it is already at `bin`.
	} else {
		await writeFile(staging, bytes);
		await rename(staging, bin);
	}

	await chmod(bin, 0o755).catch(() => {});
	return bin;
}

async function defaultHasOnPath(name) {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const probe = spawn(name, ["--version"], { stdio: "ignore", windowsHide: true });
		probe.on("error", () => resolve(false));
		probe.on("exit", (code) => resolve(code === 0));
	});
}
