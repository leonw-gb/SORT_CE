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
  const rawInner = (c._raw && typeof c._raw === "object") ? c._raw : {};
  const callId = pick(c, ["callId", "call_id", "id", "origCallId"]) ||
                 pick(rawInner, ["callId", "call_id", "id", "origCallId"]);
  if (!callId) return null;

  const event = String(
    pick(c, ["event", "state", "status", "type"]) ||
    pick(rawInner, ["event", "state", "status", "type"]) || ""
  ).toLowerCase();
  // The normalized top level first, then _raw, then the sipgate wire spelling
  // "user[]" that survives form-encoded pushes. A payload that carries the
  // name only in a nested copy must still match, or the operator sees "none
  // under your name" while their name is plainly in the response.
  const raw = rawInner;
  const rawUser =
    c.user !== undefined ? c.user
    : pick(c, ["users", "user[]", "agent", "agents", "answeredBy", "answered_by", "owner", "member"])
      ?? (raw.user !== undefined ? raw.user
          : pick(raw, ["users", "user[]", "agent", "answeredBy", "answered_by"]));

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


// ---- diagnosis ----------------------------------------------------------------
// When the endpoint answers but no call matches, the useful question is not
// "did it fail" but "what names did it offer, and under which key". This
// reports exactly that, so a mismatch is read off the screen rather than
// guessed at.
function describePayload(payload, myName) {
  const list = callList(payload);
  const names = new Set();
  const events = new Set();
  const keys = new Set();
  let live = 0, ended = 0, unnamed = 0;

  for (const raw of list) {
    if (raw && typeof raw === "object") Object.keys(raw).forEach((k) => keys.add(k));
    const n = normalizeCall(raw);
    if (!n) continue;
    if (n.event) events.add(n.event);
    if (isEnded(n)) { ended++; continue; }
    live++;
    if (n.user) names.add(n.user);
    else if (n.users.length) n.users.forEach((u) => names.add(u));
    else unnamed++;
  }

  // A name that is present but spelled differently is the single most likely
  // cause, so surface the closest fold rather than the raw list alone.
  const mine = foldVariants(myName);
  const nearly = [...names].filter((nm) => {
    const v = foldVariants(nm);
    return !v.some((x) => mine.includes(x)) &&
           v.some((x) => mine.some((m) => x.includes(m.split(" ")[0]) || m.includes(x.split(" ")[0])));
  });

  return {
    total: list.length,
    live, ended, unnamed,
    events: [...events],
    entryKeys: [...keys].slice(0, 20),
    names: [...names].slice(0, 40),
    nearly: nearly.slice(0, 5),
    firstEntry: list.length ? JSON.stringify(list[0]).slice(0, 400) : ""
  };
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
  Object.assign(globalThis, { foldName, foldVariants, namesMatch, findMyCall, callSignature, normalizeCall, callList, describePayload, isEnded });
}
