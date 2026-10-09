/**
 * The mobile web client.
 *
 * One self-contained HTML document: no build step, no framework, no CDN, so the
 * page reads the same on a school server and on a laptop, and works offline
 * from the server that served it.
 *
 * Look and feel follow the terminal mockups on learning.com.my: black panels,
 * monospace throughout, the LEARNINGCODE block banner, teal for the agent and
 * blue for the prompt. Everything is plain text, so nothing in the transcript
 * is ever rendered as HTML.
 */
export function remoteWebUi() {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>LearningCode Remote</title>
<style>
  :root {
    --bg: #000; --panel: #0a0f16; --line: #1b2636; --text: #e6edf6;
    --dim: #6b7a90; --teal: #2dd4bf; --blue: #60a5fa; --ok: #34d399;
    --warn: #fbbf24; --err: #f87171;
    --mono: "Space Mono", ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 var(--mono);
    display: flex; flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }

  /* header: the brand block, the project, the live state */
  header { border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  .logo {
    margin: 0; padding: 10px 12px 8px; font-size: 15px; font-weight: 700;
    letter-spacing: .14em; color: var(--teal);
  }
  .bar {
    display: flex; align-items: center; gap: 10px; padding: 6px 12px 8px;
    font-size: 12px; color: var(--dim); border-top: 1px solid var(--line);
  }
  .bar .project { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .bar .model {
    font: inherit; font-size: 12px; background: none; color: var(--blue);
    border: 1px solid var(--blue); padding: 5px 9px; min-height: 32px;
    max-width: 52%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-align: left; cursor: pointer;
  }
  .bar .model::after { content: " \\25BE"; }
  .bar .model:disabled { opacity: .4; cursor: default; }
  #state { margin-left: auto; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  #state .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); display: inline-block; }
  #state.online { color: var(--ok); }
  #state.online .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  #state.working { color: var(--teal); }
  #state.working .dot { background: var(--teal); animation: pulse 1.1s ease-in-out infinite; }
  #state.offline { color: var(--warn); }
  #state.offline .dot { background: var(--warn); }
  #state.error { color: var(--err); }
  #state.error .dot { background: var(--err); }
  @keyframes pulse { 50% { opacity: .3; } }

  /* the notice strip: offline, reconnecting, errors that need the student's eye */
  #notice {
    display: none; padding: 8px 12px; font-size: 12px;
    border-bottom: 1px solid var(--line); background: #1a1405; color: var(--warn);
  }
  #notice.show { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #notice button {
    font: inherit; background: none; border: 1px solid currentColor; color: inherit;
    padding: 2px 8px; cursor: pointer;
  }

  /* the transcript */
  #log { flex: 1; overflow-y: auto; padding: 12px; -webkit-overflow-scrolling: touch; }
  .turn { margin: 0 0 14px; }
  .who { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px; }
  .you .who { color: var(--blue); }
  .you .who::before { content: "> "; }
  .agent .who { color: var(--teal); }
  .agent .who::before { content: "$ "; }
  .text { white-space: pre-wrap; word-break: break-word; color: var(--text); margin: 0; }
  .you .text { color: var(--blue); }
  .streaming::after { content: "\\2588"; color: var(--teal); animation: blink 1s steps(1) infinite; margin-left: 1px; }
  @keyframes blink { 50% { opacity: 0; } }
  .activity { font-size: 12px; color: var(--dim); margin: 0 0 6px; }
  .activity.run { color: var(--teal); }
  .activity.ok { color: var(--ok); }
  .activity.fail { color: var(--err); }
  .error {
    margin: 0 0 12px; padding: 8px 10px; border: 1px solid var(--err);
    color: var(--err); font-size: 13px; white-space: pre-wrap; word-break: break-word;
  }
  .empty { color: var(--dim); font-size: 13px; margin-top: 24px; }

  /* the composer */
  form {
    display: flex; gap: 8px; align-items: flex-end;
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line); background: var(--panel);
  }
  #text {
    flex: 1; resize: none; max-height: 140px; min-height: 44px; padding: 11px 12px;
    border: 1px solid var(--line); background: #000; color: var(--text);
    font: inherit; border-radius: 0;
  }
  #text::placeholder { color: var(--dim); }
  #text:disabled { opacity: .5; }
  .btn {
    font: inherit; font-weight: 700; min-height: 44px; padding: 0 14px;
    border: 1px solid var(--teal); background: var(--teal); color: #001816; cursor: pointer;
  }
  .btn:disabled { opacity: .35; cursor: default; }
  .btn.ghost { background: none; color: var(--teal); }
  #stop { display: none; border-color: var(--err); background: none; color: var(--err); }
  #stop.show { display: block; }

  /* the model picker: a sheet over the page, one tap per model */
  #picker { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.75); z-index: 10; }
  #picker.show { display: flex; align-items: flex-end; }
  #picker .sheet {
    width: 100%; max-height: 70vh; overflow-y: auto; background: var(--panel);
    border-top: 1px solid var(--teal); padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
  }
  #picker h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--teal); font-weight: 700; }
  #picker .opt {
    display: flex; justify-content: space-between; gap: 10px; width: 100%;
    padding: 12px 10px; margin-bottom: 6px; background: #000; color: var(--text);
    border: 1px solid var(--line); font: inherit; text-align: left; cursor: pointer; min-height: 44px;
  }
  #picker .opt.current { border-color: var(--teal); color: var(--teal); }
  #picker .opt .prov { color: var(--dim); font-size: 12px; white-space: nowrap; }
  #picker .close { margin-top: 6px; width: 100%; }
  .group { border: 1px solid var(--line); margin: 0 0 8px; background: #000; }
  .group > summary {
    list-style: none; display: flex; justify-content: space-between; align-items: center;
    gap: 10px; padding: 11px 12px; min-height: 44px; cursor: pointer;
    color: var(--teal); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  }
  .group > summary::-webkit-details-marker { display: none; }
  .group > summary::after { content: "\\25B8"; color: var(--dim); }
  .group[open] > summary::after { content: "\\25BE"; }
  .group .count { color: var(--dim); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .group .opt { border: 0; border-top: 1px solid var(--line); margin: 0; }
</style>
</head>
<body>
<header>
  <div class="logo" aria-label="LEARNINGCODE">LEARNINGCODE</div>
  <div class="bar">
    <span class="project" id="project">remote</span>
    <button class="model" id="model" type="button" aria-label="Choose model" title="Choose model">choose model</button>
    <span id="state" role="status" aria-live="polite"><span class="dot"></span><span id="state-text">connecting</span></span>
  </div>
</header>

<div id="notice" role="alert"><span id="notice-text"></span><button id="notice-action" type="button" hidden>Retry</button></div>

<main id="log" aria-live="polite"></main>

<form id="composer" autocomplete="off">
  <textarea id="text" rows="1" placeholder="Type a message…" aria-label="Message" enterkeyhint="send"></textarea>
  <button id="stop" class="btn" type="button" aria-label="Stop the agent">Stop</button>
  <button id="send" class="btn" type="submit" disabled>Send</button>
</form>

<div id="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
  <div class="sheet">
    <h2 id="picker-title">Choose a model</h2>
    <div id="picker-list"></div>
    <button class="btn ghost close" id="picker-close" type="button">Close</button>
  </div>
</div>

<script>
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var log = $("log"), projectEl = $("project"), stateEl = $("state"), stateText = $("state-text");
  var noticeEl = $("notice"), noticeText = $("notice-text"), noticeAction = $("notice-action");
  var input = $("text"), sendBtn = $("send"), stopBtn = $("stop"), form = $("composer");
  var modelBtn = $("model"), picker = $("picker"), pickerList = $("picker-list");

  var socket = null, agentOnline = false, working = false;
  var current = null;          // the assistant block currently streaming
  var currentModel = null;     // { provider, id, name }
  var models = null;           // last list from the computer
  var retryDelay = 1000, closedByPage = false, retryTimer = null;
  var sessionDone = false;     // the session link is refused: stop retrying

  /* ---------- reading the link ---------- */

  /* The token rides in the fragment, so it is never sent in a query string
     and never reaches the server except inside the attach frame. */
  function parseLink() {
    var hash = location.hash.charAt(0) === "#" ? location.hash.slice(1) : location.hash;
    var q = hash.indexOf("?");
    var path = q === -1 ? hash : hash.slice(0, q);
    var params = new URLSearchParams(q === -1 ? "" : hash.slice(q + 1));
    if (path.charAt(0) === "/") path = path.slice(1);
    if (!path.startsWith("s/")) return null;
    return { sessionId: path.slice(2), token: params.get("t") || "" };
  }

  /* ---------- status and notices ---------- */

  function setState(kind, text) {
    stateEl.className = kind;
    stateText.textContent = text;
  }

  function notice(text, action) {
    if (!text) { noticeEl.className = ""; noticeAction.hidden = true; return; }
    noticeText.textContent = text;
    noticeEl.className = "show";
    noticeAction.hidden = !action;
    noticeAction.onclick = action || null;
  }

  function refreshControls() {
    var canSend = socket && socket.readyState === 1 && agentOnline;
    input.disabled = !canSend;
    sendBtn.disabled = !canSend || !input.value.trim();
    stopBtn.classList.toggle("show", working);
    if (!canSend) {
      input.placeholder = agentOnline ? "Connecting…" : "Your computer is offline. Messages wait until it is back.";
    } else {
      input.placeholder = "Type a message…";
    }
    modelBtn.disabled = !canSend;
  }

  /* ---------- the transcript ---------- */

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function turn(role) {
    var el = document.createElement("div");
    el.className = "turn " + role;
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "you" ? "you" : "learningcode";
    var body = document.createElement("p");
    body.className = "text";
    el.appendChild(who);
    el.appendChild(body);
    log.appendChild(el);
    scrollDown();
    return body;
  }

  function activity(text, kind) {
    var el = document.createElement("p");
    el.className = "activity" + (kind ? " " + kind : "");
    el.textContent = text;
    log.appendChild(el);
    scrollDown();
    return el;
  }

  function errorLine(text) {
    var el = document.createElement("div");
    el.className = "error";
    el.textContent = text;
    log.appendChild(el);
    scrollDown();
  }

  function clearEmpty() {
    var empty = log.querySelector(".empty");
    if (empty) empty.remove();
  }

  function finishAssistant() {
    if (current) current.classList.remove("streaming");
    current = null;
  }

  /* ---------- the model ---------- */

  function setModelLabel() {
    modelBtn.textContent = currentModel ? currentModel.name || currentModel.id : "choose model";
  }

  /* Friendly names for known providers; anything else is tidied from its id. */
  function providerLabel(id) {
    var known = { "tlc-spark": "TLC Spark", "opencode-go": "OpenCode Go", "opencode-zen": "OpenCode Zen" };
    if (known[id]) return known[id];
    return String(id || "other").replace(/[-_]+/g, " ").replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
  }

  function renderPicker() {
    pickerList.innerHTML = "";
    if (!models) {
      var loading = document.createElement("p");
      loading.className = "activity";
      loading.textContent = "Asking your computer which models it can reach…";
      pickerList.appendChild(loading);
      return;
    }
    if (!models.length) {
      var none = document.createElement("p");
      none.className = "activity fail";
      none.textContent = "No models are available on this computer.";
      pickerList.appendChild(none);
      return;
    }

    // Group by provider, keeping the order the computer reported.
    var order = [], groups = {};
    models.forEach(function (m) {
      if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider); }
      groups[m.provider].push(m);
    });

    order.forEach(function (provider) {
      var list = groups[provider];
      var group = document.createElement("details");
      group.className = "group";
      // Open the group the student is using, or the only group there is.
      group.open = order.length === 1 || Boolean(currentModel && currentModel.provider === provider);

      var summary = document.createElement("summary");
      var title = document.createElement("span");
      title.textContent = providerLabel(provider);
      var count = document.createElement("span");
      count.className = "count";
      count.textContent = list.length + (list.length === 1 ? " model" : " models");
      summary.appendChild(title);
      summary.appendChild(count);
      group.appendChild(summary);

      list.forEach(function (m) {
        var b = document.createElement("button");
        b.type = "button";
        var isCurrent = currentModel && currentModel.provider === m.provider && currentModel.id === m.id;
        b.className = "opt" + (isCurrent ? " current" : "");
        b.textContent = (isCurrent ? "● " : "") + (m.name || m.id);
        b.addEventListener("click", function () { chooseModel(m); });
        group.appendChild(b);
      });
      pickerList.appendChild(group);
    });
  }

  function openPicker() {
    picker.classList.add("show");
    renderPicker();
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ protocol: 1, type: "models" }));
    }
  }

  function closePicker() { picker.classList.remove("show"); }

  function chooseModel(m) {
    closePicker();
    activity("switching to " + (m.name || m.id) + "…", "run");
    socket.send(JSON.stringify({ protocol: 1, type: "set_model", provider: m.provider, modelId: m.id }));
  }

  /* ---------- the connection ---------- */

  function connect() {
    if (closedByPage || sessionDone) return;
    var link = parseLink();
    if (!link || !link.sessionId) {
      sessionDone = true;
      setState("error", "no session");
      log.innerHTML = '<p class="empty">Open the link that <b>learningcode remote</b> printed on your computer, or scan its QR code.</p>';
      refreshControls();
      return;
    }

    setState("", "connecting");
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/phone";
    try {
      socket = new WebSocket(url);
    } catch (error) {
      scheduleRetry();
      return;
    }

    socket.onopen = function () {
      retryDelay = 1000;
      notice("");
      socket.send(JSON.stringify({ protocol: 1, type: "attach", sessionId: link.sessionId, token: link.token }));
    };

    socket.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (error) { return; }
      handle(msg);
    };

    socket.onclose = function () {
      socket = null;
      agentOnline = false;
      working = false;
      finishAssistant();
      setState("offline", "reconnecting");
      refreshControls();
      if (!sessionDone) {
        notice("Connection lost. Reconnecting…", null);
        scheduleRetry();
      }
    };

    socket.onerror = function () { /* onclose follows and handles recovery */ };
  }

  function scheduleRetry() {
    if (closedByPage || sessionDone) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }

  function handle(msg) {
    switch (msg.type) {
      case "attached":
        agentOnline = msg.computer === "online";
        if (msg.session && msg.session.meta && msg.session.meta.name) {
          projectEl.textContent = msg.session.meta.name;
          document.title = "LearningCode · " + msg.session.meta.name;
        }
        setState(agentOnline ? "online" : "offline", agentOnline ? "online" : "computer offline");
        notice(agentOnline ? "" : "Your computer is offline. Messages wait until it is back.");
        refreshControls();
        socket.send(JSON.stringify({ protocol: 1, type: "models" }));
        break;

      case "history":
        log.innerHTML = "";
        if (!msg.messages || !msg.messages.length) {
          log.innerHTML = '<p class="empty">No messages yet. Type below to start.</p>';
        }
        (msg.messages || []).forEach(function (entry) {
          var body = turn(entry.role === "user" ? "you" : "agent");
          body.textContent = entry.text;
        });
        scrollDown();
        break;

      case "presence":
        agentOnline = msg.computer !== "offline";
        setState(agentOnline ? "online" : "offline", agentOnline ? "online" : "computer offline");
        notice(agentOnline ? "" : "Your computer is offline. Messages wait until it is back.");
        refreshControls();
        break;

      case "models":
        if (msg.error) { models = []; } else { models = msg.models || []; }
        if (!currentModel && models.length) {
          // The first model the computer offers is the one it is using.
          currentModel = models[0];
          setModelLabel();
        }
        if (picker.classList.contains("show")) renderPicker();
        break;

      case "model_changed":
        if (msg.ok) {
          var found = (models || []).filter(function (m) {
            return m.provider === msg.provider && m.id === msg.modelId;
          })[0];
          currentModel = found || { provider: msg.provider, id: msg.modelId, name: msg.modelId };
          setModelLabel();
          activity("now using " + (currentModel.name || currentModel.id), "ok");
        } else {
          activity("could not switch: " + (msg.error || "unknown error"), "fail");
        }
        break;

      case "event":
        applyAgentEvent(msg.event || {});
        break;

      case "error":
        if (/No such session|wrong link/.test(msg.message || "")) {
          sessionDone = true;
          setState("error", "link refused");
          notice("This link is no longer valid. Run learningcode remote again on your computer and open the new link.");
          refreshControls();
          break;
        }
        errorLine(msg.message || "error");
        break;
    }
  }

  function applyAgentEvent(event) {
    switch (event.type) {
      case "message_echo":
        clearEmpty();
        finishAssistant();
        turn("you").textContent = event.text || "";
        working = true;
        setState("working", "working");
        refreshControls();
        break;

      case "message_update":
        if (!current) {
          current = turn("agent");
          current.parentNode.classList.add("streaming");
          current.classList.add("streaming");
        }
        current.textContent += event.text || "";
        scrollDown();
        break;

      case "agent_start":
        working = true;
        setState("working", "working");
        refreshControls();
        break;

      case "tool_execution_start":
        activity("running " + (event.toolName || "tool") + "…", "run");
        break;

      case "tool_execution_end":
        activity((event.ok ? "done " : "failed ") + (event.toolName || "tool"), event.ok ? "ok" : "fail");
        break;

      case "compaction_start":
        activity("compacting conversation…");
        break;

      case "auto_retry_start":
        activity("retrying (attempt " + (event.attempt || "?") + ")…");
        break;

      case "note":
        activity(event.text || "");
        break;

      case "status":
        activity(event.text || "", "run");
        break;

      case "error":
        finishAssistant();
        errorLine(event.message || "agent error");
        break;

      case "agent_end":
      case "agent_settled":
        finishAssistant();
        working = false;
        setState(agentOnline ? "online" : "offline", agentOnline ? "online" : "computer offline");
        refreshControls();
        break;
    }
  }

  /* ---------- the composer ---------- */

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text || !socket || socket.readyState !== 1 || !agentOnline) return;
    socket.send(JSON.stringify({ protocol: 1, type: "message", text: text }));
    input.value = "";
    input.style.height = "auto";
    refreshControls();
  });

  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    refreshControls();
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  stopBtn.addEventListener("click", function () {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ protocol: 1, type: "abort" }));
      activity("stopping…", "run");
    }
  });

  modelBtn.addEventListener("click", openPicker);
  $("picker-close").addEventListener("click", closePicker);
  picker.addEventListener("click", function (event) {
    if (event.target === picker) closePicker();
  });

  window.addEventListener("pagehide", function () { closedByPage = true; });
  connect();
  refreshControls();
})();
</script>
</body>
</html>`;
}
