# LearningCode 0.8 — student-first launch readiness

Status: **complete — all workstreams done.** Workstream 3 (never lose work)
done as of 0.9.2; workstream 4 (plan templates + strict preset) as of 0.11.0;
workstream 5 (phone parity) as of 0.12.1; workstream 6 (speed) as of 0.13.0;
workstream 7 (sub-agent interface) as of 0.14.0. Audience: students,
explicitly not teachers or parents. Every item is judged by one
question: does it make a student's worst day better? If it serves an
adult's dashboard instead, it belongs in 0.9 or later.

## Locked decisions

- **No teacher features in 0.8.** Dashboard, spend caps, kill-switches,
  logging review — all deferred. Student hours are scarce; spend them on
  the kid's experience.
- **No capability breadth.** No new models, IDE plugins, background
  agents, or subagent machinery. 0.8 is trust and friction, not power.
- **Minor bump → 0.8.0** with tag, CHANGELOG entry, README updates.

### Revision — 2026-10-17: sub-agent machinery admitted (post-0.8)

The "no subagent machinery" lock above was a 0.8-scope decision, and it is
being **reversed deliberately**, in the same file, rather than silently
contradicted: workstream 7 (below) ships sub-agents as the first feature of
the 0.9 line. The reasoning for the original lock — student hours are scarce —
still holds, and is why helpers are **gated off TLC-Spark** (one active
generation per student; fan-out would only earn 429s) and why they exist to
*shrink* the main agent's context, not to add power. See `docs/plan-ws7.md`
and `docs/subagents.md`.

## Workstreams

### 1. First-run that teaches itself (onboarding)

A guided intro session on first launch (~5 minutes, no reading):

- Send a message, watch a tool run, flip Plan/Build once via Shift+Tab,
  run `/quota`, see the footer counts move.
- Skippable (`--no-intro`), re-runnable (`/intro`), never blocks.
- Footer hints stay as the persistent reminder layer.

Tests: scripted walkthrough completes headlessly; skip/rerun flags work.

### 2. Login and failure UX (never stranded)

- Token-expiry guidance: when Spark rejects the token mid-session, say
  exactly what died and give the 3-step fix (`learningcode --login`
  without echo, same rule as today — never in the input box).
- `doctor --fix`: repair common broken states (stale token cache,
  mis-scoped models, outdated install), not just diagnose them.
- Every failure mode speaks student language: what happened, what to
  do, how long to wait. Seat queue position with estimate ("you're #3,
  ~2 min"), quota-exhausted with reset time, relay-down with retry.
- No stack traces reach students. Ever.

Tests: each failure path driven with stubs, asserting the message
contains cause + action + wait.

### 3. Never lose work (resume and persistence)

- [x] Auto-checkpoint sessions; dropped lab Wi-Fi must not eat homework.
      (Pi checkpoints the transcript each turn; the checklist is now
      checkpointed too — 0.9.0.)
- [x] Checklist persistence: plan todos survive resume/session switch.
      Visible "session restored" confirm on re-entry. (0.9.0)
- [x] `/undo` coverage audit: the agent's own file changes are recoverable
      and `/undo` says so, listing what it will restore/remove. (0.9.1)

Tests: kill-and-resume round trip preserves transcript + checklist;
undo matrix over the mutating tools.

### 4. Plan mode as curriculum (training wheels) — DONE

- [x] Plan templates for common assignments (`/plan explain-bug`,
  `/plan implement-fn`): pre-shaped prompts that teach *how* to plan,
  not just what to type. (0.10.0)
- [x] Optional strict preset (student- or lab-configured): plan must exist
  and be approved before any edit tool unblocks. Off by default;
  training wheels, not handcuffs. `/plan strict on|off` for the student,
  `LEARNINGCODE_PLAN_STRICT` for a lab (overrides and cannot be toggled
  off in-session). Approval is checkpointed with the checklist. (0.11.0)
- Reuses 0.7 machinery: checklist, footer counts, `/approve`, BUILD
  progress. No new tracking layer.

Tests: template expansion (done); strict-mode block/unblock transitions,
env-pinned labs, and approval-across-resume (done).

### 5. Phone as a real client (remote parity) — DONE

- [x] End-to-end verification from a phone: login → quota → plan →
  approve → read output, start to finish, on a small screen.
- [x] Every 0.7/0.8 command (`/todo`, `/approve`, `/quota`, `/seats`)
  confirmed reachable and readable through the RPC bridge text path.
  (0.12.0)
- [x] Fix what the walkthrough found. Two real gaps, both fixed:
  - **A handled command never settled the turn.** Pi answers an
    extension command over RPC with `disposition: "handled"` and
    starts no run, so no `agent_start`/`agent_settled` ever followed.
    The phone set itself "working" when it echoed the line and then
    span forever, with Stop lit, after every `/quota` or `/todo`. The
    bridge now emits `command_done` on a handled prompt; the phone
    settles quietly (no done chime — a command is not an answer).
  - **Command output was a status blip, not readable text.** Notes
    rendered through the centred, one-line `activity` style with no
    `pre-wrap`, so a multi-line `/todos` collapsed into a run-on
    sentence, and every note was clipped to 300 characters. Notes now
    render as a left-aligned block that keeps its line breaks, and the
    notify ceiling is raised to 2000 (still bounded and redacted).

Tests: bridge-level walkthrough asserting text output per step (done) —
`test/remote-bridge.test.mjs` drives the phone through every command and
asserts the echoed line, the readable note, and the settle; the sanitizer
and web-ui suites cover the raised bound and the new rendering.


### 6. Speed (latency is the experience) — DONE

- [x] Measured cold startup and cut the one thing in front of it. The
  launcher's own bootstrap is short (`--version` lands in ~90–150ms: module
  load, parse, config), but the Spark reachability preflight blocked on a
  network round-trip before spawning Pi: ~900ms against a healthy gateway
  from the test machine, up to its full 5s request timeout on a bad one —
  all of it before a prompt appeared. The preflight now runs under a 350ms
  budget (`lib/startup.mjs`, `withinBudget`); a slow probe is abandoned and
  the first request, plus the `/quota` and `/seats` errors, report a real
  outage in plain words. (0.13.0)
- [x] Budget asserted in the suite the way `installer.test.mjs` asserts the
  Node floor: `test/startup.test.mjs` checks the cold start against
  `STARTUP_BUDGET_MS`, the preflight against `STARTUP_HEALTH_BUDGET_MS`
  (which must sit below `CHECK_TIMEOUT_MS`), unit-tests `withinBudget` for
  the slow/fast/failing cases, and structurally bans a bare
  `await checkEndpoint(` from creeping back.
- First-token time and seat-queue fairness are gateway-side: model latency
  and Spark's own queue, not launcher work. The one launcher-side lever —
  the preflight — is now bounded; nothing else on the path waits on the
  network.

Tests: `test/startup.test.mjs`.

### 7. Sub-agent interface (helpers) — DONE

- [x] A `subagent` **tool** (model-only — no `/` command) that delegates a
  job to a fresh, isolated context and returns a compressed answer. Three
  modes with Pi's semantics: `single`, `parallel`, `chain` (`{previous}`
  placeholder). (0.14.0)
- [x] **Hard gate on the active provider** (`ctx.model.provider`, read live):
  helpers run on every provider **except TLC-Spark**, which enforces one
  active generation per student. Enforced twice — removed from the active set
  while Spark is the model, and re-checked at call time so a mid-session
  `/model` switch cannot slip past.
- [x] **Shipped agents only** in v1: four curated helpers (`scout`,
  `reviewer`, `planner`, `worker`) discovered from the package's own
  `agents/` directory. Read-only by default; no project- or user-local agent
  files, so a classroom repo cannot inject one.
- [x] **Never lose work holds**: a helper's file edits are journalled into the
  *parent's* session journal via `LEARNINGCODE_UNDO_SESSION`, so `/undo`
  recovers them. `undo-record.ts` (child) and `checkpoint.ts` (parent) share
  one recorder so they cannot drift.
- [x] Student language throughout: live `🔎 scout is working…`, result
  `✓ scout: found 4 files`, failures as one sentence. No usage, cost, exit
  codes, stderr, or JSON.

Tests: `test/subagent-gate.test.mjs`, `subagent-agents.test.mjs`,
`subagent-child.test.mjs`, `subagent-render.test.mjs`,
`subagent-run.test.mjs`, `subagent-extension.test.mjs`,
`undo-record.test.mjs`; the real-Pi child handshake is covered by the opt-in
`test/subagent-e2e.test.mjs` (`npm run test:e2e`).

## Non-goals (deferred past 0.8)

Teacher dashboard, spend caps/kill-switch, session logging review, new
models/providers, IDE extensions, background agents, live mid-turn
progress widgets.

## Rollout

Build 1–6 in order → `npm test` → commit → push → tag `v0.8.0` →
CHANGELOG + README → publish. Staged student pilot before calling it
launched: one lab group first, failure-mode reports back, then wide.
