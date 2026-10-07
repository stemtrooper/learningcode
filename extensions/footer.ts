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

type Quota = { tokensUsed: number; dailyTokenLimit: number; aiEnabled: boolean };

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const pct = (used: number, limit: number): string =>
  limit > 0 ? `${Math.min(100, Math.round((used / limit) * 100))}%` : "--";

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
  const { tokensUsed, dailyTokenLimit } = quota;
  return [
    `${meter(tokensUsed, dailyTokenLimit)} ${pct(tokensUsed, dailyTokenLimit)}`,
    `${Math.round(tokensUsed / 1000)}k/${Math.round(dailyTokenLimit / 1000)}k today`,
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
          // Nothing to say off Spark, or no token: say so rather than draw a bar
          // full of empties that reads as "you have spent nothing".
          if (!TOKEN) {
            return [theme.fg("dim", "  not on Spark — /login, or use --model opencode-go/…")];
          }
          if (!quota) return [theme.fg("dim", "  Spark quota unavailable")];

          if (quota.aiEnabled === false) {
            return [theme.fg("error", "  AI disabled for your account — ask your teacher")];
          }

          const { tokensUsed, dailyTokenLimit } = quota;
          const bar = theme.fg("accent", meter(tokensUsed, dailyTokenLimit));
          const percent = theme.fg("muted", pct(tokensUsed, dailyTokenLimit));

          // Narrow terminals keep the bar and the percentage only; the absolute
          // token counts are the part that can be dropped.
          if (width < 52) return [`  ${bar} ${percent}`];

          const numbers = theme.fg(
            "dim",
            `${Math.round(tokensUsed / 1000)}k / ${Math.round(dailyTokenLimit / 1000)}k today`,
          );
          return [`  ${bar} ${percent}  ${numbers}`];
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
export const _internals = { format, meter, pct };