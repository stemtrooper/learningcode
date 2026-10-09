/**
 * The mobile web client.
 *
 * Deliberately a single self-contained HTML document: no build step, no
 * framework, no CDN. A teacher running the school server can read the whole UI
 * in one file, and it works on Android Chrome without a bundler anywhere in the
 * pipeline.
 *
 * Functionality over polish, per the brief. The one place it is fussy is the
 * reconnect path, because a phone on school wifi reconnecting is the normal
 * case, not the exception.
 */
export function remoteWebUi() {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<title>LearningCode Remote</title>
<style>
  :root {
    --bg: #0b1220; --panel: #131c2e; --line: #223049; --text: #e8eef8;
    --muted: #8ea0bd; --accent: #29c8f2; --ok: #35d07f; --warn: #f2b835; --err: #f2645c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  header {
    padding: 10px 14px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 10px; background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  header .brand { color: var(--accent); font-weight: 700; }
  header .project { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status { margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; }
  #status.online { color: var(--ok); }
  #status.offline { color: var(--warn); }
  #status.error { color: var(--err); }
  #log { flex: 1; overflow-y: auto; padding: 12px 14px 4px; }
  .msg { margin: 0 0 12px; max-width: 92%; }
  .msg .who { font-size: 11px; color: var(--muted); margin-bottom: 3px; text-transform: uppercase; letter-spacing: .04em; }
  .msg .body { padding: 9px 12px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg.you { margin-left: auto; text-align: right; }
  .msg.you .body { background: #1d3a5f; border-bottom-right-radius: 4px; }
  .msg.agent .body { background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 4px; }
  .msg.agent .body.streaming::after { content: "\\2588"; color: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .line { font-size: 13px; color: var(--muted); margin: 0 0 8px; padding-left: 2px; }
  .line.ok { color: var(--ok); }
  .line.err { color: var(--err); }
  .line.work { color: var(--accent); }
  .banner {
    padding: 8px 14px; font-size: 13px; text-align: center;
    background: #2a2410; color: var(--warn); border-bottom: 1px solid var(--line);
    display: none;
  }
  .banner.show { display: block; }
  form { display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--panel); }
  #text {
    flex: 1; resize: none; max-height: 120px; padding: 11px 13px; border-radius: 12px;
    border: 1px solid var(--line); background: #0d1526; color: var(--text); font: inherit;
  }
  button {
    border: 0; border-radius: 12px; padding: 0 16px; min-height: 44px;
    background: var(--accent); color: #04222e; font-weight: 700;
  }
  button:disabled { opacity: .45; }
  .center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="brand">learningcode</span>
  <span class="project" id="project">remote</span>
  <span id="status">connecting</span>
</header>
<div class="banner" id="banner"></div>
<div id="log"></div>
<form id="composer" autocomplete="off">
  <textarea id="text" rows="1" placeholder="Type a message" enterkeyhint="send" inputmode="text"></textarea>
  <button id="send" type="submit" disabled>Send</button>
</form>
<script>
(function () {
  "use strict";
  var log = document.getElementById("log");
  var statusEl = document.getElementById("status");
  var projectEl = document.getElementById("project");
  var bannerEl = document.getElementById("banner");
  var input = document.getElementById("text");
  var sendBtn = document.getElementById("send");
  var form = document.getElementById("composer");

  var socket = null;
  var agentOpen = false;
  var currentAssistant = null;
  var retryDelay = 1000;
  var closed = false;

  function parseLink() {
    // The token lives in the fragment: it is sent to the server once, inside
    // the attach frame, and never appears in a query string or a log line.
    var hash = location.hash.replace(/^#\\//, "");
    var qIndex = hash.indexOf("?");
    var path = qIndex === -1 ? hash : hash.slice(0, qIndex);
    var params = new URLSearchParams(qIndex === -1 ? "" : hash.slice(qIndex + 1));
    if (!path.startsWith("/s/")) return null;
    return { sessionId: path.slice(3), token: params.get("t") || "" };
  }

  function setStatus(kind, text) {
    statusEl.className = text ? "" : "";
    statusEl.className = kind;
    statusEl.textContent = text;
  }

  function banner(text) {
    bannerEl.textContent = text || "";
    bannerEl.className = text ? "banner show" : "banner";
  }

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "you" ? "You" : "LearningCode";
    var body = document.createElement("div");
    body.className = "body";
    body.textContent = text;
    el.appendChild(who);
    el.appendChild(body);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function addLine(text, kind) {
    var el = document.createElement("p");
    el.className = "line" + (kind ? " " + kind : "");
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function connect() {
    if (closed) return;
    var link = parseLink();
    if (!link) {
      document.body.innerHTML = '<div class="center">Open the link that <b>learningcode remote</b> printed on your computer.</div>';
      return;
    }
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/phone";
    setStatus("", "connecting");
    try {
      socket = new WebSocket(url);
    } catch (error) {
      scheduleRetry();
      return;
    }

    socket.onopen = function () {
      retryDelay = 1000;
      socket.send(JSON.stringify({ protocol: 1, type: "attach", sessionId: link.sessionId, token: link.token }));
    };

    socket.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (error) { return; }
      handle(msg);
    };

    socket.onclose = function () {
      socket = null;
      sendBtn.disabled = true;
      setStatus("offline", "reconnecting");
      banner("Connection lost. Reconnecting");
      scheduleRetry();
    };

    socket.onerror = function () {
      setStatus("error", "error");
    };
  }

  function scheduleRetry() {
    if (closed) return;
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }

  function handle(msg) {
    switch (msg.type) {
      case "attached":
        agentOpen = msg.computer === "online";
        if (msg.session && msg.session.meta) projectEl.textContent = msg.session.meta.name || "remote";
        setStatus(agentOpen ? "online" : "offline", agentOpen ? "computer online" : "computer offline");
        banner(agentOpen ? "" : "Waiting for your computer to come online");
        sendBtn.disabled = !agentOpen;
        break;

      case "history":
        log.innerHTML = "";
        (msg.messages || []).forEach(function (entry) {
          addMessage(entry.role === "user" ? "you" : "agent", entry.text);
        });
        break;

      case "presence":
        agentOpen = msg.computer !== "offline";
        setStatus(agentOpen ? "online" : "offline", agentOpen ? "computer online" : "computer offline");
        banner(agentOpen ? "" : "Waiting for your computer to come online");
        sendBtn.disabled = !agentOpen;
        break;

      case "event":
        applyAgentEvent(msg.event || {});
        break;

      case "error":
        addLine(msg.message || "error", "err");
        break;
    }
  }

  function applyAgentEvent(event) {
    switch (event.type) {
      case "message_update":
        if (!currentAssistant) {
          currentAssistant = addMessage("agent", "");
          currentAssistant.classList.add("streaming");
        }
        currentAssistant.textContent += event.text || "";
        log.scrollTop = log.scrollHeight;
        break;

      case "agent_start":
        setStatus("online", "working");
        addLine("Working", "work");
        break;

      case "tool_execution_start":
        addLine("Running: " + (event.toolName || "tool"), "work");
        break;

      case "tool_execution_end":
        addLine((event.ok ? "Done" : "Failed") + ": " + (event.toolName || "tool"), event.ok ? "ok" : "err");
        break;

      case "message_echo":
        finishAssistant();
        addMessage("you", event.text || "");
        break;

      case "compaction_start":
        addLine("Compacting conversation");
        break;

      case "auto_retry_start":
        addLine("Retrying (attempt " + (event.attempt || "?") + ")");
        break;

      case "note":
        addLine(event.text || "");
        break;

      case "status":
        addLine(event.text || "", "work");
        break;

      case "error":
        finishAssistant();
        addLine(event.message || "agent error", "err");
        setStatus("online", "computer online");
        break;

      case "agent_end":
      case "agent_settled":
        finishAssistant();
        setStatus("online", "computer online");
        sendBtn.disabled = !agentOpen;
        break;
    }
  }

  function finishAssistant() {
    if (currentAssistant) currentAssistant.classList.remove("streaming");
    currentAssistant = null;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text || !socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ protocol: 1, type: "message", text: text }));
    input.value = "";
    input.style.height = "auto";
  });

  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.dispatchEvent(new Event("submit"));
    }
  });

  window.addEventListener("pagehide", function () { closed = true; });
  connect();
})();
</script>
</body>
</html>`;
}
