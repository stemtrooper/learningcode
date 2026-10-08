# Plan Mode / Build Mode (Shift+Tab) — implementation plan

Status: **planned, not built**. This document saves the design so it can be
implemented later exactly as researched. All Pi API claims below were verified
against `@earendil-works/pi-coding-agent@1.1.0` in `node_modules`
(`dist/core/extensions/types.d.ts`).

## Goal

Shift+Tab toggles between two modes:

- **Build** (default): today's behaviour, every tool available.
- **Plan**: the model can look but not touch. It researches the codebase and
  proposes a change, but any edit/write/shell call is refused with a message
  pointing back at Shift+Tab.

The audience is students: the toggle must be discoverable (footer shows the
current mode) and impossible to misunderstand (blocked calls say why).

## What Pi gives us (verified, no fork needed)

- `registerShortcut(shortcut: KeyId, { description, handler })` on the
  extension API. `KeyId` covers modified keys (`ctrl+down`-style ids exist in
  the keybinding tables), so Shift+Tab is expressible; resolve the exact
  literal at build time.
- `getActiveTools()` / `setActiveTools(names)` — the active set is exactly
  what gets declared to the model. Hiding tools is the soft enforcement.
- `tool_call` handler result `{ block?: boolean; reason?: string }` — the hard
  backstop. Even if the model hallucinates a call to a hidden tool, the call
  is refused with our reason. ("To modify arguments, mutate `event.input` in
  place instead" — we only need `block` + `reason`.)
- `context` handler result `{ messages?: AgentMessage[] }` — injects a
  "you are in plan mode: research and propose, do not edit" note so the model
  plays along instead of just hitting refusals.
- Our own footer (`extensions/footer.ts`) for the mode indicator, following the
  same handler-driven pattern as the quota meter and working spinner.

## Design: `extensions/plan-mode.ts`

- State: `"build" | "plan"`, default `"build"` on `session_start`. No
  persistence initially — every session starts in Build, which is also the
  safe default for scripts (`print`/`json` modes: shortcut inert, no behaviour
  change).
- Toggle: Shift+Tab flips state, calls `setActiveTools()` with the mode's set,
  updates the indicator, and notifies once (not a transcript row — same rule
  as the footer's silent repaint).
- Plan tool set: **allowlist**, not denylist. Read-only tools stay
  (`read`, `grep`, `find`, `ls`, plus model-info tools); everything else,
  including unknown future/MCP tools, is hidden from the model *and* blocked
  in `tool_call` with reason
  `"Plan mode is on — press Shift+Tab for Build mode to edit."`
  Allowlist is the safe direction for students: a writer nobody classified yet
  must fail closed.
- Indicator: footer gains a mode segment (e.g. `· PLAN` / `· BUILD`) next to
  the quota line. Exact widget TBD at build time — check `ctx.ui.setStatus`
  semantics versus extending our footer component; do not fight Pi's own
  status area.

## Edge cases to handle at build time

- In-flight calls mid-toggle: `block` applies to new calls only. Accept and
  document — a call already executing is not yanked away.
- Custom/MCP writers: covered by allowlist fail-closed (above).
- Rebound Shift+Tab: Pi reports extension shortcut conflicts; surface the
  conflict message rather than failing silently.
- Mode + session switch/fork: state resets to Build with the new session
  (same rule as a fresh start); say so in the toggle notice.

## Tests (same style as footer/banner tests)

Drive the extension handlers with stubs, no TUI:

- toggle flips `setActiveTools` between the full set and the read-only set;
- `tool_call` for `edit`/`write`/`bash` in Plan mode returns `block: true`
  with the Shift+Tab reason; in Build mode it returns nothing;
- `read`/`grep` calls pass in both modes;
- `context` injects the planner note only in Plan mode;
- shortcut is registered exactly once per session.

## Rollout

Implement → `npm test` (32 tests today, expect ~36) → commit → push →
publish as a **minor** (`0.5.0`, new feature) → `npm install -g .` refresh,
same as 0.4.8–0.4.10.
