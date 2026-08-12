// callpoll.js - Asks the call-state endpoint "am I on a call?" on a timer.
//
// This runs in the OFFSCREEN document, not the service worker, for one reason:
// a worker is torn down after ~30s idle, and chrome.alarms cannot fire faster
// than once a minute. Either would turn "start recording when I answer" into
// "start recording up to a minute after I answer", which is useless -- the
// first minute of a hotline call is the minute that explains the problem.
// An offscreen document holds a plain setInterval and stays alive.
//
// It deliberately does NOT decide anything. It fetches, matches with
// callmatch.js, and only wakes the worker when the answer CHANGES. On a quiet
// afternoon that is zero messages.

const DEFAULT_INTERVAL_MS = 2000;
// After this many consecutive failures, stop shouting and back off. The
// endpoint being down must not turn into a request every two seconds forever.
const BACKOFF_AFTER = 3;
const MAX_INTERVAL_MS = 60000;
// A call answered less than this ago is "just now", even on the first poll.
const FRESH_CALL_MS = 45000;

let cfg = null;            // { url, apiKey, name, intervalMs }
let timer = null;
let lastSig = null;        // signature of the last state we reported
let fails = 0;
let currentDelay = DEFAULT_INTERVAL_MS;
let lastError = null;
let lastOkAt = null;
let inFlight = false;
let lastPollAt = null;

// ---- flight recorder ----------------------------------------------------------
// Every decision the watcher makes, kept in a small ring buffer the popup can
// read. Without it, "the watcher is running but nothing happened" is
// unfalsifiable: the interesting moment is two seconds long and the service
// worker's console is usually closed when it passes.
const LOG_MAX = 60;
const pollLog = [];
function note(what, extra) {
  pollLog.push(Object.assign({ t: Date.now(), what }, extra || {}));
  if (pollLog.length > LOG_MAX) pollLog.shift();
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

// Delivering a decision to the service worker is the step that was losing
// recordings, so it goes through TWO channels.
//
// chrome.runtime.sendMessage alone is not enough: the worker is torn down
// after ~30s idle, and a message from an offscreen document does not reliably
// restart it. The send neither resolves nor rejects -- it simply disappears,
// which is exactly what the trail showed: "answered -> start recording"
// followed by nothing at all.
//
// A write to chrome.storage.local DOES wake a dormant worker, every time. So
// the trigger is written to storage first (the delivery that must not fail)
// and sent as a message second (the fast path when the worker is already up).
// The worker de-duplicates on the nonce, so arriving twice is harmless.
let nonce = 0;

// ---- keeping the worker awake ---------------------------------------------------
// The root problem, finally: a decision is only useful if something is alive to
// act on it. chrome.runtime.sendMessage from an offscreen document does not
// reliably revive a torn-down service worker, and a storage write races the
// worker's own teardown.
//
// A long-lived Port does. While a port is connected the worker cannot be shut
// down, and Chrome force-disconnects it after five minutes -- so it is
// reconnected on a timer well inside that window. The worker is then simply
// always up while a call is being watched, and delivery stops being a question.
let port = null;
let portTimer = null;

function connectPort() {
  clearTimeout(portTimer);
  try {
    port = chrome.runtime.connect({ name: "callpoll-keepalive" });
    port.onDisconnect.addListener(() => {
      port = null;
      // Reconnect promptly: a disconnected port means the worker just died,
      // which is exactly when the next trigger would be lost.
      if (cfg && cfg.url) portTimer = setTimeout(connectPort, 1000);
    });
  } catch (e) {
    note("port failed", { error: String((e && e.message) || e) });
    port = null;
    if (cfg && cfg.url) portTimer = setTimeout(connectPort, 5000);
    return;
  }
  // Well inside Chrome's five-minute cap.
  portTimer = setTimeout(connectPort, 4 * 60 * 1000);
}

function disconnectPort() {
  clearTimeout(portTimer);
  portTimer = null;
  if (port) { try { port.disconnect(); } catch (e) {} }
  port = null;
}

function report(msg) {
  const id = `${Date.now()}_${++nonce}`;

  // Everything here is wrapped, because an exception thrown on the way OUT of
  // this function is invisible: it unwinds into a promise nobody awaits, the
  // trail keeps its last line, and the recording simply never happens. The
  // previous build logged nothing at all at this point, which is only possible
  // if one of these calls threw synchronously.
  try {
    const p = chrome.storage.local.set({ callTrigger: Object.assign({ id }, msg) });
    if (p && p.then) {
      p.then(() => note("queued", { type: msg.type }))
       .catch((e) => note("QUEUE FAILED", { error: String((e && e.message) || e) }));
    } else {
      note("queued (callback API)", { type: msg.type });
    }
  } catch (e) {
    note("QUEUE THREW", { error: String((e && e.message) || e) });
  }

  // The port is the primary channel: it is connected to a worker that is, by
  // construction, awake.
  try {
    if (!port) connectPort();
    if (port) {
      port.postMessage(Object.assign({ target: "worker", id }, msg));
      note("posted over port", { type: msg.type });
    } else {
      note("no port available", { type: msg.type });
    }
  } catch (e) {
    note("PORT POST THREW", { error: String((e && e.message) || e) });
    port = null;
  }

  try {
    const p = chrome.runtime.sendMessage(Object.assign({ target: "worker", id }, msg));
    if (p && p.then) {
      p.then(() => note("sent", { type: msg.type }))
       .catch((e) => note("worker asleep", { error: String((e && e.message) || e) }));
    }
  } catch (e) {
    note("SEND THREW", { error: String((e && e.message) || e) });
  }
}

let tick = async function tick() {
  if (!cfg || !cfg.url) return;
  if (inFlight) { schedule(currentDelay); return; }
  inFlight = true;
  lastPollAt = Date.now();

  let payload = null;
  try {
    const headers = { "Accept": "application/json" };
    // The key header CallHub documents. Sent only to the configured host.
    if (cfg.apiKey) headers["X-API-Key"] = cfg.apiKey;

    // A poll that outlives its own interval is worse than a skipped poll.
    const ctl = new AbortController();
    const killer = setTimeout(() => ctl.abort(), Math.max(4000, currentDelay * 2));
    const res = await fetch(cfg.url, { method: "GET", headers, signal: ctl.signal, cache: "no-store" });
    clearTimeout(killer);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();

    fails = 0;
    lastError = null;
    lastOkAt = Date.now();
    currentDelay = cfg.intervalMs || DEFAULT_INTERVAL_MS;
  } catch (e) {
    inFlight = false;
    fails += 1;
    lastError = (e && e.name === "AbortError") ? "timed out" : String((e && e.message) || e);
    // Back off geometrically, capped. Report the trouble once, not every tick.
    if (fails >= BACKOFF_AFTER) {
      currentDelay = Math.min(MAX_INTERVAL_MS, (cfg.intervalMs || DEFAULT_INTERVAL_MS) * Math.pow(2, fails - BACKOFF_AFTER + 1));
      if (fails === BACKOFF_AFTER) report({ type: "callPollError", error: lastError });
    }
    schedule(currentDelay);
    return;
  }
  inFlight = false;

  // The whole decision, in one call.
  const mine = findMyCall(payload, cfg.name);
  const sig = callSignature(mine);
  if (sig !== lastSig) note("state changed", { from: lastSig, to: sig });

  if (sig !== lastSig) {
    const prev = lastSig;
    lastSig = sig;
    // First poll after (re)start: adopt the state silently rather than
    // treating a call that was already running as freshly answered. Otherwise
    // reloading the extension mid-call opens a picker out of nowhere.
    // First poll after (re)start. Normally this is an adoption: the extension
    // reloaded mid-call and must not open a picker for a call answered ten
    // minutes ago. But the offscreen document is also re-created by Chrome
    // under memory pressure and by the keepalive repair -- and if that happens
    // in the seconds after answering, a silent adopt swallows the ONLY trigger
    // the call will ever produce. So a call that started moments ago is
    // treated as fresh, not adopted.
    if (prev === null) {
      const age = mine && mine.at ? Date.now() - mine.at : Infinity;
      if (mine && age < FRESH_CALL_MS) {
        note("first poll, call is fresh -> start", { callId: mine.callId, ageMs: age });
        report({ type: "callStateStarted", call: mine });
      } else {
        note("first poll -> adopt (no picker)", { callId: mine ? mine.callId : null, ageMs: age });
        report({ type: "callStateAdopted", call: mine || null });
      }
    } else if (mine) {
      note("answered -> start recording", { callId: mine.callId, event: mine.event });
      report({ type: "callStateStarted", call: mine });
    } else {
      note("call ended", { callId: prev.split("|")[0] });
      report({ type: "callStateEnded", callId: prev.split("|")[0] });
    }
  }

  schedule(currentDelay);
}

// A throw anywhere inside tick() would stop the chain dead -- no further polls,
// no error, a watcher that reports "running" forever while doing nothing. The
// scheduler is therefore never inside the part that can throw.
const rawTick = tick;
tick = function safeTick() {
  try {
    const r = rawTick();
    if (r && r.catch) r.catch((e) => {
      note("POLL THREW", { error: String((e && e.message) || e) });
      inFlight = false;
      schedule(currentDelay);
    });
  } catch (e) {
    note("POLL THREW", { error: String((e && e.message) || e) });
    inFlight = false;
    schedule(currentDelay);
  }
};

function start(next) {
  connectPort();
  note("watcher configured", { url: next && next.url, name: next && next.name });
  cfg = next;
  currentDelay = (cfg && cfg.intervalMs) || DEFAULT_INTERVAL_MS;
  fails = 0;
  lastSig = null;     // force a silent re-adopt on the next poll
  clearTimeout(timer);
  if (cfg && cfg.url && cfg.name) tick();
}

function stop() {
  disconnectPort();
  clearTimeout(timer);
  timer = null;
  cfg = null;
  lastSig = null;
}


// ---- probing ------------------------------------------------------------------
function probeHeaders(config) {
  const headers = { "Accept": "application/json" };
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;
  return headers;
}

async function probeOnce(url, config, timeoutMs) {
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  let res;
  try {
    res = await fetch(url, { headers: probeHeaders(config), signal: ctl.signal, cache: "no-store" });
  } finally {
    clearTimeout(killer);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return {
    success: res.ok,
    status: res.status,
    parsed: json !== null,
    calls: json !== null ? callList(json).length : 0,
    mine: json !== null ? !!findMyCall(json, config.name) : false,
    detail: json !== null ? describePayload(json, config.name) : null,
    contentType: res.headers.get("content-type") || "",
    finalUrl: res.url || url,
    redirected: !!res.redirected,
    sample: text.slice(0, 400)
  };
}

// Paths a call-state service plausibly exposes, in the order they are worth
// trying. Kept short on purpose: this fires a handful of requests at someone
// else's server, not a scan.
const CANDIDATE_PATHS = [
  "/api/calls", "/api/calls/active", "/api/calls/live", "/api/active-calls",
  "/api/state", "/api/status", "/api/call-state", "/api/current",
  "/calls", "/calls/active", "/api/v1/calls", "/state"
];

async function findJsonPaths(config) {
  let origin;
  try { origin = new URL(config.url).origin; } catch (e) { return []; }
  const base = config.url.replace(/\/+$/, "");
  const tried = new Set([config.url]);
  const found = [];

  for (const path of CANDIDATE_PATHS) {
    for (const url of [origin + path, base + path]) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const r = await probeOnce(url, config, 4000);
        if (r.parsed && r.success) {
          found.push({ url, calls: r.calls, mine: r.mine, sample: r.sample.slice(0, 120) });
        }
      } catch (e) { /* a path that does not exist is the normal case */ }
      if (found.length >= 3) return found;
    }
  }
  return found;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "callpoll") return false;
  switch (message.type) {
    case "configure":
      start(message.config);
      sendResponse({ success: true, polling: !!(message.config && message.config.url && message.config.name) });
      return false;
    case "stop":
      stop();
      sendResponse({ success: true });
      return false;
    case "status":
      sendResponse({
        success: true,
        polling: !!timer || inFlight,
        url: cfg ? cfg.url : null,
        name: cfg ? cfg.name : null,
        intervalMs: currentDelay,
        consecutiveFailures: fails,
        lastError,
        lastOkAt,
        onCall: lastSig || null,
        lastPollAt: lastPollAt || null,
        log: pollLog.slice(-25)
      });
      return false;
    // A one-shot fetch for the Settings "Test" button: same request the poller
    // makes, so a pass here means the poller will work.
    case "probe":
      (async () => {
        try {
          const out = await probeOnce(message.config.url, message.config);
          // A single-page app answers EVERY path with its index.html, so a
          // wrong API path looks exactly like a right one that is down. When
          // the configured address returns a page, walk the usual API paths on
          // the same origin and report the ones that answer JSON -- that turns
          // "not JSON" from a dead end into a list of addresses to try.
          if (!out.parsed) {
            out.candidates = await findJsonPaths(message.config);
          }
          sendResponse(out);
        } catch (e) {
          sendResponse({ success: false, error: (e && e.name === "AbortError") ? "timed out" : String((e && e.message) || e) });
        }
      })();
      return true;
  }
  return false;
});
