import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cachedTokenPrefix } from "../lib/token.mjs";
import { agentDir } from "../lib/config.mjs";

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

const BASE_URL = (process.env.SPARK_BASE_URL || "https://spark.learning.com.my/v1").replace(/\/+$/, "");
const TOKEN = process.env.SPARK_API_KEY || "";

async function call(path: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status?: number }> {
	if (!TOKEN) return { ok: false, error: "no Spark token in the environment" };
	try {
		const response = await fetch(`${BASE_URL}${path}`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, status: response.status };
		return { ok: true, body: await response.json() };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "unreachable" };
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

function quotaLine(body: QuotaBody): string {
	const used = num(body.tokensUsed);
	if (isUnlimited(body)) {
		return [
			`Spark quota - ${used.toLocaleString()} tokens used, unlimited`,
			"exempt",
			`jobs ${num(body.jobsUsed)}`,
			`day ${String(body.day ?? "?")}`,
			body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
		]
			.filter(Boolean)
			.join("  |  ");
	}
	if (body.dailyTokenLimit === null || body.dailyTokenLimit === undefined) {
		return [
			`Spark quota - ${used.toLocaleString()} tokens used today, no daily token cap`,
			`jobs ${num(body.jobsUsed)}/${num(body.dailyJobLimit)}`,
			`day ${String(body.day ?? "?")}`,
			body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
		]
			.filter(Boolean)
			.join("  |  ");
	}

	const limit = body.dailyTokenLimit;
	const pct = limit > 0 ? ` (${Math.round((used / limit) * 100)}%)` : "";
	return [
		`Spark quota - ${used.toLocaleString()}/${limit.toLocaleString()} tokens${pct}`,
		`jobs ${num(body.jobsUsed)}/${num(body.dailyJobLimit)}`,
		`day ${String(body.day ?? "?")}`,
		body.aiEnabled === false ? "AI DISABLED for your account - ask your teacher" : "",
	]
		.filter(Boolean)
		.join("  |  ");
}

export const _internals = { quotaLine, isUnlimited, thousands, num };

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
			ctx.ui.notify(
				result.ok ? quotaLine(result.body as QuotaBody) : `quota unavailable: ${result.error}`,
				result.ok ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("seats", {
		description: "Show how many Spark seats are free",
		handler: async (_args, ctx) => {
			const result = await call("/queue");
			ctx.ui.notify(
				result.ok ? queueLine(result.body) : `seat info unavailable: ${result.error}`,
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

			if (!TOKEN) {
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
				`Cannot reach Spark at ${BASE_URL} (${result.error}). Check your network.`,
				"warning",
			);
		},
	});

	// One check at startup rather than after every turn: the quota moves by at
	// most one request per turn, and a fetch on each `agent_end` would add
	// latency to the thing students are waiting on.
	pi.on("session_start", async (_event, ctx) => {
		const result = await call("/me/quota");
		if (!result.ok) return;
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
				`Heads up: ${Math.round((used / limit) * 100)}% of today's Spark quota is gone. Run /quota for detail.`,
				"warning",
			);
		}
	});
}
