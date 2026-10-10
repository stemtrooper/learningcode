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

export default function sparkFooter(pi: ExtensionAPI) {
  let quota: Quota | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let spinTimer: ReturnType<typeof setInterval> | undefined;
  let working = false;
  let frame = 0;
  let tui: TuiLike | undefined;

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
      // Repaint in place. Notifying would be the wrong tool: an empty
      // notification still appends a row to the transcript, and the transcript is
      // what the student is reading.
      tui?.requestRender?.();
    };

    const sessionCtx = ctx as { model?: { provider?: string; id?: string } | null };
    ctx.ui.setFooter((footerTui: TuiLike, theme: ThemeLike) => {
      tui = footerTui;
      return {
        render(width: number): string[] {
          // Pi's stock footer (folder, session, model, context usage) is
          // replaced by setFooter, so the active model must live here or an
          // opencode default shows nowhere.
          const modelLabel = theme.fg("warning", `  ·  ${activeModelId(sessionCtx)}`);
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
          const idleHints = theme.fg("dim", "  ctrl+c exit  ·  esc interrupt  ·  ctrl+p models  ·  shift+tab thinking  ·  ctrl+t fold");
          const hints = working
            ? theme.fg("accent", `  ${SPINNER[frame]} working…`) +
              theme.fg("muted", "  ·  esc to interrupt")
            : idleHints;

          // Nothing to say off Spark, or no token: say so rather than draw a bar
          // full of empties that reads as "you have spent nothing".
          if (!token()) {
            return [theme.fg("muted", "  not on Spark") + modelLabel, hints];
          }
          if (!quota) return [theme.fg("dim", "  Spark quota unavailable") + modelLabel, hints];

          if (quota.aiEnabled === false) {
            return [theme.fg("error", "  AI disabled for your account — ask your teacher") + modelLabel, hints];
          }

          // No ceiling: no meter and no percentage, because a full bar implies a
          // limit that does not exist.
          if (isUnlimited(quota)) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  unlimited") + modelLabel,
              hints,
            ];
          }

          // A null daily cap does not mean unlimited: the weekly cap can still
          // apply. Do not turn null into zero or show a misleading /0K allowance.
          if (quota.dailyTokenLimit === null || quota.dailyTokenLimit === undefined) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  no daily token cap") + modelLabel,
              hints,
            ];
          }

          const { tokensUsed, dailyTokenLimit } = quota;
          const limit = dailyTokenLimit;
          const bar = theme.fg("accent", meter(tokensUsed, limit));
          const percent = theme.fg("muted", pct(tokensUsed, limit));

          // Narrow terminals keep the bar and the percentage only; the absolute
          // token counts are the part that can be dropped.
          if (width < 52) return [`  ${bar} ${percent}` + modelLabel, hints];

          const numbers = theme.fg(
            "dim",
            `${Math.round(tokensUsed / 1000)}k / ${Math.round(limit / 1000)}k today`,
          );
          return [`  ${bar} ${percent}  ${numbers}` + modelLabel, hints];
        },
      };
    });

    await refresh();
    timer = setInterval(refresh, POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    setWorking(false);
    if (timer) clearInterval(timer);
    timer = undefined;
    tui = undefined;
  });

  pi.on("agent_start", async () => {
    setWorking(true);
  });

  pi.on("agent_end", async () => {
    setWorking(false);
  });
}

// Exported for tests.
export const _internals = { format, isUnlimited, meter, pct, activeModelId };
