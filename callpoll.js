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

let cfg = null;            // { url, apiKey, name, intervalMs }
let timer = null;
let lastSig = null;        // signature of the last state we reported
let fails = 0;
let currentDelay = DEFAULT_INTERVAL_MS;
let lastError = null;
let lastOkAt = null;
let inFlight = false;

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, ms);
}

function report(msg) {
  chrome.runtime.sendMessage(Object.assign({ target: "worker" }, msg)).catch(() => {});
}

async function tick() {
  if (!cfg || !cfg.url) return;
  if (inFlight) { schedule(currentDelay); return; }
  inFlight = true;

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

  if (sig !== lastSig) {
    const prev = lastSig;
    lastSig = sig;
    // First poll after (re)start: adopt the state silently rather than
    // treating a call that was already running as freshly answered. Otherwise
    // reloading the extension mid-call opens a picker out of nowhere.
    if (prev === null) {
      report({ type: "callStateAdopted", call: mine || null });
    } else if (mine) {
      report({ type: "callStateStarted", call: mine });
    } else {
      report({ type: "callStateEnded", callId: prev.split("|")[0] });
    }
  }

  schedule(currentDelay);
}

function start(next) {
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
        onCall: lastSig || null
      });
      return false;
    // A one-shot fetch for the Settings "Test" button: same request the poller
    // makes, so a pass here means the poller will work.
    case "probe":
      (async () => {
        try {
          const headers = { "Accept": "application/json" };
          if (message.config.apiKey) headers["X-API-Key"] = message.config.apiKey;
          const ctl = new AbortController();
          const killer = setTimeout(() => ctl.abort(), 8000);
          const res = await fetch(message.config.url, { headers, signal: ctl.signal, cache: "no-store" });
          clearTimeout(killer);
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) {}
          sendResponse({
            success: res.ok,
            status: res.status,
            parsed: json !== null,
            calls: json !== null ? callList(json).length : 0,
            mine: json !== null ? !!findMyCall(json, message.config.name) : false,
            sample: text.slice(0, 400)
          });
        } catch (e) {
          sendResponse({ success: false, error: (e && e.name === "AbortError") ? "timed out" : String((e && e.message) || e) });
        }
      })();
      return true;
  }
  return false;
});
