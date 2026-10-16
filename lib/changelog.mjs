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
		version: "0.9.5",
		title: "Small fixes under the hood",
		lines: [
			"When a command is more than one kind of dangerous - it deletes",
			"files and runs as administrator, say - the approval prompt now",
			"names every part, and \"Always allow\" remembers each one instead",
			"of just the first.",
			"",
			"The warning that your Spark quota is nearly used up now says when",
			"it resets, so you know how long to wait.",
			"",
			"/undo is more careful: it only puts back files inside your",
			"project, never anything outside it.",
			"",
			"Nothing about how you work changes. TLC-Spark is still the default",
			"model.",
		],
	},
	{
		version: "0.9.4",
		title: "ExpLabs keeps itself up to date",
		lines: [
			"ExpLabs' model list now comes straight from ExpLabs. When you log",
			"in, learningcode asks ExpLabs which models you can use and how big",
			"their context windows are, instead of shipping a list that goes",
			"stale. The result is saved, so starting learningcode never waits on",
			"the network.",
			"",
			"If you are offline when you log in, the built-in list is used and",
			"everything still works.",
			"",
			"Behind the scenes, the phone relay is sturdier: a misbehaving",
			"connection is dropped instead of being allowed to flood your",
			"computer, and the tunnel program is checked against the checksum",
			"its publisher reports before it is run.",
			"",
			"TLC-Spark stays the default model; everything else is unchanged.",
		],
	},
	{
		version: "0.9.3",
		title: "Honest on a bad connection",
		lines: [
			"When Spark is slow or unreachable, learningcode now says so in a",
			"few seconds instead of waiting forever. /quota and /seats always",
			"come back with an answer, and starting a session is never held up",
			"by a network that will not respond.",
			"",
			"/quota also tells you when your weekly quota comes back: every",
			"Friday at 00:00, with the time left until then.",
			"",
			"Logging in to ExpLabs now points at the correct web address and",
			"accepts its xpl_ keys, so its models actually work.",
			"",
			"If something unexpected goes wrong you get one plain sentence,",
			"never a wall of error text. (A developer can ask for the details",
			"with LEARNINGCODE_DEBUG=1.)",
			"",
			"TLC-Spark stays the default model; everything else is unchanged.",
		],
	},
	{
		version: "0.9.2",
		title: "\"Allow Always\" finally sticks",
		lines: [
			"\"Allow Always\" used to remember the exact command text. The agent",
			"rewrites a command nearly every time — new temp paths, different echo",
			"lines — so it kept asking again for the same kind of danger.",
			"",
			"Now it remembers the kind of danger: say yes once to \"deletes files\"",
			"and a later rm -rf of a different folder runs without asking. The",
			"choice is labelled with exactly what you are allowing. Anything else",
			"still asks.",
			"",
			"Risky commands are still stopped before they run — this only changes",
			"how often you are asked.",
		],
	},
	{
		version: "0.9.1",
		title: "Undo now brings back the files the agent made",
		lines: [
			"Until now /undo only reset files you already track in git. Files",
			"the agent created — or an untracked file it overwrote — were not",
			"covered by that, so experimenting could lose work.",
			"",
			"/undo now shows exactly what it will put back and remove before",
			"you say yes, then does it: it restores the files the agent changed",
			"and deletes the ones it created. If a file is too large to save a",
			"copy of, /undo says so instead of quietly skipping it.",
			"",
			"Risky shell commands are still stopped by the approval prompt; /undo",
			"covers the agent's file edits.",
			"",
			"TLC-Spark stays the default model; everything else is unchanged.",
		],
	},
	{
		version: "0.9.0",
		title: "Your plan survives a restart",
		lines: [
			"If you build a checklist in Plan mode, then close learningcode,",
			"lose Wi-Fi, or your laptop sleeps, your plan is still there when",
			"you come back with:",
			"  learningcode -c",
			"You resume in Build mode with your progress intact, and a short",
			"note says what was restored. Each conversation remembers its own",
			"checklist, so a brand-new session still starts clean.",
			"",
			"/todo clear clears it for good — nothing comes back to surprise",
			"you.",
			"",
			"TLC-Spark stays the default model; everything else is unchanged.",
		],
	},
	{
		version: "0.8.6",
		title: "Smaller, sturdier, quieter",
		lines: [
			"This release is a cleanup: nothing new to learn, but fewer ways",
			"to go wrong.",
			"",
			"learningcode doctor no longer stops to ask for a token. It reports",
			"what it could not check and finishes, so it is safe to run in a",
			"script.",
			"",
			"A mistyped remote flag (like --port with no number after it) now",
			"says what it needs instead of printing a stack trace.",
			"",
			"Colours are drawn more defensively, so a hand-edited theme cannot",
			"crash your session.",
			"",
			"TLC-Spark stays the default model; everything you use is unchanged.",
		],
	},
	{
		version: "0.7.8",
		title: "CommandCode joins the providers you can log in to",
		lines: [
			"CommandCode is now a provider, next to TLC-Spark, Token Harbor,",
			"River AI and ExpLabs. Log in from inside learningcode:",
			"  /login",
			"(pick Sign in with an API key, then CommandCode), or from your",
			"shell:",
			"  learningcode --login-provider commandcode",
			"Your key is not echoed either way. Around ninety models then",
			"appear in /model after you tick them in /scoped-models,",
			"including the Claude line, which speaks a different protocol and",
			"is already set up for you.",
			"",
			"Prefer an environment variable? COMMANDCODE_API_KEY works too.",
			"",
			"TLC-Spark stays the default model; nothing else changes.",
		],
	},
	{
		version: "0.7.7",
		title: "Remote: a message you send mid-answer waits its turn",
		lines: [
			"Typing a second message on your phone while the agent was still",
			"answering used to come back with an error about",
			"streamingBehaviour, and the message was lost. It now waits and is",
			"read after the answer, in the order you sent it.",
			"",
			"Stop now also cancels anything you had queued behind the answer,",
			"and says how many messages went with it, instead of leaving them",
			"unanswered with no explanation.",
			"",
			"On the phone your own words are blue and the agent's are white, so",
			"the transcript says who said what without reading the labels.",
			"",
			"Typing, TLC-Spark quota and everything else are unchanged.",
		],
	},
	{
		version: "0.7.6",
		title: "ExpLabs joins the providers you can log in to",
		lines: [
			"ExpLabs is now a provider, next to TLC-Spark, Token Harbor and",
			"River AI. Log in once:",
			"  learningcode --login-provider explabs",
			"Paste your ExpLabs key (it is not echoed). Its models then appear",
			"in /model after you tick them in /scoped-models.",
			"",
			"Prefer an environment variable? EXPLABS_API_KEY works too.",
			"",
			"TLC-Spark stays the default model; nothing else changes.",
		],
	},
	{
		version: "0.7.5",
		title: "Updated to the latest Pi runtime",
		lines: [
			"Learningcode now runs on Pi 1.2.0. Nothing changes in how you",
			"use it: your themes, Plan/Build mode and TLC-Spark quota all",
			"work the same.",
			"",
			"If you use a custom Pi theme, note that Pi 1.2.0 validates theme",
			"files more strictly. The built-in TLC themes are updated for it.",
		],
	},
	{
		version: "0.7.4",
		title: "River AI is now a provider",
		lines: [
			"River AI joins TLC-Spark and Token Harbor. Log in once:",
			"  learningcode --login-provider river",
			"Paste your rv_ key (it is not echoed). Its models then appear in",
			"/model after you tick them in /scoped-models.",
			"",
			"Prefer an environment variable? RIVER_API_KEY works too.",
			"",
			"Everything else is unchanged: TLC-Spark stays the default model.",
		],
	},
	{
		version: "0.5.7",
		title: "Your models are remembered, and the footer shows the active one",
		lines: [
			"/scoped-models now sticks: pick your favourite models once and they",
			"survive quitting and learningcode --resume.",
			"",
			"The footer always shows the active model in yellow, so an",
			"opencode default is visible at a glance.",
			"",
			"Token Harbor gains claude-haiku-5.5; existing installs pick it up",
			"on next launch.",
			"",
			"Thinking-level cycling moves to ctrl+shift+e, freeing shift+tab",
			"for the future Plan/Build toggle. Footer hints cover ctrl+p,",
			"ctrl+shift+e and ctrl+t.",
			"",
			"Phone: run learningcode remote, then scan the QR code with your camera.",
			"learningcode remote --resume continues this project's last conversation.",
		],
	},
	{
		version: "0.5.6",
		title: "Approvals, a done sound, undo, and test runs",
		lines: [
			"Destructive commands now ask first, in the terminal and on your phone:",
			"deleting files, force-pushing, resetting, publishing. Choose Yes or No.",
			"",
			"A tone plays when the agent finishes. On the phone, a chime plays.",
			"",
			"/undo discards uncommitted changes to tracked files and restores the last",
			"commit. It asks first, because it also discards your own unsaved edits.",
			"",
			"The agent can run your tests (npm test) and report only what fails.",
			"",
			"To resume a conversation, use learningcode -c. The line Pi prints on exit",
			"shows pi --session, which is Pi's name for the same thing.",
			"",
			"Phone: run learningcode remote, then scan the QR code with your camera.",
			"learningcode remote --resume continues this project's last conversation.",
		],
	},
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
