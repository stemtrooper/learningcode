import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A persistent footer showing what a Spark student actually needs to know:
 * how much of the day's token budget is gone, and whether their account is
 * allowed to run at all.
 *
 * Spark's quota and seat endpoints are not part of the OpenAI API, so no stock
 * harness surfaces them. `/v1/me/quota` is the reason this footer exists.
 *
 * The value is polled at most every POLL_MS. Agent turns are serial under Spark
 * (one active generation per student), so a per-turn refresh would add latency
 * to the thing the student is waiting on for no new information.
 */

type ThemeLike = { fg(token: string, text: string): string };
type ComponentLike = { render(width: number): string[] };
/** Just enough of the TUI to ask for a repaint after the quota changes. */
type TuiLike = { requestRender?(): void; invalidate?(): void };
type FooterDataLike = { getExtensionStatuses?: () => ReadonlyMap<string, string> };
type UsageLike = { input?: unknown; output?: unknown; cacheRead?: unknown };
type MsgLike = { role?: string; provider?: string; model?: string; usage?: UsageLike };
type EntryLike = { type?: string; provider?: string; model?: string; usage?: UsageLike; message?: MsgLike };
type CostLike = { input?: unknown; output?: unknown; cacheRead?: unknown };
type RegistryLike = { find?: (provider: string, modelId: string) => { cost?: CostLike } | undefined };
type SessionManagerLike = { getEntries?: () => EntryLike[] };

const baseUrl = () => (process.env.SPARK_BASE_URL || "https://spark.learning.com.my/v1").replace(/\/+$/, "");
const token = () => process.env.SPARK_API_KEY || "";

/** Two minutes. Enough to stay current, rarely enough to be invisible. */
const POLL_MS = 120_000;

/** One braille frame per tick while the agent works. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_MS = 120;

type Quota = {
  tokensUsed: number;
  /** null means no daily cap, which is not the same as a cap of zero. */
  dailyTokenLimit: number | null;
  quotaExempt?: boolean;
  aiEnabled: boolean;
};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const pct = (used: number, limit: number): string =>
  limit > 0 ? `${Math.min(100, Math.round((used / limit) * 100))}%` : "--";

/** Only Spark's explicit exemption removes every token ceiling. */
const isUnlimited = (quota: Quota): boolean => quota.quotaExempt === true;

/**
 * A ten cell meter. Text alone ("82%") is easy to skim past; a bar is read at a
 * glance, which is the entire reason this is a footer rather than a command.
 */
function meter(used: number, limit: number, width = 10): string {
  if (limit <= 0) return "";
  const filled = Math.min(width, Math.round((used / limit) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function format(quota: Quota): string[] {
  if (quota.aiEnabled === false) return ["AI off — ask your teacher"];
  const { tokensUsed } = quota;

  if (isUnlimited(quota)) {
    // No bar and no percentage: a full meter would imply a ceiling that is not
    // there, and any percentage of infinity is noise.
    return [`${Math.round(tokensUsed / 1000)}k used today  ·  unlimited`];
  }

  if (quota.dailyTokenLimit === null || quota.dailyTokenLimit === undefined) {
    return [`${Math.round(tokensUsed / 1000)}k used today  ·  no daily token cap`];
  }

  const limit = num(quota.dailyTokenLimit);
  return [
    `${meter(tokensUsed, limit)} ${pct(tokensUsed, limit)}`,
    `${Math.round(tokensUsed / 1000)}k/${Math.round(limit / 1000)}k today`,
  ];
}

/**
 * Session spend over entries. Usage arrives two ways: standalone `usage`
 * entries (model-attributed, non-LLM) and, for every turn, on the assistant
 * message itself (`message` entries, the actual per-turn source). Both are
 * harvested; the two never describe the same call.
 * Dollars use each call's own model catalog price ($/M tokens); cache-read
 * tokens are billed at the cache rate, the rest of input at the input rate
 * (cacheWrite is a subset of input, already counted). dollars is null when
 * no call has numeric rates — tokens alone must never be mistaken for a price.
 */
export function sessionSpend(
	entries: EntryLike[],
	findModel?: (provider?: string, model?: string) => { cost?: CostLike } | undefined,
): { tokens: number; dollars: number | null } {
	let tokens = 0;
	let dollars = 0;
	let priced = false;
	const attribute = (provider: string | undefined, model: string | undefined, usage: UsageLike) => {
		const input = num(usage.input);
		const output = num(usage.output);
		const read = Math.min(num(usage.cacheRead), input);
		tokens += input + output;
		const cost = findModel?.(provider ?? "", model ?? "")?.cost;
		const rates = [cost?.input, cost?.output, cost?.cacheRead];
		if (cost && rates.some((r) => typeof r === "number")) {
			priced = true;
			dollars +=
				((input - read) * num(cost.input) + read * num(cost.cacheRead) + output * num(cost.output)) / 1_000_000;
		}
	};
	for (const entry of entries ?? []) {
		if (entry?.usage) {
			attribute(entry.provider, entry.model, entry.usage);
			continue;
		}
		const message = entry?.message;
		if (message?.role === "assistant" && message.usage) {
			attribute(message.provider, message.model, message.usage);
		}
	}
	return { tokens, dollars: priced ? dollars : null };
}

/** Short model id for narrow screens: provider prefix dropped, then cut. */
export function shortModelId(id: string, max = 16): string {
	const base = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`);

/** Session spend segment, or "" before the first turn. Dollars only when priced. */
export function spendText(spend: { tokens: number; dollars: number | null }): string {
	if (spend.tokens <= 0) return "";
	const dollars = spend.dollars == null ? "" : ` ≈$${spend.dollars.toFixed(2)}`;
	return `sess ${thousands(spend.tokens)}${dollars}`;
}

async function fetchQuota(): Promise<Quota | null> {
  const t = token();
  if (!t) return null;
  try {
    const response = await fetch(`${baseUrl()}/me/quota`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as Quota;
  } catch {
    return null;
  }
}

/**
 * Read the active model id live at render time (`provider/model`), so a
 * `/model` switch or `--model opencode-go/...` shows without a restart.
 * The session_start ctx carries the live session object, so reading it per
 * render is enough; no model-change subscription to go stale.
 */
export function activeModelId(ctx: unknown): string {
	const model = (ctx as { model?: { provider?: string; id?: string } | null })?.model;
	if (!model?.id) return "no-model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/** Status key the plan-mode extension sets while planning. */
const STATUS_PLAN_KEY = "plan-mode";

export default function sparkFooter(pi: ExtensionAPI) {
  let quota: Quota | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let working = false;
  let frame = 0;
  let tui: TuiLike | undefined;
  let spend = { tokens: 0, dollars: null as number | null };
  let sessionRefs = {} as {
    model?: { provider?: string; id?: string } | null;
    sessionManager?: SessionManagerLike;
    modelRegistry?: RegistryLike;
  };

  // Usage entries land per LLM call, so recompute on turn end and on poll —
  // never per render frame (the spinner repaints at 120ms while working).
  const recomputeSpend = () => {
    try {
      const entries = sessionRefs.sessionManager?.getEntries?.() ?? [];
      const find = sessionRefs.modelRegistry?.find?.bind(sessionRefs.modelRegistry);
      spend = sessionSpend(entries, find);
    } catch {
      /* keep the last known spend rather than blanking mid-session */
    }
  };

  const repaint = () => tui?.requestRender?.();

  const setWorking = (on: boolean) => {
    working = on;
    if (on) {
      if (!spinTimer) {
        spinTimer = setInterval(() => {
          frame = (frame + 1) % SPINNER.length;
          repaint();
        }, SPIN_MS);
        spinTimer.unref?.();
      }
    } else if (spinTimer) {
      clearInterval(spinTimer);
      spinTimer = undefined;
    }
    repaint();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const refresh = async () => {
      quota = await fetchQuota();
      recomputeSpend();
      // Repaint in place. Notifying would be the wrong tool: an empty
      // notification still appends a row to the transcript, and the transcript is
      // what the student is reading.
      tui?.requestRender?.();
    };

    const sessionCtx = ctx as {
      model?: { provider?: string; id?: string } | null;
      sessionManager?: SessionManagerLike;
      modelRegistry?: RegistryLike;
    };
    sessionRefs = sessionCtx;
    ctx.ui.setFooter((footerTui: TuiLike, theme: ThemeLike, footerData?: FooterDataLike) => {
      tui = footerTui;
      return {
        render(width: number): string[] {
          // Width tiers: narrow (phone) keeps only what answers "can I run
          // and where am I" — bar, percent, mode. Model, counts and spend
          // return at 52+; the full model id at 70+.
          const narrow = width < 52;
          // Pi's stock footer (folder, session, model, context usage) is
          // replaced by setFooter, so the active model must live here or an
          // opencode default shows nowhere.
          const fullId = activeModelId(sessionCtx);
          const modelLabel = theme.fg("warning", `  ·  ${width >= 70 ? fullId : shortModelId(fullId)}`);
          const maybeModel = narrow ? "" : modelLabel;
          // Plan mode sets the `plan-mode` status ("plan" or "plan done/total");
          // Build mode keeps "build done/total" while a checklist is active.
          const planStatus = footerData?.getExtensionStatuses?.().get(STATUS_PLAN_KEY);
          const planMatch = planStatus?.match(/plan\s+(\d+)\/(\d+)/);
          const planCount = planMatch?.slice(1, 3).join("/");
          const planAllDone = planMatch != null && planMatch[1] === planMatch[2];
          const buildMatch = planStatus?.match(/build\s+(\d+)\/(\d+)/);
          const buildCount = buildMatch?.slice(1, 3).join("/");
          const buildAllDone = buildMatch != null && buildMatch[1] === buildMatch[2];
          const modeLabel =
            planStatus != null && planStatus.startsWith("plan")
              ? theme.fg("warning", `  ·  PLAN${planCount ? ` ${planCount}` : ""}${planAllDone ? " ✓" : ""}`)
              : buildCount
                ? theme.fg("dim", `  ·  BUILD ${buildCount}${buildAllDone ? " ✓" : ""}`)
                : theme.fg("dim", "  ·  build");
          // Every path ends with the exit hint. Students asked how to quit,
          // and the footer is the one line that is always on screen.
          // (ctrl+c clears the editor; pressed twice, or on an empty editor
          // via ctrl+d, it exits. These are Pi's default bindings.)
          //
          // While the agent works the hint line becomes the working
          // indicator instead: an animated frame plus the interrupt key.
          // Pi has its own status spinner, but the footer is the TLC-owned
          // surface, so the motion lives here where it cannot be restyled
          // away from the brand.
          const idleHints = theme.fg(
            "dim",
            narrow
              ? "  ctrl+c exit  ·  esc interrupt"
              : "  ctrl+c exit  ·  esc interrupt  ·  ctrl+p models  ·  ctrl+shift+e thinking  ·  ctrl+t fold  ·  shift+tab plan",
          );
          const hints = working
            ? theme.fg("accent", `  ${SPINNER[frame]} working…`) +
              theme.fg("muted", "  ·  esc to interrupt")
            : idleHints;

          const spendLabel = spendText(spend);
          const maybeSpend = narrow || !spendLabel ? "" : theme.fg("dim", `  ·  ${spendLabel}`);

          // Nothing to say off Spark, or no token: say so rather than draw a bar
          // full of empties that reads as "you have spent nothing".
          if (!token()) {
            return [theme.fg("muted", "  not on Spark") + maybeModel + modeLabel + maybeSpend, hints];
          }
          if (!quota) return [theme.fg("dim", "  quota n/a") + maybeModel + modeLabel + maybeSpend, hints];

          if (quota.aiEnabled === false) {
            return [theme.fg("error", "  AI disabled for your account — ask your teacher") + maybeModel + modeLabel + maybeSpend, hints];
          }

          // No ceiling: no meter and no percentage, because a full bar implies a
          // limit that does not exist.
          if (isUnlimited(quota)) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  unlimited") + maybeModel + modeLabel + maybeSpend,
              hints,
            ];
          }

          // A null daily cap does not mean unlimited: the weekly cap can still
          // apply. Do not turn null into zero or show a misleading /0K allowance.
          if (quota.dailyTokenLimit === null || quota.dailyTokenLimit === undefined) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  no daily token cap") + maybeModel + modeLabel + maybeSpend,
              hints,
            ];
          }

          const { tokensUsed, dailyTokenLimit } = quota;
          const limit = dailyTokenLimit;
          const bar = theme.fg("accent", meter(tokensUsed, limit));
          const percent = theme.fg("muted", pct(tokensUsed, limit));

          // Narrow terminals keep the bar, the percentage and the mode only;
          // the absolute counts, model and spend are the droppable parts.
          if (narrow) return [`  ${bar} ${percent}` + modeLabel, hints];

          const numbers = theme.fg(
            "dim",
            `${Math.round(tokensUsed / 1000)}k / ${Math.round(limit / 1000)}k today`,
          );
          return [`  ${bar} ${percent}  ${numbers}` + maybeModel + modeLabel + maybeSpend, hints];
        },
      };
    });

    await refresh();
    timer = setInterval(refresh, POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    setWorking(false);
    spend = { tokens: 0, dollars: null };
    if (timer) clearInterval(timer);
    timer = undefined;
    tui = undefined;
  });

  pi.on("agent_start", async () => {
    setWorking(true);
  });

  pi.on("agent_end", async () => {
    // Usage entries land with the turn; recompute before the repaint below.
    recomputeSpend();
    setWorking(false);
  });
}

// Exported for tests.
export const _internals = { format, isUnlimited, meter, pct, activeModelId, sessionSpend, shortModelId, spendText };
