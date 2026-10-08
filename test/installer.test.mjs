import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = readFileSync(new URL("../install.sh", import.meta.url), "utf-8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const { REQUIRED_NODE, compareVersions } = await import("../lib/config.mjs");

/** Value of a top-level constant in install.sh. */
const valueOf = (name) => script.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];

test("install.sh enforces the same Node floor as the launcher", () => {
	assert.equal(valueOf("REQUIRED_NODE"), REQUIRED_NODE);
});

test("the pinned fallback Node clears the floor", () => {
	const fallback = valueOf("FALLBACK_NODE");
	assert.match(fallback, /^\d+\.\d+\.\d+$/, "must be a full version, not a branch alias");
	assert.ok(compareVersions(fallback, REQUIRED_NODE) >= 0, "fallback cannot sit below the floor");
});

test("the install itself is a user-owned npm prefix, never sudo", () => {
	assert.match(script, /npm install --global --prefix/, "must install into a student-owned prefix");
	assert.ok(!/^sudo\s/m.test(script), "sudo must never be used to install learningcode");
	assert.ok(!/npm config set prefix/.test(script), "must not rewrite the student's ~/.npmrc");
});

test("Node is only ever fetched from nodejs.org, and pinned", () => {
	// An unpinned URL would let a bad upstream release break every install.
	assert.match(script, /https:\/\/nodejs\.org\/dist\/v\$\{FALLBACK_NODE\}\//);
	for (const url of script.match(/https?:\/\/\S+/g) ?? []) {
		assert.match(
			url,
			/^https:\/\/(nodejs\.org|github\.com|raw\.githubusercontent\.com)\//,
			"unexpected host: " + url,
		);
	}
});

test("the documented one-liner points at this repository", () => {
	assert.match(script, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/[^/]+\/\S+\/main\/install\.sh \| bash/);
});

test("the installer refuses to run as root", () => {
	// Root-owned files break the next upgrade; the check is the README's
	// "do not use sudo npm install -g" advice, enforced before anything breaks.
	assert.match(script, /\[ "\$\(id -u\)" = "0" \]/);
	assert.match(script, /LEARNINGCODE_ALLOW_ROOT/, "CI and containers need a documented escape hatch");
});

test("every installed path lives under the install root", () => {
	// Nothing may leak into /usr, /opt or the system package manager: a lab
	// machine shared by many students must survive one bad install.
	for (const name of ["PREFIX", "NODE_ROOT"]) {
		assert.match(
			script,
			new RegExp(`^${name}="\\$INSTALL_ROOT/`, "m"),
			name + " must sit under INSTALL_ROOT",
		);
	}
	assert.ok(script.includes(pkg.name), "must install the published package, not a fork");
});

test("a Windows runtime leaking onto PATH over WSL is ignored", () => {
	// WSL appends the Windows PATH, so a Windows node.exe answers
	// `command -v node` inside Linux. It runs, then resolves every package
	// path as Windows and installs with Windows shims: the install "succeeds"
	// and only the student sees it break.
	assert.match(script, /is_wsl\(\) \{ uname -r \| grep -qi microsoft; \}/);
	assert.match(script, /case "\$found" in/);
	assert.ok(script.includes("/mnt/*|/c/*) found=''"), "cross-mounted runtimes must be ignored");
});

test("PATH is wired for login shells too, not just interactive ones", () => {
	// Ubuntu's .bashrc returns early for non-interactive shells, so a block
	// appended to it never runs under `ssh host learningcode` or a login shell.
	// .profile has to carry the same line for those.
	assert.match(script, /\.profile/, "must also write the PATH line to .profile");
	assert.match(script, /targets="\$targets \$HOME\/\.profile"/);
});
