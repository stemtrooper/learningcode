/**
 * Theme helpers that never throw.
 *
 * `theme.fg()` resolves a theme *token*, and Pi throws on a token the active
 * theme does not define ("Unknown theme color: …"). A student can edit their
 * theme, and Pi can fall back to a partial one, so a raw `fg()` call inside a
 * render loop is a crash waiting to happen: one bad frame takes down the agent.
 *
 * These wrap the lookup so an unknown token degrades to uncoloured text. Every
 * extension that draws with theme colours should go through `safeFg` rather
 * than calling `theme.fg()` directly.
 */

/** `theme.fg()` that never throws — an unknown token falls back to plain text. */
export function safeFg(theme, token, text) {
	try {
		return theme.fg(token, text);
	} catch {
		return text;
	}
}

/**
 * A solid badge: the label is drawn as reverse video, so the fill colour becomes
 * the block and the text reads as negative space (it takes the terminal
 * background). This is how a status gets a filled box without a dedicated
 * background token.
 *
 * Falls back to the raw SGR reverse attribute when the theme does not expose
 * `inverse()`, so a minimal theme (and the tests) still get the box.
 */
export function inverseBox(theme, token, text) {
	const colored = safeFg(theme, token, text);
	if (typeof theme.inverse === "function") return theme.inverse(colored);
	return `\x1b[7m${colored}\x1b[27m`;
}
