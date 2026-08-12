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

// The worker is asleep most of the time. sendMessage wakes it, but if it is
// mid-teardown the send can reject -- and a swallowed rejection here is a
// recording that never starts, with nothing anywhere to say why. Retry once,
// and record the outcome either way.
function report(msg) {
  const full = Object.assign({ target: "worker" }, msg);
  chrome.runtime.sendMessage(full)
    .then(() => note("sent", { type: msg.type }))
    .catch((e) => {
      note("send failed, retrying", { type: msg.type, error: String((e && e.message) || e) });
      setTimeout(() => {
        chrome.runtime.sendMessage(full)
          .then(() => note("sent on retry", { type: msg.type }))
          .catch((e2) => note("SEND FAILED", { type: msg.type, error: String((e2 && e2.message) || e2) }));
      }, 500);
    });
}

async function tick() {
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

function start(next) {
  note("watcher configured", { url: next && next.url, name: next && next.name });
  cfg = next;
  currentDelay = (cfg && cfg.intervalMs) || DEFAULT_INTERVAL_MS;
  fails = 0;
  lastSig = null;     // force a silent re-adopt on the next poll
  clearTimeout(timer);
  if (cfg && cfg.url && cfg.name) tick();
}

function stop() {
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
