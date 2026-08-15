// player.js - Renders a recording as a clean, readable CORRELATED TIMELINE.
// Lean mode: no visual DOM replay. Visuals come from an external screen
// recorder; this page turns the captured action stream into a scannable log
// grouped by SOP step, with type filters, search, tab lanes and pause markers.

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const VIDEOS_STORE = "videos";

// The chip groups a session opens with. Everything else starts hidden.
// Stated as what you WANT rather than what to suppress: the useful default is
// the operator's own actions, and Navigation/Network/WebSocket/Other are
// context you go looking for, not context you read past every time.
const DEFAULT_VISIBLE = new Set(["click", "input", "key", "tab"]);
// A pause longer than this (ms) gets a divider; longer than LONG_MS = highlighted.
const PAUSE_MS = 3000;
const LONG_MS = 10000;

// ---- data access -------------------------------------------------------------
function getRecordingId() {
  return new URLSearchParams(location.search).get("id");
}
function openDB() {
  return new Promise((resolve, reject) => {
    // No explicit version: the player is a READER. background.js owns the
    // schema and bumps the version when stores are added. Opening with a
    // hardcoded number breaks with "requested version (N) is less than the
    // existing version (M)" every time the writer moves ahead.
    const r = indexedDB.open(RECORDINGS_DB);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function loadRecording(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readonly");
    const req = tx.objectStore(RECORDINGS_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ---- source-agnostic loading -------------------------------------------------
// Everything below this line renders {meta, events, videoUrl} and does not care
// where they came from. Today there is one source; when the upload server grows
// a viewer it becomes a second SOURCES entry and nothing downstream changes.
const SOURCES = {
  // A recording in this browser's IndexedDB -- ours or imported.
  local: {
    async load(id) {
      const rec = await loadRecording(id);
      if (!rec) return null;
      return {
        meta: {
          id: rec.id,
          startTime: rec.startTime,
          endTime: rec.endTime,
          recorder: rec.recorder || null,
          imported: !!rec.imported,
          sourceId: rec.sourceId || null,
          ticket: rec.ticket || null,
          videoStartOffset: (rec.video && rec.video.startOffset) || 0
        },
        events: rec.events || [],
        tabs: rec.tabs || {},
        sopSteps: rec.sopSteps || [],
        video: rec.video || null,
        // Deferred: the timeline must render even when the video is hundreds
        // of megabytes, so the blob is only fetched when the player asks.
        // loadVideoBlob, NOT loadVideo -- the latter is the render function
        // that CALLS this one, and pointing at it made the two recurse.
        getVideo: () => loadVideoBlob(id)
      };
    }
  }
};

function sourceFor() {
  const p = new URLSearchParams(location.search);
  return { name: p.get("src") || "local", id: p.get("id") };
}

// ---- time display ------------------------------------------------------------
// Both readings, always, one above the other. They answer different questions
// and you need whichever one the thing you are comparing against happens to
// use: wall-clock matches a ticket comment, a server log or a phone record;
// elapsed matches the video scrubber. A toggle made you choose in advance,
// which meant guessing wrong and going back for the other one. Showing both
// costs one line of vertical space per row and removes the decision.
//
// Wall clock leads because it is the coarser, more recognisable number.

// Wall-clock time of an event, from the session start plus its offset.
function fmtWall(ms) {
  const start = (recording && recording.startTime) || 0;
  if (!start) return "";                 // pre-2.18 sessions have no start time
  const d = new Date(start + (ms || 0));
  return `${String(d.getHours()).padStart(2, "0")}:` +
         `${String(d.getMinutes()).padStart(2, "0")}:` +
         `${String(d.getSeconds()).padStart(2, "0")}`;
}

// The stacked timestamp used by every row and lane head. Falls back to elapsed
// alone on old sessions that never recorded a start time, rather than printing
// an empty line where the clock should be.
function timeCellHTML(ms) {
  const wall = fmtWall(ms);
  const rel = fmtClock(ms);
  if (!wall) return `<span class="t"><span class="abs">${rel}</span></span>`;
  return `<span class="t"><span class="abs">${wall}</span>` +
         `<span class="rel">+${rel}</span></span>`;
}

// Plain-text form for the copied log, where a stack is not available.
function fmtTime(ms) {
  const wall = fmtWall(ms);
  const rel = fmtClock(ms);
  return wall ? `${wall} +${rel}` : rel;
}

// ---- formatting --------------------------------------------------------------
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}.${frac}`;
}
function fmtDur(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${m}m ${r}s`;
}
function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function shortUrl(u) {
  if (!u) return "";
  try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return u; }
}

// ---- tab naming ---------------------------------------------------------------
// A raw Chrome tab id ("tab 259748376") means nothing to a reader. Every tab in
// this fleet is one app on one RKA machine, and BOTH facts are in the URL.
// The app is identified by the port where there is one, otherwise by the
// hostname's leading label:
//   http://main-module.rka04-n0036...:30080/          -> GUI RKA04-N0036
//   http://main-module.rka04-n0036...:30003/RKA04-... -> Scheduler Dashboard RKA04-N0036
//   http://video.rka04-n0036.goodbytz.systems/        -> Video RKA04-N0036
// A third table covers fleet-wide tools that carry no machine id at all:
//   https://cloud.fully-kiosk.com/cloud               -> Fully Kiosk Device Manager
const TAB_APP_BY_PORT = {
  "30001": "Kubernetes",
  "30002": "Elastic",
  "30003": "Scheduler Dashboard",
  "30080": "GUI",
  "30081": "Pickup Screen",
  "30083": "Ordering Terminal"
};

// Apps on a default port, identified by the FIRST hostname label instead
// (video.rka04-n0036... -> Video).
const TAB_APP_BY_SUBDOMAIN = {
  video: "Video",
  idrac: "iDRAC",
  teltonika: "Teltonika"
};

// Tools that serve the whole fleet from one address, so no machine id is ever
// appended. Matched on host + a path prefix, longest prefix first.
const TAB_APP_BY_SITE = [
  { host: "unifi.ui.com", name: "Video Dashboard" },
  { host: "cloud.fully-kiosk.com", path: "/cloud", name: "Fully Kiosk Device Manager" }
];

// Machine id: "rka04-n0036" from the hostname, or from the first path segment
// (the Scheduler Dashboard puts it there too), upper-cased for display.
function rkaIdFromUrl(x) {
  const fromHost = (x.hostname || "").match(/\brka[\w-]*?\d+-n\d+\b/i) ||
    (x.hostname || "").match(/\brka[\w\d-]*\b/i);
  if (fromHost) return fromHost[0].toUpperCase();
  const seg = (x.pathname || "").split("/").filter(Boolean)[0];
  if (seg && /^rka/i.test(seg)) return seg.toUpperCase();
  return null;
}

// Human name for a tab URL, e.g. "GUI RKA04-N0036". Returns null when the URL
// is not one of the known apps, so callers can fall back to the raw id.
function tabNameFromUrl(url) {
  if (!url) return null;
  let x;
  try { x = new URL(url); } catch (e) { return null; }
  const host = (x.hostname || "").toLowerCase();

  // Fleet-wide tools first: they are named by address alone, and appending a
  // machine id to them would be a lie.
  const site = TAB_APP_BY_SITE.find((s) =>
    host === s.host && (!s.path || (x.pathname || "").startsWith(s.path)));
  if (site) return site.name;

  const port = x.port || (x.protocol === "https:" ? "443" : "80");
  let app = TAB_APP_BY_PORT[port] || null;

  // No port match: try the leading hostname label. Only for hosts that are
  // actually part of the fleet, so unrelated sites still fall back to the id.
  if (!app) {
    const first = host.split(".")[0];
    if (TAB_APP_BY_SUBDOMAIN[first] && /goodbytz\.systems$/i.test(host)) {
      app = TAB_APP_BY_SUBDOMAIN[first];
    }
  }
  if (!app) return null;

  const rka = rkaIdFromUrl(x);
  return rka ? `${app} ${rka}` : app;
}

// Name for a tab id: prefer the tab's recorded URL, else the URL of any event
// from that tab (a tab that navigated after capture still has events).
const tabNameCache = new Map();
function tabName(tabId) {
  if (tabId == null) return "";
  if (tabNameCache.has(tabId)) return tabNameCache.get(tabId);
  let name = null;
  const t = (recording && recording.tabs && recording.tabs[tabId]) || null;
  if (t && t.url) name = tabNameFromUrl(t.url);
  if (!name) {
    for (const ev of events || []) {
      if (ev.tabId !== tabId) continue;
      name = tabNameFromUrl(ev.pageUrl || ev.url);
      if (name) break;
    }
  }
  const out = name || `tab ${tabId}`;
  tabNameCache.set(tabId, out);
  return out;
}

// ---- video sync ----------------------------------------------------------------
// The session video is one stream of the whole window, so a timeline event at
// relativeTime T sits at video time (T - startOffset). startOffset is the gap
// between the encoder's first frame and the session clock's zero.
let videoEl = null;
let videoOffsetMs = 0;
let videoReady = false;
let videoObjectUrl = null;
let currentSource = null;

// An imported session is someone else's work. Say so once, at the top, so the
// timeline is never read as a record of what I did.
function renderProvenance(meta) {
  if (!meta || !meta.imported) return;
  const bar = document.getElementById("provenance");
  if (!bar) return;
  const who = meta.recorder || "an unknown colleague";
  const when = meta.startTime
    ? new Date(meta.startTime).toLocaleString(undefined,
        { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "an unknown time";
  bar.innerHTML = `<b>Imported session</b> &middot; recorded by ${esc(who)} on ${esc(when)}`;
  bar.classList.add("on");
}

function eventToVideoTime(ev) {
  return Math.max(0, ((ev.relativeTime || 0) - videoOffsetMs) / 1000);
}

async function loadVideo() {
  const pane = document.getElementById("videoPane");
  videoEl = document.getElementById("sessionVideo");
  const meta = document.getElementById("videoMeta");
  const v = recording.video || null;
  // An imported session's video flags describe the machine that RECORDED it.
  // What matters here is whether a blob actually arrived, so imported sessions
  // always look in the store rather than trusting the sender's metadata.
  if (!recording.imported && (!v || !v.captured)) return;

  // The video is a Blob in the videos store. Read it here rather than via the
  // service worker: a Blob cannot cross sendMessage, and the old base64
  // round-trip inflated long recordings past what a single string can hold.
  let rec = null;
  try {
    rec = currentSource ? await currentSource.getVideo() : await loadVideoBlob(recording.id);
  } catch (e) {
    rec = null;
  }

  if (!rec || !rec.blob) {
    pane.classList.add("on");
    // Two very different failures used to share one sentence. An imported
    // session whose video did not survive the import is not the same thing as
    // a capture that never finished, and the operator can act on one of them.
    meta.innerHTML = recording.imported
      ? `<b>No video stored</b><br>The bundle carried a video but it was not saved on import.<br>Import the .sortz again.`
      : `<b>No video stored</b><br>The capture did not finish saving.`;
    videoEl.style.display = "none";
    return;
  }

  videoOffsetMs = (v && v.startOffset) || recording.videoStartOffset || 0;
  // An object URL streams the Blob: the browser seeks within it without ever
  // holding the whole file in memory, which is what makes 30+ minute
  // recordings play at all.
  videoObjectUrl = URL.createObjectURL(rec.blob);
  videoEl.src = videoObjectUrl;
  pane.classList.add("on");
  videoReady = true;

  const mb = ((rec.size || (rec.blob && rec.blob.size) || 0) / (1024 * 1024)).toFixed(0);
  meta.innerHTML =
    `<b>Session video</b><br>${mb} MB · video only, no audio<br>` +
    `Click any timeline row to jump to that moment.` +
    (v && v.endedEarly ? `<br><span style="color:#e0a33e">Sharing was stopped before the session ended.</span>` : "");

  // Video -> timeline: highlight the row the playhead is currently on.
  videoEl.addEventListener("timeupdate", () => {
    if (!videoReady) return;
    const tMs = videoEl.currentTime * 1000 + videoOffsetMs;
    let current = null;
    document.querySelectorAll(".row[data-t]").forEach((row) => {
      if (Number(row.dataset.t) <= tMs) current = row;
      row.classList.remove("playing");
    });
    if (!current) return;
    current.classList.add("playing");
    followPlayhead(current);
  });
}

// ---- following the playhead ---------------------------------------------------
// The highlighted row is useless once it has scrolled out of view, so the log
// follows it. Two things this deliberately does NOT do:
//
// scrollIntoView() -- it scrolls the nearest scrollable ancestor, which on this
// page can be the window, dragging the whole layout sideways. The log's own
// scrollTop is set directly instead.
//
// Fight the operator. Scrolling by hand while the video plays is how you read
// ahead or look back, and yanking the view away on the next tick makes the page
// feel broken. A manual scroll suspends following until the current row comes
// back into view on its own, or the video is seeked.
const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let followEnabled = true;
let programmaticScroll = false;
let followResumeTimer = null;

function initFollow() {
  const log = document.getElementById("log");
  if (!log) return;

  // Clicking a row seeks the video, which is an explicit "put me here" -- so it
  // re-arms following even if the operator had scrolled away.
  log.addEventListener("click", (e) => {
    if (e.target.closest(".row[data-t]")) { followEnabled = true; setFollowHint(false); }
  });

  log.addEventListener("scroll", () => {
    // Our own scrolling must not read as the operator taking over.
    if (programmaticScroll) return;
    followEnabled = false;
    setFollowHint(true);
  }, { passive: true });

  // A seek is an explicit "take me here", so it re-arms following.
  if (videoEl) {
    videoEl.addEventListener("seeking", () => {
      followEnabled = true;
      setFollowHint(false);
    });
  }
}

function setFollowHint(paused) {
  const hint = document.getElementById("followHint");
  if (!hint) return;
  hint.classList.toggle("on", !!paused && videoReady);
}

function followPlayhead(row) {
  const log = document.getElementById("log");
  if (!log) return;

  const logRect = log.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();

  // The sticky SOP step header overlaps the top of the viewport, so a row is
  // "visible" only below it -- otherwise following stops one row too early and
  // the active row sits hidden under the header.
  const head = log.querySelector(".step-head");
  const headH = head ? head.getBoundingClientRect().height : 0;

  const topLimit = logRect.top + headH;
  const bottomLimit = logRect.bottom;
  const fullyVisible = rowRect.top >= topLimit && rowRect.bottom <= bottomLimit;

  if (!followEnabled) {
    // Following resumes on its own once the playhead catches up to where the
    // operator is reading. No button to press, nothing to remember.
    if (fullyVisible) { followEnabled = true; setFollowHint(false); }
    return;
  }

  if (fullyVisible) return;

  // body { zoom } scales getBoundingClientRect but NOT scrollTop or
  // clientHeight, so the pixel delta has to be converted back to layout pixels
  // -- the same correction the splitter makes. Without it the log overshoots by
  // the zoom factor and the active row lands off screen in the other direction.
  const ZOOM = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const deltaCss = rowRect.top - logRect.top - headH;

  // Park the row a third of the way down rather than at the very top: the next
  // few actions stay on screen, which is what you want while watching.
  const target = log.scrollTop + deltaCss / ZOOM - log.clientHeight / 3;

  programmaticScroll = true;
  log.scrollTo({
    top: Math.max(0, target),
    // Jumping is correct for a large gap (a seek), gliding for the next row.
    behavior: prefersReducedMotion() || Math.abs(target - log.scrollTop) > log.clientHeight * 1.5
      ? "auto" : "smooth"
  });

  // scrollend is not in every Chrome we run on, so release the guard on a
  // timer as well. Releasing early would make our own scroll disable following.
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => { programmaticScroll = false; }, 450);
}

function loadVideoBlob(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(VIDEOS_STORE)) { resolve(null); return; }
    const tx = db.transaction(VIDEOS_STORE, "readonly");
    const req = tx.objectStore(VIDEOS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

// Release the object URL when the page goes away so the Blob can be collected.
window.addEventListener("pagehide", () => {
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
});

// Map an event to a display "kind" (drives icon, color, filtering).
function kindOf(ev) {
  switch (ev.type) {
    case "sopStep": return "sop";
    case "sopNote": return "note";
    case "interaction":
      if (ev.subtype === "input" || ev.subtype === "change") return "input";
      return "click";
    case "key": return "key";
    case "tabNavigated":
    case "historyChange": return "nav";
    case "tabSwitch":
    case "tabEntered":
    case "tabClosed": return "tab";
    case "networkRequest": return "net";
    case "wsFrame":
    case "websocket": return "ws";
    case "scroll": return "scroll";
    case "visibilityChange": return "visibility";
    default: return "misc";
  }
}
const ICON = {
  click: "\u25C9", input: "\u270E", key: "\u2328", nav: "\u2192", tab: "\u25A2",
  net: "\u21C5", ws: "\u21C6", sop: "\u2691", note: "\u270E", misc: "\u2022",
  scroll: "\u2195", visibility: "\u25D1"
};
// Chip groups shown in the toolbar (kinds folded into one control).
const CHIP_GROUPS = [
  { k: "click", label: "Clicks", kinds: ["click"] },
  { k: "input", label: "Inputs", kinds: ["input"] },
  { k: "key", label: "Keys", kinds: ["key"] },
  { k: "nav", label: "Navigation", kinds: ["nav"] },
  { k: "tab", label: "Tabs", kinds: ["tab"] },
  // WebSocket frames ride along with Network. They are the same question --
  // "what did the page talk to?" -- and two chips for it cost more header room
  // than the distinction is worth. Capture is unchanged; only the filter merged.
  { k: "net", label: "Network", kinds: ["net", "ws", "scroll", "visibility"] },
  { k: "misc", label: "Other", kinds: ["misc"] }
];

// Some captured labels (esp. Flutter root clicks) contain dumped CSS/markup or
// enormous strings. Trim them to something readable: drop CSS blocks, collapse
// whitespace, cap length, and fall back to the tag name.
function cleanLabel(raw, tag) {
  let s = String(raw == null ? "" : raw);
  // Flutter root clicks capture the whole stylesheet as textContent. If the
  // string contains CSS rules or Flutter internals, it is not a real label.
  if (/\{[^}]*\}/.test(s) || /flt-scene-host|flt-semantics|-webkit-appearance|font:\s*normal|::selection|flutter-view\s+\w/.test(s)) {
    return "";
  }
  s = s.replace(/\s+/g, " ").trim();
  // A "label" longer than ~100 chars is not a label -- it is the concatenated
  // text of a whole view (Flutter root/container clicks). Reject it entirely.
  if (s.length > 200) return "";
  if (s.length > 160) s = s.slice(0, 160) + "\u2026";
  return s;
}

// Icon glyph -> readable verb for plain-DOM (Quasar/NiceGUI) clicks whose only
// content is a Material icon. Mirrors ICON_VERB_MAP in content.js.
const PLAYER_ICON_VERBS = {
  refresh: "Refresh", cancel: "Clear", close: "Close", stop: "Stop",
  play_arrow: "Start", done_all: "Complete", done: "Confirm", check: "Confirm",
  delete: "Delete", edit: "Edit", add: "Add", remove: "Remove",
  search: "Search", settings: "Settings", menu: "Menu",
  more_vert: "More", more_horiz: "More",
  arrow_back: "Back", arrow_forward: "Forward",
  expand_more: "Expand", expand_less: "Collapse",
  keyboard_arrow_down: "Expand", keyboard_arrow_up: "Collapse",
  folder: "Expand section", light_mode: "Light mode", dark_mode: "Dark mode"
};


// Composed labels read "Name (detail)". The NAME is the action; the detail is
// context, so only the name is emphasised. Splits on the last balanced
// parenthetical that ends the string.
function boldLabel(label) {
  const s = String(label == null ? "" : label);
  const m = s.match(/^(.*?)\s*(\([^()]*\))$/);
  if (!m || !m[1].trim()) return `<b>${esc(s)}</b>`;
  return `<b>${esc(m[1].trim())}</b> ${esc(m[2])}`;
}

// One human-readable line { lead(html), sub(text) } per event.
function describe(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "sopStep": return { lead: `Step started: <b>${esc(ev.stepLabel || ev.stepId)}</b>`, sub: "" };
    case "sopNote": return { lead: `Note`, sub: ev.note };
    case "interaction": {
      const verb = (ev.subtype === "input" || ev.subtype === "change") ? "Typed in" : "Clicked";
      // Flutter clicks: uniform "flt-semantic-node-ID -> LABEL" (resolved once
      // in resolveFlutterClicks from the semanticsTree ground truth).
      if (ev.__sem) {
        const g = ev.__sem.dbg || {};
        const isTyping = ev.subtype === "input" || ev.subtype === "change";
        // Value ONLY for typing events, and never when it merely repeats the
        // label (clicks on buttons capture value = textContent, which caused
        // the duplicate "Ready -> "Ready"" noise).
        const cleanVal = (d.value != null && d.value !== "" && !d.masked) ? cleanLabel(d.value) : "";
        const semVal = (isTyping && cleanVal && cleanVal !== ev.__sem.label)
          ? ` \u2192 "${esc(cleanVal)}"` : (isTyping && d.masked ? " (masked)" : "");
        // Text fields read as their own kind: "Clicked Text Field -> LABEL".
        const isTextField = ev.__sem.role === "text-field" ||
          d.tagName === "INPUT" || d.tagName === "TEXTAREA" ||
          (d.control && d.control.role === "text-field");
        // If the tree only knew the role, recover the real label from the live
        // capture (aria-label/placeholder of the input at event time).
        const shownLabel = (isTextField && ev.__sem.label === "text-field")
          ? (cleanLabel(d.ariaLabel || d.placeholder) || "text-field")
          : ev.__sem.label;
        const noun = debugMode ? esc(ev.__sem.id) : (isTextField ? "Text Field" : "node");
        return {
          lead: `${verb} <b>${noun} \u2192 ${esc(shownLabel)}</b>${semVal}`,
          sub: shortUrl(d.url),
          dbg: debugMode ? `id: ${g.idSrc || "?"} \u00B7 label: ${g.labelSrc || "?"}` : ""
        };
      }
      // Sidebar/menu click resolved via the route change it caused.
      if (ev.__nav) {
        return {
          lead: `Clicked menu \u2192 <b>${esc(ev.__nav.name)}</b>`,
          sub: `${shortUrl(d.url)} \u2192 ${shortUrl(ev.__nav.url)}`,
          dbg: debugMode ? `nav-inference: no widget node at click \u2192 labeled by destination route; ${ev.__nav.dbg || ""}` : ""
        };
      }
      // Quasar/NiceGUI pages: the recorder already resolved the clicked
      // control's semantic meaning (tooltip / visible label / icon) into
      // d.control. Prefer that over raw target attributes -- the raw target is
      // often a bare <i>glyph</i> icon or a div with an auto-generated id
      // (c73, f_<uuid>) that means nothing to a reader.
      const c = d.control || null;
      const usefulId = (d.id && !/^c\d+$/.test(d.id) && !/^f_[0-9a-f-]{16,}$/i.test(d.id)) ? d.id : null;

      // Plain-DOM text fields read like Flutter ones:
      //   Clicked Text Field -> Search Current Schedule
      //   Typed in Text Field -> Search Current Schedule -> "fail"
      const isPlainTextField =
        (c && c.role === "text-field") ||
        ((d.tagName === "INPUT" || d.tagName === "TEXTAREA") &&
          !["checkbox", "radio", "button", "submit"].includes(String(d.inputType || "").toLowerCase()));
      if (isPlainTextField) {
        const fieldName =
          cleanLabel((c && c.label) || d.ariaLabel || d.placeholder || d.name) || "Text field";
        const isClear = c && c.action === "clear";
        const typing = !isClear && (ev.subtype === "input" || ev.subtype === "change");
        const raw = (d.value != null && d.value !== "" && !d.masked) ? cleanLabel(d.value) : "";
        const tail = typing
          ? (d.masked ? " (masked)" : (raw ? ` \u2192 "${esc(raw)}"` : ""))
          : "";
        const fieldVerb = isClear ? "Cleared" : verb;
        return {
          lead: `${fieldVerb} <b>Text Field \u2192 ${esc(fieldName)}</b>${tail}`,
          sub: shortUrl(d.url),
          dbg: debugMode ? "plain DOM text field \u2014 labeled from field label + section title" : ""
        };
      }

      let label = cleanLabel(
        (c && c.tooltip) ||
        (c && c.label) ||
        d.ariaLabel || d.placeholder || d.name ||
        usefulId ||
        d.text,
        d.tagName
      );
      // A label that is just a Material icon glyph name (play_arrow,
      // keyboard_arrow_down, ...) reads badly -- translate it to a verb.
      if (label && /^[a-z][a-z0-9_]*$/.test(label)) {
        label = PLAYER_ICON_VERBS[label] ||
          (label.includes("_")
            ? label.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ")
            : label);
      }
      if (!label && c && c.icon) {
        label = PLAYER_ICON_VERBS[c.icon] ||
          c.icon.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
      }
      let sub = shortUrl(d.url);
      let plainDbg = "";
      if (debugMode) {
        const why = ev.__semReject
          ? ev.__semReject
          : (String(d.tagName || "").indexOf("FLT") === 0 || d.tagName === "FLUTTER-VIEW")
            ? "no semanticsId captured, no tree node at click coords, no route change followed"
            : "plain DOM element (non-Flutter) — labeled from DOM attributes";
        plainDbg = `unresolved: ${why}`;
      }
      if (!label) {
        // No usable label (e.g. Flutter canvas hit). Describe by tag + position;
        // the route in the sub-line gives the real context.
        const tag = (d.tagName || "element").toLowerCase();
        const pos = (ev.clientX != null && ev.clientY != null) ? ` at (${ev.clientX}, ${ev.clientY})` : "";
        label = `${tag}${pos}`;
      }
      // Value ONLY for typing events, and never when it just repeats the label
      // (a click's captured "value" is the element's textContent).
      const isTypingPlain = ev.subtype === "input" || ev.subtype === "change";
      const plainVal = (d.value != null && d.value !== "" && !d.masked) ? cleanLabel(d.value) : "";
      const val = (isTypingPlain && plainVal && plainVal !== label)
        ? ` \u2192 "${esc(plainVal)}"` : (isTypingPlain && d.masked ? " (masked)" : "");
      return { lead: `${verb} ${boldLabel(label)}${val}`, sub, dbg: plainDbg };
    }
    case "key": {
      const combo = [ev.ctrl && "Ctrl", ev.meta && "Cmd", ev.alt && "Alt", ev.shift && "Shift", ev.key].filter(Boolean).join("+");
      return { lead: `Key <b>${esc(combo)}</b>`, sub: "" };
    }
    case "tabNavigated": return { lead: `Navigated`, sub: shortUrl(ev.url) };
    case "historyChange": return { lead: `Route change <span style="color:var(--dim)">(${esc(ev.method)})</span>`, sub: shortUrl(ev.url) };
    case "tabSwitch": return { lead: `Switched to ${esc(tabName(ev.tabId))}`, sub: "" };
    case "tabEntered": return { lead: `Tab opened`, sub: ev.title || shortUrl(ev.url) };
    case "tabClosed": return { lead: `${esc(tabName(ev.tabId))} closed`, sub: "" };
    case "networkRequest": return { lead: `<b>${esc(ev.method)}</b> request`, sub: shortUrl(ev.url) };
    case "semanticsTree": {
      const n = (ev.nodes || []).length;
      const labeled = (ev.nodes || []).filter((x) => x.label).length;
      return { lead: `Widget map captured <span style="color:var(--dim)">(${esc(ev.reason || "")})</span>`, sub: `${n} widgets, ${labeled} labeled — ${shortUrl(ev.url)}` };
    }
    case "scroll": return { lead: `Scrolled`, sub: `(${ev.scrollX}, ${ev.scrollY})` };
    case "visibilityChange": return { lead: ev.hidden ? "Tab hidden" : "Tab visible", sub: "" };
    default: return { lead: esc(ev.type), sub: "" };
  }
}

// ---- Flutter semantics resolution ---------------------------------------------
// Goal: EVERY Flutter click renders as "flt-semantic-node-ID -> LABEL".
// The recording carries semanticsTree snapshots (ground truth: id, label, role,
// rect per widget). This pass walks the timeline once and, for each click,
// resolves the node id (captured semanticsId, else rect hit-test of the click
// coordinates against the tree valid at that moment) and the best label for
// that id (tree label preferred over whatever the live capture grabbed).
function isFlutterClickCandidate(ev) {
  if (ev.type !== "interaction") return false;
  const d = ev.data || {};
  if (d.semanticsId) return true;
  const tag = String(d.tagName || "");
  return /^(FLT-|FLUTTER-)/.test(tag) || tag === "SPAN";
}
// Group nodes (table rows etc.) carry multi-line labels: "NAME\nAUTHOR\nSTATUS".
// Usually the first line is the entity name. BUT some cards prefix a short
// status badge as its own first line ("Entwurf\nCremiger Pilzrisotto",
// "Aktiv\n...", etc. -- the badge vocabulary is open-ended). Heuristic: when
// line 1 is a single short word and line 2 is longer/multi-word, line 1 is a
// badge -> the entity name is line 2. Otherwise keep line 1.
function firstLine(label) {
  const lines = String(label == null ? "" : label)
    .split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  if (lines.length >= 2) {
    const l1 = lines[0], l2 = lines[1];
    const l1SingleShortWord = !/\s/.test(l1) && l1.length <= 16;
    const l2Richer = l2.length > l1.length || /\s/.test(l2);
    if (l1SingleShortWord && l2Richer) return l2;
  }
  return lines[0];
}
// Smallest LABELED node containing the point (used to resolve unlabeled child
// widgets -- e.g. the tap-target inside a table row -- to their row's name).
function hitTestLabeledTree(nodes, x, y, excludeId) {
  if (!nodes || x == null || y == null) return null;
  let best = null, bestArea = Infinity;
  nodes.forEach((n) => {
    const r = n.rect;
    if (!n.id || n.id === excludeId || !n.label || !r || !r.w || !r.h) return;
    if (n.id === "flt-semantic-node-0") return;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const area = r.w * r.h;
      if (area < bestArea) { bestArea = area; best = n; }
    }
  });
  return best;
}
function hitTestTree(nodes, x, y) {
  if (!nodes || x == null || y == null) return null;
  let best = null, bestArea = Infinity;
  nodes.forEach((n) => {
    const r = n.rect;
    if (!n.id || !r || !r.w || !r.h) return;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const area = r.w * r.h;
      if (area < bestArea) { bestArea = area; best = n; }
    }
  });
  return best;
}
function resolveFlutterClicks(evs) {
  // Global id -> best label map across ALL tree snapshots (Flutter node ids
  // are monotonically assigned, so collisions across routes don't occur).
  const labelById = {};
  const roleById = {};
  evs.forEach((e) => {
    if (e.type !== "semanticsTree") return;
    (e.nodes || []).forEach((n) => {
      if (!n.id) return;
      if (n.label) labelById[n.id] = n.label;
      if (n.role) roleById[n.id] = n.role;
    });
  });
  // Walk in time order keeping the tree that was on screen at each click.
  let currentTree = null;
  const trees = evs.filter((e) => e.type === "semanticsTree");
  evs.forEach((ev) => {
    if (ev.type === "semanticsTree") { currentTree = ev; return; }
    if (!isFlutterClickCandidate(ev)) return;
    const d = ev.data || {};
    let id = d.semanticsId || null;
    let hit = null;
    // Debug provenance: HOW the node id was found.
    let idSrc = id ? "recorder semanticsId (DOM ancestry/live hit-test)" : null;
    if (!id) {
      // Hit-test against the tree valid AT the click; if none yet (click before
      // the first snapshot), try the first snapshot after it.
      hit = hitTestTree(currentTree && currentTree.nodes, ev.clientX, ev.clientY);
      if (hit) idSrc = `player hit-test vs tree@${fmtClock(currentTree.relativeTime || 0)} (${currentTree.reason})`;
      if (!hit) {
        const next = trees.find((t) => t.relativeTime >= (ev.relativeTime || 0));
        hit = hitTestTree(next && next.nodes, ev.clientX, ev.clientY);
        if (hit) idSrc = `player hit-test vs NEXT tree@${fmtClock(next.relativeTime || 0)} (${next.reason}) — tree from AFTER the click, may be stale`;
      }
      if (hit) id = hit.id;
    }
    // The ROOT node (flt-semantic-node-0) spans the whole viewport; attributing
    // a click to it is meaningless -- treat as unresolved so the navigation
    // pass below (or the plain fallback) can describe it better.
    if (id === "flt-semantic-node-0") { id = null; ev.__semReject = "resolved to ROOT node (flt-semantic-node-0) — discarded, whole-viewport container"; }
    if (!id) return; // not resolvable -> navigation pass / plain fallback
    // Best label: ground-truth tree label > live-captured aria/text.
    // Debug provenance: HOW the label was chosen (priority order).
    const liveLabel = cleanLabel(d.ariaLabel || d.text, d.tagName);
    const role = roleById[id] || (hit && hit.role) || null;
    let label, labelSrc;
    if (labelById[id]) { label = cleanLabel(firstLine(labelById[id])); labelSrc = "semanticsTree label (global id map)"; }
    if (!label && hit && hit.label) { label = cleanLabel(firstLine(hit.label)); labelSrc = "semanticsTree label (hit-tested node)"; }
    if (!label && liveLabel) { label = firstLine(liveLabel); labelSrc = d.ariaLabel ? "live aria-label at click time" : "live element text at click time"; }
    // Convention in this app: a BUTTON with no label anywhere is always the
    // cross/X that closes the current window or popup. Applied before the
    // enclosing-group fallback so an X inside a labeled view isn't mislabeled
    // with that view's title.
    if (!label && role === "button") { label = "Close"; labelSrc = "unlabeled button — close-button (X) convention"; }
    // Unlabeled, role-less child widget inside a labeled GROUP (e.g. the tap
    // target of a table row in Collections/Resources): use the enclosing row's
    // name -- the first line of the group's multi-line label (NAME\nAUTHOR\nSTATUS).
    if (!label) {
      const encl = hitTestLabeledTree(currentTree && currentTree.nodes, ev.clientX, ev.clientY, id) ||
                   hitTestLabeledTree(trees.length && (trees.find((t) => t.relativeTime >= (ev.relativeTime || 0)) || {}).nodes, ev.clientX, ev.clientY, id);
      if (encl) {
        label = cleanLabel(firstLine(encl.label));
        labelSrc = `enclosing labeled group ${encl.id} (first line of row label)`;
      }
    }
    if (!label && role) { label = role; labelSrc = "role only — node has NO label in any tree snapshot"; }
    if (!label) { label = "unlabeled"; labelSrc = "nothing available — no label, no role"; }
    ev.__sem = { id, label, role, dbg: { idSrc, labelSrc } };
  });

  // Navigation pass: sidebar/menu items in this app have NO semantics nodes of
  // their own (only the root contains them), but each such click triggers a
  // route change within ~2s -- and the destination path names the menu item
  // (Dashboard, Orders, Collections, ...). Label these clicks as navigation.
  // One-to-one: each navigation explains only the LAST unresolved click before
  // it (within the window). Walking clicks in REVERSE and consuming nav events
  // prevents two rapid clicks from both claiming the same route change.
  // URL -> on-screen page title. Primary source: pageTitle events (the first
  // <span> of the mounted view, captured on every route change -- e.g.
  // /customer-door shows "Locker Box"). Fallback for older recordings: the
  // header node of a semanticsTree snapshot (labeled node in the top-left
  // corner of the view).
  const titleByUrl = {};   // path -> title
  const titleSrc = {};     // path -> which technique produced the title
  evs.forEach((e) => {
    if (e.type === "pageTitle" && e.url && e.title) {
      titleByUrl[normUrl(e.url)] = e.title;
      titleSrc[normUrl(e.url)] = "pageTitle event (first <span> of mounted view)";
    }
  });
  // Fallback #1 (older recordings without pageTitle events): a root/container
  // click captures the view's concatenated text, which STARTS with the
  // on-screen title -- spans join without separators, so the title ends at the
  // first lowercase->uppercase seam ("Locker BoxStatus..." -> "Locker Box").
  evs.forEach((e) => {
    if (e.type !== "interaction" || !e.data || !e.data.url) return;
    const key = normUrl(e.data.url);
    if (titleByUrl[key]) return; // pageTitle wins
    // Only ROOT/container clicks qualify: their text is the whole view dump
    // (starts with the title). A click on an individual widget ("History"
    // button) must NOT donate its own text as the page title.
    const tag = String(e.data.tagName || "");
    const t = String(e.data.text || "");
    if (tag !== "FLUTTER-VIEW" && t.length < 60) return;
    const m = t.match(/^([A-Z][a-z]+(?:[ -][A-Z]?[a-z]+)*)(?=[A-Z]|$)/);
    if (m && m[1].length <= 40) {
      titleByUrl[key] = m[1].trim();
      titleSrc[key] = "prefix of root-click text dump (case-seam split)";
    }
  });
  // Fallback #2: the header node of a semanticsTree snapshot (labeled node in
  // the top-left corner). Less reliable than the text prefix (tab bars can sit
  // in the same region), so it only fills remaining gaps.
  evs.forEach((e) => {
    if (e.type !== "semanticsTree" || !e.url) return;
    const key = normUrl(e.url);
    if (titleByUrl[key]) return;
    const header = (e.nodes || []).find((n) =>
      n.label && n.rect && n.rect.y < 80 && n.rect.x < 400 && n.label.length <= 40);
    if (header) {
      titleByUrl[key] = header.label;
      titleSrc[key] = `semanticsTree header node ${header.id} (top-left labeled node)`;
    }
  });

  const NAV_WINDOW_MS = 2000;
  const consumedNav = new Set();
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (!isFlutterClickCandidate(ev) || ev.__sem) continue;
    if (ev.subtype !== "click") continue;
    const t = ev.relativeTime || 0;
    for (let j = i + 1; j < evs.length; j++) {
      const nx = evs[j];
      const nt = nx.relativeTime || 0;
      if (nt - t > NAV_WINDOW_MS) break;
      // A later click intervened -> this navigation belongs to that click.
      if (nx.type === "interaction" && nx.subtype === "click") break;
      if ((nx.type === "tabNavigated" || nx.type === "historyChange") && nx.url && !consumedNav.has(j)) {
        const from = (ev.data && ev.data.url) || "";
        if (nx.url !== from) {
          consumedNav.add(j);
          const key = normUrl(nx.url);
          const named = titleByUrl[key];
          ev.__nav = {
            url: nx.url,
            name: named || routeName(nx.url),
            dbg: `${nx.type} +${fmtDur(nt - t)} after click; name via ${named ? titleSrc[key] : "URL path segment (no title found for route)"}`
          };
        }
        break;
      }
    }
  }
}

// Normalize a URL to its path (ignore hash/query jitter) for title lookup.
function normUrl(u) {
  try { return new URL(u).pathname; } catch (e) { return u || ""; }
}

// Human name of a route: first path segment, prettified.
// /orders/preparing -> Orders, /item_refill/items -> Item Refill.
function routeName(u) {
  try {
    const seg = (new URL(u).pathname.split("/").filter(Boolean)[0] || "");
    if (!seg) return "Home";
    return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch (e) { return u; }
}

// ---- state -------------------------------------------------------------------
let recording = null;
let events = [];                 // filtered, sorted action events (no rrweb)
const hiddenKinds = new Set();   // kinds currently OFF
let tabFilter = "";
let searchQ = "";
// Debug mode: show the technical semantics node id (flt-semantic-node-N) on
// resolved clicks. Default OFF -> clicks read "Clicked node -> LABEL".
let debugMode = false;
const collapsedSteps = new Set();
// Fold to tabs: collapse the detail rows so the log reads as the tab-switch
// sequence only -- which app was in front, and for how long.
let foldTabs = false;
const collapsedLanes = new Set();

// ---- build -------------------------------------------------------------------
function passesFilters(ev) {
  const kind = kindOf(ev);
  // Chip filter (grouped)
  // SOP steps and notes are structure, not a filterable event type: they have
  // no chip, and grouping them under "Other" meant switching Other off erased
  // the step headers the whole timeline is organised by.
  if (kind === "sop" || kind === "note") return true;
  const group = CHIP_GROUPS.find((g) => g.kinds.includes(kind));
  if (group && hiddenKinds.has(group.k)) return false;
  if (!group && hiddenKinds.has("misc")) return false;
  // Tab filter
  if (tabFilter !== "" && String(ev.tabId) !== tabFilter) return false;
  // Search
  if (searchQ) {
    const dsc = describe(ev);
    const hay = (dsc.lead + " " + dsc.sub + " " + (ev.actionLabel || "") + " " + (ev.url || "") + " " + (ev.__sem ? ev.__sem.id : "")).toLowerCase();
    if (!hay.includes(searchQ)) return false;
  }
  return true;
}

function render() {
  const log = document.getElementById("log");
  log.innerHTML = "";

  const visible = events.filter(passesFilters);
  if (!visible.length) {
    log.innerHTML = `<div id="empty">No events match the current filters.</div>`;
    return;
  }
  if (foldTabs) { renderTabLanes(log, visible); return; }

  // Group by SOP step, preserving order. Events before any step -> "Unassigned".
  const groups = [];        // { key, label, items:[] }
  const byKey = {};
  visible.forEach((ev) => {
    const key = ev.sopStep || "__none__";
    const label = ev.type === "sopStep" ? null : null;
    if (!byKey[key]) {
      const g = { key, label: stepLabelFor(key), items: [] };
      byKey[key] = g; groups.push(g);
    }
    byKey[key].items.push(ev);
  });

  const frag = document.createDocumentFragment();
  groups.forEach((g) => {
    const section = document.createElement("div");
    section.className = "step-group" + (collapsedSteps.has(g.key) ? " collapsed" : "");

    const head = document.createElement("div");
    head.className = "step-head";
    head.innerHTML =
      `<span class="caret">\u25BC</span>` +
      (g.key === "__none__" ? `<span class="badge" style="background:#5b6472">\u2014</span>` : `<span class="badge">SOP</span>`) +
      `<span class="title">${esc(g.label)}</span>` +
      `<span class="count">${g.items.length} event${g.items.length === 1 ? "" : "s"}</span>`;
    head.addEventListener("click", () => {
      if (collapsedSteps.has(g.key)) collapsedSteps.delete(g.key); else collapsedSteps.add(g.key);
      render();
    });
    section.appendChild(head);

    const bodyEl = document.createElement("div");
    bodyEl.className = "step-body";
    let prevT = null;
    g.items.forEach((ev) => {
      // Pause divider between consecutive actions
      if (prevT != null) {
        const gap = ev.relativeTime - prevT;
        if (gap >= PAUSE_MS) {
          const gd = document.createElement("div");
          gd.className = "gap" + (gap >= LONG_MS ? " long" : "");
          gd.textContent = `\u23F1 ${fmtDur(gap)} pause`;
          bodyEl.appendChild(gd);
        }
      }
      prevT = ev.relativeTime;
      bodyEl.appendChild(rowEl(ev));
    });
    section.appendChild(bodyEl);
    frag.appendChild(section);
  });
  log.appendChild(frag);
}


// A "lane" is one uninterrupted stretch on a single tab. Consecutive events on
// the same tab belong to the same lane; a tab switch starts a new one, so the
// lane heads alone read as the session's switch sequence.
function renderTabLanes(log, visible) {
  const lanes = [];
  visible.forEach((ev) => {
    const last = lanes[lanes.length - 1];
    if (last && String(last.tabId) === String(ev.tabId)) last.items.push(ev);
    else lanes.push({ tabId: ev.tabId, key: `${lanes.length}:${ev.tabId}`, items: [ev] });
  });

  const frag = document.createDocumentFragment();
  lanes.forEach((lane) => {
    const first = lane.items[0];
    const last = lane.items[lane.items.length - 1];
    const span = (last.relativeTime || 0) - (first.relativeTime || 0);
    const collapsed = foldTabs ? !collapsedLanes.has(lane.key) : collapsedLanes.has(lane.key);

    const el = document.createElement("div");
    el.className = "tab-lane" + (collapsed ? " collapsed" : "");

    const head = document.createElement("div");
    head.className = "tab-lane-head";
    head.tabIndex = 0;
    head.innerHTML =
      `<span class="caret">\u25BC</span>` +
      `<span class="swatch"></span>` +
      `<span class="name">${esc(tabName(lane.tabId))}</span>` +
      `<span class="when">${fmtWall(first.relativeTime || 0) || fmtClock(first.relativeTime || 0)}` +
      (fmtWall(first.relativeTime || 0) ? ` \u00B7 +${fmtClock(first.relativeTime || 0)}` : "") +
      (span >= 1000 ? ` \u00B7 ${fmtDur(span)}` : "") + `</span>` +
      `<span class="count">${lane.items.length} event${lane.items.length === 1 ? "" : "s"}</span>`;
    const toggle = () => {
      if (collapsedLanes.has(lane.key)) collapsedLanes.delete(lane.key);
      else collapsedLanes.add(lane.key);
      render();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    el.appendChild(head);

    const body = document.createElement("div");
    body.className = "tab-lane-body";
    lane.items.forEach((ev) => body.appendChild(rowEl(ev)));
    el.appendChild(body);
    frag.appendChild(el);
  });
  log.appendChild(frag);
}

// Draggable split between the video and the timeline. Only active once a video
// is actually shown -- without one the timeline owns the whole pane.
function initSplitter() {
  const pane = document.getElementById("videoPane");
  const bar = document.getElementById("dragbar");
  if (!pane.classList.contains("on")) return;
  bar.classList.add("on");

  // body { zoom } scales pointer coordinates but not offsetHeight, so convert
  // the pointer delta back into layout pixels before writing a height.
  const ZOOM = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const maxH = () => window.innerHeight / ZOOM - 200;
  const clamp = (px) => Math.max(120, Math.min(maxH(), px));
  const setH = (px) => { pane.style.height = clamp(px) + "px"; };

  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    setH((e.clientY - pane.getBoundingClientRect().top) / ZOOM);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("dragging");
    document.body.classList.remove("resizing");
  };
  bar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    bar.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);

  // Keyboard: the handle is focusable, so arrows resize in 24px steps.
  bar.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 72 : 24;
    if (e.key === "ArrowUp") { e.preventDefault(); setH(pane.offsetHeight - step); }
    if (e.key === "ArrowDown") { e.preventDefault(); setH(pane.offsetHeight + step); }
  });
}

function rowEl(ev) {
  const kind = kindOf(ev);
  const dsc = describe(ev);
  const row = document.createElement("div");
  row.className = "row";
  // Timeline -> video: every row knows its own moment, so a click seeks.
  row.dataset.t = ev.relativeTime || 0;
  row.addEventListener("click", () => {
    if (!videoReady || !videoEl) return;
    videoEl.currentTime = eventToVideoTime(ev);
    videoEl.play().catch(() => {});
  });
  const tabPill = (ev.tabId != null && Object.keys(recording.tabs || {}).length > 1)
    ? `<span class="tab-pill">${esc(tabName(ev.tabId))}</span>` : "";
  row.innerHTML =
    `${timeCellHTML(ev.relativeTime || 0)}` +
    `<span class="ico ${kind}">${ICON[kind] || "\u2022"}</span>` +
    `<span class="body"><span class="lead">${dsc.lead}${tabPill}</span>` +
    (dsc.sub ? `<span class="sub">${esc(dsc.sub)}</span>` : "") +
    (dsc.dbg ? `<span class="dbg">${esc(dsc.dbg)}</span>` : "") +
    `</span>` +
    `<span class="meta">${esc(kind)}</span>`;
  return row;
}

function stepLabelFor(key) {
  if (key === "__none__") return "Before first SOP step";
  const st = (recording.sopSteps || []).find((s) => s.id === key);
  return st ? st.label : key;
}

// ---- header + toolbar --------------------------------------------------------
function renderStats() {
  const all = events;
  const clicks = all.filter((e) => kindOf(e) === "click").length;
  const inputs = all.filter((e) => kindOf(e) === "input").length;
  const steps = all.filter((e) => e.type === "sopStep").length;
  const navs = all.filter((e) => kindOf(e) === "nav").length;
  const dur = all.length ? Math.max(...all.map((e) => e.relativeTime || 0)) : 0;
  const nTabs = Object.keys(recording.tabs || {}).length || 1;
  document.getElementById("stats").innerHTML =
    `<span>Duration <b>${fmtDur(dur)}</b></span>` +
    `<span>SOP steps <b>${steps}</b></span>` +
    `<span>Tabs <b>${nTabs}</b></span>`;
}

function renderChips() {
  const wrap = document.getElementById("chips");
  wrap.innerHTML = "";
  CHIP_GROUPS.forEach((g) => {
    // Only show a chip if the recording actually has such events.
    const has = events.some((e) => g.kinds.includes(kindOf(e)));
    if (!has) return;
    const chip = document.createElement("span");
    chip.className = "chip" + (hiddenKinds.has(g.k) ? "" : " on");
    chip.dataset.k = g.k;
    const n = events.filter((e) => g.kinds.includes(kindOf(e))).length;
    chip.textContent = `${g.label} (${n})`;
    chip.addEventListener("click", () => {
      if (hiddenKinds.has(g.k)) hiddenKinds.delete(g.k); else hiddenKinds.add(g.k);
      chip.classList.toggle("on");
      render();
    });
    wrap.appendChild(chip);
  });
}

function renderTabFilter() {
  const sel = document.getElementById("tabFilter");
  const tabs = recording.tabs || {};
  Object.keys(tabs).forEach((id) => {
    const o = document.createElement("option");
    o.value = id;
    const t = tabs[id];
    o.textContent = tabName(Number(id)) !== `tab ${id}`
      ? tabName(Number(id))
      : `Tab ${id}` + (t && t.title ? ` — ${t.title.slice(0, 30)}` : "");
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => { tabFilter = sel.value; render(); });
}

function buildCopyText() {
  const lines = [];
  lines.push(`# Session timeline — ${recording.id}`);
  lines.push(`Duration: ${fmtDur(Math.max(0, ...events.map((e) => e.relativeTime || 0)))}`);
  lines.push("");
  let lastStep = "\u0000";
  events.filter(passesFilters).forEach((ev) => {
    const key = ev.sopStep || "__none__";
    if (key !== lastStep) { lines.push(`\n== ${stepLabelFor(key)} ==`); lastStep = key; }
    const dsc = describe(ev);
    const plain = (dsc.lead + (dsc.sub ? ` — ${dsc.sub}` : ""))
      .replace(/<[^>]+>/g, "");
    lines.push(`[${fmtTime(ev.relativeTime || 0)}] ${plain}`);
    if (dsc.dbg) lines.push(`    [why] ${dsc.dbg}`);
  });
  return lines.join("\n");
}

// ---- init --------------------------------------------------------------------
async function init() {
  const { name: srcName, id } = sourceFor();
  const log = document.getElementById("log");
  if (!id) { log.innerHTML = `<div id="empty">No recording id in the URL.</div>`; return; }

  const source = SOURCES[srcName];
  if (!source) {
    log.innerHTML = `<div id="empty">Unknown session source "${esc(srcName)}".</div>`;
    return;
  }

  let loaded;
  try {
    loaded = await source.load(id);
  } catch (e) {
    log.innerHTML = `<div id="empty">Could not load recording: ${esc(e.message || e)}</div>`;
    return;
  }
  if (!loaded) { log.innerHTML = `<div id="empty">Recording not found.</div>`; return; }

  // The rest of the player reads `recording`; keep that shape so the loader is
  // the only thing that knows about sources.
  recording = {
    id: loaded.meta.id,
    startTime: loaded.meta.startTime,
    endTime: loaded.meta.endTime,
    recorder: loaded.meta.recorder,
    imported: loaded.meta.imported,
    ticket: loaded.meta.ticket,
    videoStartOffset: loaded.meta.videoStartOffset,
    events: loaded.events,
    tabs: loaded.tabs,
    sopSteps: loaded.sopSteps,
    video: loaded.video
  };
  currentSource = loaded;
  renderProvenance(loaded.meta);

  events = (recording.events || [])
    .filter((e) => e.type !== "rrweb")           // lean mode: no DOM stream anyway
    .sort((a, b) => (a.relativeTime || 0) - (b.relativeTime || 0));

  // Resolve every Flutter click to its semantics node id + ground-truth label.
  resolveFlutterClicks(events);

  CHIP_GROUPS.forEach((g) => {
    if (!DEFAULT_VISIBLE.has(g.k)) hiddenKinds.add(g.k);
  });

  renderStats();
  renderChips();
  renderTabFilter();
  render();
  loadVideo().then(() => { initSplitter(); initFollow(); });

  document.getElementById("search").addEventListener("input", (e) => {
    searchQ = e.target.value.trim().toLowerCase(); render();
  });
  const foldBtn = document.getElementById("foldTabs");
  foldBtn.addEventListener("click", () => {
    foldTabs = !foldTabs;
    collapsedLanes.clear();
    foldBtn.textContent = foldTabs ? "Unfold tabs" : "Fold to tabs";
    foldBtn.classList.toggle("active", foldTabs);
    render();
  });

  const dbgBtn = document.getElementById("debugToggle");
  dbgBtn.addEventListener("click", () => {
    debugMode = !debugMode;
    dbgBtn.textContent = debugMode ? "Debug: on" : "Debug: off";
    dbgBtn.classList.toggle("active", debugMode);
    render();
  });
  document.getElementById("copyLog").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(buildCopyText());
      const b = document.getElementById("copyLog"); const o = b.textContent;
      b.textContent = "Copied!"; setTimeout(() => (b.textContent = o), 1200);
    } catch (e) { alert("Copy failed: " + (e.message || e)); }
  });
}

init();
