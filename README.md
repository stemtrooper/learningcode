# learningcode

A terminal coding agent for **The Learning Curve** students, running on TLC's own
inference through **TLC-Spark**.

`learningcode` is a purpose-built client for the TLC-Spark token plan. It is not a
general-purpose AI coding tool: the model, the quota and the seat limits all belong
to TLC, and every token you spend comes out of your course allocation.

---

## You will need a TLC-Spark token

`learningcode` cannot reach a model on its own. It connects to the TLC-Spark
gateway, which checks who you are and whether you are allowed to use it right now.

**Ask your teacher for a Spark API token.** In the Spark bench, go to
**Issue / rotate token**. The token is shown **once** and cannot be retrieved
afterwards, so copy it immediately. It looks like `spark_live_…`.

Without a token, `learningcode` will not start a conversation. That is by design:
there is no shared school key and no fallback to somebody else's account.

---

## Requirements

| | |
|---|---|
| **Node.js** | **22.19.0 or newer** (24.x LTS recommended) |
| **Disk** | about 120 MB |
| **Network** | must reach `spark.learning.com.my` |
| **Token** | your personal `spark_live_…` from the Spark bench |
| **Terminal** | 51+ columns for the banner; 99+ for the large one |

Node 22.19 is the floor because the underlying agent runtime requires it. If you
install Node and `npm i` only *warns*, check `node --version` — an older Node
produces a confusing error later rather than at install time.

---

## Install

### Windows (PowerShell)

```powershell
node --version
npm install -g @stemtrooper/learningcode
learningcode --version
```

If PowerShell refuses to run the command because script execution is disabled:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### macOS / Linux

```bash
node --version
npm install -g @stemtrooper/learningcode
learningcode --version
```

### Termux (Android)

No root and no `proot-distro` needed.

```bash
pkg install nodejs-lts npm
node --version
npm install -g @stemtrooper/learningcode
learningcode --version
```

Install `npm` explicitly: Termux stopped bundling it with Node at 25.3.0.
Prefer `nodejs-lts` (24.x) over `nodejs` (26.x).

---

## First run

```bash
cd ~/your-project
learningcode
```

It asks for your Spark token, stores it with owner-only permissions in
`~/.learningcode/agent/spark-token`, and writes its configuration. The token is
only ever read from your own machine.

You now have an agent that can read files, run shell commands, and edit code in
the directory you started it from. **It runs those commands on your machine, as
you.** Nothing runs on a microcontroller, and Spark never executes anything on
your behalf.

---

## Using it

Type a request in plain language.

```
write a function that reads notes.txt and returns the average resistance
why does my ESP32 reset when I power the servo
explain this error: "Brown detector failed"
```

Useful commands, typed inside the session:

| Command | What it does |
|---|---|
| `/help` | list everything available |
| `/quota` | your token spend today |
| `/seats` | how many seats are free |
| `/spark-login` | check your TLC-Spark token, or find out how to get a new one |
| `/model` | switch model |
| `/hotkeys` | keyboard shortcuts |

`/quota`, `/seats` and `/spark-login` talk to Spark directly. They are the commands a
stock AI coding tool does not have, because those endpoints are not part of any
public API.

**Getting a new TLC-Spark token.** Use `/spark-login` to check the one you have;
it tells you whether Spark still accepts it. To actually replace it, exit and run
`learningcode --login`, which prompts without echoing. It is deliberately *not* a
`/` command: typing a token into the agent's own input box would leave it in your
scrollback, which is the wrong thing to do on a shared lab machine.

One-off, non-interactive:

```bash
learningcode -p "explain main.py"
learningcode -c                    # continue your last session
learningcode --mode json           # machine-readable output
```

---

## What it looks like

The TLC brand theme and banner ship with the package, so there is nothing to
configure.

```
  ██╗     ███████╗ █████╗ ██████╗ ███╗   ██╗██╗███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
  ██║     ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██║     █████╗  ███████║██████╔╝██╔██╗ ██║██║██╔██╗ ██║██║  ███╗██║     ██║   ██║██║  ██║█████╗
  ██║     ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
  ███████╗███████╗██║  ██║██║  ██║██║ ╚████║██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
  ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
  The Learning Curve · Sarawak
```

On a narrower terminal it steps down to a condensed banner, then to the wordmark,
rather than drawing art that would be clipped.

A footer shows your remaining quota whenever you are connected to Spark:

```
  █████░░░░░ 50%  125k / 250k today
```

---

## Troubleshooting

**`Node 22.19.0 or newer is required`**
Upgrade Node, then reinstall: `npm i -g @stemtrooper/learningcode`.

**`No Spark API token configured`**
You do not have a token yet, or it is not cached. Run `learningcode --login` to
enter a new one. If you never had one, ask your teacher.

**`Token rejected (401)`**
The token is wrong, or it was rotated and the old one no longer works.
`learningcode --login`.

**`AI off — ask your teacher` / `AI disabled for your account`**
Spark has AI switched off for your account — usually a timetable window or a
policy setting. This is not something you can fix.

**`You already have a generation running`**
Spark allows one active generation per student. Stop the running one first.

**`Every seat is taken` / queue position**
All seats are busy. `learningcode` prints your position; try again shortly.

**The banner looks like plain text**
Your terminal is narrower than 51 columns. Widen it.

---

## Configuration

Everything lives in `~/.learningcode/agent/`. Nothing is uploaded anywhere except
to Spark, and no telemetry is sent.

| Variable | Purpose |
|---|---|
| `LEARNINGCODE_DIR` | config location (default `~/.learningcode/agent`) |
| `LEARNINGCODE_SPARK_BASE_URL` | point at a different Spark deployment |
| `LEARNINGCODE_TOKEN` | supply a token without using the cached file |
| `LEARNINGCODE_THEME` | `tlc-dark` (default), `tlc-light`, or any Pi theme |
| `LEARNINGCODE_PI_FLAGS` | extra flags passed to the agent on every launch |

```bash
learningcode --show-config     # show resolved paths and settings
learningcode --login           # enter a new token
learningcode --list-models     # every reachable model
learningcode --theme dark      # use the upstream theme instead of TLC's
```

**Your edits are kept.** If you change the theme or the model configuration,
upgrading `learningcode` will not overwrite your copy.

---

## For educators

<details>
<summary>Running a local Spark, and other model providers</summary>

**Local bench.** `learningcode --base-url http://localhost:3000/v1` points the
client at a Spark running on your own machine, for demos without spending course
quota.

**Other providers.** Any `--model` other than `tlc-spark/…` skips the Spark token
and health check entirely:

```bash
export OPENCODE_API_KEY=...
learningcode --model opencode-go/glm-5.3-flash
```

This uses **your own** provider account and **your own** credits, with no Spark
quota, seat limit or audit trail. `learningcode` deliberately excludes OpenCode
Zen, which bills per token, so a stale entry cannot silently spend money. It is
still not something to hand to students.

**Seat awareness.** Spark enforces one active generation per student, so the
client runs strictly serially with subagents off. Expect a 429 rather than
parallel fan-out.

</details>

---

## How it works

`learningcode` is a thin wrapper around [Pi](https://github.com/earendil-works/pi),
an open-source coding agent by Mario Zechner. It adds the TLC-Spark provider
configuration, the TLC theme and banner, and the quota and seat commands.

The underlying model is **Qwen3.8-27B**, served through TLC-Spark. Every turn is a
separate request, takes a seat, and spends quota — an agent session that reads ten
files costs roughly eleven turns. That is why the footer exists.

Pi is pinned to an exact version on purpose: the runtime ships breaking changes
often, and a student's install must not change underneath them mid-term.

## Licence

MIT. `learningcode` is distributed under the MIT licence and depends on Pi, which
is also MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to Pi, OpenCode, Anomaly, or any of
the model providers reachable through this client. "The Learning Curve", TLC and
Spark are trademarks of The Learning Curve.