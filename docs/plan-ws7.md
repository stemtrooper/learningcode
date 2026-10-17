# WS7 — Sub-agent interface

**Status:** shipped — 0.14.0. Built as planned; two notes changed in the doing:
the child does **not** pass `--no-skills` (it is not in the child argv — skills
are already off in a `-p` run, and the flag is unnecessary), and the "best-effort
visibility" layer also listens to `model_select` so a `/model` switch in either
direction keeps the active set in step. Live verification: a `scout` child, a
`worker` child whose edit landed in the parent journal, and a two-helper
parallel run all succeeded against a real provider off Spark; the Spark gate is
unit-tested (the dev token was expired for a live Spark call).

**Follow-up shipped in 0.14.1:** helper names and one-line results now reach the
phone and the computer console (`lib/remote/labels.mjs`, wired through
`sanitize.mjs`). Custom tool renderers are TUI/HTML-export only, so the remote
path had to derive its own label; see the "What a student sees" section below.
**Placement:** post-0.8. First feature of the 0.9 line, **after** WS5 (phone parity)
and WS6 (speed budgets) land.
**Audience:** students. Same rule as ever — student language, no stack traces.

---

## 1. Decision and roadmap revision

Pi has **no first-class sub-agent feature**, but ships a full reference extension
(`node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/`)
that spawns a separate `pi` process per sub-agent with an isolated context
window, in three modes: **single**, **parallel**, and **chain**.

We adopt **full parity** with that shape, with one hard gate: it runs on every
provider **except TLC-Spark**.

This **revises a locked 0.8 decision.** `docs/plan-0.8.md` says:

> No capability breadth. No new models, IDE plugins, background agents, or
> subagent machinery. 0.8 is trust and friction, not power.

That lock was correct for 0.8. WS7 is a deliberate, post-0.8 reversal, and the
plan must say so in the same file (a dated note under "Locked decisions") rather
than let the document silently contradict itself.

### Why Spark is gated out

TLC-Spark enforces **one active generation per student**. Two places already
state the client is deliberately serial because of it:

- `bin/learningcode.mjs:566` — "Spark enforces one active generation per
  student, so subagents and parallel tool calls would only earn 429s."
- `README.md:469` — "the client runs strictly serially with subagents off."

Parallel/chain sub-agents fan out to N generations at once; on Spark that is a
wall of 429s and burned student time. Off Spark, the student is on their own
provider key and the constraint does not apply — so full parity is safe there.

---

## 2. Goals / non-goals

**Goals**
- A `subagent` **tool** (model-only — no user-facing command, per decision #4)
  that delegates a task to a fresh, isolated context and returns a compressed
  result.
- Three modes with Pi's semantics: `single`, `parallel`, `chain` (`{previous}`
  placeholder).
- Shipped, curated agents only in v1 (decision #3).
- Child file edits are **recoverable by `/undo`** (decision #1).
- Everything the student sees is translated into student language.

**Non-goals (v1)**
- No project-local or user-local agent files (see §6).
- No `/helpers` command, no agent picker UI.
- No new provider; the child inherits the parent's model by default.

---

## 3. Model gate (the load-bearing rule)

Gate on the **active provider**, not a string guess.

- Source of truth: **`ctx.model.provider`**, read live at call time. That is the
  same live session model the footer renders (`extensions/footer.ts:186`
  `activeModelId(ctx)` reads `ctx.model`) and the same handle Pi's own subagent
  example uses for its dispatch defaults (`ctx.model` → `provider/id`). Do
  **not** parse the provider out of the model id — `river/deepseek-ai/…` has two
  slashes, and ids are not stable.
- Extract the lookup out of `footer.ts` into a shared module
  (`lib/active-model.mjs`): `activeModelId(ctx)` and `activeProviderId(ctx)`.
  `footer.ts` re-exports `activeModelId` for compatibility; the gate uses
  `activeProviderId`.

**Behaviour**

| Active provider | Result |
|---|---|
| `tlc-spark` (`PROVIDER_ID`, `lib/config.mjs:15`) | Tool unavailable |
| any other provider | Full parity |

Two layers:
1. **Authoritative at call time.** If Spark, return a refusal — never a spawn,
   never a throw. Student language:
   > "Helpers need a model that can run more than one answer at a time.
   > TLC-Spark runs one at a time. Switch with `/model` to use helpers."
2. **Best-effort visibility.** At `session_start`, drop the tool from the active
   set via `pi.setActiveTools` when Spark is active, so the model does not even
   try. Re-check at every call (the model can change mid-session via `/model`).

**Per-agent `model:` overrides must not smuggle Spark.** A parallel/chain run
mixes agents; validate *every* resolved child model against the gate before
spawning anything. If any child would land on `tlc-spark`, refuse the whole run
(the mixed case is more confusing than a partial run).

---

## 4. Architecture

```
extensions/subagent.ts        # registers the `subagent` tool + renderer
extensions/undo-record.ts     # child-only: journals edit/write into the parent journal
lib/subagent/gate.mjs         # subagentsAllowed(providerId) + refusal text
lib/subagent/agents.mjs       # shipped-agent discovery + frontmatter parsing + tool scoping
lib/subagent/child.mjs        # child argv/env builder, spawn, JSON-lines parse
lib/subagent/render.mjs       # child events -> student-language lines
lib/active-model.mjs          # extracted provider/model resolution (shared w/ footer)
agents/*.md                   # shipped agent definitions (like extensions/)
docs/subagents.md             # design + safety (this plan, build-facing)
```

**Reuse**
- `lib/pi.mjs`: `resolvePiEntry`, `agentEnvironment`.
- **Do not reuse `forcedPiArgs` wholesale** — it loads the eleven TUI
  extensions (`footer`, `banner`, `orange-cat`, `whats-new`, `intro`,
  `done-sound`, `spark-quota`, …), none of which belong in a
  `--mode json -p` child.
- `extensions/approval.ts` — headless fail-closed already implemented
  (`approval.ts:44`: no UI → `{ block: true, reason: "… and there is no one to
  confirm it." }`). This is our destructive-command safety net in children.

---

## 5. Child invocation

```
--mode json -p --no-session
--model  <inherited active model | agent override>
--thinking <inherited active thinking level>
--tools  <agent tools | read-only default>
--append-system-prompt <tmp file: agent body + guardrails>
--no-skills
[--extension <abs>/extensions/approval.ts]     # only if agent may bash/edit/write
[--extension <abs>/extensions/undo-record.ts]  # only if agent may edit/write
```

- No theme flags, no interactive extensions.
- `--no-session` keeps the child out of Pi's session store; the parent
  transcript is never polluted.
- Env: `{ ...process.env, ...agentEnvironment({ dir, token }) }`, plus the undo
  bridge variable in §7. No Spark token is needed (Spark is gated out).

### Child output (JSON lines) — verified against Pi 1.3.0

`-p --mode json` writes one JSON object per line. The parser is pinned to what
1.3.0 actually sends (`docs/json.md`), **not** to Pi's example, which tracks an
older wire shape:

- first line `{"type":"session",…}` — header; ignore it.
- `{"type":"message_end","message":{…}}` — the **authoritative** message. Take
  assistant text, `usage`, `model`, `stopReason`, and `errorMessage` from here,
  and count one turn per assistant `message_end`.
- `{"type":"tool_execution_end",…}` — a tool finished. (Pi's example listens for
  `tool_result_end`; 1.3.0 no longer emits it. Do not copy that line.)
- `{"type":"agent_settled",…}` — Pi has no remaining automatic work; treat it as
  the completion signal.
- Only `message_end` feeds the student-facing output; every other event type is
  ignored without erroring.

### Child extension policy

| Extension | In child? | Why |
|---|---|---|
| `approval.ts` | For bash/edit/write agents | Fail-closed destructive blocking |
| `undo-record.ts` | For edit/write agents | Journal child edits into the parent journal (§7) |
| `footer`, `banner`, `orange-cat`, `whats-new` | No | TUI only |
| `intro`, `done-sound`, `spark-quota` | No | TUI / Spark-specific |
| `plan-mode` | No | Child is a worker, not a planner |
| `checkpoint` | No | `/undo` is a parent command; children only record |
| `run-tests` | No (v1) | Keep the child surface minimal |

---

## 6. Agents — shipped only (v1)

Markdown + YAML frontmatter, discovered from the package's `agents/` directory
only. Same schema as Pi's example (`name`, `description`, `tools`, `model`,
optional `thinking`), but every agent ships with us and is written in student
language.

| Agent | Purpose | Tools | Model |
|---|---|---|---|
| `scout` | Look around, report what's where | `read, grep, find, ls` | inherited |
| `reviewer` | Second opinion on work so far | `read, grep, find, ls` | inherited |
| `planner` | Turn a goal into ordered steps | `read, grep, find, ls` | inherited |
| `worker` | Do a scoped chunk of work | full default | inherited |

Rules enforced by `agents.mjs`:
- **Read-only is the default.** `bash`/`edit`/`write` only when the shipped
  agent names them.
- Reject unknown tool names in frontmatter (typo → loud, not silent).
- No project-local `.pi/agents` or user agent dirs in v1 (decision #3). This
  removes Pi's prompt-injection surface: a classroom repo cannot smuggle an
  agent file.

The tool description lists the available agents so the model knows what it can
call. Discovery is fresh per invocation (agents editable without restart).

---

## 7. Undo integration (locked: yes)

The journal (`lib/undo-journal.mjs`) is keyed by **session id**
(`agentDir/undo/<sessionId>`) and only records pre-states from a `tool_call`
hook on `edit`/`write` (`extensions/checkpoint.ts:24`). A `--no-session` child
has no session id and a separate process, so **child edits would be invisible to
`/undo` — a WS3 "never lose work" regression.** Fix:

- New **`extensions/undo-record.ts`**: the recording half of `checkpoint.ts`
  only (the `edit`/`write` `tool_call` hook), no `/undo` command.
- It resolves the session id from **`LEARNINGCODE_UNDO_SESSION`** (env) when set,
  falling back to `ctx.sessionManager` otherwise.
- The parent passes its own session id in that env var, so the child records
  into `agentDir/undo/<parentSessionId>` — the same journal the parent's
  `/undo` reads. `cwd` and the `within(base, abs)` boundary are the parent's,
  so child edits are journalled under the same project scope.
- `checkpoint.ts` (parent) is refactored to import the same recorder so the two
  cannot drift.

**Known caveat (accept in v1):** `recordChange` is a read-modify-write of the
manifest and is best-effort. Parallel `worker` children touching the *same*
file could race on the manifest. Read-only agents (the common parallel case)
never touch it. Mitigation if it bites: serialize journal writes behind a lock
file, or snapshot-merge in the parent after the run.

---

## 8. Concurrency (locked: 6/3)

- `MAX_TASKS = 6` (total per tool call).
- `MAX_CONCURRENCY = 3` (in flight at once).
- Lower than Pi's 8/4 default: gentler on provider rate limits, fewer concurrent
  journal writers (§7).
- Per-task model-visible output capped (Pi uses 50 KB); full results stay in tool
  details for the expanded view.

---

## 9. Tool surface (model-only)

`subagent` tool parameters (mirrors Pi, trimmed to our caps):

```jsonc
// single
{ "agent": "scout", "task": "…" }
// parallel
{ "tasks": [ { "agent": "scout", "task": "…" }, … ] }   // <= 6, <= 3 concurrent
// chain
{ "chain": [ { "agent": "scout", "task": "… {previous} …" }, … ] }
```

- No student command or shortcut (decision #4).
- Abort (Ctrl+C) propagates to kill child processes, as in Pi's example.

---

## 10. Rendering / student language

A custom tool renderer. The Pi example's usage line
(`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:…`) is exactly what we
must **not** show.

- **Collapsed:** one live line — e.g. `🔎 scout is looking around…`, then
  `✓ scout: found 4 files`. Parallel shows `2/3 done, 1 running`.
- **Expanded (Ctrl+O):** full task text and the agent's final answer, still
  student-phrased.
- **Failures:** translate to one sentence + agent name
  (`scout couldn't finish — it hit an error.`). Never surface child stderr, exit
  codes, JSON, usage, or cost.

---

## 11. Test plan

Pure (no Pi):
- `gate.mjs`: Spark provider → refusal text and **no spawn**; each non-Spark
  provider → allowed; mixed-model chain with a Spark child → refused.
- `agents.mjs`: discovery from the shipped dir; frontmatter parse; read-only
  default; unknown tool names rejected; no project/user dirs read.
- `child.mjs`: argv has exactly the expected flags and **no TUI extensions**;
  `approval.ts` present only for bash/edit/write agents; `undo-record.ts` present
  only for edit/write agents; `LEARNINGCODE_UNDO_SESSION` set to the parent id.
- `render.mjs`: child events → student lines; usage/cost never appear; crash →
  single sentence, no stack.

Extension:
- `subagent` tool refuses on Spark, runs on others (stub spawn).
- Hiding: tool absent from the active set when Spark is active at
  `session_start`.

Integration (opt-in, like `remote-e2e`):
- One sequential `scout` child against a stub provider returns compressed output.
- A `worker` child edit appears in the parent's journal, and `/undo` restores it.

---

## 12. Rollout and versioning

- Ship as the **first 0.9.0 feature**, after WS5/WS6.
- Add the dated revision note to `docs/plan-0.8.md` (§1).
- Add `"agents"` to `package.json` `files`. It is not there today, so without
  this the shipped agent definitions never reach the published tarball and §6
  discovery silently finds nothing on a fresh global install.
- New `docs/subagents.md` (design + safety), a README section, a CHANGELOG
  entry, and the version bump — same release ritual as every prior version.
- `npm audit` clean and the full suite green before publish, as always.

---

## 13. Open questions / risks

1. **Journal race under parallel `worker`s** (§7) — accept best-effort in v1;
   serialise writes only if observed.
2. **Refactor blast radius** — moving `activeModelId` out of `footer.ts` and
   splitting the recorder out of `checkpoint.ts` touch shipped, tested code;
   both need their existing tests to stay green.
3. **RESOLVED — `--no-session` + JSON mode.** Pi 1.3.0 documents the shape in
   `docs/json.md`, and every flag the child needs exists in `--help`
   (`--mode json`, `-p`, `--no-session`, `--tools`, `--thinking`,
   `--append-system-prompt`, `--no-skills`). The parser is pinned in §5 to
   `message_end` (authoritative) + `tool_execution_end` + `agent_settled`. The
   one trap: Pi's example still listens for `tool_result_end`, which this
   version does not emit — do not copy that line.
4. **Provider rate limits off Spark** — 6/3 is a guess; revisit after real use.
