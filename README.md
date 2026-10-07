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

## Banner

The LEARNINGCODE block banner replaces Pi's header at startup:

```
  ██╗     ███████╗ █████╗ ██████╗ ███╗   ██╗██╗███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
  ██║     ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██║     █████╗  ███████║██████╔╝██╔██╗ ██║██║██╔██╗ ██║██║  ███╗██║     ██║   ██║██║  ██║█████╗
  ██║     ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
  ███████╗███████╗██║  ██║██║  ██║██║ ╚████║██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
  ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
  ═════════════════════════════════════════════════════════════════════════════════════════════════
  The Learning Curve · Sarawak
  /help commands · /quota today's spend · /hotkeys keys
```

The figlet "ANSI Shadow" face, 97 columns wide, kept verbatim because the
double-line box characters only align if every row keeps its exact offset.

Colour comes from the active theme, so it stays legible in light and dark.

**It needs a 99 column terminal.** Below that it collapses to a wordmark,
rather than drawing art that would be clipped into something that looks broken.
An 80 column terminal will show the compact form, so widen the window or reduce
the art.

It installs via `ctx.ui.setHeader`, the supported way to brand a fork.

## Other providers

Any `--model` other than `tlc-spark/...` skips the Spark token and the Spark
health check, so you can work while Spark is down:

```bash
export OPENCODE_API_KEY=...
learningcode --model opencode-go/glm-5.3-flash
```

**OpenCode Zen is excluded.** Zen and Go share one `OPENCODE_API_KEY`, so leaving
that variable in place authenticates both and exposes Zen's 111 pay-per-use models
alongside the 29 a Go subscription covers, at up to $20/M output. learningcode
moves the key into Pi's `auth.json` under `opencode-go` alone, which leaves Zen
credential-less so it never registers. Set `LEARNINGCODE_ALLOW_ZEN=1` to opt in.

## Theme

Two TLC themes ship with the package and are seeded into
`~/.learningcode/agent/themes/` on first run:

| Theme | Accent | Sampled from |
|---|---|---|
| `tlc-dark` | `#29c8f2` | `TLC_BLACKBGND.png` |
| `tlc-light` | `#0dacd6` | `TLC_WHITEBGND.png` |

The values are read out of the logo pixels, not eyeballed. The logo ships two
cyans because the darker one has to hold contrast on a white field, which maps
exactly onto Pi's light/dark split.

A seeded theme is **never overwritten**, so an edit survives upgrades. Override
the default with `--theme`, or `LEARNINGCODE_THEME=tlc-light`. To try Pi's own:

```bash
learningcode --theme dark
```

28 of Pi's 56 colour tokens are re-tinted: the accent, borders, greys, markdown,
syntax highlighting, diff colours, selected backgrounds, and the thinking-level
ramp. Semantic colours (red, green, yellow) are left alone, because those mean
error, success and warning rather than anything about the brand. The thinking ramp
runs grey to cyan and keeps red at the top, where it still means "this is getting
expensive".

The banner does **not** follow the theme. It uses the brand cyan directly, the way
Pi's own logo does, because a wordmark that changes colour with whatever theme is
active stops being a wordmark. It picks the right one of the two cyans from the
terminal's colour mode.

## Footer

While connected to Spark, a footer shows today's token spend:

```
  █████░░░░░ 50%  125k / 250k today
```

Spark's quota endpoint is not part of the OpenAI API, so no stock harness shows
this. It polls at most every two minutes, since Spark allows one active
generation per student and a per-turn refresh would add latency to the thing the
student is waiting on. When AI is switched off for an account the footer says so
instead of showing a bar.

Off Spark, or with no token, it says so rather than drawing an empty bar that would
read as "you have spent nothing".

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