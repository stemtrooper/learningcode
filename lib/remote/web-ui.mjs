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
    --bg: #000; --surface: #1c1c1e; --surface-2: #2c2c2e; --sep: #38383a;
    --text: #f2f2f7; --dim: #8e8e93; --accent: #0a84ff;
    --ok: #30d158; --warn: #ffd60a; --err: #ff453a;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 16px/1.45 var(--sans);
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* header: project as the title, model as the subtitle, connection as a dot */
  header { position: sticky; top: 0; z-index: 5; background: rgba(0,0,0,.92); border-bottom: 1px solid var(--sep); }
  .titlebar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; }
  .titles { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
  .titlerow { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .logo { font-size: 11px; font-weight: 600; letter-spacing: .08em; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .project { flex: 1 1 auto; min-width: 0; font-size: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model {
    font: inherit; font-size: 13px; color: #64d2ff; background: none; border: 0; padding: 0;
    flex: 0 1 auto; min-width: 0; max-width: 45%; cursor: pointer; text-align: left;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .model::after { content: " \\203A"; }
  .model:disabled { opacity: .4; cursor: default; }
  #state { display: flex; align-items: center; flex: none; align-self: center; }
  #state .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); }
  #state.online .dot { background: var(--ok); }
  #state.working .dot { background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  #state.offline .dot { background: var(--warn); }
  #state.error .dot { background: var(--err); }
  @keyframes pulse { 50% { opacity: .35; } }

  /* notice: a connection problem that needs an action (status line covers the rest) */
  #notice {
    display: none; padding: 10px 16px; font-size: 14px;
    background: var(--surface); color: var(--warn); border-bottom: 1px solid var(--sep);
  }
  #notice.show { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  #notice button { font: inherit; font-size: 14px; background: none; border: 0; color: var(--accent); cursor: pointer; min-height: 32px; }

  /* transcript: no bubbles. You align right, the agent aligns left, labels say who. */
  #log { flex: 1; overflow-y: auto; padding: 16px; -webkit-overflow-scrolling: touch; display: flex; flex-direction: column; }
  .turn { display: flex; flex-direction: column; max-width: 88%; margin: 0 0 18px; }
  .turn.you { align-self: flex-end; align-items: flex-end; }
  .turn.agent { align-self: flex-start; align-items: flex-start; }
  .who { font-size: 12px; font-weight: 600; color: var(--dim); margin: 0 0 2px; }
  .you .who { color: var(--accent); }
  .text { margin: 0; font-size: 16px; white-space: pre-wrap; word-break: break-word; }
  .activity { align-self: center; margin: 0 0 14px; font-size: 13px; color: var(--dim); text-align: center; }
  .activity.ok { color: var(--ok); }
  .activity.fail { color: var(--err); }
  .error {
    margin: 0 0 14px; padding: 10px 12px; border-radius: 12px; background: var(--surface);
    color: var(--err); font-size: 14px; white-space: pre-wrap; word-break: break-word;
  }
  .empty { margin: auto; max-width: 30ch; color: var(--dim); font-size: 15px; line-height: 1.5; text-align: center; text-wrap: pretty; }
  .empty b { color: var(--text); font-weight: 600; }
  .empty-sub { display: block; margin-top: 10px; font-size: 13px; }

  .approval {
    margin: 0 0 14px; padding: 12px; border-radius: 12px; background: var(--surface);
    border: 1px solid var(--warn);
  }
  .approval .q { font-size: 15px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
  .approval .opts { display: flex; gap: 8px; flex-wrap: wrap; }
  .approval button {
    font: inherit; font-size: 15px; font-weight: 600; min-height: 44px; padding: 0 16px;
    border: 0; border-radius: 10px; background: var(--surface-2); color: var(--text); cursor: pointer;
  }
  .approval button.yes { background: var(--accent); color: #fff; }
  .approval button:disabled { opacity: .5; cursor: default; }
  /* status: one line above the composer that says what the agent is doing */
  #status { display: none; align-items: center; gap: 8px; padding: 8px 16px 0; font-size: 13px; color: var(--dim); }
  #status.show { display: flex; }
  #status:not(.busy) .spinner { display: none; }
  .spinner {
    width: 12px; height: 12px; flex: none; border-radius: 50%;
    border: 2px solid var(--surface-2); border-top-color: var(--accent);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* composer: rounded field, round send / stop, the way Messages does it */
  form {
    display: flex; gap: 8px; align-items: flex-end;
    padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--sep); background: #000;
  }
  #text {
    flex: 1; min-height: 40px; max-height: 140px; padding: 9px 16px;
    border: 1px solid var(--sep); border-radius: 20px; background: var(--surface); color: var(--text);
    font: inherit; font-size: 16px; line-height: 1.35; resize: none; outline: none;
    overflow-y: hidden; scrollbar-width: none;
  }
  #text::-webkit-scrollbar { display: none; }
  #text.scrolls { overflow-y: auto; }
  #text::placeholder { color: var(--dim); }
  #text:focus { border-color: var(--accent); }
  #text:disabled { opacity: .5; }
  form.offline #text { border-color: var(--warn); }
  form.offline #text::placeholder { color: var(--warn); }
  .round {
    flex: none; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  .round svg { width: 18px; height: 18px; }
  .round:disabled { background: var(--surface-2); color: var(--dim); cursor: default; }
  #send.hide { display: none; }
  #stop { display: none; background: var(--surface-2); color: var(--text); }
  #stop.show { display: flex; }

  /* model picker: a sheet over the page */
  #picker { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 10; }
  #picker.show { display: flex; align-items: flex-end; }
  #picker .sheet {
    width: 100%; max-height: 70vh; overflow-y: auto; background: var(--surface);
    border-radius: 14px 14px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  }
  #picker h2 { margin: 0 0 12px; font-size: 17px; font-weight: 600; text-align: center; }
  #picker .close {
    width: 100%; min-height: 44px; margin-top: 4px; border: 0; border-radius: 12px;
    background: var(--surface-2); color: var(--accent); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer;
  }
  .group { margin: 0 0 12px; border-radius: 12px; overflow: hidden; background: var(--surface-2); }
  .group > summary {
    list-style: none; display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; min-height: 44px; cursor: pointer; font-size: 16px; font-weight: 600;
  }
  .group > summary::-webkit-details-marker { display: none; }
  .group > summary::after { content: "\\203A"; margin-left: auto; color: var(--dim); }
  .group[open] > summary::after { transform: rotate(90deg); }
  .group .count { color: var(--dim); font-weight: 400; font-size: 13px; }
  .group .opt {
    display: block; width: 100%; margin: 0; padding: 12px 14px; min-height: 44px;
    background: none; border: 0; border-top: 1px solid var(--sep); border-radius: 0;
    color: var(--text); font: inherit; font-size: 16px; text-align: left; cursor: pointer;
  }
  .group .opt.current { color: var(--accent); }

  /* people who ask the system to cut motion get none */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header>
  <div class="titlebar">
    <div class="titles">
      <span class="logo">LEARNINGCODE REMOTE</span>
      <div class="titlerow">
        <span class="project" id="project">remote</span>
        <button class="model" id="model" type="button" aria-label="Choose model">choose model</button>
        <span id="state" role="status" aria-live="polite" title="Connection"><span class="dot"></span><span class="sr-only" id="state-text">connecting</span></span>
      </div>
    </div>
  </div>
</header>

<div id="notice" role="alert"><span id="notice-text"></span><button id="notice-action" type="button" hidden>Retry</button></div>

<main id="log" aria-live="polite"></main>

<div id="status" role="status"><span class="spinner"></span><span id="status-text"></span></div>

<form id="composer" autocomplete="off">
  <textarea id="text" rows="1" placeholder="Message" aria-label="Message" enterkeyhint="send"></textarea>
  <button id="stop" class="round" type="button" aria-label="Stop the agent"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
  <button id="send" class="round" type="submit" disabled aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
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
  var statusEl = $("status"), statusText = $("status-text");
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
    sendBtn.classList.toggle("hide", working);
    form.classList.toggle("offline", !canSend);
    if (!canSend) {
      input.placeholder = agentOnline ? "Connecting\u2026" : "Your computer is offline.";
    } else {
      input.placeholder = "Type a message…";
    }
    modelBtn.disabled = !canSend;
  }

  /* ---------- the transcript ---------- */

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function append(el) {
    log.appendChild(el);
    scrollDown();
  }

  /* One line above the composer says what the agent is doing right now. */
  function setStatus(text) {
    if (text) {
      statusText.textContent = text;
      statusEl.classList.add("show", "busy");
    } else {
      statusEl.classList.remove("show", "busy");
    }
  }

  function turn(role) {
    var el = document.createElement("div");
    el.className = "turn " + role;
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "you" ? "You" : "Agent";
    var body = document.createElement("p");
    body.className = "text";
    el.appendChild(who);
    el.appendChild(body);
    append(el);
    return body;
  }

  function activity(text, kind) {
    var el = document.createElement("p");
    el.className = "activity" + (kind ? " " + kind : "");
    el.textContent = text;
    append(el);
    return el;
  }

  function errorLine(text) {
    var el = document.createElement("div");
    el.className = "error";
    el.textContent = text;
    append(el);
  }

  function clearEmpty() {
    var empty = log.querySelector(".empty");
    if (empty) empty.remove();
  }

  function finishAssistant() {
    current = null;
  }

  /* ---------- the model ---------- */

  /* The model button keeps its last label across reloads: until the first
     models frame arrives over a slow tunnel, "choose model" reads as if
     nothing were selected. */
  function setModelLabel() {
    var label = currentModel ? currentModel.name || currentModel.id : null;
    if (!label) {
      try { label = localStorage.getItem("lc-model-name") || null; } catch (error) { /* private mode */ }
    }
    modelBtn.textContent = label || "choose model";
    modelBtn.classList.toggle("known", Boolean(label));
  }
  function rememberModel(m) {
    try { localStorage.setItem("lc-model-name", m.name || m.id); } catch (error) { /* private mode */ }
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
    setStatus("Switching to " + (m.name || m.id) + "...");
    socket.send(JSON.stringify({ protocol: 1, type: "set_model", provider: m.provider, modelId: m.id }));
  }

  /* ---------- the done sound ---------- */

  /* Browsers only let a page make sound after a tap, so the context is created
     on the first interaction. Until then the chime is silently skipped. */
  var audioCtx = null, soundOn = true;
  try { soundOn = localStorage.getItem("lc-sound") !== "off"; } catch (error) { /* private mode */ }
  function unlockAudio() {
    if (audioCtx) return;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try { audioCtx = new Ctor(); } catch (error) { audioCtx = null; }
  }
  document.addEventListener("pointerdown", unlockAudio, { once: false, passive: true });

  /* A short two-note chime, generated rather than shipped as a file. */
  function playDoneChime() {
    if (!soundOn || !audioCtx) return;
    if (audioCtx.state === "suspended") audioCtx.resume();
    var t = audioCtx.currentTime;
    [[660, 0], [880, 0.14]].forEach(function (n) {
      var osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = n[0];
      gain.gain.setValueAtTime(0.0001, t + n[1]);
      gain.gain.exponentialRampToValueAtTime(0.15, t + n[1] + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + n[1]);
      osc.stop(t + n[1] + 0.3);
    });
  }
  /* ---------- the connection ---------- */

  function connect() {
    if (closedByPage || sessionDone) return;
    var link = parseLink();
    if (!link || !link.sessionId) {
      sessionDone = true;
      setState("error", "no session");
      log.innerHTML = '<p class="empty">Open the link that <b>learningcode remote</b> printed on your computer.<span class="empty-sub">No link? Run <b>learningcode remote</b> on your computer and scan its QR code. This page stays here until a link opens it.</span></p>';
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
      setStatus("");
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
          /* The bar shows the pc folder name as-is, even when it repeats the
             brand: that word tells the student which computer folder they are
             driving. */
          var name = String(msg.session.meta.name);
          projectEl.textContent = name;
          document.title = "LearningCode · " + projectEl.textContent;
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
        // The computer says which model the agent is using. Trust that, not the
        // first item in the list.
        if (msg.current && msg.current.id) {
          var reported = (models || []).filter(function (m) {
            return m.provider === msg.current.provider && m.id === msg.current.id;
          })[0];
          currentModel = reported || { provider: msg.current.provider, id: msg.current.id, name: msg.current.name || msg.current.id };
          rememberModel(currentModel);
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
          rememberModel(currentModel);
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

  /* A dialog the agent is waiting on: the student taps an option, and the answer
     goes back to the computer, which passes it to the agent. */
  function showApproval(a) {
    clearEmpty();
    var card = document.createElement("div");
    card.className = "approval";
    card.setAttribute("role", "alertdialog");
    var q = document.createElement("p");
    q.className = "q";
    q.textContent = a.title || "Allow this?";
    var opts = document.createElement("div");
    opts.className = "opts";
    (a.options || []).forEach(function (label) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (/^yes/i.test(label)) b.className = "yes";
      b.addEventListener("click", function () {
        opts.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ protocol: 1, type: "approval", id: a.id, value: label }));
        }
        card.remove();
      });
      opts.appendChild(b);
    });
    card.appendChild(q);
    card.appendChild(opts);
    append(card);
  }
  function applyAgentEvent(event) {
    switch (event.type) {
      case "approval":
        showApproval(event);
        break;

      case "message_echo":
        clearEmpty();
        finishAssistant();
        turn("you").textContent = event.text || "";
        working = true;
        setStatus("Thinking...");
        setState("working", "working");
        refreshControls();
        break;

      case "message_update":
        if (!current) current = turn("agent");
        current.textContent += event.text || "";
        scrollDown();
        break;

      case "agent_start":
        working = true;
        setStatus("Thinking...");
        setState("working", "working");
        refreshControls();
        break;

      case "tool_execution_start":
        setStatus("Running " + (event.toolName || "a tool") + "...");
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
        setStatus(event.text || "Working...");
        break;

      case "error":
        finishAssistant();
        errorLine(event.message || "agent error");
        break;

      case "agent_end":
      case "agent_settled":
        finishAssistant();
        working = false;
        setStatus("");
        setState(agentOnline ? "online" : "offline", agentOnline ? "online" : "computer offline");
        refreshControls();
        // agent_settled is the final signal for a turn; agent_end comes before it.
        if (event.type === "agent_settled") {
          playDoneChime();
          // A question left open once the turn ends is no longer waiting on anyone.
          log.querySelectorAll(".approval").forEach(function (card) { card.remove(); });
        }
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
    input.classList.toggle("scrolls", input.scrollHeight > 140);
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
      setStatus("Stopping...");
    }
  });

  modelBtn.addEventListener("click", openPicker);
  $("picker-close").addEventListener("click", closePicker);
  picker.addEventListener("click", function (event) {
    if (event.target === picker) closePicker();
  });

  window.addEventListener("pagehide", function () { closedByPage = true; });
  setModelLabel();
  connect();
  refreshControls();
})();
</script>
</body>
</html>`;
}
