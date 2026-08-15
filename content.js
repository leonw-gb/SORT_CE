// content.js - Captures user interactions + rrweb DOM recording + SOP step-tagger
// Loaded with run_at=document_start. lib/rrweb.min.js is loaded before this file.

// Guard: with programmatic re-injection (orphan recovery) this file can be
// evaluated twice in the same page. The second evaluation must be a no-op.
if (window.__mtrContentLoaded) {
  throw new Error("multi-tab-recorder content script already loaded (harmless)");
}
window.__mtrContentLoaded = true;

let currentRecordingId = null;
let rrwebStopFn = null;
let taggerMounted = false;
let currentSopStep = null;
let currentSteps = null;

// ---- SOP step definitions ----------------------------------------------------
// Edit this list to match your real SOP. These are the default phases of a
// generic troubleshooting workflow. The expert clicks one as they progress;
// every event recorded after that click is labeled with the active step.
const DEFAULT_SOP_STEPS = [
  { id: "observe",  label: "1 - Observe / reproduce" },
  { id: "diagnose", label: "2 - Diagnose root cause" },
  { id: "plan",     label: "3 - Apply fix" },
  { id: "apply",    label: "4 - Verify resolved / close" }
];

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "initializeRecorder") {
    initialize(message.recordingId, message.sopSteps);
  } else if (message.type === "updateSopSteps") {
    // Live update of the tagger's step list while recording
    currentSteps = message.sopSteps && message.sopSteps.length ? message.sopSteps : DEFAULT_SOP_STEPS;
    rebuildTaggerSteps();
  } else if (message.type === "teardownRecorder") {
    teardown();
  }
});

function teardown() {
  stopCanvasFrameLoop();
  stopVideoFrameLoop();
  // Stop rrweb
  if (typeof rrwebStopFn === "function") {
    try { rrwebStopFn(); } catch (e) {}
    rrwebStopFn = null;
  }
  // Tell the page-world WS hook to stop streaming frames.
  try { stopWsBridge(); } catch (e) {}
  // Remove the floating tagger
  const root = document.getElementById("sop-tagger-root");
  if (root) root.remove();
  taggerMounted = false;
  currentRecordingId = null;
  currentSopStep = null;
}

function initialize(recordingId, sopSteps) {
  currentSteps = sopSteps && sopSteps.length ? sopSteps : DEFAULT_SOP_STEPS;
  if (currentRecordingId === recordingId) {
    // Already recording this session (e.g. re-init after navigation) — just refresh steps.
    rebuildTaggerSteps();
    return;
  }
  currentRecordingId = recordingId;

  // LEAN MODE (v2.0): visual replay is handled by a separate screen recorder.
  // This extension now records ONLY the action/timeline data: clicks, inputs,
  // navigation, tab switches, network/WS ground truth, SOP tags. No rrweb DOM
  // stream, no canvas/video frame capture -> small files, no replay bugs.
  startCustomRecorder(recordingId);
  whenBodyReady(() => {
    mountTagger(recordingId, currentSteps);
    // Still needed: Flutter semantics gives real labels to click targets.
    enableFlutterSemantics();
    // Ground-truth widget map (Flutter pages): first dump after semantics builds.
    scheduleSemanticsTree(recordingId, "start");
  });
}

// rrweb takes its ONE initial full snapshot the instant record() is called. If
// recording starts on the login page, that snapshot is the login DOM; the app
// then auto-navigates to the feed, and the feed route replays only from
// incremental mutations layered on the login snapshot. Evidence shows a session
// that STARTED on the feed replays every route fine, so incremental replay is
// reliable ONCE a good base exists. To give login-start sessions that same
// good base, we take exactly ONE additional full snapshot after the first app
// view has settled (non-empty, stable body). This is a single, well-timed
// snapshot - NOT a per-route checkout - so it doesn't trigger the mid-stream
// checkout blank-replay problem.
let baseSnapshotDone = false;
let routeChangedSinceStart = false;
function scheduleBaseSnapshotOnce() {
  if (baseSnapshotDone) return;
  if (!(window.rrweb && window.rrweb.record && window.rrweb.record.takeFullSnapshot)) return;
  // ONLY arm this for sessions that START on the login page. A session that
  // starts anywhere in the app already has a good base snapshot, and ANY later
  // route change (e.g. clicking History) would otherwise fire a mid-stream
  // full snapshot -- which is exactly the thing that turns the replay white
  // from that point on. Evidence: test B (start on feed, click History) went
  // white at the History click with the previous gate.
  // DISABLED (v1.24.0): mid-stream full snapshots re-serialize the DOM with
  // fresh node ids; the replayer then hits "Node with id ... not found" and
  // mutation exceptions -> artifacts/misplaced elements after login (test A).
  // The original login-start whiteness this tried to fix was actually caused
  // by the recorder's t.matches crash (fixed in v1.23.0), so pure incremental
  // recording is both sufficient and the only mode that replays cleanly.
  baseSnapshotDone = true; return;
  let attempts = 0, lastSize = -1, stable = 0;
  const check = () => {
    if (baseSnapshotDone) return;
    // Only needed when the view changed AFTER recording began (login -> app
    // auto-navigation). If no route change happened, the initial snapshot is
    // already the app view -> taking another is pointless and risks a
    // mid-stream rebuild, so we keep waiting (capped) and skip if it never navigates.
    attempts += 1;
    let size = 0;
    try { size = document.body ? (document.body.innerHTML || "").length : 0; } catch (e) {}
    if (size > 500 && size === lastSize) stable += 1; else stable = 0;
    lastSize = size;
    if (!routeChangedSinceStart) {
      if (attempts >= 20) { baseSnapshotDone = true; return; } // never navigated: skip
      setTimeout(check, 400); return;
    }
    // On a video-feed route, also require the player's <video> to be mounted so
    // the snapshot captures the feed component (not an empty shell -> white).
    let feedReady = true;
    try { if (isVideoFeedPage()) feedReady = hasPlayableVideo(); } catch (e) {}
    if ((size > 500 && feedReady && stable >= 2) || attempts >= 40) {
      baseSnapshotDone = true;
      // isCheckout=false: this is an ADDITIONAL full snapshot on the same
      // event stream, not a checkout boundary. It gives the replayer a fresh,
      // complete DOM state to apply subsequent mutations onto.
      try { window.rrweb.record.takeFullSnapshot(); } catch (e) {}
      return;
    }
    setTimeout(check, 400);
  };
  setTimeout(check, 400);
}

function whenBodyReady(cb) {
  if (document.body) return cb();
  document.addEventListener("DOMContentLoaded", cb, { once: true });
}

// ---- Flutter (CanvasKit) support ---------------------------------------------
// Flutter web paints the whole UI onto a <canvas>; the DOM is an empty shell.
// Two consequences for us:
//  1. Visual replay needs canvas snapshots (rrweb recordCanvas + the WebGL
//     preserveDrawingBuffer wrap installed by ws-hook.js in the page world).
//  2. There are no DOM labels -- but Flutter ships an invisible accessibility
//     ("semantics") tree it builds on demand. We activate it exactly the way a
//     screen reader does: by clicking the flt-semantics-placeholder. After
//     that, every widget gets a positioned flt-semantics node with role +
//     aria-label, which our click capture can resolve into real action labels.
function isFlutterPage() {
  return !!document.querySelector("flutter-view, flt-glass-pane");
}

function enableFlutterSemantics() {
  if (!isFlutterPage()) return;
  const ph = document.querySelector("flt-semantics-placeholder");
  if (!ph) return; // already enabled (placeholder is removed on activation)
  try {
    ph.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  } catch (e) { /* ignore */ }
  // Flutter builds the tree asynchronously; nothing else to do -- semantics
  // nodes appear under flt-semantics-host and become the click targets.
}

// ---- Flutter canvas frame capture --------------------------------------------
// rrweb's built-in canvas sampler (sampling.canvas) locates canvases with
// document.querySelectorAll('canvas'), which does NOT pierce shadow roots.
// Flutter's CanvasKit canvas lives inside the shadow root of flt-glass-pane,
// so the sampler never finds it -> zero canvas frames -> white replay.
// This loop finds canvases through shadow roots and emits frames as rrweb
// custom events ("canvasFrame"), which player.js paints back onto the replayed
// canvas. Readback works because ws-hook.js forces preserveDrawingBuffer:true.
let canvasFrameTimer = null;
let flutterDetectTimer = null;
// Adaptive sampling: popups and dialogs appear right after user input, so we
// capture at BURST rate (10 fps) for a short window after every click/key/
// scroll, and at IDLE rate otherwise. Unchanged frames are deduped below, so
// the extra ticks only cost data when pixels actually changed.
const CANVAS_IDLE_MS = 250;         // ~4 fps baseline (was 500ms / 2 fps)
const CANVAS_BURST_MS = 100;        // ~10 fps right after user input
const BURST_WINDOW_MS = 2000;       // keep bursting this long after the last input
let burstUntil = 0;                 // timestamp until which we sample at burst rate
let lastCaptureAt = 0;
const lastCanvasFrame = new WeakMap(); // canvas -> last dataURL (skip unchanged)

// Any user input on a Flutter page = a popup/transition may be imminent.
function noteUserActivity() {
  burstUntil = Date.now() + BURST_WINDOW_MS;
}

function findCanvasesDeep(root, out) {
  out = out || [];
  if (!root || !root.querySelectorAll) return out;
  root.querySelectorAll("canvas").forEach((c) => out.push(c));
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) findCanvasesDeep(el.shadowRoot, out);
  });
  return out;
}

function captureCanvasFrames() {
  if (document.hidden) return;
  const mirror = window.rrweb.record.mirror;
  if (!mirror || !mirror.getId) return;
  findCanvasesDeep(document).forEach((canvas) => {
    if (!canvas.width || !canvas.height) return;
    let dataURL;
    try {
      dataURL = canvas.toDataURL("image/webp", 0.5);
    } catch (e) {
      return; // tainted canvas etc.
    }
    if (!dataURL || dataURL === "data:," || lastCanvasFrame.get(canvas) === dataURL) return;
    lastCanvasFrame.set(canvas, dataURL);
    const id = mirror.getId(canvas);
    if (id == null || id === -1) return; // not (yet) in the rrweb mirror
    try {
      window.rrweb.record.addCustomEvent("canvasFrame", { id, dataURL });
    } catch (e) { /* recording stopped */ }
  });
}

function startCanvasFrameLoop() {
  if (canvasFrameTimer) return;
  if (!window.rrweb || !window.rrweb.record || !window.rrweb.record.addCustomEvent) return;
  // Every user input primes a 2s burst window so the frames bracketing a
  // popup's appearance are captured, not skipped.
  ["pointerdown", "pointerup", "click", "keydown", "wheel", "touchstart"].forEach((t) => {
    document.addEventListener(t, noteUserActivity, { capture: true, passive: true });
  });
  // Tick at the burst rate; skip ticks while idle so CPU stays low between
  // interactions. Dedup above means unchanged frames never hit the payload.
  canvasFrameTimer = setInterval(() => {
    const now = Date.now();
    const interval = now < burstUntil ? CANVAS_BURST_MS : CANVAS_IDLE_MS;
    if (now - lastCaptureAt < interval - CANVAS_BURST_MS / 2) return;
    lastCaptureAt = now;
    captureCanvasFrames();
  }, CANVAS_BURST_MS);
}

function stopCanvasFrameLoop() {
  if (canvasFrameTimer) {
    clearInterval(canvasFrameTimer); canvasFrameTimer = null;
    ["pointerdown", "pointerup", "click", "keydown", "wheel", "touchstart"].forEach((t) => {
      document.removeEventListener(t, noteUserActivity, { capture: true });
    });
  }
  if (flutterDetectTimer) { clearInterval(flutterDetectTimer); flutterDetectTimer = null; }
}

// Flutter bootstraps asynchronously: <flutter-view> may not exist yet when we
// initialize. Poll briefly; start the frame loop as soon as Flutter appears.
// Non-Flutter pages (Scheduler Dashboard) never start the loop -> zero overhead.
function watchForFlutterCanvas() {
  if (flutterDetectTimer) return;
  // SPA-safe: a Flutter view can appear after a client-side route change, so we
  // poll persistently and start the canvas loop the moment one shows up.
  const tick = () => { if (isFlutterPage()) startCanvasFrameLoop(); };
  tick();
  flutterDetectTimer = setInterval(tick, 1000);
}

function emit(recordingId, event) {
  chrome.runtime.sendMessage({
    type: "recordEvent",
    recordingId,
    event: { ...event, sopStep: currentSopStep }
  }).catch(() => {});
}

// ---- <video> feed frame capture --------------------------------------------
// Camera pages render the live stream into an HTML <video> element fed by a
// blob:/MSE/WebRTC source. rrweb records the <video> TAG but never its pixels,
// and the blob URL dies with the session -> replay shows the UI but a BLACK
// video. To make the feed visible offline we periodically draw the <video>'s
// current frame onto an offscreen canvas, encode it as webp, and emit it as an
// rrweb custom event ("videoFrame"). player.js paints these onto an overlay
// positioned over the replayed <video>.
//
// Approved capture settings: ~5 fps steady, webp quality 0.5.
let wsSuppressedForVideo = false;
let videoFrameTimer = null;
let videoDetectTimer = null;
const VIDEO_FRAME_MS = 200;         // ~5 fps steady
const VIDEO_QUALITY = 0.5;          // webp, matches canvas frames
const videoScratch = document.createElement("canvas");
const lastVideoFrame = new WeakMap(); // video -> last dataURL (skip unchanged)

function findVideosDeep(root, out) {
  out = out || [];
  if (!root || !root.querySelectorAll) return out;
  root.querySelectorAll("video").forEach((v) => out.push(v));
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) findVideosDeep(el.shadowRoot, out);
  });
  return out;
}

function hasPlayableVideo() {
  return findVideosDeep(document).some(
    (v) => v.videoWidth > 0 && v.videoHeight > 0
  );
}

function captureVideoFrames() {
  if (document.hidden) return;
  const mirror = window.rrweb && window.rrweb.record && window.rrweb.record.mirror;
  if (!mirror || !mirror.getId) return;
  findVideosDeep(document).forEach((video) => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;                 // metadata not ready / no frame yet
    if (video.readyState < 2) return;     // HAVE_CURRENT_DATA
    let dataURL;
    try {
      // Cap the encoded size: downscale very large feeds to <=640px wide.
      const scale = w > 640 ? 640 / w : 1;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      if (videoScratch.width !== cw) videoScratch.width = cw;
      if (videoScratch.height !== ch) videoScratch.height = ch;
      const ctx = videoScratch.getContext("2d");
      ctx.drawImage(video, 0, 0, cw, ch);
      dataURL = videoScratch.toDataURL("image/webp", VIDEO_QUALITY);
    } catch (e) {
      return; // tainted (cross-origin) source etc.
    }
    if (!dataURL || dataURL === "data:," || lastVideoFrame.get(video) === dataURL) return;
    lastVideoFrame.set(video, dataURL);
    const id = mirror.getId(video);
    if (id == null || id === -1) return; // not (yet) in the rrweb mirror
    try {
      window.rrweb.record.addCustomEvent("videoFrame", { id, dataURL, w, h });
    } catch (e) { /* recording stopped */ }
  });
}

function startVideoFrameLoop() {
  if (videoFrameTimer) return;
  if (!window.rrweb || !window.rrweb.record || !window.rrweb.record.addCustomEvent) return;
  videoFrameTimer = setInterval(captureVideoFrames, VIDEO_FRAME_MS);
}

function stopVideoFrameLoop() {
  if (videoFrameTimer) { clearInterval(videoFrameTimer); videoFrameTimer = null; }
  if (videoDetectTimer) { clearInterval(videoDetectTimer); videoDetectTimer = null; }
}

// A <video> feed may not exist / may not have frames yet when we initialize
// (the stream connects asynchronously). Poll briefly and start capturing as
// soon as a playable video appears. Pages with no video never start the loop.
function watchForVideoFeed() {
  if (videoDetectTimer) return;
  // The camera app is a single-page app (UniFi Protect): login -> dashboard ->
  // camera feed are all in-place route changes on ONE document. A <video> only
  // appears once the feed route is opened, possibly minutes after recording
  // starts. So we poll PERSISTENTLY (no give-up) and (re)start the capture loop
  // whenever a playable video appears. The frame loop itself no-ops on pages
  // with no video, so this is cheap.
  const tick = () => {
    if (hasPlayableVideo()) {
      // LEAN MODE: no frame capture; the detector only manages WS suppression.
      // On the live camera route, stop RELAYING WS media frames to the recorder
      // (they're binary/truncated and bloat the file). This never touches the
      // app's real traffic - only our postMessage relay.
      if (!wsSuppressedForVideo) { wsSuppressedForVideo = true; try { stopWsBridge(); } catch (e) {} }
    } else {
      stopVideoFrameLoop_soft(); // feed closed -> pause capture, keep watching
      // Left the feed: resume WS action capture for normal pages.
      if (wsSuppressedForVideo) {
        wsSuppressedForVideo = false;
        try { window.postMessage({ __mtrWsControl: "start" }, "*"); } catch (e) {}
      }
    }
  };
  tick();
  videoDetectTimer = setInterval(tick, 1000);
}

// Stop the capture loop but KEEP the detector running (used when the feed route
// is left, so we resume capturing if the user navigates back to a camera).
function stopVideoFrameLoop_soft() {
  if (videoFrameTimer) { clearInterval(videoFrameTimer); videoFrameTimer = null; }
}

// ---- rrweb DOM recording -----------------------------------------------------
// Defensive realm patch for the RECORDER. The Protect UI feeds rrweb's mutation
// observer nodes that lack Element APIs (shadow roots / text nodes reached via
// maskTextSelector + blockSelector parent walks). rrweb then throws
// "t.matches is not a function" INSIDE its MutationObserver callback, the
// observer dies, and from that moment NOTHING is recorded -> every view after
// the crash (History, back-to-live) replays white. Content scripts get their
// own prototype wrappers, and rrweb runs in THIS world, so patching here fixes
// rrweb without touching the page's own realm.
(function patchRecorderRealm() {
  try {
    const noop = function () { return false; };
    if (typeof Node !== "undefined" && !Node.prototype.matches) Node.prototype.matches = noop;
    if (typeof CharacterData !== "undefined" && !CharacterData.prototype.matches) CharacterData.prototype.matches = noop;
    if (typeof DocumentFragment !== "undefined" && !DocumentFragment.prototype.matches) DocumentFragment.prototype.matches = noop;
    if (typeof Document !== "undefined" && !Document.prototype.matches) Document.prototype.matches = noop;
    if (typeof ShadowRoot !== "undefined" && !ShadowRoot.prototype.matches) ShadowRoot.prototype.matches = noop;
    if (typeof Node !== "undefined" && !Node.prototype.closest) Node.prototype.closest = function () { return null; };
  } catch (e) { /* never break the page over this */ }
})();

function startRRWeb(recordingId) {
  // LEAN MODE: rrweb DOM recording disabled. Kept as a stub so init paths and
  // the player's data format stay compatible. Visual capture = external screen
  // recorder.
  emit(recordingId, { type: "rrwebStatus", available: false, leanMode: true });
}

// ---- SOP step-tagger UI ------------------------------------------------------
function buildStepButtons(recordingId, list, steps) {
  list.innerHTML = "";
  steps.forEach((step) => {
    const btn = document.createElement("button");
    btn.className = "sop-step-btn";
    btn.textContent = step.label;
    btn.dataset.stepId = step.id;
    if (currentSopStep === step.id) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentSopStep = step.id;
      list.querySelectorAll(".sop-step-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      emit(recordingId, {
        type: "sopStep",
        stepId: step.id,
        stepLabel: step.label,
        url: window.location.href
      });
    });
    list.appendChild(btn);
  });
}

function rebuildTaggerSteps() {
  const root = document.getElementById("sop-tagger-root");
  if (!root || !currentSteps) return;
  const list = root.querySelector(".sop-tagger-list");
  if (list) buildStepButtons(currentRecordingId, list, currentSteps);
}

function mountTagger(recordingId, steps) {
  if (taggerMounted) { rebuildTaggerSteps(); return; }
  taggerMounted = true;

  const root = document.createElement("div");
  root.id = "sop-tagger-root";
  root.className = "record-block record-ignore"; // keep out of rrweb capture

  const header = document.createElement("div");
  header.className = "sop-tagger-header";
  header.innerHTML = '<span class="sop-rec-dot"></span><span>Recording &middot; SOP step</span>';

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "sop-collapse";
  collapseBtn.textContent = "_";
  collapseBtn.title = "Collapse";
  header.appendChild(collapseBtn);

  const list = document.createElement("div");
  list.className = "sop-tagger-list";
  buildStepButtons(recordingId, list, steps);

  const noteWrap = document.createElement("div");
  noteWrap.className = "sop-note-wrap";
  const note = document.createElement("input");
  note.type = "text";
  note.className = "sop-note record-ignore";
  note.placeholder = "Add a note about this step (Enter)";
  note.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && note.value.trim()) {
      emit(recordingId, {
        type: "sopNote",
        stepId: currentSopStep,
        note: note.value.trim(),
        url: window.location.href
      });
      note.value = "";
      note.placeholder = "Note saved \u2713";
      setTimeout(() => (note.placeholder = "Add a note about this step (Enter)"), 1500);
    }
  });
  noteWrap.appendChild(note);

  collapseBtn.addEventListener("click", () => {
    root.classList.toggle("collapsed");
    collapseBtn.textContent = root.classList.contains("collapsed") ? "+" : "_";
  });

  root.appendChild(header);
  root.appendChild(list);
  root.appendChild(noteWrap);
  document.body.appendChild(root);
}

// ---- Lightweight structured event capture ------------------------------------
// ---- Input value capture -----------------------------------------------------
// Cleartext capture is ENABLED for training data. Only passwords are masked.
// To mask a specific field, add it to MASK_FIELD_BLOCKLIST or put
// [data-record-mask] on the element.
const MASK_FIELD_BLOCKLIST = [
  // "ssn", "creditcard"  <-- add field ids/names to force-mask here
];

function shouldMask(target) {
  if (!target || !target.tagName) return false;
  if (target.type === "password") return true;
  if (target.hasAttribute && target.hasAttribute("data-record-mask")) return true;
  const id = (target.id || "").toLowerCase();
  const name = (target.getAttribute && (target.getAttribute("name") || "")).toLowerCase();
  return MASK_FIELD_BLOCKLIST.some((f) => id === f.toLowerCase() || name === f.toLowerCase());
}

function maskValue(value) {
  if (value == null) return value;
  return "*".repeat(Math.min(String(value).length, 32));
}

function captureValue(target, type) {
  const isInputLike = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  if (isInputLike && (type === "input" || type === "change" || type === "submit")) {
    let raw = target.value;
    // For checkboxes/radios, value alone is not meaningful — record checked state.
    if (target.type === "checkbox" || target.type === "radio") {
      raw = target.checked ? (target.value || "on") : "";
    }
    return shouldMask(target) ? maskValue(raw) : raw;
  }
  // Non-input elements: capture a short label (button text, link text, etc.)
  const text = (target.textContent || "").trim();
  return text ? text.substring(0, 120) : null;
}

function startCustomRecorder(recordingId) {
  whenBodyReady(() => captureSnapshot(recordingId, "initial"));

  // Use capture phase + composedPath so we get the REAL target even inside
  // shadow DOM (event.target would otherwise be the shadow host).
  document.addEventListener("click", (e) => captureInteraction(recordingId, "click", e), true);
  // Only record the committed "change" (fires with the final value on blur /
  // Enter). We deliberately skip the noisy per-keystroke "input" events: typing
  // "100" would otherwise emit 1 -> 10 -> 100; the change event alone captures
  // the final value "100", which is all the training data needs.
  document.addEventListener("change", (e) => captureFinalValue(recordingId, e), true);
  // Fallback: some frameworks (Quasar q-input, custom components) don't fire a
  // native "change" reliably. Track input silently and flush a single final
  // value when typing pauses or the field loses focus -- but suppress it if a
  // native "change" already fired for that element (so we never double-record).
  document.addEventListener("input", (e) => scheduleInputFlush(recordingId, e), true);
  document.addEventListener("blur", (e) => flushInputNow(recordingId, e), true);
  document.addEventListener("submit", (e) => captureInteraction(recordingId, "submit", e), true);
  document.addEventListener("keydown", (e) => captureKey(recordingId, e), true);
  window.addEventListener("scroll", debounce(() => captureScroll(recordingId), 300), true);

  document.addEventListener("visibilitychange", () => {
    emit(recordingId, { type: "visibilityChange", hidden: document.hidden, url: window.location.href });
  });

  // On SPA route changes the recorder context stays alive, but a NEW view
  // (dashboard -> camera feed) may mount a <video>/Flutter canvas that our
  // one-time init never saw. The persistent detectors (watchFor*) already keep
  // polling, but we also nudge them here so capture starts promptly and, on the
  // camera feed route, WS media frames get suppressed.
  function onSpaRouteChange() {
    routeChangedSinceStart = true;
    // LEAN MODE: no canvas/video capture to (re)arm; just keep click labels
    // working on newly mounted Flutter views.
    try { enableFlutterSemantics(); } catch (e) {}
    try { scheduleSemanticsTree(recordingId, "route"); } catch (e) {}
    try { schedulePageTitle(recordingId); } catch (e) {}
    // NOTE: We deliberately do NOT inject a full snapshot on route changes.
    // Mid-stream checkout snapshots are a known cause of blank replays in rrweb
    // (the replayer rebuilds from the checkpoint and later incremental events
    // fail to apply). Evidence: a session that STARTED with the feed loaded
    // replays every route (login/history/live) correctly from incremental
    // mutations alone. So incremental replay is reliable here; the checkout was
    // the thing breaking the live route. The camera PIXELS come from our
    // videoFrame overlay, not the DOM snapshot, so no checkout is needed for the
    // feed to be visible.
    // Suppress WS relay if we just landed on a camera-feed route.
    try {
      if (!wsSuppressedForVideo) {
        setTimeout(() => {
          if (isVideoFeedPage()) {
            wsSuppressedForVideo = true;
            stopWsBridge();
          }
        }, 1500);
      }
    } catch (e) {}
  }

  // Detect SPA route changes (pushState/replaceState + popstate) so the JSON
  // records every URL the expert navigated to, even without a page reload.
  const op = window.history.pushState;
  const or = window.history.replaceState;
  window.history.pushState = function (...args) {
    const r = op.apply(this, args);
    emit(recordingId, { type: "historyChange", method: "pushState", url: window.location.href });
    onSpaRouteChange();
    return r;
  };
  window.history.replaceState = function (...args) {
    const r = or.apply(this, args);
    emit(recordingId, { type: "historyChange", method: "replaceState", url: window.location.href });
    onSpaRouteChange();
    return r;
  };
  window.addEventListener("popstate", () => {
    emit(recordingId, { type: "historyChange", method: "popstate", url: window.location.href });
    onSpaRouteChange();
  });

  window.addEventListener("hashchange", () => {
    emit(recordingId, { type: "historyChange", method: "hashchange", url: window.location.href });
    onSpaRouteChange();
  });

  // Safety net: some routers change the view without a history API call we can
  // wrap. Poll the URL so no route (and thus no fresh snapshot) is ever missed.
  let lastHref = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      emit(recordingId, { type: "historyChange", method: "poll", url: window.location.href });
      onSpaRouteChange();
    }
  }, 700);

  interceptNetworkRequests(recordingId);
  installWsBridge(recordingId);
  // Camera pages flood the WS relay with binary media frames; this persistent
  // detector suppresses the relay while a live <video> is on screen and
  // resumes it when the user leaves the feed. (Kept in lean mode for file size.)
  watchForVideoFeed();
}

// ---- NiceGUI WebSocket capture (ground-truth actions) ------------------------
// NiceGUI/Socket.IO sends every interaction over a WebSocket, NOT over fetch/XHR.
// A content script runs in an isolated world and cannot patch the page's own
// WebSocket. So we inject a tiny script into the PAGE world that wraps WebSocket
// and relays sent/received frames back to us via window.postMessage.
// A camera-feed page's WebSocket carries the video media stream (MSE/WebRTC
// chunks). Those frames are binary, truncated in-page, and CANNOT be
// reconstructed for offline replay -- they only bloat the recording (the
// 17MB / 2562-event sessions were ~99% these frames). We reconstruct the feed
// visually via videoFrame capture instead, so on video-feed pages we skip WS
// recording entirely. All other pages (NiceGUI/Socket.IO actions) keep it.
function isVideoFeedPage() {
  return hasPlayableVideo() ||
    findVideosDeep(document).some((v) => (v.currentSrc || v.src || "").startsWith("blob:"));
}

function installWsBridge(recordingId) {
  // Skip WS capture on video-feed pages (see isVideoFeedPage). We re-check on a
  // short delay too, since the <video> may attach its blob source a moment
  // after load.
  function maybeSuppress() {
    if (isVideoFeedPage()) {
      wsSuppressedForVideo = true;
      try { stopWsBridge(); } catch (e) {}
      emit(recordingId, {
        type: "wsBridgeStatus", installed: false,
        reason: "suppressed-video-feed-page", pageUrl: window.location.href
      });
      return true;
    }
    return false;
  }
  if (maybeSuppress()) return;
  // Video source can attach shortly after load; recheck and tear down if so.
  setTimeout(() => { if (!wsSuppressedForVideo) maybeSuppress(); }, 1500);

  // The page-world WebSocket hook (ws-hook.js) is already installed at
  // document_start via a MAIN-world content script (see manifest). It buffers
  // frames from page load. Here we just:
  //   1. Listen for relayed frames + the hook's install-confirmation, and
  //   2. Tell the hook to start streaming (and flush its buffer).
  let bridgeConfirmed = false;

  window.addEventListener("message", (e) => {
    if (!e.data || e.source !== window) return;

    // Hook confirmed alive -> record it so we can prove installation in JSON.
    if (e.data.__mtrWsStatus === true) {
      if (!bridgeConfirmed) {
        bridgeConfirmed = true;
        emit(recordingId, { type: "wsBridgeStatus", installed: true, pageUrl: window.location.href });
      }
      return;
    }

    // Actual WebSocket frame.
    if (e.data.__mtrWs === true) {
      if (wsSuppressedForVideo) return; // video-feed page: drop media frames
      emit(recordingId, {
        type: "websocket",
        direction: e.data.direction, // "send" | "receive"
        url: e.data.url || null,
        payload: e.data.payload,     // string (truncated in-page for safety)
        buffered: e.data.buffered === true, // true = captured before Start
        pageUrl: window.location.href
      });
    }
  });

  // Ask the page-world hook to start relaying (and flush its pre-Start buffer).
  try {
    window.postMessage({ __mtrWsControl: "start" }, "*");
  } catch (err) {
    emit(recordingId, { type: "wsBridgeStatus", installed: false, error: String(err) });
  }

  // If we never hear back from the hook, record that too (helps diagnose CSP /
  // world issues rather than leaving a silent zero).
  setTimeout(() => {
    if (!bridgeConfirmed) {
      emit(recordingId, { type: "wsBridgeStatus", installed: false, reason: "no-response-from-page-hook" });
    }
  }, 3000);
}

function stopWsBridge() {
  try { window.postMessage({ __mtrWsControl: "stop" }, "*"); } catch (e) {}
}

// Resolve the true event target, piercing shadow DOM via composedPath.
function realTarget(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : null;
  if (path && path.length && path[0] instanceof Element) return path[0];
  return event.target;
}

function describeTarget(target) {
  return {
    tagName: target.tagName,
    inputType: target.type || null,
    id: target.id || null,
    name: (target.getAttribute && target.getAttribute("name")) || null,
    className: typeof target.className === "string" ? target.className : null,
    ariaLabel: (target.getAttribute && target.getAttribute("aria-label")) || null,
    placeholder: (target.getAttribute && target.getAttribute("placeholder")) || null,
    text: visibleText(target),
    xpath: getXPath(target),
    selector: getSelector(target),
    // Semantic meaning of the control (Quasar/NiceGUI-aware). This is the key
    // training signal on component-based UIs where the raw target is a bare div.
    control: describeControl(target)
  };
}

// Text content of an element EXCLUDING <style>/<script> children. Flutter's
// <flutter-view> keeps its stylesheets as direct children, so a naive
// textContent would return CSS soup instead of a label.
function visibleText(target) {
  let t;
  if (target.querySelector && target.querySelector("style, script")) {
    const clone = target.cloneNode(true);
    clone.querySelectorAll("style, script").forEach((n) => n.remove());
    t = clone.textContent || "";
  } else {
    t = target.textContent || "";
  }
  t = t.replace(/\s+/g, " ").trim().substring(0, 300);
  return t || null;
}

// ---- Quasar / NiceGUI control resolver --------------------------------------
// On Quasar UIs the clickable "action" is a component (q-btn, q-item,
// q-expansion-item, q-tree node), and its human meaning lives in the icon name,
// the tooltip text, and the item label -- not in the raw clicked element.
// This walks up from the clicked node to the nearest recognizable control and
// extracts a stable, human-readable description.
const QUASAR_CONTROL_SELECTORS = [
  { sel: ".q-btn", role: "button" },
  { sel: ".q-item", role: "menu-item" },
  { sel: ".q-expansion-item__container", role: "expansion-item" },
  { sel: ".q-tree__node", role: "tree-node" },
  { sel: ".q-tab", role: "tab" },
  { sel: ".q-checkbox", role: "checkbox" },
  { sel: ".q-toggle", role: "toggle" },
  { sel: ".q-radio", role: "radio" },
  // NiceGUI module/status cards: title in .q-item__label, caption below it.
  { sel: ".q-card", role: "card" },
  { sel: "[role='button']", role: "button" },
  { sel: "a[href]", role: "link" }
];

// Deepest Flutter semantics element under the given viewport coordinates.
// Semantics nodes are absolutely positioned transparent divs stacked over the
// canvas; elementsFromPoint returns them even though pointer-events pass through.
function flutterSemanticsAt(x, y) {
  let best = null;
  if (document.elementsFromPoint) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "flt-semantics" || /^flt-semantics/.test(tag) || (el.id && el.id.indexOf("flt-semantic-node") === 0)) {
        // Prefer a node that carries a label (own aria-label, span text, or an
        // embedded text-field input's aria-label); else remember the first.
        if (semanticsLabel(el)) return el;
        if (!best) best = el;
      }
    }
  }
  // Rect fallback: the stack may only contain unlabeled container nodes (or
  // none at all). Pick the SMALLEST semantics node that carries a usable label
  // (aria-label OR visible text, e.g. <flt-semantics><span>DEMO</span>) whose
  // bounding box contains the click point -- that is the tapped widget.
  let bestRect = null;
  let bestArea = Infinity;
  document
    .querySelectorAll("flt-semantics, [id^='flt-semantic-node']")
    .forEach((el) => {
      const hasLabel = semanticsLabel(el);
      if (!hasLabel) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (area < bestArea) { bestArea = area; bestRect = el; }
      }
    });
  return bestRect || best;
}

// Direct text of a semantics node (its own <span> children), NOT the subtree.
// Flutter renders the label as <flt-semantics><span>LABEL</span></flt-semantics>;
// using textContent of the whole subtree would leak every descendant's label
// into container nodes, so only read direct span children here.
function semanticsText(el) {
  let t = "";
  for (const c of el.children || []) {
    if (c.tagName === "SPAN") t += " " + (c.textContent || "");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t || null;
}

// Flutter TEXT FIELDS render as <flt-semantics><input aria-label="..."
// data-semantics-role="text-field"></flt-semantics>: the label lives on the
// INPUT child, NOT on the semantics host. This finds that editable child.
function semanticsInput(el) {
  if (!el || !el.querySelector) return null;
  for (const c of el.children || []) {
    if (c.tagName === "INPUT" || c.tagName === "TEXTAREA") return c;
  }
  return el.querySelector("input[data-semantics-role], textarea[data-semantics-role]");
}

// Unified label for a semantics node: own aria-label > direct span text >
// the aria-label/placeholder of an embedded input/textarea (text fields).
function semanticsLabel(el) {
  if (!el) return null;
  const own = el.getAttribute && el.getAttribute("aria-label");
  if (own) return own;
  const txt = semanticsText(el);
  if (txt) return txt;
  const inp = semanticsInput(el);
  if (inp) {
    return inp.getAttribute("aria-label") || inp.getAttribute("placeholder") || null;
  }
  return null;
}

// Resolve a click on a Flutter semantics node into a control description.
// After semantics is enabled, Flutter positions <flt-semantics> elements over
// the canvas with role= and aria-label= describing the widget. If the click
// landed on flutter-view/flt-glass-pane directly (semantics off or a gap),
// fall back to locating the semantics node at the click's coordinates.
function describeFlutterControl(startEl) {
  if (!startEl.closest) return null;
  let node = startEl.closest("flt-semantics, [id^='flt-semantic-node']");
  if (!node) {
    // Click hit the glass pane; try the semantics node under the pointer.
    if (!startEl.closest("flutter-view, flt-glass-pane")) return null;
    node = null;
  }
  if (!node) return null;

  const labeledAncestor = node.closest("flt-semantics[aria-label], [id^='flt-semantic-node'][aria-label]");
  const semInput = semanticsInput(node) || (startEl.tagName === "INPUT" || startEl.tagName === "TEXTAREA" ? startEl : null);
  const label =
    semanticsLabel(node) ||
    (semInput && (semInput.getAttribute("aria-label") || semInput.getAttribute("placeholder"))) ||
    (node.querySelector("[aria-label]") &&
      node.querySelector("[aria-label]").getAttribute("aria-label")) ||
    (labeledAncestor && labeledAncestor.getAttribute("aria-label")) ||
    (labeledAncestor && semanticsText(labeledAncestor)) ||
    visibleText(node) ||
    null;
  const role =
    node.getAttribute("role") ||
    (semInput && (semInput.getAttribute("data-semantics-role") || "text-field")) ||
    (node.getAttribute("flt-tappable") != null ? "button" : null) ||
    "widget";

  return {
    role,
    icon: null,
    tooltip: null,
    label,
    active: node.getAttribute("aria-selected") === "true" || node.getAttribute("aria-pressed") === "true",
    quasarClasses: null,
    flutter: true
  };
}

// ---- Flutter semantics tree snapshots -----------------------------------------
// Ground truth for click resolution: a list of EVERY semantics node currently
// on screen (id, label, role, bounding rect). With this in the recording, any
// click can be re-matched to the right widget offline (by coordinates), even
// if the live label resolution picked the wrong node. Emitted on start, on SPA
// route changes and whenever the tree materially changes; deduped by hash so
// an unchanged tree costs nothing.
let semTreeTimer = null;
let lastSemTreeHash = null;
function collectSemanticsTree() {
  const out = [];
  document.querySelectorAll("flt-semantics, [id^='flt-semantic-node']").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    // Label: host aria-label > direct span text > embedded input's aria-label/
    // placeholder (text fields keep their label on the <input> child).
    const label = semanticsLabel(el);
    const inp = semanticsInput(el);
    const role = el.getAttribute("role") ||
      (inp && (inp.getAttribute("data-semantics-role") || "text-field")) ||
      (el.getAttribute("flt-tappable") != null ? "button" : null);
    // Skip pure containers with neither label nor role: no training value.
    if (!label && !role) return;
    out.push({
      id: el.id || null,
      label,
      role,
      tappable: el.getAttribute("flt-tappable") != null,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    });
  });
  return out;
}
function emitSemanticsTree(recordingId, reason) {
  try {
    if (!isFlutterPage()) return;
    const nodes = collectSemanticsTree();
    if (!nodes.length) return;
    // Cheap structural hash: id+label+rect of every node.
    const hash = nodes.map((n) => `${n.id}|${n.label}|${n.rect.x},${n.rect.y},${n.rect.w},${n.rect.h}`).join(";");
    if (hash === lastSemTreeHash) return;
    lastSemTreeHash = hash;
    emit(recordingId, { type: "semanticsTree", reason: reason || "change", url: window.location.href, nodes });
  } catch (e) { /* never break capture */ }
}
// ---- Page title capture --------------------------------------------------------
// Every view in this app renders its title as the FIRST <span> inside the
// flutter-view (e.g. "Locker Box" on /customer-door). The route path does NOT
// always match the on-screen name, so we record the title explicitly on every
// route change. Retries because Flutter mounts the new view asynchronously.
function readPageTitle() {
  try {
    const span = document.querySelector("flutter-view span, flt-semantics span");
    if (!span) return null;
    const t = (span.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 60) return null; // not a title
    return t;
  } catch (e) { return null; }
}
let pageTitleTimer = null;
function schedulePageTitle(recordingId) {
  clearTimeout(pageTitleTimer);
  const url = window.location.href;
  let tries = 0;
  const attempt = () => {
    // The route changed again while we were waiting -> that change schedules
    // its own capture; abandon this one.
    if (window.location.href !== url) return;
    const title = readPageTitle();
    if (title) {
      emit(recordingId, { type: "pageTitle", url, title });
      return;
    }
    if (++tries < 10) pageTitleTimer = setTimeout(attempt, 300);
  };
  pageTitleTimer = setTimeout(attempt, 250);
}

function scheduleSemanticsTree(recordingId, reason) {
  clearTimeout(semTreeTimer);
  // Wait for Flutter to finish (re)building semantics before dumping.
  semTreeTimer = setTimeout(() => emitSemanticsTree(recordingId, reason), 800);
}

function describeControl(startEl) {
  if (!startEl || !startEl.closest) return null;

  // Flutter semantics node? (flt-semantics* elements carry role + aria-label)
  const flt = describeFlutterControl(startEl);
  if (flt) return flt;

  // Plain DOM text inputs (Quasar q-input / NiceGUI): the field's own label
  // ("Search") plus the section it belongs to ("Current Schedule"). Resolved
  // BEFORE the generic control walk, otherwise closest('.q-card') wins and the
  // label becomes the whole card's concatenated textContent.
  const tf = describeTextFieldControl(startEl);
  if (tf) return tf;

  let control = null;
  let role = null;
  for (const { sel, role: r } of QUASAR_CONTROL_SELECTORS) {
    const match = startEl.closest(sel);
    if (match) {
      // Prefer the closest (most specific) control found.
      if (!control || match.contains(control) === false) {
        control = match;
        role = r;
      }
      break;
    }
  }
  if (!control) return null;

  const icon = extractIcon(control);
  const tooltip = extractTooltip(control);
  let label = extractControlLabel(control, role);

  // Skill name of the enclosing skill row (module skill lists): the row is a
  // .q-item whose "Name" caption section holds the bold skill label.
  function skillNameOf(el) {
    const row = el.closest && el.closest(".q-item");
    if (!row) return null;
    for (const sec of row.querySelectorAll(".q-item__section")) {
      const cap = sec.querySelector(".q-item__label--caption");
      if (!cap || cap.textContent.trim().toLowerCase() !== "name") continue;
      const val = sec.querySelector(".q-item__label:not(.q-item__label--caption)");
      if (val) return val.textContent.trim();
    }
    const b = row.querySelector(".q-item__label.text-bold");
    return b ? b.textContent.trim() : null;
  }

  // Expand/Collapse toggle inside a skill row: the avatar section carries
  // role="button" aria-label="Expand"/"Collapse". Label it with the skill it
  // belongs to: Expand "Fill" skill.
  const toggle = startEl.closest("[role='button'][aria-label='Expand'], [role='button'][aria-label='Collapse']");
  if (toggle) {
    const verb = toggle.getAttribute("aria-label");
    const skillName = skillNameOf(toggle);
    if (skillName) {
      return {
        role: "button",
        icon: null,
        tooltip: null,
        label: `${verb} "${skillName}" skill`.substring(0, 120),
        active: toggle.getAttribute("aria-expanded") === "true",
        quasarClasses: pickQuasarClasses(control)
      };
    }
    // Not a skill row (e.g. sidebar "Modules" expansion header): the header
    // carries a visible label ("Modules") next to the folder icon. Prefer
    // that label so the timeline reads 'Clicked Modules' (optionally with the
    // toggle state) instead of the bare aria-label verb "Expand"/"Collapse".
    const visible = composeItemLabel(toggle) || cleanLabelText(toggle);
    if (visible) {
      return {
        role: "expansion-item",
        icon: extractIcon(toggle),
        tooltip: null,
        label: visible.substring(0, 120),
        active: toggle.getAttribute("aria-expanded") === "true",
        quasarClasses: pickQuasarClasses(control)
      };
    }
    label = verb;
  }

  // Skill action buttons (module skill rows): icon-only round q-btns with the
  // "action-button" class. Their meaning is verb (icon) + the enclosing row's
  // skill name: Start "Fill" skill, Reset "Weigh" skill. Note: in this context
  // the refresh icon means RESET (skill state machine reset), not refresh.
  if (role === "button" && /(^|\s)action-button(\s|$)/.test(String(control.className || ""))) {
    const ACTION_ICON_VERBS = {
      play_arrow: "Start", stop: "Stop", refresh: "Reset", replay: "Reset", pause: "Pause"
    };
    const verb = ACTION_ICON_VERBS[icon] || iconToVerb(icon) || "Trigger";
    const skillName = skillNameOf(control);
    if (skillName) label = `${verb} "${skillName}" skill`.substring(0, 120);
    else if (!label) label = verb;
  }

  // q-item rows that pair a NAME with a VALUE:
  //   - status rows: bold title + caption line  -> "Offline - Idle (System is now off.)"
  //   - detail grid cells: overline + value     -> "Change Time (08/15/26 15:16:33.682945)"
  // Clock-only captions (15:16:33.682) are dropped: the timeline already has a
  // timestamp column, and the wall clock makes the label unstable.
  if (role === "menu-item" || role === "expansion-item" || role === "card") {
    const composed = composeItemLabel(control);
    if (composed) label = composed;
  }

  // Icon-only buttons that act on a titled section (refresh/clear/add next to a
  // card header): the glyph gives the verb, the header gives the object.
  // "Refresh" alone is ambiguous when a page has several refreshable panels.
  if (role === "button" && !label && icon && !tooltip) {
    const verb = ICON_VERB_MAP[icon] || iconToVerb(icon);
    if (verb) {
      const sec = sectionTitleOf(control, verb);
      if (sec) label = (verb + " " + sec).substring(0, 120);
    }
  }

  // Action-grid buttons inside a titled card (main page "Restart Pods" /
  // "Restart Nodes" grids): the card header carries the ACTION ("Restart
  // Pods") and the button carries the TARGET name ("Grp2", "CM", ...). Compose
  // both, depluralizing the header's last word so the timeline reads
  // "Restart Pod Grp2" / "Restart Node CM" instead of just "Grp2".
  if (role === "button") {
    const card = control.closest(".q-card");
    const titleNode = card && card.querySelector(".q-card__section .text-bold");
    const titleText = titleNode ? titleNode.textContent.trim() : null;
    if (titleText && /^restart\b/i.test(titleText)) {
      const name = cleanLabelText(control); // icon glyph already stripped
      if (name) {
        const action = titleText.replace(/s\s*$/i, ""); // "Restart Pods" -> "Restart Pod"
        label = `${action} ${name}`.substring(0, 120);
      }
    }
  }

  return {
    role,
    // Material icon name, e.g. "stop", "storage", "rocket".
    icon,
    // Tooltip text is Quasar's built-in accessible description of the control.
    tooltip,
    // Visible label of a menu item / button / tree node.
    label,
    // Active/selected state (highlighted nav item, checked box, etc.).
    active: isControlActive(control),
    quasarClasses: pickQuasarClasses(control)
  };
}

// ---- q-item label composition ------------------------------------------------
// A Quasar list row carries its meaning in TWO parts: a name and a value.
// Quasar marks the name with --overline (detail grids) or renders it as the
// plain label with the value in a --caption line (status rows). Reading only
// one part loses the point of the click; concatenating the row's raw
// textContent glues in the wall clock. So: pick the name, pick the value(s),
// join them as "Name (value)".
const CLOCK_ONLY_RE = /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/;

// Endpoint URLs (opc.tcp://robot-01.goodbytz:4840) identify a machine to an
// integrator, not an action to an operator. A module row is named by its module
// ("Cooking Robot"); the endpoint is noise in a timeline of what someone did.
const CONNECTION_URL_RE = /(opc\.tcp|wss?|https?|tcp|udp|ftp|mqtt|modbus|amqp|coap):\/\//i;

function composeItemLabel(control) {
  if (!control || !control.querySelectorAll) return null;

  // Only labels the operator can actually SEE. A collapsed expansion panel keeps
  // its detail grid in the DOM (display:none); folding that into the header's
  // label is what produced the run-on status line.
  const nodes = Array.from(control.querySelectorAll(".q-item__label")).filter((n) => {
    if (n.querySelector(".q-item__label")) return false; // wrapper, not a leaf
    return isVisibleNode(n);
  });
  if (!nodes.length) return null;

  // The row that owns these labels is the DEEPEST .q-item containing all of
  // them. Quasar nests a real row inside the clickable wrapper, so the wrapper
  // itself is too coarse and any single label's parent is too narrow.
  // If no single row holds them all, the control spans SIBLING rows (a list of
  // expansion panels). Falling back to "use every node" is what glued the next
  // panel's header onto this one. Scope to the row owning the first visible
  // label instead: that is the row the operator clicked.
  const firstRow = nodes[0].closest(".q-item");
  const row = deepestCommonItem(nodes, control) ||
    (firstRow && (control.contains(firstRow) || firstRow === control) ? firstRow : null);
  const scoped = row ? nodes.filter((n) => row.contains(n)) : [nodes[0]];
  if (!scoped.length) return null;

  let name = null;
  const values = [];
  for (const node of scoped) {
    const cls = String(node.className || "");
    const text = cleanLabelText(node).replace(/\s+/g, " ").trim();
    if (!text || CLOCK_ONLY_RE.test(text) || !/[A-Za-z0-9]/.test(text)) continue;
    // Never let an endpoint become the parenthetical detail.
    if (CONNECTION_URL_RE.test(text)) continue;

    if (/--overline|--header/.test(cls)) {
      if (!name) name = text;
    } else if (/--caption/.test(cls)) {
      values.push(text);
    } else if (!name) {
      name = text;
    } else {
      values.push(text);
    }
  }

  if (!name) return null;
  const detail = values.join(" ").replace(/\s+/g, " ").trim();
  const out = detail ? name + " (" + detail + ")" : name;
  return out.length > 200 ? out.slice(0, 199) + "\u2026" : out;
}

// Rendered and not hidden. offsetParent alone is unreliable (position:fixed),
// so fall back to a box check.
function isVisibleNode(el) {
  try {
    if (el.closest("[style*='display: none'], [style*='display:none'], [hidden]")) return false;
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect();
    return !!(r.width || r.height);
  } catch (e) { return true; }
}

// Deepest .q-item (within `limit`) that contains every given node.
function deepestCommonItem(nodes, limit) {
  let chain = [];
  let el = nodes[0].closest(".q-item");
  while (el && (!limit || limit.contains(el) || el === limit)) {
    chain.push(el);
    el = el.parentElement && el.parentElement.closest(".q-item");
  }
  // chain is innermost -> outermost; take the first that holds all nodes.
  for (const cand of chain) {
    if (nodes.every((n) => cand.contains(n))) return cand;
  }
  return null;
}

// ---- Text fields --------------------------------------------------------------
// A click or keystroke in a q-input must read as the field the operator sees:
// its own label ("Search") qualified by the section it sits in ("Current
// Schedule"). Without the section, every table filter on the page reads
// "Search"; without the field label, the card's whole textContent leaks in.
function describeTextFieldControl(startEl) {
  if (!startEl || !startEl.closest) return null;

  let input = null;
  if (startEl.matches && startEl.matches("input, textarea")) input = startEl;
  if (!input && startEl.closest("input, textarea")) input = startEl.closest("input, textarea");
  if (!input) {
    const field = startEl.closest(".q-field, .q-input, .q-textarea");
    if (field) input = field.querySelector("input, textarea");
  }
  if (!input) return null;
  const t = String(input.type || "text").toLowerCase();
  if (["checkbox", "radio", "hidden", "submit", "button", "file"].includes(t)) return null;

  const field = input.closest(".q-field, .q-input, .q-textarea, label") || input;

  // Quasar renders the clear affordance as an <i role="button" aria-label="Clear">
  // in the field's append slot. It is a distinct ACTION on the field, not a
  // click into it, so the timeline must say "Cleared", not "Clicked".
  const clearBtn = startEl.closest('[aria-label="Clear"], .q-field__focusable-action');
  const isClear = !!(clearBtn && field.contains(clearBtn) && !clearBtn.matches("input, textarea"));

  // The clear affordance is a BUTTON acting on the section, not the field
  // itself: it reads "Clear Current Schedule", parallel to "Refresh Current
  // Schedule" next to it. Resolve it here (we already have the field) rather
  // than in the generic button path, which cannot see past the <label>.
  if (isClear) {
    const sec = sectionTitleOf(field, "Clear");
    return {
      role: "button",
      action: "clear",
      icon: "cancel",
      tooltip: null,
      label: ("Clear" + (sec ? " " + sec : "")).substring(0, 120),
      active: false,
      quasarClasses: pickQuasarClasses(field)
    };
  }

  let name =
    (input.getAttribute("aria-label") || "").trim() ||
    (input.getAttribute("placeholder") || "").trim();
  if (!name) {
    const inner = field.querySelector(".q-field__label");
    if (inner) name = cleanLabelText(inner);
  }
  if (!name && input.id) {
    const forLabel = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
    if (forLabel) name = cleanLabelText(forLabel);
  }
  if (!name) name = (input.getAttribute("name") || "").trim() || "Text field";

  const section = sectionTitleOf(field, name);
  const label = (section ? name + " " + section : name).replace(/\s+/g, " ").trim();

  return {
    role: "text-field",
    action: null,
    icon: null,
    tooltip: null,
    label: label.substring(0, 120),
    active: document.activeElement === input,
    quasarClasses: pickQuasarClasses(field)
  };
}

// Title of the card/table/section a control lives in. Used to qualify generic
// field names ("Search" -> "Search Current Schedule").
const SECTION_TITLE_SELECTORS = [
  ".q-table__title",
  ".q-item__label--header",
  ".text-h4", ".text-h5", ".text-h6",
  ".text-subtitle1", ".text-subtitle2",
  "h1", "h2", "h3", "h4", "h5", "h6",
  ".text-bold"
];

function sectionTitleOf(el, excludeText) {
  let container = el && el.closest && el.closest(".q-card, .nicegui-card, .q-table__container, .q-table, section, [class*='card']");
  let hops = 0;
  while (container && hops++ < 4) {
    for (const sel of SECTION_TITLE_SELECTORS) {
      for (const node of container.querySelectorAll(sel)) {
        if (node.contains(el) || el.contains(node)) continue;
        const t = cleanLabelText(node).replace(/\s+/g, " ").trim();
        if (!t || t.length < 2 || t.length > 40) continue;
        if (excludeText && t.toLowerCase() === String(excludeText).toLowerCase()) continue;
        return t;
      }
    }
    container = container.parentElement && container.parentElement.closest(".q-card, .nicegui-card, .q-table__container, .q-table, section, [class*='card']");
  }
  return null;
}

// The icon <i class="q-icon ...">name</i> or [class~=material-icons] text/name.
function extractIcon(control) {
  const icon = control.querySelector(".q-icon");
  if (!icon) return null;
  // Material icons render the icon name as the element's text content.
  const t = (icon.textContent || "").trim();
  if (t && /^[a-z0-9_]+$/.test(t) && !t.includes("__")) return t;
  // Fallback: some icons carry the name in an aria-label.
  const aria = icon.getAttribute("aria-label");
  if (aria) return aria;
  // Class-token fallback: only accept a plausible Material-icon name, never a
  // Quasar/utility class (q-*, __bem, text-*, notranslate, etc.).
  const cls = (typeof icon.className === "string" ? icon.className : "")
    .split(/\s+/)
    .find(
      (c) =>
        c &&
        !c.startsWith("q-") &&
        !c.startsWith("text-") &&
        !c.includes("__") &&
        !["notranslate", "material-icons", "material-icons-outlined", "on-left", "on-right"].includes(c)
    );
  return cls || null;
}

// Read the associated Quasar tooltip. This is the exact phrase the operator
// sees on hover (e.g. "Stop in Manual mode.") and is the best possible label
// for an icon-only button. Quasar keeps the q-tooltip in the DOM (often as a
// descendant of the control, sometimes teleported to <body> and linked via
// aria-describedby). We look in several places, in order of reliability.
function extractTooltip(control) {
  // 1. Tooltip nested inside the control (most common on q-btn / q-item / q-icon).
  const inner = control.querySelector(".q-tooltip");
  if (inner) {
    const t = (inner.textContent || "").trim();
    if (t) return t;
  }
  // 2. Tooltip teleported to <body> and linked via aria-describedby.
  const describedBy = control.getAttribute && control.getAttribute("aria-describedby");
  if (describedBy) {
    const tip = document.getElementById(describedBy);
    if (tip) {
      const t = (tip.textContent || "").trim();
      if (t) return t;
    }
  }
  // 3. A q-tooltip sibling within the same avatar/section wrapper (icons put the
  //    tooltip next to, not inside, the clicked <i>).
  const wrapper = control.closest(".q-item-section, .q-btn, .q-item, .q-tree__node") || control.parentElement;
  if (wrapper) {
    const sib = wrapper.querySelector(".q-tooltip");
    if (sib) {
      const t = (sib.textContent || "").trim();
      if (t) return t;
    }
  }
  // 4. Native title attribute.
  const title = control.getAttribute && control.getAttribute("title");
  if (title && title.trim()) return title.trim();
  return null;
}

// Last-resort map: an icon-only control with NO tooltip / aria-label / title
// still gets a readable verb instead of the raw Material-icon glyph name.
// Tooltips (extractTooltip) are preferred whenever present, so this only fills
// gaps and degrades gracefully for icons we have not seen before.
const ICON_VERB_MAP = {
  refresh: "Refresh",
  cancel: "Clear",
  close: "Close",
  stop: "Stop",
  play_arrow: "Start",
  done_all: "Complete",
  done: "Confirm",
  check: "Confirm",
  delete: "Delete",
  edit: "Edit",
  add: "Add",
  remove: "Remove",
  search: "Search",
  settings: "Settings",
  menu: "Menu",
  more_vert: "More",
  more_horiz: "More",
  arrow_back: "Back",
  arrow_forward: "Forward",
  expand_more: "Expand",
  expand_less: "Collapse",
  keyboard_arrow_down: "Expand",
  keyboard_arrow_up: "Collapse",
  light_mode: "Light mode",
  dark_mode: "Dark mode",
  brightness_auto: "Auto theme"
};

// Turn an icon glyph name into a readable verb via the map, else Title Case it
// (e.g. "toggle_on" -> "Toggle On") so we never emit a raw snake_case glyph.
function iconToVerb(icon) {
  if (!icon) return null;
  if (ICON_VERB_MAP[icon]) return ICON_VERB_MAP[icon];
  return icon
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// A single lower-case token that looks like a Material icon glyph name
// (e.g. "cancel", "play_arrow"). These sometimes leak into a control's
// resolved label when the control's only child is a bare <i>glyph</i>.
function isIconGlyphToken(s) {
  return typeof s === "string" && /^[a-z][a-z0-9_]*$/.test(s.trim());
}

// True only for glyphs we have an explicit, trustworthy verb for -- so we
// don't accidentally rewrite a real one-word label (e.g. "Yes") that merely
// looks glyph-shaped.
function knownIconVerb(s) {
  return isIconGlyphToken(s) && Object.prototype.hasOwnProperty.call(ICON_VERB_MAP, s.trim());
}

// Visible label, excluding icon glyph text (icon name) and tooltip text.
function extractControlLabel(control, role) {
  // q-item: the label lives in .q-item__label / q-item-section (non-avatar).
  const labelNode =
    control.querySelector(".q-item__label:not([class*='caption'])") ||
    control.querySelector(".q-item-section:not(.q-item-section--avatar) .q-item__label") ||
    control.querySelector(".q-tree__node-header-content");

  if (labelNode) {
    const t = cleanLabelText(labelNode);
    if (t) return t.substring(0, 120);
  }

  // For buttons and everything else: take the control's text, but strip the
  // icon-name glyph and any tooltip text so we don't concatenate them.
  const t = cleanLabelText(control);
  return t ? t.substring(0, 120) : null;
}

// Extract textContent from a node while removing .q-icon (icon name) and
// .q-tooltip (hover text) descendants first.
function cleanLabelText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(".q-icon, .q-tooltip").forEach((n) => n.remove());
  return (clone.textContent || "").trim();
}

// Known Material-icon glyph names that get glued to device-row text with no
// separator (e.g. "precision_manufacturinglink Cooking Robot"). We strip these
// from the FRONT of the blob before any other processing.
const LEADING_ICON_NAMES = [
  "precision_manufacturing", "local_car_wash", "markunread_mailbox",
  "move_down", "move_up", "storage", "rocket", "folder", "link", "lan",
  "whatshot", "dvr", "scale", "notifications", "view_timeline", "settings",
  "keyboard_arrow_down", "keyboard_arrow_up", "toggle_on", "toggle_off"
];

// Every icon glyph name we might see glued into a container div's textContent.
// Union of the leading-icon list and the icon->verb map keys (which cover the
// common action icons: search, refresh, cancel, close, add, ...). Sorted
// longest-first so multi-word glyphs match before their fragments.
const ICON_GLYPH_NAMES = Array.from(
  new Set([...LEADING_ICON_NAMES, ...Object.keys(ICON_VERB_MAP)])
).sort((a, b) => b.length - a.length);

// Turn a run-on textContent blob (icon names + concatenated child text +
// timestamps, with no separators) into a short readable label. Used only as a
// fallback when there's no tooltip / aria-label / role-based name.
function sanitizeFallbackText(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();

  // 1. Strip leading glued icon glyph names (possibly several, e.g.
  //    "precision_manufacturinglink..." -> "precision_manufacturing" + "link").
  //    Repeat because device rows often prefix TWO icons (device icon + "link").
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of LEADING_ICON_NAMES) {
      if (s.toLowerCase().startsWith(name)) {
        s = s.slice(name.length);
        changed = true;
      }
    }
  }
  s = s.trim();

  // 2. Extract a connection URL (opc.tcp://, ws://, tcp://, http(s)://, ...).
  //    It is the most identifying part of a device row, so we preserve it whole.
  //    Stop the URL at a space OR at a glued CamelCase / trailing lowercase word
  //    boundary (e.g. ":4840local" -> ":4840"), which is the start of the next
  //    node's text getting concatenated onto the URL.
  let url = null;
  const sm = s.match(/(opc\.tcp|wss?|https?|tcp|udp|ftp|mqtt|modbus|amqp|coap):\/\/[^\s]+/i);
  if (sm) {
    url = sm[0];
    // Cut a glued suffix: the URL ends at the last digit/host char before an
    // obvious appended word. Ports/hosts contain [\w.:-]; a following lowercase
    // run with no dot after a port number is appended text ("...:4840local").
    const portCut = url.match(/^(.*:\d{2,5})([a-z][a-z ].*)?$/i);
    if (portCut) url = portCut[1];
  }

  // 3. Work on the text with the URL removed so we don't mangle it.
  //    If the input already presents "name (url)", capture the inner url so we
  //    don't double-wrap it later.
  let already = s.match(/^(.*?)\s*\((\s*(?:opc\.tcp|wss?|https?|tcp|udp|ftp|mqtt|modbus|amqp|coap):\/\/[^)]+)\)\s*$/i);
  let label;
  if (already) {
    label = already[1];
    url = url || already[2].trim();
  } else {
    label = url ? s.replace(sm[0], " ") : s;
  }

  // Strip clock timestamps, including ones glued to a word ("Idle19:53:47.153").
  label = label.replace(/\d{1,2}:\d{2}(:\d{2})?(\.\d+)?/g, " ");

  // Remove any Material-icon glyph name glued mid-string (e.g.
  // "Controlsrocket Offline" -> "Controls Offline"). Insert a boundary before
  // the icon name, then delete it.
  // Remove any Material-icon glyph name glued into the string (e.g.
  // "Controlsrocket Offline" -> "Controls Offline", or a container div's
  // "Current Schedulesearch Searchrefresh" -> "Current Schedule Search").
  // We check the full glyph set (leading icons + action icons like
  // search/refresh/cancel), longest-first, and cover three glue patterns.
  for (const name of ICON_GLYPH_NAMES) {
    // Glued after a lowercase run, before an uppercase letter or end
    // ("Schedulesearch" -> "Schedule ", "Searchrefresh" -> "Search ").
    label = label.replace(new RegExp("([a-z])" + name + "(?=[A-Z]|$)", "g"), "$1 ");
    // Glued after any letter, before an uppercase letter, space, or end.
    const re = new RegExp("(?<=[a-zA-Z])" + name + "(?=[A-Z ]|$)", "g");
    label = label.replace(re, " ");
    // Also a standalone glued icon (lower run) at a word boundary.
    label = label.replace(new RegExp("\\b" + name + "\\b", "g"), " ");
  }

  // Split remaining glued camelCase boundaries: "RobotOffline" -> spaced.
  label = label.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  label = label.replace(/\s+/g, " ").trim();

  // Drop any remaining leading lowercase icon-name tokens.
  let parts = label.split(" ");
  while (parts.length > 1 && /^[a-z_]+$/.test(parts[0]) && parts[0].length <= 14) {
    parts.shift();
  }
  label = parts.join(" ");

  // Keep only the first line/segment so we don't glue a status line, a toast
  // message, etc. onto the control name.
  label = label.split(/[\u2022|]/)[0].trim();
  // Cut at the start of an obvious appended status/toast sentence.
  label = label.replace(/\s+(Successfully|System is now|Error|Warning|Failed)\b.*$/i, "").trim();

  // Re-join device slot codes that got over-split ("Slot A 5" -> "Slot A5").
  label = label.replace(/\b([A-Z])\s+(\d)\b/g, "$1$2");

  // Compose: the human-readable name wins. A connection URL (opc.tcp://...) is
  // an implementation detail of the module row, not something the operator
  // reads, so we only fall back to it when there is no name at all.
  let out = label || url;

  if (!out) return null;
  if (out.length > 120) out = out.slice(0, 120).trim() + "\u2026";
  return out;
}

function isControlActive(control) {
  const cls = typeof control.className === "string" ? control.className : "";
  if (/(^|\s)(q-item--active|q-tab--active|q-tree__node--selected|active-device)(\s|$)/.test(cls)) return true;
  if (control.getAttribute && control.getAttribute("aria-selected") === "true") return true;
  if (control.getAttribute && control.getAttribute("aria-pressed") === "true") return true;
  // Checkbox/toggle checked state
  const inner = control.querySelector("[aria-checked='true']");
  if (inner) return true;
  return false;
}

function pickQuasarClasses(control) {
  const cls = typeof control.className === "string" ? control.className : "";
  const q = cls.split(/\s+/).filter((c) => c.startsWith("q-"));
  return q.length ? q.slice(0, 6).join(" ") : null;
}

function captureInteraction(recordingId, type, event) {
  let target = realTarget(event);
  if (!target || !target.tagName) return;
  if (target.closest && target.closest("#sop-tagger-root")) return; // ignore tagger UI

  // Flutter: pointer events land on flutter-view / flt-glass-pane, not on the
  // invisible semantics nodes. Hit-test the click coordinates for the deepest
  // flt-semantics element so labels resolve to the actual widget.
  if (
    event.clientX != null &&
    target.closest &&
    target.closest("flutter-view, flt-glass-pane") &&
    !target.closest("flt-semantics")
  ) {
    const sem = flutterSemanticsAt(event.clientX, event.clientY);
    if (sem) target = sem;
  }

  // Normalize: a click on the label <span> INSIDE a semantics node belongs to
  // the node itself. This makes every Flutter click carry the node id
  // (flt-semantic-node-N) consistently, which is the join key into the
  // semanticsTree dumps.
  // EXCEPTION: Flutter TEXT FIELDS render an <input aria-label="..."
  // data-semantics-role="text-field"> INSIDE the semantics host. The label and
  // the typed value live on that input, NOT on the host -- normalizing to the
  // host made these events "unlabeled" with no value. Keep the input as the
  // target; the semanticsId join key is still resolved via closest() below.
  if (target.closest && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
    const semHost = target.closest("flt-semantics, [id^='flt-semantic-node']");
    if (semHost) target = semHost;
  }

  // The UI usually changes right after a click (dialogs, menus, routes) ->
  // refresh the ground-truth semantics map shortly after.
  if (type === "click" && isFlutterPage()) scheduleSemanticsTree(recordingId, "after-click");

  const described = describeTarget(target);
  const value = captureValue(target, type);

  emit(recordingId, {
    type: "interaction",
    subtype: type,
    // One-line human-readable summary of the action, derived from the control's
    // semantic meaning. This is what makes the JSON directly usable for training
    // and for SOP-compliance review (e.g. "click button: Stop in Manual mode").
    actionLabel: buildActionLabel(type, described, value),
    data: {
      ...described,
      value,
      masked: shouldMask(target),
      // Join key into the semanticsTree dumps (offline re-labeling).
      semanticsId: (function () {
        if (target.id && target.id.indexOf("flt-semantic-node") === 0) return target.id;
        const h = target.closest && target.closest("[id^='flt-semantic-node']");
        if (h) return h.id;
        // Rect fallback: the click landed on a label <span> or a node without an
        // id attribute. Hit-test the click coordinates against every semantics
        // node that HAS an id and pick the smallest box containing the point --
        // that is the widget the user tapped. Guarantees the id join key even
        // when DOM ancestry doesn't provide it.
        if (event.clientX == null || !isFlutterPage()) return null;
        let bestId = null, bestArea = Infinity;
        // Only consider nodes that describe a real widget (label, role or
        // flt-tappable) and skip near-viewport-sized containers -- otherwise
        // every click degenerates to the ROOT node (flt-semantic-node-0),
        // which spans the whole page and says nothing about the widget.
        const maxArea = window.innerWidth * window.innerHeight * 0.5;
        document.querySelectorAll("[id^='flt-semantic-node']").forEach((el) => {
          const isWidget = (el.getAttribute && (el.getAttribute("aria-label") ||
                            el.getAttribute("role") || el.getAttribute("flt-tappable") != null)) ||
                            semanticsText(el);
          if (!isWidget) return;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const area = r.width * r.height;
          if (area > maxArea && !el.getAttribute("aria-label")) return;
          if (event.clientX >= r.left && event.clientX <= r.right &&
              event.clientY >= r.top && event.clientY <= r.bottom) {
            if (area < bestArea) { bestArea = area; bestId = el.id; }
          }
        });
        return bestId;
      })(),
      url: window.location.href
    },
    clientX: event.clientX != null ? event.clientX : null,
    clientY: event.clientY != null ? event.clientY : null
  });
}

// ---- Final-value capture for text inputs ------------------------------------
// We record only ONE event per edited field, carrying its final value -- never
// the intermediate keystrokes. Typing "100" yields a single change event with
// value "100", not 1 / 10 / 100. A native "change" (blur / Enter) is preferred;
// an input-debounce + blur flush covers frameworks whose change doesn't fire.
const INPUT_FLUSH_MS = 700;
const pendingInputs = new WeakMap();   // element -> setTimeout id
const lastEmittedValue = new WeakMap();// element -> last value we recorded

function isEditable(el) {
  if (!el || !el.tagName) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
  return el.isContentEditable === true;
}

// Current committed value of an editable element (for de-dup comparison).
function currentValue(el) {
  if (el.isContentEditable) return (el.textContent || "");
  if (el.type === "checkbox" || el.type === "radio") return el.checked ? "on" : "";
  return el.value != null ? String(el.value) : "";
}

// Decide whether a final value is worth recording as a change.
// Skip it when nothing was actually entered (empty value that was never given a
// value) or when it is identical to the value we already recorded for this
// field -- both eliminate the spurious empty/duplicate change events that
// Quasar/NiceGUI number inputs emit.
function shouldRecordFinalValue(target) {
  const val = currentValue(target);
  const isToggle = target.type === "checkbox" || target.type === "radio";
  if (!isToggle && val === "" && !lastEmittedValue.has(target)) return false;
  if (lastEmittedValue.has(target) && lastEmittedValue.get(target) === val) return false;
  return true;
}

// Emit exactly one final "change" per distinct value, then remember it.
function emitFinalValue(recordingId, event, target) {
  if (!shouldRecordFinalValue(target)) return;
  lastEmittedValue.set(target, currentValue(target));
  captureInteraction(recordingId, "change", event);
}

// Native change event: emit the final value immediately and cancel any pending
// debounce so we don't double-record the same field.
function captureFinalValue(recordingId, event) {
  const target = realTarget(event);
  if (!isEditable(target)) return;
  const t = pendingInputs.get(target);
  if (t) { clearTimeout(t); pendingInputs.delete(target); }
  emitFinalValue(recordingId, event, target);
}

// Per-keystroke input: don't record yet. Reset a short debounce; if typing
// pauses, flush the final value once (as a change) -- de-dup guards drop it if
// a native change already recorded the same value.
function scheduleInputFlush(recordingId, event) {
  const target = realTarget(event);
  if (!isEditable(target)) return;
  const prev = pendingInputs.get(target);
  if (prev) clearTimeout(prev);
  const id = setTimeout(() => {
    pendingInputs.delete(target);
    emitFinalValue(recordingId, event, target);
  }, INPUT_FLUSH_MS);
  pendingInputs.set(target, id);
}

// Losing focus commits the value: flush any pending final value now.
function flushInputNow(recordingId, event) {
  const target = realTarget(event);
  if (!isEditable(target)) return;
  const t = pendingInputs.get(target);
  if (t) { clearTimeout(t); pendingInputs.delete(target); }
  emitFinalValue(recordingId, event, target);
}

// Compose a readable label from the resolved control meaning.
// Priority: tooltip (the operator's own hover text) > visible label >
// aria-label > cleaned/sanitized fallback text > icon verb > selector.
function buildActionLabel(type, described, value) {
  const c = described.control;

  // Sanitize the raw text fallback, but DISCARD it when it is merely the icon
  // glyph name (e.g. "play_arrow") -- otherwise it would win over the nicer
  // icon->verb mapping ("Start"). A glyph name is a single snake_case token.
  let cleanFallback = sanitizeFallbackText(described.text);
  if (
    cleanFallback &&
    c &&
    c.icon &&
    cleanFallback.toLowerCase() === String(c.icon).toLowerCase()
  ) {
    cleanFallback = null;
  }
  // Also drop a fallback that is any bare Material-glyph-looking token when we
  // have a better source available.
  if (cleanFallback && /^[a-z][a-z0-9_]*$/.test(cleanFallback) && cleanFallback.includes("_")) {
    cleanFallback = null;
  }

  // A resolved control "label" is sometimes just the icon glyph name (e.g. a
  // clear button whose only child is <i>cancel</i>). If the label is a bare
  // Material-glyph token that the verb map knows, prefer the verb ("Clear").
  let ctrlLabel = c && c.label;
  if (isIconGlyphToken(ctrlLabel) && knownIconVerb(ctrlLabel)) {
    ctrlLabel = iconToVerb(ctrlLabel);
  }

  // A tooltip is the exact phrase the operator sees on hover (e.g.
  // "Stop in Manual mode.") -- always the best label when it exists.
  // A visible q-item/q-tree label is next best. Only then do we fall back to
  // raw text, and we ALWAYS sanitize it to strip icon glyph names / URLs /
  // timestamps before use. Icon->verb is the graceful last resort so an
  // icon-only button never surfaces its raw glyph name (refresh/stop/close).
  const name =
    (c && c.tooltip) ||
    ctrlLabel ||
    described.ariaLabel ||
    cleanFallback ||
    described.placeholder ||
    (c && c.icon ? iconToVerb(c.icon) : null) ||
    described.selector ||
    described.tagName;

  const roleWord = c ? c.role : described.tagName.toLowerCase();

  if (type === "input" || type === "change") {
    if (value != null && value !== "") return `set ${name} = "${value}"`;
    // Empty value after the field previously held content = a deliberate clear.
    if (type === "change") return `clear ${name}`;
    return `${type} ${name}`;
  }
  if (type === "submit") return `submit ${name}`;
  return `click ${roleWord}: ${name}`;
}

// Capture meaningful keystrokes (Enter, Tab, Escape, and shortcut combos).
function captureKey(recordingId, event) {
  const target = realTarget(event);
  if (target && target.closest && target.closest("#sop-tagger-root")) return;
  const isModifierCombo = event.ctrlKey || event.metaKey || event.altKey;
  const meaningful = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Delete", "Backspace"];
  if (!isModifierCombo && !meaningful.includes(event.key)) return; // skip plain typing (covered by input)

  emit(recordingId, {
    type: "key",
    key: event.key,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    target: target && target.tagName ? describeTarget(target) : null,
    url: window.location.href
  });
}

function captureScroll(recordingId) {
  emit(recordingId, { type: "scroll", scrollX: window.scrollX, scrollY: window.scrollY, url: window.location.href });
}

function captureSnapshot(recordingId, snapshotType) {
  emit(recordingId, {
    type: "snapshot",
    snapshotType,
    data: { url: window.location.href, title: document.title, timestamp: Date.now() }
  });
}

function interceptNetworkRequests(recordingId) {
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0];
    const options = args[1] || {};
    emit(recordingId, {
      type: "networkRequest",
      method: options.method || "GET",
      url: typeof url === "string" ? url : url.url
    });
    return originalFetch.apply(this, args);
  };
  const originalXHR = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, url) {
    emit(recordingId, { type: "networkRequest", method, url });
    return originalXHR.apply(this, arguments);
  };
}

function getXPath(element) {
  if (!element || element.nodeType !== 1) return "";
  if (element.id !== "") return "//*[@id='" + element.id + "']";
  if (element === document.body) return element.tagName.toLowerCase();
  if (!element.parentNode) return element.tagName.toLowerCase();
  const ix = Array.from(element.parentNode.children).indexOf(element) + 1;
  return getXPath(element.parentNode) + "/" + element.tagName.toLowerCase() + "[" + ix + "]";
}

// A short, human-readable CSS-style selector for the element (best-effort).
function getSelector(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return "#" + el.id;
  let sel = el.tagName.toLowerCase();
  if (typeof el.className === "string" && el.className.trim()) {
    const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
    if (cls) sel += "." + cls;
  }
  const name = el.getAttribute && el.getAttribute("name");
  if (name) sel += `[name="${name}"]`;
  return sel;
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
