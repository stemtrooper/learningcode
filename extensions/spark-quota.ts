import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../lib/config.mjs";
import { cachedTokenPrefix } from "../lib/token.mjs";
import { quotaErrorLine, quotaResetLine, seatsErrorLine, startupFailureLine, queuePositionLine } from "../lib/failure.mjs";
import { paceLine, remainingTokens, resolveReserve, stepsLeft, tokensPerStep } from "../lib/pace.mjs";
import { readPaceReserve } from "../lib/settings.mjs";
import { sessionSpend } from "../lib/spend.mjs";

/**
 * Spark-aware status for the learningcode client.
 *
 * Spark exposes two endpoints that no stock harness knows about, because they
 * are not part of the OpenAI API:
 *
 *   GET /v1/me/quota  per-student weekly spend, job count, and whether the
 *                     account is allowed to use AI at all right now
 *   GET /v1/queue     live seat queue, so a student can see why a turn is waiting
 *
 * Both need the same personal token the agent already authenticates with, so we
 * read it from the environment the launcher sets rather than asking again.
 */

const baseUrl = () => (process.env.SPARK_BASE_URL || "https://spark.learning.com.my/v1").replace(/\/+$/, "");
const token = () => process.env.SPARK_API_KEY || "";

/**
 * Spark calls are bounded. On a flaky school network a stalled socket would
 * otherwise leave `/quota` and `/seats` spinning forever and hold up the
 * `session_start` check, which reads to a student as "the app is broken".
 * Injectable so a test can force the timeout without a real 8-second wait.
 */
const SPARK_TIMEOUT_MS = 8000;

async function call(
	path: string,
	{ fetchImpl = fetch, timeoutMs = SPARK_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status?: number }> {
	const t = token();
	if (!t) return { ok: false, error: "no Spark token in the environment" };
	try {
		const response = await fetchImpl(`${baseUrl()}${path}`, {
			headers: { Authorization: `Bearer ${t}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, status: response.status };
		return { ok: true, body: await response.json() };
	} catch (error) {
		const timedOut = (error as { name?: string })?.name === "TimeoutError";
		return { ok: false, error: timedOut ? "timed out" : error instanceof Error ? error.message : "unreachable" };
	}
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

type QuotaBody = {
	day?: string;
	tokensUsed?: number;
  dailyTokenLimit?: number | null;
  jobsUsed?: number;
  dailyJobLimit?: number | null;
  quotaExempt?: boolean;
  aiEnabled?: boolean;
};

/** Only Spark's explicit exemption removes every token ceiling. */
const isUnlimited = (body: QuotaBody): boolean => body.quotaExempt === true;

const thousands = (value: number): string => `${Math.round(value / 1000)}k`;

const withPace = (line: string, pace: string): string => (pace ? `${line}  |  ${pace}` : line);

function quotaLine(body: QuotaBody, pace = ""): string {
	const used = num(body.tokensUsed);
	if (isUnlimited(body)) {
		return withPace([
			`Spark quota - ${used.toLocaleString()} tokens used, unlimited`,
			"exempt",
			`jobs ${num(body.jobsUsed)}`,
			`day ${String(body.day ?? "?")}`,
			body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
		]
			.filter(Boolean)
			.join("  |  "), pace);
	}
	if (body.dailyTokenLimit === null || body.dailyTokenLimit === undefined) {
		return withPace([
			`Spark quota - ${used.toLocaleString()} tokens used today, no daily token cap`,
			`jobs ${num(body.jobsUsed)}/${num(body.dailyJobLimit)}`,
			quotaResetLine(),
			body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
		]
			.filter(Boolean)
			.join("  |  "), pace);
	}

	const limit = body.dailyTokenLimit;
	const pct = limit > 0 ? ` (${Math.round((used / limit) * 100)}%)` : "";
	return withPace([
		`Spark quota - ${used.toLocaleString()}/${limit.toLocaleString()} tokens${pct}`,
		`jobs ${num(body.jobsUsed)}/${num(body.dailyJobLimit)}`,
		quotaResetLine(),
		body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
	]
		.filter(Boolean)
		.join("  |  "), pace);
}

/**
 * The pace sentence for `/quota`: about how many more steps today, from the
 * same session harvest the footer uses, plus the quota reset tail. No network —
 * the caller already has the quota body.
 */
async function paceText(body: QuotaBody, ctx: { sessionManager?: { getEntries?: () => unknown[] } }): Promise<string> {
	const entries = (ctx?.sessionManager?.getEntries?.() ?? []) as Parameters<typeof sessionSpend>[0];
	const spend = sessionSpend(entries);
	let reserve = 0;
	try {
		// The same lab pin the stop uses, so the two cannot disagree.
		reserve = resolveReserve(await readPaceReserve(agentDir()), process.env.LEARNINGCODE_PACE_RESERVE).reserve;
	} catch {
		reserve = 0;
	}
	const steps = stepsLeft({
		remainingTokens: remainingTokens(body),
		tokensPerStep: tokensPerStep(spend.tokens, spend.steps),
		reserve,
	});
	// No reset tail: quotaLine already carries the reset time.
	return paceLine({ steps, reserve });
}

export const _internals = { quotaLine, isUnlimited, thousands, num, call, paceText };

/**
 * The queue view shape is not guaranteed, so surface the fields we recognise
 * and fall back to raw JSON rather than inventing structure.
 */
function queueLine(body: unknown): string {
	if (!body || typeof body !== "object") return `Spark queue: ${JSON.stringify(body)}`;
	const record = body as Record<string, unknown>;

	const recognised = ["position", "queued", "waiting", "depth", "active", "seats", "available"];
	const known = Object.entries(record).filter(([key]) => recognised.includes(key));
	if (known.length) {
		return `Spark seats - ${known.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ")}`;
	}
	return `Spark seats - ${JSON.stringify(record).slice(0, 200)}`;
}

export default function sparkQuota(pi: ExtensionAPI) {
	pi.registerCommand("quota", {
		description: "Show your Spark token spend for today",
		handler: async (_args, ctx) => {
			const result = await call("/me/quota");
			if (!result.ok) {
				ctx.ui.notify(quotaErrorLine(result, baseUrl()), "warning");
				return;
			}
			const body = result.body as QuotaBody;
			ctx.ui.notify(quotaLine(body, await paceText(body, ctx)), "info");
		},
	});

	pi.registerCommand("seats", {
		description: "Show how many Spark seats are free",
		handler: async (_args, ctx) => {
			const result = await call("/queue");
			ctx.ui.notify(
				result.ok ? (queuePositionLine(result.body) ?? queueLine(result.body)) : seatsErrorLine(result, baseUrl()),
				result.ok ? "info" : "warning",
			);
		},
	});

	/**
	 * Check the TLC-Spark token and say what to do about it.
	 *
	 * This deliberately does not accept a pasted token. Two constraints make that
	 * the wrong place to type a secret:
	 *
	 *   - Pi's input dialog has no mask option, so the value would sit in scrollback
	 *     in plain text, which on a shared lab machine is worse than the masked
	 *     prompt `learningcode --login` already uses.
	 *   - Pi caches resolved environment values, so a token set mid-session would
	 *     not reliably take effect until the next launch anyway.
	 *
	 * So this reports whether the token Spark is actually seeing is still good,
	 * which is the question a student has after rotating it, and points at the
	 * command that does the work.
	 */
	pi.registerCommand("spark-login", {
		description: "Check your TLC-Spark token, or get a new one",
		handler: async (_args, ctx) => {
			const prefix = await cachedTokenPrefix(agentDir()).catch(() => undefined);

			if (!token()) {
				ctx.ui.notify(
					"No TLC-Spark token loaded. Exit and run:  learningcode --login",
					"warning",
				);
				return;
			}

			const result = await call("/me/quota");

			if (result.ok) {
				const body = result.body as Record<string, unknown>;
				const used = num(body.tokensUsed);
				const limit = num(body.dailyTokenLimit);
				ctx.ui.notify(
					[
						`Token OK${prefix ? ` (${prefix}…)` : ""}`,
						`${used.toLocaleString()}/${limit.toLocaleString()} tokens today`,
						"Rotating it? Exit and run:  learningcode --login",
					].join("  |  "),
					"info",
				);
				return;
			}

			if (result.status === 401 || result.status === 403) {
				ctx.ui.notify(
					[
						`Spark rejected your token${prefix ? ` (${prefix}…)` : ""}.`,
						"It was probably rotated, which revokes the old one.",
						"Exit and run:  learningcode --login",
					].join(" "),
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				`Cannot reach Spark at ${baseUrl()} (${result.error}). Check your network.`,
				"warning",
			);
		},
	});

	// One check at startup rather than after every turn: the quota moves by at
	// most one request per turn, and a fetch on each `agent_end` would add
	// latency to the thing students are waiting on.
	pi.on("session_start", async (_event, ctx) => {
		const result = await call("/me/quota");
		if (!result.ok) { const startupFailure = startupFailureLine(result, baseUrl()); if (startupFailure) ctx.ui.notify(startupFailure, "warning"); return; }
		const body = result.body as Record<string, unknown>;

		if (body.aiEnabled === false) {
			ctx.ui.notify(
				"AI is switched off for your Spark account. Ask your teacher, then run /quota.",
				"warning",
			);
			return;
		}

		const used = num(body.tokensUsed);
		const limit = num(body.dailyTokenLimit);
		if (limit > 0 && used / limit >= 0.8) {
			ctx.ui.notify(
				`Heads up: ${Math.round((used / limit) * 100)}% of your Spark quota is spent. It ${quotaResetLine()}. Run /quota for detail.`,
				"warning",
			);
		}
	});
}
