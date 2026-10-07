import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";

/**
 * LEARNINGCODE startup banner.
 *
 * Pi lets an extension replace the whole header, which is the supported way to
 * brand a fork without touching Pi's internals. The built-in header is Pi's own
 * logo plus key hints; we trade that for the TLC banner and a line of slash
 * commands, so nothing is claimed about keybindings we cannot read.
 *
 * The art is the figlet "ANSI Shadow" face, kept verbatim rather than rebuilt from
 * a glyph map: the double-line box characters only line up if every row keeps
 * its exact offset, and a one-space drift makes the whole thing look broken.
 *
 * Rendering uses the active theme's colour tokens (`accent`, `border`, `dim`,
 * `muted`) so the banner stays legible in light and dark terminals instead of
 * hard-coding colours that break on one of them.
 */

/**
 * Only the parts of Pi's Theme this file touches, to keep the runtime import
 * down to the two colour helpers it actually needs.
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
 * not one, so a raw hex there crashes the header at render time. `foregroundAnsi`
 * takes a colour value directly, and unlike a hand-rolled escape it still
 * degrades to 256 colour on terminals without truecolour support.
 */
const CYAN_DARK_BG = rgbColor(0x29, 0xc8, 0xf2);
const CYAN_LIGHT_BG = rgbColor(0x0d, 0xac, 0xd6);
const RESET = "\x1b[0m";

const ART: readonly string[] = [
  "██╗     ███████╗ █████╗ ██████╗ ███╗   ██╗██╗███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██║     ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║     █████╗  ███████║██████╔╝██╔██╗ ██║██║██╔██╗ ██║██║  ███╗██║     ██║   ██║██║  ██║█████╗",
  "██║     ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝",
  "███████╗███████╗██║  ██║██║  ██║██║ ╚████║██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

const TAGLINE = "The Learning Curve · Sarawak";
const HINTS = "/help commands · /quota today's spend · /hotkeys keys";

const PAD = "  ";

/** A copy, so a caller mutating the result cannot corrupt later renders. */
export const bannerArt = (): string[] => [...ART];

export const bannerWidth = (): number => Math.max(...ART.map((line) => line.length));

/**
 * The art is 97 columns, which does not fit the classic 80 column terminal.
 * Below the art plus its indent we show a wordmark instead, because clipped box
 * characters look like a rendering bug rather than a design.
 */
const MIN_FULL_WIDTH = bannerWidth() + PAD.length;

export function createBanner(theme: ThemeLike): HeaderComponent {
	const art = bannerArt();
	const artWidth = bannerWidth();

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
			if (width < MIN_FULL_WIDTH) {
				return ["", ink(PAD + "learningcode"), theme.fg("muted", PAD + TAGLINE)];
			}

			const lines = ["", ...art.map((line) => ink(PAD + line))];
			lines.push(theme.fg("border", PAD + "═".repeat(artWidth)));
			lines.push(theme.fg("muted", PAD + TAGLINE));
			lines.push(theme.fg("dim", PAD + HINTS));
			lines.push("");
			return lines;
		},
	};
}

/**
 * `setHeader` lives on ExtensionUIContext, not on the ExtensionAPI the factory
 * receives, so it has to be reached from an event's context. session_start is the
 * right moment: extensions are loaded in print and JSON modes too, where there is
 * no header to replace, and starting work in the factory would run for those.
 */
export default function learningcodeBanner(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => createBanner(theme as ThemeLike));
	});
}