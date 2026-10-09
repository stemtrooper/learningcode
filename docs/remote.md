# LearningCode Remote — design

Status: implemented. The vertical slice — phone message to agent and back, with
reconnect — is covered by `test/remote-e2e.test.mjs` (`npm run test:e2e`), which
runs in CI on all three platforms. Future work is listed at the bottom.
Update this file as decisions change.

## Goal

Continue and control an existing LearningCode session from a phone, without
moving code execution off the student's machine. The computer runs the agent,
the filesystem, the shell, Git, arduino-cli and the USB link. The phone is a
remote client and nothing more.

## What already exists (and is reused)

| Existing piece | Reused as |
|---|---|
| `bin/learningcode.mjs` launcher | gains `remote` / `remote-server` subcommands; its own-flag parsing and env setup are shared, not copied |
| Pi's `--mode rpc` | the agent integration point. JSON lines on stdin/stdout, `prompt`/`steer`/`abort`/`get_messages`/`switch_session`, and the same `AgentSessionEvent` stream the TUI renders |
| `SessionManager` JSONL sessions | remote conversations *are* Pi sessions under `~/.learningcode/agent/sessions/…`, so `learningcode -c` on the terminal and the phone show the same history |
| `LEARNINGCODE_*` env + `agentDir()` | the only configuration surface. Remote adds env vars in the same family |
| `node:test` suite | every new module gets tests; the WebSocket path is tested against a real server on an ephemeral port |

## Shape

```text
 Phone (mobile browser, vanilla JS + WebSocket)
   │  attach with sessionId + token
   ▼
 Remote server  ── enroll key ──▶ student computer
   │ session registry, auth,        │ outbound WebSocket only
   │ routing, presence              ▼
   │                          learningcode remote
   │                                │ spawns
   │                                ▼
   │                          Pi --mode rpc (child process)
   │                                │ AgentSessionEvent stream
   └────────────────────────────────┘
```

The computer always initiates the connection. Nothing is exposed inbound, no
SSH, no public port on the student's machine.

## Why not the exported `RpcClient`

`@earendil-works/pi-coding-agent` exports an `RpcClient`, but its bundle spawns
the literal program name `node`. On Windows that only works when `node` is on
PATH, and the whole point of the install script is that it might not be. So
`lib/remote/agent.mjs` speaks the same JSONL protocol but spawns
`process.execPath` with the resolved bundle path, the same trick
`bin/learningcode.mjs:158` already documents. The adapter keeps RpcClient's
method names so swapping back is a one-line change.

## Protocol

Versioned, JSON, one object per frame. Deliberately *not* Pi's event union on
the wire: the phone sees `agent.event` frames with a small allowlisted shape,
so Pi internals can change without breaking the UI. Unknown `type` values are
rejected rather than ignored, so a mismatch fails loudly.

Agent ⇄ server (agent connects first):

```text
agent → server : hello { protocol, sessionId, enrollKey, client }
                 event { type: "agent.event", event }
                 snapshot { messages }
                 pong { t }
server → agent : welcome { sessionId, phones }
                 phone_message { text, id }
                 control { action: "abort" | "stop" }
                 ping { t }
```

Phone ⇄ server:

```text
phone → server : attach { sessionId, token }
                 message { text }
                 abort
server → phone : attached { session }
                 event { type: "agent.event", event }
                 history { messages }
                 presence { computer: "online" | "offline", phone }
                 error { message }
```

## Security model

- **No inbound access to the student machine.** Outbound WebSocket only.
- **Enrollment key** (`LEARNINGCODE_REMOTE_KEY`) gates session registration on
  the server. In local development the server generates one and prints it.
- **Per-session phone token**: 256 bits from `crypto.randomBytes`, stored by
  the *server* only as `sha256(salt ‖ token)` with a per-session salt, compared
  with `timingSafeEqual`. The computer keeps the token in
  `~/.learningcode/agent/remote-token` with mode `0600`, the same treatment
  `lib/token.mjs:22` gives the Spark token.
- **The token travels in the URL fragment** (`…/#/s/<id>?t=<token>`) so it stays
  out of server logs and `Referer` headers; the server sees it once, inside the
  attach frame.
- **Session IDs are 128-bit random** and never derived from the student, the
  project name or a counter; there is nothing to guess or enumerate.
- **Per-session authorization**: a token opens exactly one session. Attach rate
  limiting per IP (a handful of attempts, then a lockout) makes online guessing
  pointless.
- **Secrets never cross the wire.** Every agent event passes through a
  sanitizer that allowlists fields, truncates them, and redacts
  `spark_live_…`-shaped values. A test asserts no Spark token or enroll key can
  appear in any frame.
- The server binds to loopback unless `LEARNINGCODE_REMOTE_HOST` is set
  explicitly, and prints a warning when it binds beyond loopback without TLS.

## Sessions and persistence

- A session record holds `sessionId`, token hash + salt, `createdAt`,
  `lastSeen`, `meta` (project name, cwd, platform, learningcode version).
- Phone disconnects: nothing happens to the agent. The session stays
  `computer: online`; the phone reattaches with the same token and gets the
  conversation replayed from `get_messages`.
- Computer reconnects: the outbound WebSocket re-dials with exponential backoff
  and jitter; queued phone messages flush on reconnect. The agent process stays
  alive across phone disconnects, so the conversation and the Pi session file
  continue untouched.
- Computer exits (crash, reboot, `remote stop`): the session is marked
  `computer: offline` on the server. Returning to the project and running
  `learningcode remote` again re-enrolls the same session id (stored locally)
  and resumes the same Pi session, so the next phone message continues where the
  conversation left off rather than starting a new one.

## Failure cases and answers

| Case | Behaviour |
|---|---|
| Phone network drop | UI shows reconnecting; reattach replays history; agent unaffected |
| Computer network drop | Bridge re-dials with backoff + jitter; phone sees `computer: offline` |
| Server restart | Session records are persisted to disk; phones reattach, computer re-enrolls |
| Agent crash | Bridge reports `agent.event { type: "error" }`, exits non-zero; `remote stop`/re-run resumes the Pi session |
| Duplicate phone | Second attach for the same session kicks the first socket; both see `presence` |
| Duplicate computer | Second enroll for the same session id rejects the previous socket |
| Expired token | `remote --rotate` mints a new token; the old hash is dropped, old links die |

## Scaling notes (not built now)

The registry is the only stateful piece and it is already behind a Map with a
documented interface, so it can move to Redis or a database without touching
the protocol. Fan-out per session is O(phones), and phones per session are few.

## Deliberately not in the MVP

Diff view, file browser, terminal, share-with-teacher, multiple sessions per
student, push notifications. The protocol carries `type` strings precisely so
these can arrive later without a redesign.
