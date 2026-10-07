import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * LEARNINGCODE startup banner.
 *
 * Pi lets an extension replace the whole header, which is the supported way to
 * brand a fork without touching Pi's internals. The built-in header is Pi's own
 * logo plus key hints; we trade that for the TLC banner and a line of slash
 * commands, so nothing is invented about keybindings we cannot read.
 *
 * Rendering is delegated to the active theme's colour tokens (`accent`, `border`,
 * `dim`, `muted`) so the banner stays legible in light and dark terminals rather
 * than hard-coding colours that break on one of them.
 */

/** Structural types, so this file needs no runtime import from Pi's packages. */
type ThemeLike = { fg(token: string, text: string): string };
type HeaderComponent = { render(width: number): string[] };

/**
 * A condensed 5-row block face, 3 columns per glyph except N at 4, because a
 * 3-column N reads as a filled blob. Spelled out rather than generated so the
 * letterforms can be adjusted by hand.
 */
const GLYPHS: Record<string, readonly string[]> = {
	L: ["█  ", "█  ", "█  ", "█  ", "███"],
	E: ["███", "█  ", "███", "█  ", "███"],
	A: [" █ ", "█ █", "███", "█ █", "█ █"],
	R: ["███", "█ █", "███", "█ █", "█ █"],
	N: ["█  █", "█ ██", "██ █", "█  █", "█  █"],
	I: ["███", " █ ", " █ ", " █ ", "███"],
	G: ["███", "█  ", "█ █", "█ █", "███"],
	C: ["███", "█  ", "█  ", "█  ", "███"],
	O: ["███", "█ █", "█ █", "█ █", "███"],
	D: ["███", "█ █", "█ █", "█ █", "███"],
};

const WORD = "LEARNINGCODE";
const ROWS = 5;
const PAD = "  ";

export const bannerArt = (word: string = WORD): string[] => {
	const missing = [...new Set(word)].filter((letter) => !GLYPHS[letter]);
	if (missing.length) throw new Error(`banner has no glyph for: ${missing.join(", ")}`);
	return Array.from({ length: ROWS }, (_, row) =>
		[...word].map((letter) => GLYPHS[letter][row]).join(" ").trimEnd(),
	);
};

const TAGLINE = "The Learning Curve · Sarawak";
const HINTS = "/help commands · /quota today's spend · /hotkeys keys";

/** Widest glyph row, so the caller can decide between full art and the wordmark. */
export const bannerWidth = (word: string = WORD): number =>
	Math.max(...bannerArt(word).map((line) => line.length));

/**
 * Below this the block art wraps or collides with the prompt, so fall back to a
 * single line rather than draw something broken.
 */
const MIN_FULL_WIDTH = 52;

export function createBanner(theme: ThemeLike): HeaderComponent {
	const art = bannerArt();
	const artWidth = bannerWidth();
	const accent = (text: string) => theme.fg("accent", text);

	return {
		render(width: number): string[] {
			if (width < MIN_FULL_WIDTH) {
				return [
					"",
					accent(PAD + "learningcode"),
					theme.fg("muted", PAD + TAGLINE),
				];
			}

			const lines = ["", ...art.map((line) => accent(PAD + line))];
			lines.push(theme.fg("border", PAD + "─".repeat(artWidth)));
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