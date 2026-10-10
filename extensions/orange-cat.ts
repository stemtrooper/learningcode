import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Image, allocateImageId, getCapabilities } from "@earendil-works/pi-tui";
import type { Component, TUI, Theme } from "@earendil-works/pi-tui";

/**
 * Micro orange cat (opencode-style footprint: 5 cells, 1 row).
 * Sitting front-facing cat: orange ears, blinking eyes, flicking tail.
 * True-pixel PNG (30x12px) where image protocols exist, half-blocks elsewhere.
 * The loader-row spinner is also swapped to a small orange rotating square.
 */

const FRAMES = [
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAARElEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oRl4SIiAjWVPo6rwmretFJdVjF37x5M5qqwWA0OzHQCwAACZMNF3vfv8oAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAARElEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oRl4SIiAjWVPo6rwmretFJdVjF37x5M5qqwWA0OzHQCwAACZMNF3vfv8oAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAAQ0lEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oFl8TJk9jF/zdNw5p6T57MIsliJoYBAkyjFtMLDFhQAwCZmQy+VnpibQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAARElEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oRl4SIiAjWVPo6rwmretFJdVjF37x5M5qqwWA0OzHQCwAACZMNF3vfv8oAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAAT0lEQVR4nGM8kcfwnwELsJjEwIhN/P9S7OoZo0lTz8QwQIBp1OJhH9SMuCRERESwpsbXeU1Y1YtOqsMq/ubNG6x2MDEMEGAatZheYMCCGgCBNA+6BCtJTQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAARElEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oRl4SIiAjWVPo6rwmretFJdVjF37x5M5qqwWA0OzHQCwAACZMNF3vfv8oAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAATUlEQVR4nGNkwAH+L2X4j02cMZqBkRT1J09iN5+JYYAA06jFwz6oGXFJiIiIYE2lr/OasKoXnVSHVfzNmzdY7WBiGCDANGoxvcCABTUAbQkOTKbjrEAAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAMCAYAAAB1Lg0yAAAARElEQVR4nGNkwAH+L2X4j02cMZqBkRrqmRgGCDCNWjzsg5oRl4SIiAjWVPo6rwmretFJdVjF37x5M5qqwWA0OzHQCwAACZMNF3vfv8oAAAAASUVORK5CYII=",
];

const SPIN = ["◰", "◳", "◲", "◱"].map((g) => "\x1b[38;2;255;165;0m" + g + "\x1b[39m");

// Braille fallback: 12x4 cells = 24x16 dots (4x half-block density).
// Orange silhouette of assets/cat.webp; eyes carved (blink), tail shifts.
const BRAILLE_SEQ: string[][] = [
  ["[38;2;255;165;0m⠓⣄⣠⠚[39m"],
  ["[38;2;255;165;0m⠓⣄⣠⠚[39m"],
  ["[38;2;255;165;0m⠓⣤⣤⠚[39m"],
  ["[38;2;255;165;0m⠓⣄⣠⠚[39m"],
  ["[38;2;255;165;0m⠒⣄⣠⠒[39m"],
  ["[38;2;255;165;0m⠓⣄⣠⠚[39m"]
];
const FB_TRAVEL = 4;

function mirrorBraille(line: string): string {
  // strip ANSI, mirror dot bits left-right, re-wrap
  const core = line.replace(/\[[0-9;]*m/g, "");
  let out = "";
  for (let i = core.length - 1; i >= 0; i--) {
    const b = core.charCodeAt(i)! - 0x2800;
    const m =
      ((b & 0x01) << 3) | ((b & 0x08) >> 3) |
      ((b & 0x02) << 3) | ((b & 0x10) >> 3) |
      ((b & 0x04) << 3) | ((b & 0x20) >> 3) |
      ((b & 0x40) << 1) | ((b & 0x80) >> 1);
    out += String.fromCharCode(0x2800 + m);
  }
  return "[38;2;255;165;0m" + out + "[39m";
}

function fallbackFrames(): string[][] {
  const frames: string[][] = [];
  for (let i = 0; i <= FB_TRAVEL; i++) {
    const s = BRAILLE_SEQ[i % BRAILLE_SEQ.length]!;
    frames.push(s.map((l) => " ".repeat(i) + l));
  }
  for (let i = FB_TRAVEL; i >= 0; i--) {
    const s = BRAILLE_SEQ[i % BRAILLE_SEQ.length]!;
    frames.push(s.map((l) => " ".repeat(i) + mirrorBraille(l)));
  }
  return frames;
}

class CatWidget implements Component {
  private idx = 0;
  private imageId = allocateImageId();
  private fallback = fallbackFrames();
  private images: Image[] = [];
  private tui!: TUI;
  constructor(tui: TUI, theme: Theme) {
    this.tui = tui;
    const fallbackColor = (s: string) => s;
    for (const f of FRAMES) {
      this.images.push(new Image(f, "image/png", { fallbackColor }, { imageId: this.imageId }));
    }
    void theme;
  }
  advance() {
    this.idx = (this.idx + 1) % FRAMES.length;
    this.invalidate();
    this.tui.requestRender?.();
  }
  invalidate() {
    for (const im of this.images) im.invalidate();
  }
  render(width: number): string[] {
    if (!getCapabilities().images) return this.fallback[this.idx % this.fallback.length]!;
    return this.images[this.idx % this.images.length]!.render(width);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cat", {
    description: "Show which cat renderer is active (pixel PNG or block fallback).",
    handler: async (_args, ctx) => {
      const caps = getCapabilities();
      ctx.ui.notify(
        "cat renderer: " + (caps.images ? "true-pixel PNG (" + caps.images + ")" : "block fallback (no image protocol)"),
        "info",
      );
    },
  });
  let widget: CatWidget | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Single working indicator: the footer owns it (extensions/footer.ts).
  // Pi's built-in working row above the editor is hidden so "working"
  // never appears twice. The cat widget is gone for the same reason.
  pi.on("session_start", async (_e, ctx: ExtensionContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(false);
  });
}
