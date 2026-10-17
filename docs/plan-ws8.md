# WS8 — Student-owned quota pacing ("save some for later")

**Status:** shipped — 0.15.0. Built as planned, with one deviation: the phone
needed **no new `labels.mjs` code**. The estimate and the reserve stop are
delivered through `ctx.ui.notify`, which the existing sanitiser already
forwards as a `note` and the existing bound already admits, so the plan's
"add a label path" step became a bridge test proving the reserve stop reaches
the phone with its `/pace reserve off` escape hatch intact.

Two details changed in review. The stop is gated on the active provider
(`tlc-spark` only) and judges `bash` per command, so read-only wrap-up
(`git status`, `npm test`) still runs while `edit`/`write`/`powershell` stop —
the earlier blanket `bash` block was both too wide and, on Windows, too narrow.
And the block sets `terminate: true`, so Pi ends the batch instead of the model
retrying the refused call. The estimate also subtracts only the spend since its
quota snapshot and re-baselines on `/compact`, so a resume cannot double-count.

**Placement:** first feature of the 0.15 line, after WS7 shipped (0.14.0/0.14.1).
**Audience:** students. Same rule as ever — student language, no stack traces.

---

## 1. Decision

Turn the footer's raw token numbers into two honest things a student can act on:

- **"about N more steps today"** — a plain-language estimate of how much work
  the remaining Spark quota buys, derived from what this session has actually
  spent per turn.
- **a reserve** — a student-set number of steps to keep in the tank. When the
  estimate reaches it, the agent stops *before* the next change and says so,
  instead of running the day's quota to zero mid-assignment.

Running dry mid-assignment is the worst recurring student day, and Spark — the
primary provider, one active generation per student — cannot use the 0.14
helpers to save context. So efficiency *on Spark itself* is the highest-value
gap left on the board.

### Why this is not the deferred "spend caps / kill-switch"

`docs/plan-0.8.md` defers an **adult** spend cap and kill-switch. WS8 is the
opposite thing, and the line must be said out loud:

| | Deferred (adult) | WS8 (student) |
|---|---|---|
| Who sets it | teacher / lab, remotely | the student, locally, right now |
| Kind | **hard** cap, cannot be lifted | **soft** reserve, `/pace reserve off` lifts it instantly |
| Purpose | control spend across a class | don't get stranded mid-homework |
| Failure mode it fixes | cost overrun | a dead session at 11pm |

WS8 adds no telemetry, no dashboard, and nothing a teacher can see. If a
feature here would let an adult cap a student without the student's say-so, it
is out of scope and belongs to the deferred adult work.

---

## 2. Goals / non-goals

**Goals**
- A pure estimate: remaining daily tokens ÷ observed tokens-per-step → an
  approximate step count, never a promise.
- `/pace` to show the estimate, set the reserve (`reserve <n>`), and lift it
  (`reserve off`).
- The reserve stops the agent cleanly at a **tool boundary** — checkpointing
  stays intact, so `/undo` still recovers everything.
- Footer shows the same estimate and reserve state, no extra network.
- The phone can read the estimate and the stop in one line.
- Everything in student language.

**Non-goals (v1)**
- No adult cap, no kill-switch, no remote/teacher control (see §1).
- No estimate off Spark, where there is no daily limit to measure against —
  `/pace` says so plainly.
- No per-turn quota fetch (WS6: latency is the experience).
- No new provider or model.
- No guarantee, no countdown clock, no per-tool quota math.

---

## 3. The estimate (load-bearing rule)

**The unit is steps, not dollars, on Spark.** Dollars stay off-Spark only,
where they are already priced by `sessionSpend` and the model catalog. A
student on Spark cannot act on "$0.014"; they can act on "about 6 more steps".

Pure function in a new `lib/pace.mjs`:

```
stepsLeft({ remainingTokens, mathPerStep, reserve })
  -> approximate, always rounded DOWN, null when there is no honest answer
```

Honesty rules (each one is a test in §8):
- **No history → conservative default.** A fresh session has no observed
  cost; assume a deliberately pessimistic per-step figure rather than
  flattering the student.
- **No limit → `null`, never `0`.** `dailyTokenLimit` absent, `0`, or
  `quotaExempt === true` means there is no ceiling; show "no daily limit", not
  "0 steps".
- **Round down, say "about".** The rendered line is always approximate, so it
  can never read as a promise.
- **AI off / quota already gone → plain words,** from a dedicated string, not
  a computed `0`.

Observed per-step cost comes from the **same usage harvest the footer already
does** (`sessionSpend` splits per-call usage over assistant `message` entries
and standalone `usage` entries). To stop the two drifting, the harvest moves
to a shared home (`lib/pace.mjs`, or a small `lib/spend.mjs` if it reads
cleaner) and `extensions/footer.ts` imports it — the same "cannot drift" rule
WS7 used for `checkpoint.ts` / `undo-record.ts`. This refactor touches shipped,
tested code and must keep `test/learningcode.test.mjs` green.

---

## 4. Behaviour

**`/pace` (new command)**

| Input | Result |
|---|---|
| `/pace` | Estimate + reserve line: `about 9 more steps today · reserve 3` |
| `/pace reserve 3` | Keep 3 steps in reserve (student-set, local) |
| `/pace reserve off` | Lift the reserve immediately — always available |
| off Spark | `No daily limit on this model — nothing to pace.` |
| exempt / unlimited | `Unlimited today — no need to pace.` |

**`/quota` (existing, extended)** — appends the pace line to `quotaLine`'s
output instead of a second command, so the student sees spend and meaning
together.

**The stop.** On `tool_call`, when the estimate is at or below the reserve and
the tool would **change files** (`edit`, `write`, `bash`), return
`{ block: true, reason }` — the same hook `plan-mode.ts` uses. Read-only tools
stay allowed, so the agent can wrap up and summarise. The reason must tell the
**model** to stop and summarise, because a blocked `tool_call` does not halt
generation (see risk 1):

> "You are saving the last N steps for later. Stop now and tell the student
> what is finished and what is left. They can run `/pace reserve off` to keep
> going."

In student language on screen:

> "You asked to keep ~3 steps for later, so I stopped before changing files.
> Run `/pace reserve off` to keep going, or `/pace` to see where you are."

---

## 5. Code map

```
extensions/pace.ts        # /pace command + tool_call reserve stop
lib/pace.mjs              # pure: stepsLeft, format, reserve resolution, lines
lib/settings.mjs          # readPaceReserve / setPaceReserve (mirror plan strict)
extensions/spark-quota.ts # /quota appends the pace line
extensions/footer.ts      # reuse the shared harvest; show steps-left + reserve
lib/remote/labels.mjs     # one-line label for the estimate and the stop
lib/remote/sanitize.mjs   # let that line through under the bound
lib/pi.mjs                # add pace.ts to PI_EXTENSIONS
docs/plan-0.8.md          # dated note distinguishing soft reserve from adult cap
```

**Reuse**
- `lib/settings.mjs`: the `PLAN_STRICT_KEY` / `readPlanStrict` /
  `setPlanStrict` trio is the exact shape for the reserve.
- `extensions/plan-mode.ts:352` is the `tool_call` → `{ block, reason }`
  pattern to copy.
- `extensions/footer.ts` `format(quota)` and its width tiers (< 52 col) are
  where the new segment drops in; `fetchQuota` stays the only quota call.
- `lib/failure.mjs` voice for the not-enough / no-token cases.

**Settings.** `PACE_RESERVE_KEY = "paceReserve"` in `settings.json`, a small
non-negative integer or `0` for off. Env pin `LEARNINGCODE_PACE_RESERVE`
mirrors `LEARNINGCODE_PLAN_STRICT`: a lab may set a floor, the student may
raise the reserve but not lower it past the pin, and `reserve off` is refused
while the pin holds. Default remains **off**.

---

## 6. Test plan

Pure (no Pi), `test/pace.test.mjs`:
- no history → conservative default, never flattering.
- no limit / `dailyTokenLimit: 0` / `quotaExempt` → `null`, and the rendered
  line never says "0 steps".
- limit reached → plain wording from the dedicated string.
- always rounded down; two different histories produce different estimates.
- `reserve > stepsLeft`; env pin parses; a nonsense pin is ignored.
- no dollars anywhere on Spark.

Settings, `test/settings.test.mjs`: reserve round-trips; off clears it;
env pin cannot be undercut in-session; reserve-off refused under a pin.

Extension, `test/pace-extension.test.mjs`: `/pace` output for each row in §4;
block emitted at the reserve for `edit`/`write`/`bash`; **no** block for
read-only tools; no stack, cost, or JSON in any message.

Registration, `test/features.test.mjs`: `pace.ts` is in `PI_EXTENSIONS`.

Quota + footer, `test/learningcode.test.mjs`: `/quota` carries the pace line
(through `_internals`), and the footer renders steps-left + reserve without a
second fetch.

Phone, `test/remote-bridge.test.mjs`: estimate and reserve stop each reach the
phone as one readable line, under the sanitiser bound.

Integration (opt-in, like `remote-e2e`), `test/pace-e2e.test.mjs`, wired into
`scripts/test-e2e.mjs`: a stub-provider session with a low reserve stops before
a write, the student sees one sentence, and `/undo` shows nothing was lost.

---

## 7. Rollout and versioning

- Ship as the first 0.15.0 feature, after WS7.
- Add the dated revision note to `docs/plan-0.8.md` (§1 of this plan), beside
  the existing WS7 revision note, so the deferred "spend caps" wording is not
  silently contradicted.
- `lib/` and `extensions/` are already in `package.json` `files`; no packaging
  change needed (unlike WS7's `agents/` gap).
- New README section ("Saving quota: about N more steps") + a Troubleshooting
  entry for the reserve stop; CHANGELOG entry; version bump — same release
  ritual as every prior version.
- `npm test` green and `npm audit --omit=dev --audit-level=high` clean before
  publish, as always.

---

## 8. Locked decisions

1. **Steps, not dollars, on Spark.** Dollars stay off-Spark, where they are
   already priced.
2. **Reserve ships default off.** If a stop reads as frustrating in the pilot,
   the feature is cut, not tuned forever.
3. **Stop at a `tool_call` boundary, never by killing Pi** — so checkpointing
   and `/undo` keep every byte of work.
4. **No per-turn quota fetch.** Reuse the `session_start` snapshot and local
   session usage; the WS6 latency rule still binds.
5. **"About N" is always approximate** (round down), so it can never read as a
   guarantee.

---

## 9. Open questions / risks

1. **Blocking a `tool_call` does not halt the model's generation.** The reason
   string must explicitly tell the model to stop and summarise; a silent block
   invites a retry loop. Watch this in the pilot.
2. **Hook composition with `plan-mode.ts` and `approval.ts`.** All three can
   block `tool_call`; their reasons must not swallow each other. Verify the
   combined path, and keep the reserve reason distinguishable from plan/strict.
3. **`sessionSpend` refactor blast radius.** Moving the usage harvest out of
   `footer.ts` touches shipped, tested code; `test/learningcode.test.mjs` must
   stay green and the two call sites must share one implementation.
4. **A too-high reserve frustrates students** and a too-low one does nothing.
   Default-off plus one-lab pilot tuning is the mitigation; revisit after real
   use.
5. **"Steps left" misread as a guarantee.** Wording ("about") and rounding down
   are the only guardrails; if a student reports being surprised by the stop,
   the estimate is the bug, not the reserve.
