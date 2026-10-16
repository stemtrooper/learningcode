# LearningCode audit — 0.9.x

Full code audit run 2026-10-16, after the 0.9.2 release. Scope: everything a
student actually runs — `bin/learningcode.mjs`, `lib/**` (including the remote
relay), `extensions/**`, the CI workflow, and the published-file list.

Method: read the whole of the highest-risk modules (remote auth/sanitizer/
server, approval, undo journal, provider seeding, settings, argument parsing),
then grepped the tree for the usual rot — swallowed errors, unbounded network,
`error.stack`, injection surfaces, dead exports, `JSON.parse` without a guard,
leftover `console.*`/`TODO`s.

Baseline at audit time: 268 tests, 267 pass, 1 skip, 0 fail. After the P1 fixes
below: 272 tests. After the P2 fixes (0.9.4): 280 tests, 279 pass, 1 skip, 0 fail.
After the P3 fixes (0.9.5): 286 tests, 285 pass, 1 skip, 0 fail.

Severity key: **P1** = a student can hit it on a normal day (correctness, safety,
or a stated product rule); **P2** = real but narrower (robustness, abuse of an
authenticated path, supply chain); **P3** = polish or a deliberate trade-off
worth naming.

---

## P1 — fixed in this change (0.9.3)

### P1.1 Stack traces could reach a student
`bin/learningcode.mjs` (top-level `main().catch`) printed `error.stack` for
anything that was not a `UserError`. The roadmap forbids this, full stop: a Pi
spawn failure, a provider returning malformed JSON, or a bug in our own code
would dump a Node stack into a student's terminal.

Fixed by moving the rule into a pure, tested helper — `fatalMessage(error, env)`
in `lib/failure.mjs` — which returns `error.message` and only returns the stack
when `LEARNINGCODE_DEBUG=1`. Tests: `test/failure.test.mjs`.

### P1.2 Spark calls had no timeout
`extensions/spark-quota.ts` (`call()`) and `extensions/footer.ts` (`fetchQuota()`)
called `fetch` with no `signal`. On a flaky school network a stalled socket:
- held up the `session_start` quota check (`await call("/me/quota")` never
  settled, so session start could appear to hang);
- left `/quota` and `/seats` spinning with no output;
- left the footer's `refresh()` promise dangling.

Fixed with an 8-second `AbortSignal.timeout(...)`, and a `TimeoutError` mapped to
the plain phrase "timed out". `call()` takes an injectable `fetchImpl`/`timeoutMs`
so the path is testable without a real wait. Tests: `test/learningcode.test.mjs`.

---

## P2 — fixed in 0.9.4

### P2.1 Per-frame rate limiting is documented but not enforced
`lib/remote/protocol.mjs` documents `LIMITS.frameRate` as "frames accepted per
socket per second", and `lib/remote/server.mjs` says "every socket is rate
limited". In fact `#rateOk` was called **only once, at connection**; the
`message` handlers never consulted it, so an authenticated phone could send
unbounded frames, every one forwarded to the shared agent.
**Fixed:** `#onAgent`/`#onPhone` now check `#rateOk` on every frame and close
(1008) past the ceiling. Test: `test/remote-server.test.mjs`.

### P2.2 `x-forwarded-for` was trusted unconditionally
`lib/remote/server.mjs` (`ipOf`) preferred `x-forwarded-for` with no check that a
proxy sat in front. On the `--no-tunnel`/LAN path — or any host without a proxy —
a client could forge the header to reset its own rate window and dodge the
`${ip}:${sessionId}` attach lockout.
**Fixed:** `x-forwarded-for` is honoured only when the immediate peer is loopback
(cloudflared connects from 127.0.0.1) or when an operator sets
`LEARNINGCODE_REMOTE_TRUST_PROXY=1` for a proxy on another host. Test:
`test/remote-auth.test.mjs`.

### P2.3 cloudflared was downloaded without an integrity check
`lib/remote/cloudflared.mjs` pinned the release tag and used HTTPS, but wrote the
downloaded bytes, `chmod 755`'d them, and ran them with no checksum.
**Fixed:** the download is verified against the SHA-256 GitHub publishes for the
asset (via the release API) before anything is written; a mismatch is fatal and
says so. When GitHub exposes no digest (older release, API rate limit) the
install proceeds as before rather than being blocked. Tests:
`test/remote-cloudflared.test.mjs`.

---

## P3 — cleared in 0.9.5

### P3.1 Frame direction is not enforced
`AGENT_FRAMES`/`PHONE_FRAMES` are exported from `protocol.mjs` but were unused; a
frame valid for one side was silently dropped (`default: return`) on the other,
contradicting the module's own "reject, never ignore" doctrine.
**Fixed:** `#onAgent`/`#onPhone` reject a frame the sender's side may not send
with an `error` frame and a 1008 close. Tests: `test/remote-server.test.mjs`.

### P3.2 Footer polls can overlap
`setInterval(refresh, POLL_MS)` (`footer.ts`) fired regardless of an in-flight
refresh, so a slow Spark could stack requests.
**Fixed:** an in-flight guard makes the poll skip a tick rather than stack.

### P3.3 The ≥80% startup warning omits the reset
**Fixed:** the warning (`spark-quota.ts`) now names the reset through
`quotaResetLine()`, so a student near the limit knows when it comes back.

### P3.4 Config files use the default umask
`models.json`, `settings.json`, and `keybindings.json` were written without an
explicit mode.
**Fixed:** all three are written `0600` (with a `chmod` for files created
before), matching tokens and remote state. The contents are not secrets, but the
agent dir now has one rule.

### P3.5 Undo restores absolute paths from the manifest
`restoreJournal` trusted each recorded path; a tampered manifest could touch a
file outside the project.
**Fixed:** `recordChange` declines a target outside the project `cwd`, and
`restoreJournal` skips any legacy manifest entry that names one. Tests:
`test/undo-journal.test.mjs`.

### P3.6 Only the first destructive kind is reported
`destructiveMatch()` returned the first pattern that hit, so a compound command
reported and remembered only one danger.
**Fixed:** `destructiveMatches()` reports every kind, the prompt names them all
("deletes files, runs as administrator"), and "Always allow" stores each. A later
command is skipped only when every danger it carries is already allowed. Tests:
`test/approval.test.mjs`, `test/approval-always.test.mjs`.

### P3.7 No dependency vulnerability scan in CI
**Fixed:** the workflow runs `npm audit --omit=dev --audit-level=high` on every
run, and `.github/dependabot.yml` keeps npm and GitHub Actions current weekly.

---

## Checked and found sound

- **Remote authentication** (`lib/remote/tokens.mjs`, `sessions.mjs`): salted
  SHA-256 token hashes (never cleartext at rest), `timingSafeEqual` with a
  deliberate length tolerance so a mismatch is not an oracle, per-`ip:session`
  lockout, and an identical "no such session, or the wrong link" reply that
  leaks nothing about which sessions exist.
- **Outbound sanitizer** (`lib/remote/sanitize.mjs`): allowlist, not denylist;
  credential redaction (`spark_live_…`, `Bearer …`, `key=value`); hard length
  caps on every field; conversation history reduced to text.
- **Mobile web client** (`lib/remote/web-ui.mjs`): every piece of untrusted
  content is written with `textContent`; the only `innerHTML` writes are static
  literals. No XSS path found.
- **State parsing**: every `JSON.parse` on a state file is inside a `try` that
  degrades to "start empty", never a crash.
- **Argument parsing / `--port`**: value-less flags are rejected with a sentence,
  not a `RangeError` stack.
- **Hygiene**: no leftover `console.*`, `TODO`, `FIXME`, or `@ts-ignore` in
  `lib/`, `bin/`, or `extensions/`.

## Fixed alongside this audit

- **ExpLabs provider** (`lib/explabs.mjs`, `bin/learningcode.mjs`, `README.md`):
  endpoint corrected to `https://api.experientiallabs.ai/v1`, real key page and
  `xpl_` key shape, and the invented `qwen3.8-max` slug replaced with the real
  `qwen3.8-27b`. Verified against the live catalog on 2026-10-16 and guarded by
  a test. The model list, context windows, reasoning flags and prices now come
  from that catalog (`GET /api/models`), fetched at login and cached beside
  `models.json`, with the built-in list only as an offline fallback — so a launch
  makes no network request.
- **Weekly reset time**: `/quota` (and the quota line) now state
  `resets Fri 00:00 (in …)`, computed by a pure `quotaResetLine()` in
  `lib/failure.mjs`.
