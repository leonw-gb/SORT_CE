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

// Some endpoints nest the original push under "_raw" as an object, others keep
// it under "payload" as a JSON STRING. Both are the same thing; read either.
// A user field that is a JSON array serialised into a string, or a plain
// comma-separated roster, is still a group -- not a person.
function maybeList(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a;
    } catch (e) { /* not JSON after all */ }
  }
  // Two or more comma-separated full names is a ringing group, not a name.
  if (t.includes(",") && t.split(",").filter((x) => x.trim()).length > 1) {
    return t.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return v;
}

function innerOf(c) {
  if (c._raw && typeof c._raw === "object") return c._raw;
  for (const k of ["_raw", "payload", "body", "raw"]) {
    const v = c[k];
    if (v && typeof v === "object") return v;
    if (typeof v === "string" && v.trim().startsWith("{")) {
      try { return JSON.parse(v); } catch (e) { /* a string that is not JSON */ }
    }
  }
  return {};
}

function timeOf(c) {
  const v = pick(c, ["answeredAt", "answered_at", "startedAt", "started_at",
                     "receivedAt", "received_at", "timestamp", "time", "createdAt", "created_at"]);
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;   // seconds or ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
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
  const rawInner = innerOf(c);
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
    : pick(c, ["userName", "user_name", "users", "user[]", "agent", "agents", "answeredBy", "answered_by", "owner", "member"])
      ?? (raw.user !== undefined ? raw.user
          : pick(raw, ["userName", "user_name", "users", "user[]", "agent", "answeredBy", "answered_by"]));

  // The distinction the whole design rests on -- but the ringing group can
  // arrive as a JSON STRING rather than an array once it has been through a
  // database column. Unpack it, or a whole ringing roster reads as one absurd
  // name and every agent looks "close to" whoever is configured.
  const parsedUser = maybeList(rawUser);
  const users = Array.isArray(parsedUser) ? parsedUser.filter((u) => typeof u === "string") : [];
  const user = (!Array.isArray(parsedUser) && typeof parsedUser === "string" && parsedUser.trim())
    ? parsedUser : null;

  return {
    callId: String(callId),
    event,
    user,                       // scalar: the person ON the call
    users,                      // array: the group that is merely ringing
    direction: String(pick(c, ["direction", "dir"]) || "in").toLowerCase() === "out" ? "out" : "in",
    from: pick(c, ["from", "caller", "fromNumber"]),
    to: pick(c, ["to", "callee", "toNumber"]),
    at: timeOf(c),
    seq: Number(pick(c, ["id", "seq", "sequence"])) || null
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
function describePayload(payload, myName, opts) {
  const rows = callList(payload);
  const cur = currentCalls(payload, opts);
  const names = new Set();
  const events = new Set();
  const keys = new Set();
  let unnamed = 0;

  rows.forEach((r) => {
    if (r && typeof r === "object") Object.keys(r).forEach((k) => keys.add(k));
    const n = normalizeCall(r);
    if (n && n.event) events.add(n.event);
    if (n && n.user) names.add(n.user);
    else if (n && n.users.length) n.users.forEach((u) => names.add(u));
  });
  cur.forEach((n) => { if (!n.user && !n.users.length) unnamed++; });

  const mine = foldVariants(myName);
  const nearly = [...names].filter((nm) => {
    const v = foldVariants(nm);
    return !v.some((x) => mine.includes(x)) &&
           v.some((x) => mine.some((m) => x.includes(m.split(" ")[0]) || m.includes(x.split(" ")[0])));
  });

  return {
    total: rows.length,
    rows: rows.length,
    distinct: new Set(rows.map((r) => { const n = normalizeCall(r); return n && n.callId; }).filter(Boolean)).size,
    live: cur.length,
    ended: 0,
    unnamed,
    events: [...events],
    entryKeys: [...keys].slice(0, 20),
    names: [...names].slice(0, 40),
    nearly: nearly.slice(0, 5),
    liveSummary: cur.slice(0, 5).map((n) =>
      `${n.callId.slice(0, 16)}… ${n.event} ${n.direction} ${n.user || "(no name)"}`),
    firstEntry: rows.length ? JSON.stringify(rows[rows.length - 1]).slice(0, 400) : ""
  };
}

// The endpoint returns an append-only EVENT LOG, not a list of active calls:
// newCall, answer and hangup all arrive as separate rows and nothing is ever
// removed. Reading it row by row counts one call three times and never sees a
// hangup retire the answer that preceded it -- which is why 51 rows read as
// "30 live".
//
// So collapse it first: group every row by callId, keep the LAST row per call
// (by sequence id, falling back to timestamp), and treat that as the call's
// current state. A call whose last row is a hangup is over. Everything else
// follows from the same rule as before.
const MAX_CALL_AGE_MS = 6 * 60 * 60 * 1000;   // a call still "live" after six hours is a log artefact

function currentCalls(payload, opts) {
  const now = (opts && opts.now) || Date.now();
  const byId = new Map();

  callList(payload).forEach((row, i) => {
    const n = normalizeCall(row);
    if (!n) return;
    n._ord = (n.seq != null) ? n.seq : (n.at != null ? n.at : i);
    const prev = byId.get(n.callId);
    if (!prev || n._ord >= prev._ord) {
      // The name rides on the answer row; a later hangup row carries none.
      // Keep the one we learned so a finished call can still be attributed.
      if (prev && !n.user && prev.user) n.user = prev.user;
      if (prev && !n.users.length && prev.users.length) n.users = prev.users;
      if (prev && n.at == null) n.at = prev.at;
      byId.set(n.callId, n);
    }
  });

  return [...byId.values()].filter((n) => {
    if (isEnded(n)) return false;
    // A newCall or answer that was never hung up, hours ago, is a log that
    // lost its closing row -- not a call anyone is still on.
    if (n.at != null && now - n.at > MAX_CALL_AGE_MS) return false;
    return true;
  });
}

// The answer to the only question: the live call this operator is on, or null.
function findMyCall(payload, myName, opts) {
  if (!foldName(myName)) return null;
  for (const n of currentCalls(payload, opts)) {
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
  Object.assign(globalThis, { foldName, foldVariants, namesMatch, findMyCall, callSignature, normalizeCall, callList, describePayload, isEnded, currentCalls, innerOf, maybeList });
}
