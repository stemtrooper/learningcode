# Plan Mode / Build Mode (Shift+Tab) — final build plan

Status: **approved, to build as 0.6.0**. All Pi API claims verified against
`@earendil-works/pi-coding-agent@1.1.0` in `node_modules`
(`dist/core/extensions/types.d.ts`; `KeyId` in `@earendil-works/pi-tui`).

## Locked decisions

- **Shift+Tab toggles Plan/Build**, matching other agents. Freed in 0.5.7 by
  moving thinking-cycle to `ctrl+shift+e` (`ensureThinkingCycleKey` seeds
  `<agent-dir>/keybindings.json`; `shift+tab` is a valid `KeyId`).
- **No right-side panel exists** in Pi's API: `setWidget` placement is only
  `aboveEditor | belowEditor`. The progress checklist is an above-editor
  widget, shown only when the window is wide enough; the phone gets a text
  checklist through the bridge instead.
- **Single working indicator**: the footer owns it (`setWorkingVisible(false)`
  since `621de60`). Plan mode adds no new spinners.
- **Default is Build**, including after `--resume` / session switch. No
  persistence in 0.6.0: resuming into a neutered agent confuses students.
  The checklist survives Plan → Build (footer reads `BUILD done/total`) so
  progress stays visible while building; a fresh Plan session resets it.
- **Minor bump → 0.6.0** with tag, CHANGELOG entry, README highlight + rows.

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

## Design: `extensions/plan-mode.ts` (+ `extensions/plan-todos.ts` widget)

Remote path: the extension loads in RPC mode too (remote uses the same
`forcedPiArgs` + `PI_EXTENSIONS`), so `/plan` typed in the phone input works
with no extra wiring. `registerShortcut` must degrade gracefully under RPC
(no keyboard) — verify it does not throw; gate TUI-only calls on
`ctx.hasUI && ctx.mode === "tui"`.

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
- Indicator: footer gains a mode segment (`· PLAN` in `warning` yellow /
  `· BUILD` dim) next to the yellow model label, via silent repaint.
  Footer hint line gains `shift+tab plan`.
- Progress checklist: plan-mode state tracks steps
  (`{ step, text, completed }[]`, seeded from the model's `Plan:` header on
  `agent_end`, or manually via `/todo add <text>` / `/todo done <n>` /
  `/todo clear`; `/todos` lists the full checklist). A widget
  (`plan-todos`, `aboveEditor`) renders the single current-step row,
  and returns `[]` when narrow (< 100 cols, same pattern as
  the footer's `width < 52` branch), when in Build mode, or when no plan is
  active. All-done shows `PLAN n/n ✓` in the footer and `✓ all done` in the
  widget. Phone: text checklist through `ctx.ui.notify`, which RPC forwards
  as `extension_ui_request`; `setWidget` is guarded (try/catch) so RPC never
  throws.

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

Implement → `npm test` (158 today) → commit → push → tag `v0.6.0` →
CHANGELOG entry + README highlight/changelog rows → publish.
