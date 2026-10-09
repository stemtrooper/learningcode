import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./config.mjs";

/**
 * What changed in each release, written for students rather than developers.
 * Newest first. Add an entry here with each version bump; the first launch
 * after an update shows the entry for that version, then never again.
 */
export const CHANGELOG = [
	{
		version: "0.5.5",
		title: "learningcode doctor",
		lines: [
			"Run learningcode doctor to check your setup. It shows which models",
			"you can use, whether TLC-Spark answers, and whether remote is running.",
			"It never shows your keys.",
			"",
			"Phone: run learningcode remote, then scan the QR code with your camera.",
			"learningcode remote --resume continues this project's last conversation.",
		],
	},
	{
		version: "0.5.4",
		title: "Token Harbor models, and a shorter /model list",
		lines: [
			"Token Harbor is now a provider you can log in to from learningcode:",
			"  learningcode --login-provider tokenharbor",
			"Paste your thk_ key once. Its models then appear in /model.",
			"",
			"/model shows only providers you are logged in to, plus TLC-Spark.",
			"OpenAI and Anthropic appear once you add their keys.",
			"",
			"Phone: run learningcode remote, then scan the QR code with your camera.",
			"learningcode remote --resume continues this project's last conversation.",
		],
	},
	{
		version: "0.5.3",
		title: "New terminal look, and this notice inside the session",
		lines: [
			"The terminal theme now matches the phone page: black and blue on dark,",
			"white and blue on light.",
			"",
			"Existing installs keep their old theme files. To get the new look, delete",
			"tlc-dark.json and tlc-light.json in ~/.learningcode/agent/themes, then run",
			"learningcode again.",
			"",
			"This notice now appears in the chat, after the banner, so it can be read.",
			"",
			"Phone: run learningcode remote, then scan the QR code with your camera.",
			"learningcode remote --resume continues this project's last conversation.",
		],
	},
	{
		version: "0.5.2",
		title: "Phone page: calmer, and it remembers your model",
		lines: [
			"The phone page is redesigned: no chat bubbles, a clear status line",
			"while the agent works, and a compact header.",
			"",
			"learningcode remote now opens the phone link through Cloudflare by",
			"default. Use learningcode remote --no-tunnel for wifi only.",
			"",
			"The phone page remembers the model you chose and reopens with it.",
			"",
			"Scan the QR code with your phone camera. learningcode remote --resume",
			"continues this project's last conversation.",
		],
	},
	{
		version: "0.5.1",
		title: "Phone notice and a clearer phone page",
		lines: [
			"learningcode now shows this notice once after each update.",
			"",
			"Remote control from your phone:",
			"  learningcode remote --tunnel",
			"  learningcode remote --tunnel --resume   (continue this project)",
			"",
			"Scan the QR code with your phone camera. The phone can switch",
			"models from the model name at the top, and Stop halts a turn.",
			"",
			"The phone link is a password. learningcode remote rotate cancels it.",
		],
	},
	{
		version: "0.5.0",
		title: "Remote control from your phone",
		lines: [
			"Continue your session from a phone, from anywhere:",
			"  learningcode remote --tunnel",
			"Open the QR code it prints with your phone camera.",
			"",
			"  --resume        continue this project's last conversation",
			"  remote stop     stop the phone session",
			"  remote rotate   cancel every old phone link",
			"",
			"The computer must stay on with the command running.",
			"Treat the phone link like a password.",
		],
	},
];

/** Compare dotted versions. Returns true when `a` is strictly newer than `b`. */
export function isNewer(a, b) {
	const parse = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

function seenPath(dir = agentDir()) {
	return join(dir, "last-seen-version");
}

/**
 * The notice to show for this launch, or null. Shown once per upgrade: the
 * version is recorded after the notice is returned, so a student who restarts
 * the same version does not see it again.
 *
 * A brand-new install (no record yet) gets the notice too, because it is the
 * first thing a student needs to know about the tool.
 */
export async function pendingNotice(currentVersion, dir = agentDir()) {
	let seen = null;
	try {
		seen = (await readFile(seenPath(dir), "utf-8")).trim() || null;
	} catch (error) {
		if (error?.code !== "ENOENT") return null;
	}
	if (seen && !isNewer(currentVersion, seen)) return null;

	const entry = CHANGELOG.find((item) => item.version === currentVersion) ?? null;
	return entry ? { version: currentVersion, ...entry } : null;
}

/** Record that this version's notice has been shown. Failures are ignored. */
export async function markNoticeShown(currentVersion, dir = agentDir()) {
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(seenPath(dir), `${currentVersion}\n`, "utf-8");
	} catch {
		/* a read-only home must not stop learningcode from starting */
	}
}

/** The notice as plain lines for the terminal. */
export function formatNotice(notice) {
	const rule = "-".repeat(60);
	return [
		"",
		rule,
		`  What's new in learningcode ${notice.version}: ${notice.title}`,
		rule,
		...notice.lines.map((line) => `  ${line}`),
		rule,
		"  (shown once after an update; `learningcode --help` lists every command)",
		"",
	].join("\n");
}
