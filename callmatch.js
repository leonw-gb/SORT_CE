// callmatch.js - Turns whatever the call-state endpoint returns into the one
// question SORT actually asks: "am I on a call right now, and which one?"
//
// Loaded by BOTH the service worker (importScripts) and the offscreen poller
// (<script>), so the poller can decide whether anything changed without waking
// the worker every two seconds.
//
// The rule, derived from real sipgate pushes on our hotline:
//
//   inbound  newCall -> user is an ARRAY of every logged-in agent (the group
//                       is ringing; nobody has taken it) -> NOT mine
//   inbound  answer  -> user is a STRING: the agent who picked up -> mine if me
//   outbound newCall -> user is a STRING: the caller -> mine if me
//   any      hangup  -> NO user at all, only callId
//
// So: a SCALAR user naming me means the call is mine and live. An array never
// does. That single rule covers both directions without a special case, and it
// is why ringing can never start a recording by accident.
//
// hangup carries no identity, so it cannot be matched by name -- the call is
// matched by callId against the one we are already following.

// ---- names -------------------------------------------------------------------
// Sipgate's roster is hand-maintained and shows it: two entries in a real
// payload had a leading space (" Valentin Resapow"). Names are also spelled
// inconsistently across systems -- "Mueller" here, "Müller" there. Both folds
// are applied so a recording is not silently skipped over a typo nobody can see.
function foldVariants(s) {
  if (s == null) return [];
  const base = String(s).normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!base) return [];
  // Two folds, because the two conventions disagree and both are in use:
  //   expanded -> "schuetz", "mueller"   (German transliteration)
  //   stripped -> "schutz",  "muller"    (accent simply dropped)
  // A name matches if EITHER fold agrees, so "Schütz" in Sipgate matches both
  // "Schuetz" and "Schutz" typed in Settings. Without both, one spelling
  // silently never records and looks like a broken endpoint.
  const expanded = base
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const stripped = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss");
  return expanded === stripped ? [expanded] : [expanded, stripped];
}

// Single fold, for logging and for the config check.
function foldName(s) {
  const v = foldVariants(s);
  return v.length ? v[0] : "";
}

function namesMatch(a, b) {
  const x = foldVariants(a), y = foldVariants(b);
  if (!x.length || !y.length) return false;
  return x.some((v) => y.includes(v));
}

// ---- payload shapes ----------------------------------------------------------
// The endpoint is not built yet, so this accepts the shapes it could plausibly
// take rather than betting on one: a bare array of live calls, an object
// wrapping that array under any of the usual keys, or a single state object.
function callList(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  for (const key of ["calls", "live", "data", "items", "results", "events"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // A single-object state endpoint: {state:"idle"} means no call.
  const state = String(payload.state || payload.status || "").toLowerCase();
  if (state === "idle" || state === "none" || state === "") {
    return payload.callId || payload.call_id ? [payload] : [];
  }
  return [payload];
}

const pick = (o, keys) => {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return null;
};

// One live-call entry, flattened. `_raw` is preferred for nothing: n8n's
// normalized top level already has the fields, and _raw loses the array shape
// on inbound newCall anyway.
function normalizeCall(c) {
  if (!c || typeof c !== "object") return null;
  const callId = pick(c, ["callId", "call_id", "id", "origCallId"]);
  if (!callId) return null;

  const event = String(pick(c, ["event", "state", "status", "type"]) || "").toLowerCase();
  const rawUser = c.user !== undefined ? c.user : pick(c, ["users", "agent", "answeredBy", "answered_by"]);

  // The distinction the whole design rests on.
  const users = Array.isArray(rawUser) ? rawUser.filter((u) => typeof u === "string") : [];
  const user = (!Array.isArray(rawUser) && typeof rawUser === "string" && rawUser.trim()) ? rawUser : null;

  return {
    callId: String(callId),
    event,
    user,                       // scalar: the person ON the call
    users,                      // array: the group that is merely ringing
    direction: String(pick(c, ["direction", "dir"]) || "in").toLowerCase() === "out" ? "out" : "in",
    from: pick(c, ["from", "caller", "fromNumber"]),
    to: pick(c, ["to", "callee", "toNumber"]),
    at: Number(pick(c, ["answeredAt", "answered_at", "startedAt", "started_at", "timestamp", "time"])) || null
  };
}

// Is this entry an ENDED call? Some endpoints keep hung-up calls in the list
// for a while; a hangup event must never read as "still on a call".
function isEnded(n) {
  return n.event === "hangup" || n.event === "ended" || n.event === "idle" || n.event === "completed";
}

// The answer to the only question: the live call this operator is on, or null.
function findMyCall(payload, myName) {
  if (!foldName(myName)) return null;
  for (const raw of callList(payload)) {
    const n = normalizeCall(raw);
    if (!n || isEnded(n)) continue;
    if (n.user && namesMatch(n.user, myName)) return n;
  }
  return null;
}

// Cheap change detector for the poller: identical signature = nothing to say,
// so the service worker is left asleep instead of being woken every 2 seconds
// by a payload whose only moving part is a timestamp.
function callSignature(myCall) {
  return myCall ? `${myCall.callId}|${myCall.event}` : "";
}

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, { foldName, foldVariants, namesMatch, findMyCall, callSignature, normalizeCall, callList });
}
