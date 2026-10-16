# LearningCode 0.8 — student-first launch readiness

Status: **in progress — 0.8.x hardened; workstream 3 (never lose work) is
done as of 0.9.2; workstream 4 (plan templates + strict preset) done as of
0.11.0; workstreams 5–6 remain.** Audience: students,
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

### 5. Phone as a real client (remote parity)

- End-to-end verification from a phone: login → quota → plan →
  approve → read output, start to finish, on a small screen.
- Every 0.7/0.8 command (`/todo`, `/approve`, `/quota`, `/seats`)
  confirmed reachable and readable through the RPC bridge text path.
- Fix what the walkthrough finds; the phone is some students' only
  computer, so parity gaps are launch blockers, not polish.

Tests: bridge-level walkthrough asserting text output per step.

### 6. Speed (latency is the experience)

- Budgets: cold startup time, first-token time, seat-queue fairness on
  shared lab networks. Measure first, then cut.
- No feature in 0.8 may regress startup; the test suite asserts the
  budget the way `installer.test.mjs` asserts the Node floor today.

## Non-goals (deferred past 0.8)

Teacher dashboard, spend caps/kill-switch, session logging review, new
models/providers, IDE extensions, background agents, live mid-turn
progress widgets.

## Rollout

Build 1–6 in order → `npm test` → commit → push → tag `v0.8.0` →
CHANGELOG + README → publish. Staged student pilot before calling it
launched: one lab group first, failure-mode reports back, then wide.
