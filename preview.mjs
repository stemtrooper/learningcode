import { createJiti } from "jiti";
import { readFileSync } from "node:fs";

const jiti = createJiti(process.cwd() + "/x.js");
const bannerMod = await jiti.import("./extensions/banner.ts");
const footerMod = await jiti.import("./extensions/footer.ts");

// Render with the real theme values so the colours match what a student sees.
const themeFile = JSON.parse(readFileSync("./assets/themes/tlc-dark.json", "utf-8"));

function ansi(hex, text, bg = false) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return text;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const open = bg ? `48;2;${r};${g};${b}` : `38;2;${r};${g};${b}`;
  return `\x1b[${open}m${text}\x1b[0m`;
}

// okhsl is not resolvable here, so map the tokens the banner and footer use.
const tokenColour = {
  accent: themeFile.colors.accent,
  dim: themeFile.colors.dim,
  muted: themeFile.colors.muted,
  border: themeFile.colors.border,
  error: themeFile.colors.error,
};

const theme = {
  fg: (token, text) => ansi(tokenColour[token] ?? "#888888", text),
  getColorMode: () => "dark",
};

console.log(ansi("#333333", "┌─ tlc-dark theme, 120 columns ─────────────────────────────────────────────"));
console.log("");
console.log(bannerMod.createBanner(theme).render(120).join("\n"));
console.log(ansi("#333333", "├─ footer, quota states ──────────────────────────────────────────────────"));
console.log("");

const cases = [
  ["fresh", { tokensUsed: 1200, dailyTokenLimit: 250000, aiEnabled: true }],
  ["half", { tokensUsed: 125000, dailyTokenLimit: 250000, aiEnabled: true }],
  ["92%", { tokensUsed: 230000, dailyTokenLimit: 250000, aiEnabled: true }],
  ["over budget", { tokensUsed: 260000, dailyTokenLimit: 250000, aiEnabled: true }],
];

for (const [name, quota] of cases) {
  const { tokensUsed, dailyTokenLimit } = quota;
  const line =
    "  " +
    ansi(tokenColour.accent, footerMod._internals.meter(tokensUsed, dailyTokenLimit)) +
    " " +
    ansi(tokenColour.muted, footerMod._internals.pct(tokensUsed, dailyTokenLimit)) +
    "  " +
    ansi(tokenColour.dim, `${Math.round(tokensUsed / 1000)}k / ${Math.round(dailyTokenLimit / 1000)}k today`);
  console.log(ansi("#666666", name.padEnd(12)) + line);
}

console.log("");
console.log(
  "  " + ansi(tokenColour.error, "AI disabled for your account — ask your teacher"),
);
console.log("");
console.log(ansi("#333333", "└─ narrow terminal, 44 columns ──────────────────────────────────────────────"));
console.log("");
console.log(bannerMod.createBanner(theme).render(44).join("\n"));