# Sub-agents (helpers)

**Status:** shipped (0.14.0).
**Audience:** students see the *behaviour*; this file is the build-facing design.

A **helper** is a job handed to a fresh, separate agent process with its own
context window. The main agent stays small; the helper reads the pile of files
the job needs and returns one short answer. The main agent never has to carry
that reading in its own conversation.

The model reaches helpers through a single tool, `subagent`. There is no `/`
command and no picker: the model decides when a job is worth delegating, the
same way it decides to call `read` or `bash`.

---

## Why, and the one hard rule

Pi has no first-class sub-agents, but ships a reference extension that spawns a
separate `pi` process per helper over JSON lines, in three modes: **single**,
**parallel**, **chain**. We take that shape and gate it.

**The gate: helpers run on every provider _except_ TLC-Spark.**

TLC-Spark enforces one active generation per student. Fanning out to several
helpers at once — or even running one while the parent waits — spends the
student's quota on a wall of 429s. Off Spark the student is on their own
provider key, where the constraint does not apply, so full parity is safe.

The gate is read from the **active provider** (`ctx.model.provider`), live at
call time — never parsed out of the model id, which can contain slashes
(`river/deepseek-ai/…`). It is enforced twice:

1. **Visibility.** At `session_start` and on every `model_select`, the tool is
   added to or removed from the active set, so the model does not even see it on
   Spark. This is best-effort and keeps a `/model` switch in step.
2. **Authority.** Every call re-checks the provider before spawning. On Spark it
   returns a plain refusal — no child, no throw. A per-agent `model:` override
   that pointed at Spark refuses the *whole* run (a mixed run is more confusing
   than a clean no).

---

## The helpers

Shipped with the package (`agents/*.md`), curated, and read-only by default:

| Helper | Job | Tools |
|---|---|---|
| `scout` | Look around and report what is where | read, grep, find, ls |
| `reviewer` | Second opinion: what is wrong or risky | read, grep, find, ls |
| `planner` | Turn a goal into ordered steps | read, grep, find, ls |
| `worker` | Do one scoped piece of work | read, grep, find, ls, bash, edit, write |

Only `worker` can change files, and only `worker` reaches a shell.

**Shipped-only in v1.** There is no project-local or user-local agent directory:
a classroom repo cannot smuggle in an agent definition, which removes Pi's whole
prompt-injection surface for helpers. An unknown tool name in a shipped
definition is a loud error, not a silent drop.

---

## Modes

```
{ "agent": "scout", "task": "…" }                    // single
{ "tasks": [ { "agent": "scout", "task": "…" }, … ] } // parallel
{ "chain": [ { "agent": "scout", "task": "… {previous} …" }, … ] } // chain
```

- **Parallel** runs up to **6** jobs, at most **3** at once. Lower than Pi's
  8/4 default: gentler on provider rate limits and on the journal writers below.
- **Chain** runs in order; a later task may use `{previous}` for the answer
  before it.
- Per-helper model-visible output is capped (8 KB) so a chatty helper cannot
  blow up the parent's context. The full text stays in the tool details
  (Ctrl+O).

---

## How a helper runs

Each helper is a separate `pi` process:

```
--mode json -p --no-session
--model  <inherited active model | agent override>
--thinking <inherited active thinking level>
--tools  <agent tools | read-only default>
--append-system-prompt <agent body>
[--extension <abs>/extensions/approval.ts]     # only if the helper may bash/edit/write
[--extension <abs>/extensions/undo-record.ts]  # only if the helper may edit/write
```

- **No TUI extensions.** The child does not reuse the interactive flag set — no
  footer, banner, cat, quota, or theme. Those belong to a terminal session, not
  a `-p` child.
- `--no-session` keeps the child out of Pi's session store, so the parent's
  transcript is never polluted.
- The parser is pinned to what Pi 1.3.0 emits: `message_end` (authoritative),
  `tool_execution_end`, `agent_settled`. Pi's own example still listens for
  `tool_result_end`, which 1.3.0 no longer sends; do not copy that line.

---

## Never lose work (undo)

The journal (`lib/undo-journal.mjs`) is keyed by **session id**
(`agentDir/undo/<sessionId>`) and records a file's pre-state from a `tool_call`
hook on `edit`/`write`. A `--no-session` child has no session id and is a
separate process, so its edits would be invisible to `/undo` — a regression of
the "never lose work" rule.

The bridge:

- `undo-record.ts` is the recording half of `checkpoint.ts` (no `/undo`
  command). It resolves the session id from **`LEARNINGCODE_UNDO_SESSION`** when
  set, else from `ctx.sessionManager`.
- The parent puts its **own** session id in that variable, so the child records
  into `agentDir/undo/<parentSessionId>` — the same journal the parent's
  `/undo` reads, under the same `cwd` boundary.
- `checkpoint.ts` imports the same recorder, so the parent and child paths
  cannot drift.

A `worker` helper's change is therefore recoverable by the student's `/undo`,
exactly like the main agent's own edits.

**Accepted v1 caveat:** `recordChange` is a best-effort read-modify-write of the
manifest. Two parallel `worker`s touching the *same* file could race on it.
Read-only helpers (the common parallel case) never touch it. If it ever bites:
serialise journal writes behind a lock file, or merge snapshots in the parent
after the run.

---

## What a student sees

Student language throughout; no usage, cost, exit codes, stderr, or JSON.

- **Collapsed:** a live line — `🔎 scout is working…` — then a result line,
  `✓ scout: found 4 files`, or parallel progress `2/3 done`.
- **Expanded (Ctrl+O):** the task and the helper's full answer.
- **Failure:** one sentence naming the helper —
  `scout couldn't finish — it hit an error.`
- **On Spark:** the tool is hidden; if it is somehow called, the student gets
  "Helpers need a model that can run more than one answer at a time. TLC-Spark
  runs one at a time. Switch with `/model` to use them."

---

## Code map

```
extensions/subagent.ts        # registers the tool + renderer + Spark visibility
extensions/undo-record.ts     # child-only: journals edits into the parent journal
lib/subagent/gate.mjs         # subagentsAllowed / modelIsSpark / refusal text
lib/subagent/agents.mjs       # shipped-agent discovery, frontmatter, tool scoping
lib/subagent/child.mjs        # argv/env builder, spawn, JSON-lines parse, concurrency
lib/subagent/run.mjs          # orchestration (modes, gate, undo session) — testable
lib/subagent/render.mjs       # runs -> student-language strings
lib/active-model.mjs          # activeModelId / activeProviderId (shared with footer)
agents/*.md                   # the four shipped helpers
```

Tests: `test/subagent-*.test.mjs` (pure + extension, in `npm test`) and
`test/subagent-e2e.test.mjs` (opt-in via `npm run test:e2e`).
