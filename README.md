# learningcode

A terminal coding agent for TLC students, wired to [Spark](../spark) — the
inference gateway that holds per-student tokens, timetable policy, seat limits
and weekly quota.

Students run one command:

```bash
npm i -g @stemtrooper/learningcode
learningcode
```

On first run it asks for the personal `spark_live_` token from the Spark bench,
caches it with `0600`, writes the TLC-Spark provider config, and hands off to
Pi with the model pinned.

```
baseURL  https://spark.learning.com.my/v1
model    TLC-Spark
```

## What students get

Pi's four built-in tools — `read`, `bash`, `edit`, `write` — against
Qwen3.8-27B. Two extra commands, because Spark is not a plain OpenAI endpoint:

| Command | Why it exists |
|---|---|
| `/quota` | Tokens used against today's limit, and whether AI is enabled for your account |
| `/seats` | Live seat queue, so a student can see why a turn is waiting |

`session_start` also warns once if you cross 80% of your daily quota or if a
teacher has switched AI off for your account.

## Why not just ship Pi?

Because Spark's limits are the design constraint, not the model:

- **32K max context, 16K default.** Agent sessions burn this fast. `learningcode`
  starts Pi with `--no-skills`, since skills are pure prompt-token spend.
- **One active generation per student.** Subagents and parallel tool calls would
  only earn `429`s. Pi is serial by default and this wrapper does not turn that off.
- **250K tokens per week.** Frugality is the product, so the budget is visible
  instead of mysterious.

Stock Pi does not know `/v1/me/quota` or `/v1/queue` exist. That gap is the whole
reason this wrapper exists.

## Configuration

`~/.learningcode/agent/models.json` is created on first run and **never
overwritten** — local edits survive upgrades. The provider is seeded with these
compatibility flags, each of which matches a field Spark either rejects or drops:

| Flag | Value | Spark behaviour |
|---|---|---|
| `supportsDeveloperRole` | `false` | message union is `system \| user \| assistant \| tool`; there is no `developer` |
| `maxTokensField` | `"max_tokens"` | `v1.ts` reads `body.max_tokens` only |
| `supportsReasoningEffort` | `false` | not forwarded to the runtime |
| `supportsStore` | `false` | not implemented |

Environment variables:

| Variable | Purpose |
|---|---|
| `LEARNINGCODE_DIR` | agent directory (default `~/.learningcode/agent`) |
| `LEARNINGCODE_SPARK_BASE_URL` | point at another Spark deployment |
| `LEARNINGCODE_TOKEN` | Spark token, skips the cached file |
| `LEARNINGCODE_PI_FLAGS` | extra flags appended to every launch |

```bash
learningcode --show-config      # resolved paths, model, token prefix
learningcode --base-url http://localhost:3000/v1   # local bench
learningcode --login            # re-enter a rotated token
learningcode -c                 # continue last session
learningcode -p "explain main.py"
learningcode --mode json        # machine-readable event stream
```

Anything not listed as a `learningcode` flag is passed straight to Pi.

## Pinning

`@earendil-works/pi-coding-agent` is pinned to an exact version, not a range. Pi
ships breaking changes daily, and a student's install must not change underneath
them mid-term. Bump it deliberately, after testing against a live pod.

## Licence

MIT. Depends on Pi, also MIT. See [LICENSE](LICENSE).