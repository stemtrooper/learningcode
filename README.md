```text
██╗     ███████╗ █████╗ ██████╗ ███╗   ██╗██╗███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗
██║     ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║████╗  ██║██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     █████╗  ███████║██████╔╝██╔██╗ ██║██║██╔██╗ ██║██║  ███╗██║     ██║   ██║██║  ██║█████╗
██║     ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝
███████╗███████╗██║  ██║██║  ██║██║ ╚████║██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

*The Learning Curve · Sarawak*

Follow on X: [@stemtrooper](https://x.com/stemtrooper) · [@ruffleseed](https://x.com/ruffleseed)

A terminal coding agent for **The Learning Curve** students, running on TLC's own
inference through **TLC-Spark**.

`learningcode` is a purpose-built client for the TLC-Spark token plan. It is not a
general-purpose AI coding tool: the model, the quota and the seat limits all belong
to TLC, and every token you spend comes out of your course allocation.

> **New in 0.13.0** — learningcode starts without waiting on a network check.
> The Spark reachability preflight now runs under a small budget, so a slow
> network no longer holds up your prompt. See [Changelog](#changelog).

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
| **Disk** | about 120 MB, plus ~80 MB if the one-line installer has to fetch Node |
| **Network** | must reach `spark.learning.com.my` |
| **Token** | your personal `spark_live_…` from the Spark bench |
| **Terminal** | 51+ columns for the banner; 99+ for the large one |

Node 22.19 is the floor because the underlying agent runtime requires it. If you
install Node and `npm i` only *warns*, check `node --version` — an older Node
produces a confusing error later rather than at install time.

---

## Install

### One line (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/stemtrooper/learningcode/main/install.sh | bash
```

The installer checks Node first. If yours is 22.19.0 or newer it uses it; if it
is missing or too old, it fetches a private LTS build into
`~/.learningcode/node` and puts it ahead of the old one on your PATH. Either
way the package itself is installed with npm into `~/.learningcode/prefix`, a
directory you own, and that prefix is added to your `~/.bashrc` or `~/.zshrc`
between marker comments.

No `sudo`, no `apt`, no changes to your system Python/Node packages. Open a new
terminal when it finishes, then `learningcode --version`.

Read the script before running it, as you should with anything piped into a
shell. Prefer installing by hand, or want to pin a version? The regular
instructions are below.

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

`node --version` must report **22.19.0 or newer**. If it is older — and
Ubuntu's own `apt` package is usually Node 18 — install a current one first:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
nvm alias default 24
```

**If the install fails with a permissions error**, npm's global directory belongs
to root. Move it somewhere you own, then install again:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc

npm install -g @stemtrooper/learningcode
```

The last line is what makes `learningcode` visible in future terminals; without
it you will think the install failed.

**Do not use `sudo npm install -g`.** It appears to work, then writes
root-owned files that break your next upgrade with a confusing error.

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

## LearningCode Remote

Continue and steer a session from your phone. The agent keeps running on your
computer, with its filesystem, shell, Git and USB devices; the phone is a remote
for it.

**Start it, in your project folder:**

```bash
learningcode remote
```

The first run downloads cloudflared once, into `~/.learningcode/bin`. After that
it starts straight away and prints a QR code. Point your phone camera at it and
open the page. The text link is printed under the code in case the camera
struggles.

The phone can reach your session from any network. To keep it on your own wifi
only, use `learningcode remote --no-tunnel`.

**Continue an existing conversation** (quit the interactive session first):

```bash
learningcode remote --resume
```

`--resume` continues this project's last conversation. Without it, the phone
starts a new thread.

Nothing is exposed inbound: your computer opens the connection to the relay, so
the phone can only reach a session your computer has announced.

### Using it

The phone shows your project, the model in use, whether the computer is online,
and the conversation so far. Messages stream as they arrive, and tool runs show
as one line each (`running bash…` / `done bash`). Tap the model name to switch
models; the list shows only the models your computer can reach, grouped by
provider. Tap **Stop** to halt a running turn.

Closing the browser loses nothing. Reconnect and the same conversation is there.

```bash
learningcode remote status    # what is running, and from which directory
learningcode remote rotate    # cancel every old phone link at once
learningcode remote stop      # stop the session
```

**The phone link is a password** for the session. Anyone holding it can send
messages to the agent. Run `learningcode remote rotate` if it is shared by
mistake. The computer must stay on with the command running: when that terminal
closes, the phone loses the session. The conversation itself is kept, so
`--resume` brings it back.

### Running your own relay

The relay server is included, so a class or a lab can run its own. It keeps the
session registry and nothing else: it cannot run a command on anyone's machine,
and it never sees a file from a student's computer.

```bash
learningcode remote-server          # prints the URLs and the enrolment key
```

Then, on the computer:

```bash
LEARNINGCODE_REMOTE_SERVER=ws://192.168.1.10:8787/agent \
LEARNINGCODE_REMOTE_KEY=<the key the server printed> \
learningcode remote
```

Bind it beyond loopback only on a trusted network, or behind TLS — the default
bind is `127.0.0.1` deliberately.

### How it is put together

`learningcode remote` runs the same Pi agent as an interactive session, in RPC
mode: a headless child process that speaks JSON lines on stdin/stdout. The
bridge carries phone messages down that pipe and streams agent events back up
through the relay, after passing them through a sanitiser that allowlists fields
and redacts anything shaped like a token. Sessions are Pi's own session files,
so `learningcode -c` in the terminal and the phone show the same history.

The full design, including the protocol and the security model, is in
[docs/remote.md](docs/remote.md).

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
| `/plan` | toggle Plan / Build mode (`shift+tab`) — plan without touching anything; `/plan <template>` starts a guided plan; `/plan strict on\|off` sets the strict preset |
| `/approve` | approve the plan and start building, checklist carried along |
| `/pace` | save a few steps of today's quota for later (`/pace reserve 3`, `/pace reserve off`) |
| `/todo` | manage the checklist: `add <text> \| done <n> \| clear` |
| `/todos` | show the full plan checklist |
| `/intro` | replay the 5-minute guided tour (`--no-intro` skips it) |

`/plan strict on` turns on the optional strict preset: editing stays locked in
Build until you make a plan and approve it with `/approve`. It is off by default
and `/plan strict off` turns it off; a lab can pin it on for a shared machine
with `LEARNINGCODE_PLAN_STRICT=1` (the student cannot toggle that off in-session).

`/pace` shows about how many more steps today and can keep a few back: with
`/pace reserve 3` the assistant stops before changing files once only three
steps remain, so you keep something for later instead of running the day's Spark
quota to zero mid-assignment. `/pace reserve off` lifts it instantly, and
`/quota` shows the same estimate. The count always rounds down and is
approximate. This is Spark-only, where the daily quota lives; a lab may pin a
minimum with `LEARNINGCODE_PACE_RESERVE`, and even then you can raise the
reserve — never lower it past the pin. The reserve is yours: it is off by
default and no teacher can set a hard cap with it.

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

When you quit a session, it prints a line starting `To resume this session:`.
That line comes from Pi and shows `pi --session ...`. Use `learningcode -c`
instead; it continues the same conversation.

---

## Helpers for big jobs

Sometimes a job means reading a dozen files before one small question can be
answered — and all that reading fills the assistant's own memory, making it
slower and vaguer as the session goes on. The assistant can hand that kind of
job to a **helper**: a fresh copy of itself with its own clean memory, which
does the reading and returns a few lines.

You do not summon a helper by hand — the assistant decides, the same way it
decides to open a file. When it does, you see which helper ran and a one-line
result, and **Ctrl+O** opens the full answer. Four helpers ship with the
package:

| Helper | Job |
|---|---|
| `scout` | look around and report what's where |
| `reviewer` | a second opinion on work so far |
| `planner` | turn a goal into ordered steps |
| `worker` | do one small, complete piece of work |

The assistant can run several helpers at once, or pass one helper's answer to
the next in a chain. Anything a helper changes is recorded like the assistant's
own edits, so **`/undo`** puts it back — a helper cannot lose your work.

Helpers need a model that can run more than one answer at a time. TLC-Spark
serves one generation per student, so helpers stay **off** there; switch with
`/model` to a provider of your own to use them. See
[docs/subagents.md](docs/subagents.md) for the design and the safety rules.

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

LearningCode suppresses Pi's built-in startup header so its own banner appears
without the Pi logo flashing first. Use `learningcode --verbose` to show Pi's
startup header and loaded-resource list as well. An explicit `quietStartup`
setting in `~/.learningcode/agent/settings.json` is respected.

A footer shows your remaining quota whenever you are connected to Spark:

```
  █████░░░░░ 50%  125k / 250k today
```

Quota-exempt accounts show `unlimited`. An account with no daily token cap but
still subject to a weekly cap shows `no daily token cap` instead; Spark reports
those as different states, and the client must not mistake a missing daily
limit for either zero allowance or unlimited use.

---

## Troubleshooting

**`The curl | bash installer failed`**
The installer prints the failing step to stderr. Open a new terminal first: if
it just installed its own Node, the PATH change only reaches new shells. If it
still fails, install by hand with the npm steps above, and paste the
installer's output to whoever supports your lab.

**`Node 22.19.0 or newer is required`**
Upgrade Node, then reinstall: `npm i -g @stemtrooper/learningcode`. On Linux this
is usually the first thing to check, because Ubuntu ships Node 18 — see
[macOS / Linux](#macos--linux).

**`No Spark API token configured`**
You do not have a token yet, or it is not cached. Run `learningcode --login` to
enter a new one. If you never had one, ask your teacher.

**`Token rejected (401)`**
The token was probably rotated, which revokes the previous one. Run `/spark-login`
to confirm, then `learningcode --login` to enter the new one.

**`AI off — ask your teacher` / `AI disabled for your account`**
Spark has AI switched off for your account — usually a timetable window or a
policy setting. This is not something you can fix.

**`You already have a generation running`**
Spark allows one active generation per student. Stop the running one first.

**`Every seat is taken` / queue position**
All seats are busy. `learningcode` prints your position; try again shortly.

**`You asked to keep ~3 steps for later, so I stopped before changing files`**
You set a quota reserve with `/pace reserve 3`, and only that many steps were
left. Nothing is lost — the assistant stopped at a safe point, and `/undo`
still lists and recovers its file changes. Run `/pace reserve off` to use the
rest of the day, or `/pace` to see where you are.

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
| `RIVER_API_KEY` | River AI key, or store one with `--login-provider river` |
| `EXPLABS_API_KEY` | ExpLabs key, or store one with `--login-provider explabs` |
| `COMMANDCODE_API_KEY` | CommandCode key, or store one with `--login-provider commandcode` |

```bash
learningcode --show-config     # show resolved paths and settings
learningcode --login           # enter a new token
learningcode --list-models     # every reachable model
learningcode --use-theme dark   # use the upstream theme instead of TLC's
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

**River AI.** [River](https://river.ai/) exposes an OpenAI-compatible endpoint
at `https://api.river.ai/v1`. Sign in once and its models join `/model`:

```bash
learningcode --login-provider river      # paste an rv_ key
learningcode --model river/deepseek-ai/DeepSeek-V4.1-Flash
```

`RIVER_API_KEY` works instead of a stored key, for machines where the
environment already carries the credential.

**ExpLabs.** [Experiential Labs](https://platform.experientiallabs.ai/) (the
`explabs` provider) is an OpenAI-compatible gateway; its endpoint is
`https://api.experientiallabs.ai/v1`. Mint an `xpl_` key at
[platform.experientiallabs.ai/settings/api-keys](https://platform.experientiallabs.ai/settings/api-keys),
log in once, and its models join `/model`:

```bash
learningcode --login-provider explabs    # paste your xpl_ key
learningcode --model explabs/glm-5.3-flash
```

`EXPLABS_API_KEY` works instead of a stored key.

**CommandCode.** [CommandCode](https://commandcode.ai/) serves its catalogue at
`https://api.commandcode.ai/provider/v1`, mostly over OpenAI Chat Completions
with its Claude line on Anthropic Messages. About ninety models join `/model`
once a key is stored — from inside learningcode with `/login` (*Sign in with an
API key*, then CommandCode), or from the shell:

```bash
learningcode --login-provider commandcode   # paste a key from commandcode.ai/settings/keys
learningcode --model commandcode/claude-sonnet-5-5
learningcode --model commandcode/deepseek/deepseek-v4-pro
```

`COMMANDCODE_API_KEY` works instead of a stored key. Every plan except the free
Go tier has API access.

**Seat awareness.** Spark enforces one active generation per student, so on Spark
the client runs strictly serially and helpers (sub-agents) stay off — they run on
any other provider. Expect a 429 rather than parallel fan-out.

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

## Changelog

* **0.15.0** — quota pacing: the footer and `/quota` say *about how many more
  steps today*, and `/pace reserve N` keeps a few steps back so the assistant
  stops before changing files instead of running the day's Spark quota to zero.
  `/pace reserve off` lifts it, and the estimate always rounds down. It is
  student-owned, off by default, and Spark-only.
* **0.13.0** — speed: the launcher no longer blocks on the Spark
  reachability preflight before showing a prompt. It runs under a 350ms
  budget, so a slow network can't hold up startup; a real outage still shows
  up on the first request and on `/quota` and `/seats`.
* **0.12.1** — remote privacy: once a phone attaches, the QR code and link are
  cleared from the computer screen so no one walking past can scan them. The
  attached phone keeps working, including after sleep.
* **0.12.0** — remote parity: every command (`/quota`, `/seats`, `/todo`,
  `/todos`, `/approve`, `/plan`, `/undo`) works from the phone. Command answers
  now render as readable text that keeps its line breaks instead of a one-line
  status blip, and a handled command settles the screen instead of leaving it
  spinning with Stop lit.
* **0.11.0** — optional strict plan mode: `/plan strict on` locks Build until a
  plan exists and is approved with `/approve`, so editing cannot start before
  planning. The footer reads `PLAN first` while locked. Off by default; a lab can
  pin it on for a shared machine, and `/plan strict off` turns it off.
* **0.10.0** — guided plans and a screen that tells you where you are:
  `/plan explain-bug [about]` and `/plan implement-fn [about]` enter Plan mode
  with a pre-shaped prompt that teaches *how* to plan (`/plan` alone still
  toggles). The working folder now leads the terminal tab title and shows in the
  footer, so several open windows are told apart. `learningcode remote` shows a
  live line of what the phone is running on the computer — the current tool and
  the file it touched, the model, seats and queue — with a short scrolling log.
* **0.9.5** — hardening under the hood: a compound command shows every kind of
  danger it carries and "Always allow" remembers each; the nearly-out-of-quota
  warning now says when the weekly quota resets; `/undo` only touches files
  inside your project.
* **0.9.4** — ExpLabs' model list is fetched live at login (cached for offline),
  the phone relay drops a connection that floods it, and the tunnel program is
  checksum-verified before it runs.
* **0.9.3** — Spark calls time out in seconds instead of hanging; `/quota` names
  the weekly reset (Friday 00:00) and `/seats` always answers; ExpLabs login and
  its `xpl_` keys are fixed; an unexpected error is one plain sentence, never a
  stack.
* **0.9.2** — "Allow Always" remembers the *kind* of danger ("deletes files"),
  not the exact command text, so a rewritten command no longer re-prompts.
* **0.9.1** — `/undo` recovers the agent's own file changes: it lists what it
  will restore and remove, puts changed files back, and deletes created ones.
* **0.9.0** — your Plan-mode checklist survives a restart (`learningcode -c`),
  per conversation, resuming in Build with progress intact.
* **0.8.6** — cleanup: `doctor` no longer blocks on a token, a mistyped remote
  flag says what it needs, and colours are drawn defensively.
* **0.7.8** — CommandCode is a provider you can log in to from learningcode:
  `learningcode --login-provider commandcode` (your key is entered without echo),
  or `/login` inside learningcode. Its ~90 OpenAI- and Anthropic-compatible
  models then appear in `/model` after `/scoped-models`.
* **0.7.7** — remote fixes: a message typed on the phone while the agent is still
  answering is queued behind that answer instead of failing with a
  `streamingBehaviour` error; **Stop** cancels what was queued and says how much
  went with it; and the phone colours your messages apart from the agent's.
* **0.7.6** — ExpLabs is a provider you can log in to from learningcode:
  `learningcode --login-provider explabs` (your key is entered without echo),
  or set `EXPLABS_API_KEY`. Its OpenAI-compatible models then appear in
  `/model` after `/scoped-models`.
* **0.7.5** — updated to the Pi 1.2.0 runtime (theme schema validation,
  `before_agent_start` message-type handling), so themes and Plan mode keep
  working on the new release.
* **0.7.4** — River AI is a provider you can log in to from learningcode:
  `learningcode --login-provider river` (your `rv_` key is entered without
  echo), or set `RIVER_API_KEY`. Its OpenAI-compatible models then appear in
  `/model` after `/scoped-models`.
* **0.7.3** — longer answers: TLC-Spark output cap 4096 → 8192 tokens
  (existing installs migrate on next launch); approval prompt truncates
  long commands so Yes/No stays visible, with an Enter = Yes hint.
* **0.7.2** — failure UX: quota/seats/startup errors say what died and how to fix it, seat queue position without invented ETAs, `doctor --fix` clears a rejected token cache.
* **0.7.1** — footer shows session spend (`sess 3k ≈$0.03`, catalog-priced)
  and compacts for narrow screens (short model id, `quota n/a`, trimmed
  hints); scripted first-run tour with `/intro` replay and `--no-intro`.
* **0.7.0** — Plan/Build mode (`shift+tab` or `/plan`): research-only
  planning with writer tools hidden and blocked; checklist with footer
  counts (`PLAN 0/5`, `BUILD 2/5 ✓`), `/todo` management with completions,
  and `/approve` to carry a plan into Build.
* **0.5.7** — scoped models remembered; footer shows the active model in
  yellow; Token Harbor gains `claude-haiku-5.5`; thinking cycle on
  `ctrl+shift+e`, `shift+tab` reserved for Plan/Build.
* **0.5.6** — approval prompts, done sound, undo (`/undo`), test runs.
* **0.5.5** — `learningcode doctor` health check.
* **0.5.4** — Token Harbor provider login; `/model` scoped to logged-in providers.

## Licence

MIT. `learningcode` is distributed under the MIT licence and depends on Pi, which
is also MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or connected to Pi, OpenCode, Anomaly, or any of
the model providers reachable through this client. "The Learning Curve", TLC and
Spark are trademarks of The Learning Curve.
