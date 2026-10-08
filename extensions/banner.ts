import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";

/**
 * LEARNINGCODE startup banner.
 *
 * Pi lets an extension replace the whole header, which is the supported way to
 * brand a fork without touching Pi's internals.
 *
 * Three tiers, because the full face does not fit everywhere. A phone will never
 * have 97 columns, and clipping box characters looks like a rendering bug rather
 * than a design, so the banner steps down instead:
 *
 *   >= 99 columns   figlet "ANSI Shadow", 97 wide, 6 rows
 *   >= 51 columns   condensed 4 row face, 47 wide
 *   below that     the wordmark
 *
 * The full art is stored verbatim rather than rebuilt from a glyph map. That face
 * only aligns because every row keeps its exact offset, the top row flush left
 * and the rest flush too; a one-space drift makes the whole banner look broken.
 * A test asserts those offsets.
 */

/**
 * Only the parts of Pi's Theme this file touches, to keep the runtime import down
 * to the two colour helpers actually needed.
 */
type ThemeLike = {
  fg(token: string, text: string): string;
  /** "light" | "dark" - the background the active theme is designed for. */
  appearance?: "light" | "dark";
  /** The terminal's colour capability, e.g. "truecolor". Not light or dark. */
  getColorMode?(): string;
};
type HeaderComponent = { render(width: number): string[] };

/**
 * TLC brand cyan, sampled from the logo pixels in TLC_BLACKBGND.png and
 * TLC_WHITEBGND.png rather than eyeballed.
 *
 * The banner uses these directly instead of the theme's `accent`, because a
 * wordmark that changes colour with whatever theme is active stops being a
 * wordmark. Pi's own logo does the same thing, keeping fixed brand colours and
 * adapting only for light versus dark terminals.
 *
 * Two values because the logo ships two: the darker cyan holds contrast on a
 * white field, the brighter one on black.
 *
 * Note this must not go through `theme.fg()`. That resolves theme *tokens*, and
 * `Theme.tokenAnsi` throws `Unknown theme color: #29c8f2` for anything that is
 * not one, so a raw hex there crashes the header at render time.
 * `foregroundAnsi` takes a colour value directly, and unlike a hand-rolled escape
 * it still degrades to 256 colour on terminals without truecolour support.
 */
const CYAN_DARK_BG = rgbColor(0x29, 0xc8, 0xf2);
const CYAN_LIGHT_BG = rgbColor(0x0d, 0xac, 0xd6);
const RESET = "\x1b[0m";

const WORD = "LEARNINGCODE";
const PAD = "  ";
const TAGLINE = "The Learning Curve · Sarawak";
const HINTS = "/help commands · /quota today's spend · /hotkeys keys";

/** figlet "ANSI Shadow", verbatim. 97 columns, 6 rows. */
const ART: readonly string[] = [
  "██╗     ███████╗ █████╗ ██████╗ ███╗   ██╗██╗███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██║     ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║     █████╗  ███████║██████╔╝██╔██╗ ██║██║██╔██╗ ██║██║  ███╗██║     ██║   ██║██║  ██║█████╗",
  "██║     ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝",
  "███████╗███████╗██║  ██║██║  ██║██║ ╚████║██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

/**
 * Condensed fallback for narrow terminals. Three columns per glyph, which is
 * the most a twelve letter word can be compressed before the letterforms stop
 * reading: an N needs four columns to show its diagonal, and dropping it to
 * three turns the letter into a filled block.
 */
const CONDENSED_GLYPHS: Record<string, readonly string[]> = {
  L: ["█  ", "█  ", "█  ", "███"],
  E: ["███", "█  ", "███", "███"],
  A: [" █ ", "█ █", "███", "█ █"],
  R: ["███", "█ █", "███", "█ █"],
  N: ["█ █", "███", "█ █", "█ █"],
  I: ["███", " █ ", " █ ", "███"],
  G: ["███", "█  ", "█ █", "███"],
  C: ["███", "█  ", "█  ", "███"],
  O: ["███", "█ █", "█ █", "███"],
  D: ["███", "█ █", "█ █", "███"],
};

const condensedArt = (): string[] => {
  const rows = CONDENSED_GLYPHS[WORD[0]].length;
  return Array.from({ length: rows }, (_, row) =>
    [...WORD].map((letter) => CONDENSED_GLYPHS[letter][row]).join(" ").trimEnd(),
  );
};

/** A copy, so a caller mutating the result cannot corrupt later renders. */
export const bannerArt = (): string[] => [...ART];

export const condensedArt_ = condensedArt;

export const bannerWidth = (): number => Math.max(...ART.map((line) => line.length));
export const condensedWidth = (): number => Math.max(...condensedArt().map((line) => line.length));

/** Art plus its indent. Derived, never guessed. */
const MIN_FULL_WIDTH = bannerWidth() + PAD.length;
const MIN_CONDENSED_WIDTH = condensedWidth() + PAD.length;

export function createBanner(theme: ThemeLike): HeaderComponent {
	const full = bannerArt();
	const small = condensedArt();

	// Two different things, easy to swap by accident:
	//   appearance    light or dark, decides which brand cyan is readable
	//   getColorMode  the terminal's colour capability, decides how to emit it
	// Default to dark so the banner keeps its colour on a host that reports
	// neither, rather than dropping the brand.
	const isLight = theme.appearance === "light";
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	const brand = foregroundAnsi(isLight ? CYAN_LIGHT_BG : CYAN_DARK_BG, mode as never);
	const ink = (text: string) => `${brand}${text}${RESET}`;

	return {
		render(width: number): string[] {
			if (width >= MIN_FULL_WIDTH) {
				const lines = ["", ...full.map((line) => ink(PAD + line))];
				lines.push(theme.fg("border", PAD + "═".repeat(bannerWidth())));
				lines.push(theme.fg("muted", PAD + TAGLINE));
				lines.push(theme.fg("dim", PAD + HINTS));
				lines.push("");
				return lines;
			}

			if (width >= MIN_CONDENSED_WIDTH) {
				const lines = ["", ...small.map((line) => ink(PAD + line))];
				lines.push(theme.fg("muted", PAD + TAGLINE));
				lines.push("");
				return lines;
			}

			return ["", ink(PAD + "learningcode"), theme.fg("muted", PAD + TAGLINE)];
		},
	};
}

/**
 * `setHeader` lives on ExtensionUIContext, not on the ExtensionAPI the factory
 * receives, so it has to be reached from an event's context. session_start is the
 * right moment: extensions are loaded in print and JSON modes too, where there is
 * no header to replace, and starting work in the factory would run for those.
 */

/** Terminal tab title. Just enough of the event context to set it. */
const TITLE = "learningcode by the learning curve";
type TitleContext = {
  hasUI: boolean;
  mode: string;
  ui: { setTitle(title: string): void };
};

/**
 * Pi rewrites its own π title after extensions bind and again after its async
 * startup package check on Windows, so one write is never enough. The title is
 * set on every event where Pi rewrites its own (startup, renames, new turns),
 * plus once deferred past the startup check. Each write is last-writer-wins in
 * our favour on at least one of those paths.
 */
const TITLE_REASSERT_MS = 2500;

export default function learningcodeBanner(pi: ExtensionAPI) {
  let titleTimer: ReturnType<typeof setTimeout> | undefined;

  const applyTitle = (ctx: TitleContext) => {
    try {
      ctx.ui.setTitle(TITLE);
    } catch {
      // Cosmetic only: a title failure must never break startup.
    }
  };

  const titleHook =
    (defer: boolean) => async (_event: unknown, ctx: TitleContext) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      applyTitle(ctx);
      if (!defer) return;
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = setTimeout(() => {
        titleTimer = undefined;
        applyTitle(ctx);
      }, TITLE_REASSERT_MS);
      titleTimer.unref?.();
    };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => createBanner(theme as ThemeLike));
    await titleHook(true)(_event, ctx);
  });
  pi.on("session_info_changed", titleHook(false));
  pi.on("agent_start", titleHook(false));
  pi.on("session_shutdown", async () => {
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = undefined;
  });
}