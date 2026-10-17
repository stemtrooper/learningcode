import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeProviderId } from "../lib/active-model.mjs";
import { PROVIDER_ID, agentDir } from "../lib/config.mjs";
import { isSafeCommand } from "../lib/plan-mode.mjs";
import {
	blocksAtReserve,
	holdsAtReserve,
	paceLine,
	remainingTokens,
	resolveReserve,
	stepsLeft,
	stoppedMessage,
	stopReason,
	tokensPerStep,
} from "../lib/pace.mjs";
import { readPaceReserve, setPaceReserve } from "../lib/settings.mjs";
import { sessionSpend } from "../lib/spend.mjs";

/**
 * Student-owned quota pacing ("save some for later").
 *
 * Spark's quota is a daily token budget. `/pace` turns it into the one thing a
 * student can act on — about how many more steps today — and lets them keep a
 * few steps back so the day does not run dry mid-assignment.
 *
 * This is the *opposite* of the deferred adult spend cap: the student sets it,
 * the student can lift it with `/pace reserve off`, and nothing here is visible
 * to a teacher. A lab may pin a floor with LEARNINGCODE_PACE_RESERVE, and even
 * then the student may raise the reserve, never lower it off.
 *
 * The reserve stops the agent at a `tool_call` boundary, never by killing Pi,
 * so checkpointing and `/undo` keep every byte of work.
 *
 * No network on the hot path: the daily ceiling is fetched lazily, once, the
 * first time the feature is actually used. A failed fetch fails *open* — a
 * flaky network must never block a student's edits.
 */

const baseUrl = () => (process.env.SPARK_BASE_URL || "https://spark.learning.com.my/v1").replace(/\/+$/, "");
const token = () => process.env.SPARK_API_KEY || "";

const SPARK_TIMEOUT_MS = 8000;

type QuotaBody = { tokensUsed?: number; dailyTokenLimit?: number | null; quotaExempt?: boolean };

async function fetchQuota(
	{ fetchImpl = fetch, timeoutMs = SPARK_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<QuotaBody | null> {
	const t = token();
	if (!t) return null;
	try {
		const response = await fetchImpl(`${baseUrl()}/me/quota`, {
			headers: { Authorization: `Bearer ${t}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		return (await response.json()) as QuotaBody;
	} catch {
		return null;
	}
}

export const _internals = { fetchQuota, baseUrl };

export default function pace(pi: ExtensionAPI) {
	/** Steps the student wants kept back; 0 means off. */
	let reserve = 0;
	/** Lab floor the student cannot undercut. */
	let floor = 0;
	/** True when a lab pin forbids `/pace reserve off`. */
	let locked = false;
	/** Tokens left when the ceiling was first fetched; null when unknown. */
	let remainingBase: number | null = null;
	/** Session tokens already counted in `remainingBase`, so the delta is what is new. */
	let spentAtBase = 0;
	/** Whether the one lazy quota fetch has been attempted (failures do not retry). */
	let baseTried = false;
	/** Whether the student has already been told the reserve stopped the agent. */
	let stopped = false;

	const entriesOf = (ctx?: ExtensionContext) => {
		const sessionManager = (ctx as { sessionManager?: { getEntries?: () => unknown[] } })?.sessionManager;
		return (sessionManager?.getEntries?.() ?? []) as Parameters<typeof sessionSpend>[0];
	};

	/** Only Spark has a daily quota to pace. */
	const onSpark = (ctx?: ExtensionContext): boolean => activeProviderId(ctx) === PROVIDER_ID;

	/**
	 * Tokens left now: the ceiling fetched once, minus only the spend that has
	 * happened *since* that fetch. Subtracting the whole session would double
	 * count a resume (or a mid-session reserve) and stop too early.
	 */
	const remainingNow = (ctx?: ExtensionContext): number | null => {
		if (remainingBase === null) return null;
		const since = Math.max(0, sessionSpend(entriesOf(ctx)).tokens - spentAtBase);
		return Math.max(0, remainingBase - since);
	};

	/** About how many more steps, after the reserve, or null when there is no ceiling. */
	const estimate = (ctx?: ExtensionContext): number | null => {
		const spend = sessionSpend(entriesOf(ctx));
		return stepsLeft({
			remainingTokens: remainingNow(ctx),
			tokensPerStep: tokensPerStep(spend.tokens, spend.steps),
			reserve,
		});
	};

	/** Fetch the ceiling once, when the feature is first used. Failure fails open. */
	const ensureBase = async (ctx?: ExtensionContext) => {
		if (baseTried) return;
		baseTried = true;
		const body = await fetchQuota();
		if (body) {
			remainingBase = remainingTokens(body);
			// Anything the session has already spent is inside the server's figure;
			// only spend after this point is new.
			spentAtBase = sessionSpend(entriesOf(ctx)).tokens;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const dir = agentDir();
		let saved = 0;
		try {
			saved = await readPaceReserve(dir);
		} catch {
			saved = 0; // A corrupt settings file must not break startup.
		}
		const resolved = resolveReserve(saved, process.env.LEARNINGCODE_PACE_RESERVE);
		reserve = resolved.reserve;
		floor = resolved.floor;
		locked = resolved.locked;
		remainingBase = null;
		spentAtBase = 0;
		baseTried = false;
		stopped = false;
		// Warm the ceiling only when a reserve is already on; otherwise stay silent.
		if (reserve > 0) await ensureBase(ctx);
		void ctx;
	});

	// Compaction rewrites the session's entries; re-fetch so the base is the
	// server's current figure rather than one measured against the old history.
	pi.on("session_compact", async (_event, ctx) => {
		remainingBase = null;
		spentAtBase = 0;
		baseTried = false;
		stopped = false;
		if (reserve > 0) await ensureBase(ctx);
	});

	pi.registerCommand("pace", {
		description: "Save a few steps of today's quota for later (/pace reserve 3, /pace reserve off)",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();

			if (!text) {
				if (!onSpark(ctx)) {
					ctx.ui.notify(paceLine({ steps: null }), "info");
					return;
				}
				await ensureBase(ctx);
				ctx.ui.notify(paceLine({ steps: estimate(ctx), reserve }), "info");
				return;
			}

			const match = /^reserve(?:\s+(.+))?$/i.exec(text);
			if (!match) {
				ctx.ui.notify("Use /pace, /pace reserve <number>, or /pace reserve off.", "info");
				return;
			}

			const dir = agentDir();
			const value = String(match[1] ?? "").trim().toLowerCase();

			if (value === "off" || value === "0" || value === "") {
				if (locked) {
					ctx.ui.notify(
						`Your lab set a minimum of ${floor} step${floor === 1 ? "" : "s"} to keep back, so the reserve stays on. Ask a teacher to change it.`,
						"warning",
					);
					return;
				}
				await setPaceReserve(dir, 0);
				reserve = 0;
				stopped = false;
				ctx.ui.notify("Reserve off — the agent can use the whole day. Run /pace to set it again.", "info");
				return;
			}

			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify("Give a whole number of steps, like /pace reserve 3, or /pace reserve off.", "info");
				return;
			}
			const next = Math.max(n, floor);
			await setPaceReserve(dir, next);
			reserve = next;
			stopped = false;
			const clamped = next > n ? ` (your lab keeps at least ${floor})` : "";
			ctx.ui.notify(`Saving the last ${next} step${next === 1 ? "" : "s"} of today's quota for later${clamped}.`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (reserve <= 0) return undefined;
		// Off Spark there is no daily quota to pace; never block another provider.
		if (!onSpark(ctx)) return undefined;
		const name = (event as { toolName?: string }).toolName ?? "";
		const command = (event as { input?: { command?: string } }).input?.command;
		if (!blocksAtReserve(name, command, isSafeCommand)) return undefined; // readers still wrap up
		try {
			await ensureBase(ctx);
			const steps = estimate(ctx);
			if (!holdsAtReserve({ steps, reserve })) return undefined;
		} catch {
			return undefined; // a bad estimate must never block a student's work
		}
		if (!stopped) {
			stopped = true;
			ctx?.ui?.notify?.(stoppedMessage(reserve), "info");
		}
		// `terminate` asks Pi to stop the batch, so the model does not retry the block.
		return { block: true, terminate: true, reason: stopReason(reserve) };
	});
}
