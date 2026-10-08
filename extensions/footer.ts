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

const BASE_URL = (process.env.SPARK_BASE_URL || "https://spark.learning.com.my/v1").replace(/\/+$/, "");
const TOKEN = process.env.SPARK_API_KEY || "";

/** Two minutes. Enough to stay current, rarely enough to be invisible. */
const POLL_MS = 120_000;

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
  if (!TOKEN) return null;
  try {
    const response = await fetch(`${BASE_URL}/me/quota`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as Quota;
  } catch {
    return null;
  }
}

export default function sparkFooter(pi: ExtensionAPI) {
  let quota: Quota | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tui: TuiLike | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const refresh = async () => {
      quota = await fetchQuota();
      // Repaint in place. Notifying would be the wrong tool: an empty
      // notification still appends a row to the transcript, and the transcript is
      // what the student is reading.
      tui?.requestRender?.();
    };

    ctx.ui.setFooter((footerTui: TuiLike, theme: ThemeLike) => {
      tui = footerTui;
      return {
        render(width: number): string[] {
          // Every path ends with the exit hint. Students asked how to quit,
          // and the footer is the one line that is always on screen.
          // (ctrl+c clears the editor; pressed twice, or on an empty editor
          // via ctrl+d, it exits. These are Pi's default bindings.)
          const hints = theme.fg("dim", "  ctrl+c exit  ·  esc interrupt");

          // Nothing to say off Spark, or no token: say so rather than draw a bar
          // full of empties that reads as "you have spent nothing".
          if (!TOKEN) {
            return [theme.fg("dim", "  not on Spark — /login, or use --model opencode-go/…"), hints];
          }
          if (!quota) return [theme.fg("dim", "  Spark quota unavailable"), hints];

          if (quota.aiEnabled === false) {
            return [theme.fg("error", "  AI disabled for your account — ask your teacher"), hints];
          }

          // No ceiling: no meter and no percentage, because a full bar implies a
          // limit that does not exist.
          if (isUnlimited(quota)) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  unlimited"),
              hints,
            ];
          }

          // A null daily cap does not mean unlimited: the weekly cap can still
          // apply. Do not turn null into zero or show a misleading /0K allowance.
          if (quota.dailyTokenLimit === null || quota.dailyTokenLimit === undefined) {
            return [
              theme.fg("dim", `  ${Math.round(quota.tokensUsed / 1000)}k used today`) +
                theme.fg("muted", "  ·  no daily token cap"),
              hints,
            ];
          }

          const { tokensUsed, dailyTokenLimit } = quota;
          const limit = dailyTokenLimit;
          const bar = theme.fg("accent", meter(tokensUsed, limit));
          const percent = theme.fg("muted", pct(tokensUsed, limit));

          // Narrow terminals keep the bar and the percentage only; the absolute
          // token counts are the part that can be dropped.
          if (width < 52) return [`  ${bar} ${percent}`, hints];

          const numbers = theme.fg(
            "dim",
            `${Math.round(tokensUsed / 1000)}k / ${Math.round(limit / 1000)}k today`,
          );
          return [`  ${bar} ${percent}  ${numbers}`, hints];
        },
      };
    });

    await refresh();
    timer = setInterval(refresh, POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    tui = undefined;
  });
}

// Exported for tests.
export const _internals = { format, isUnlimited, meter, pct };
