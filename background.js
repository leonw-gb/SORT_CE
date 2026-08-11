// background.js - Service Worker
// Session is started/stopped manually via the popup button.
// ALL tabs are recorded once a session is active.

// Fixed deployment values (upload host, Odoo host/db/model, reminder interval).
importScripts("defaults.js");
// Shared with the offscreen poller: one copy of the "is this call mine" rule.
importScripts("callmatch.js");

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const CONFIG_STORE = "config";
// Screen-capture videos live in their OWN store: a session video is megabytes,
// and the player must be able to load the (small) event timeline without
// pulling the video into memory.
const VIDEOS_STORE = "videos";

// ---- IndexedDB ---------------------------------------------------------------
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDINGS_DB, 3);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(RECORDINGS_STORE))
        db.createObjectStore(RECORDINGS_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CONFIG_STORE))
        db.createObjectStore(CONFIG_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(VIDEOS_STORE))
        db.createObjectStore(VIDEOS_STORE, { keyPath: "recordingId" });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function deleteVideo(recordingId) {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction(VIDEOS_STORE, "readwrite");
    tx.objectStore(VIDEOS_STORE).delete(recordingId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ---- Screen capture ----------------------------------------------------------
// One video stream for the whole session. The operator picks a screen or window
// once; the stream then follows every tab switch, which per-tab tabCapture
// cannot do. Video only -- audio is never requested.
let captureStartedAt = null;   // wall-clock ms when the encoder actually began
let pendingCaptureWarning = null; // capture error to report back to the popup

// Screen capture host: a small extension WINDOW (capture.html).
//
// Why not chrome.desktopCapture: chooseDesktopMedia() requires a targetTab on a
// SECURE scheme. The RKA machines are served over plain http://, so anchoring
// the picker to the operator's tab fails with "URL scheme for the specified tab
// is not secure". An extension page is chrome-extension:// (secure) and can call
// getDisplayMedia() itself, which needs no targetTab at all.
//
// Why a visible window and not the offscreen document: getDisplayMedia() only
// runs after a genuine user gesture, which an offscreen document cannot supply.
let captureWindowId = null;
let capturePending = null;   // resolver for the in-flight startCapture()
// Set the moment the window is put away, so any later focus attempt -- from a
// different trigger path, or a message arriving out of order -- cannot drag it
// back onto the screen.
let captureMinimized = false;

async function openCaptureWindow(recordingId) {
  captureMinimized = false;
  const url = chrome.runtime.getURL(
    `capture.html?rec=${encodeURIComponent(recordingId || "")}`);

  // Chrome renders the share picker INSIDE this window, so the window must be
  // big enough to show the Screen/Window/Tab tabs and their thumbnails. At
  // 420x320 the picker was clipped and unusable. Clamp to the display so the
  // window still fits on smaller laptop screens.
  const W = 940, H = 760;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round(cur.left + (cur.width - W) / 2));
    top = Math.max(0, Math.round(cur.top + (cur.height - H) / 2));
  } catch (e) { /* let Chrome place it */ }

  const win = await chrome.windows.create({
    url, type: "popup", width: W, height: H, left, top, focused: true
  });
  captureWindowId = win.id;
  return win;
}

// Minimized, never closed: the MediaRecorder lives in this window's document.
async function minimizeCaptureWindow() {
  if (captureWindowId == null) return;
  captureMinimized = true;
  try {
    await chrome.windows.update(captureWindowId, { state: "minimized" });
  } catch (e) { /* the operator may have closed it already */ }
}

async function closeCaptureWindow() {
  if (captureWindowId == null) return;
  try { await chrome.windows.remove(captureWindowId); } catch (e) {}
  captureWindowId = null;
  captureMinimized = false;
}

// Resolves when capture.js reports the encoder started, or the operator
// cancels/denies the picker.
function startCapture(recordingId) {
  return new Promise(async (resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; capturePending = null; resolve(v); } };
    capturePending = done;

    // No response at all (window closed before choosing) must not hang Start.
    const timer = setTimeout(() => {
      done({ success: false, error: "No source chosen. Recording continues without video." });
    }, 120000);
    const wrapped = (v) => { clearTimeout(timer); done(v); };
    capturePending = wrapped;

    try {
      await openCaptureWindow(recordingId);
    } catch (e) {
      clearTimeout(timer);
      done({ success: false, error: String(e.message || e) });
    }
  });
}

async function stopCapture(recordingId) {
  if (captureWindowId == null) return { success: false, error: "No capture running" };
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ target: "capture", type: "stopCapture" });
  } catch (e) {
    res = { success: false, error: String(e.message || e) };
  }
  // capture.js writes the Blob to IndexedDB itself: a Blob cannot cross
  // sendMessage, and the old base64 data-URL round-trip inflated every file by
  // 33% and broke on long sessions. Nothing to persist here.
  await closeCaptureWindow();
  captureStartedAt = null;
  return res || { success: false };
}

async function saveConfig(config) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readwrite");
    tx.objectStore(CONFIG_STORE).put({ key: "recordingConfig", value: withFixedSettings(config) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getConfig() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readonly");
    const req = tx.objectStore(CONFIG_STORE).get("recordingConfig");
    req.onsuccess = () => resolve(withFixedSettings(req.result?.value || {}));
    req.onerror = () => reject(req.error);
  });
}

async function saveRecording(recording) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readwrite");
    tx.objectStore(RECORDINGS_STORE).put(recording);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllRecordings() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readonly");
    const req = tx.objectStore(RECORDINGS_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecording(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readwrite");
    tx.objectStore(RECORDINGS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Default SOP steps -------------------------------------------------------
const DEFAULT_SOP_STEPS = [
  { id: "observe",  label: "1 - Observe / reproduce" },
  { id: "diagnose", label: "2 - Diagnose root cause" },
  { id: "plan",     label: "3 - Apply fix" },
  { id: "apply",    label: "4 - Verify resolved / close" }
];

// ---- Active session ----------------------------------------------------------
// One shared session object across all tabs. null = not recording.
let activeSession = null;

// Tabs that already have an active recorder injected (avoids restarting rrweb
// on SPA route changes, which would split the DOM stream).
const injectedTabs = new Set();

function makeSessionId() {
  return `recording_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// One recording at a time, always.
//
// The case this exists for: an operator starts a recording by hand, then answers
// an incoming call. Once calls trigger recordings automatically, that second
// trigger must NOT open a second capture -- two screen recordings of the same
// screen, two ticket dialogs, and the manual one silently orphaned. The first
// recording wins and simply absorbs the call: we note the call on the running
// session so the ticket dialog can pre-select its ticket later, and re-arm the
// reminder so the "still recording?" prompt is measured from the call, not from
// whenever the operator happened to press Start.
//
// The reverse order needs no special case: a call-started recording is a normal
// active session, so a later manual Start hits the same guard.
async function startSession(options) {
  if (activeSession) {
    if (options && options.trigger === "call") {
      attachCallToSession(options.call || {});
      return {
        success: true,
        joinedExisting: true,
        recordingId: activeSession.id,
        videoCapturing: !!(activeSession.video && activeSession.video.captured)
      };
    }
    return { success: false, error: "Already recording", recordingId: activeSession.id };
  }

  const config = await getConfig();

  // A recording with no name on it cannot be shared usefully: the moment it
  // leaves this machine as a bundle, "who recorded this" has no answer. The
  // check lives here rather than in the popup because the keyboard shortcut
  // and the call trigger both reach startSession without the popup ever
  // opening. Refuse BEFORE startCapture, so nobody picks a screen for a
  // session that is about to be turned down.
  const recorder = (config.sipgateName || "").trim();
  if (!recorder) {
    if (options && options.trigger !== "popup") await notifyNameMissing();
    return {
      success: false,
      needsName: true,
      error: "Add your Sipgate name in Settings before recording. It identifies your sessions when you share them."
    };
  }

  const sopSteps = (config.sopSteps && config.sopSteps.length) ? config.sopSteps : DEFAULT_SOP_STEPS;

  // Screen capture first: the operator picks a window BEFORE the clock starts,
  // so the video's zero point and the timeline's zero point stay aligned. If
  // they cancel the picker we still record the timeline.
  const sessionId = makeSessionId();

  // Always captured. The picker is the only step the operator has to complete.
  const capture = await startCapture(sessionId);

  activeSession = {
    id: sessionId,
    startTime: Date.now(),
    endTime: null,
    tabs: {},
    events: [],
    sopSteps,
    // videoStartOffset: ms between the encoder's first frame and the session
    // clock's zero. The player subtracts it so a timeline click seeks to the
    // right frame even though the two clocks start microseconds apart.
    video: capture.success
      ? { captured: true, startedAt: capture.startedAt, mimeType: capture.mimeType }
      : { captured: false, error: capture.error || null },
    // Calls seen during this session. The first one decides the ticket the
    // dialog pre-selects; the rest are context for the timeline.
    calls: [],
    // Stamped at record time, not export time: this says who made the
    // recording, not who happened to send it on.
    recorder,
    imported: false,
    sourceId: null,
    metadata: { manualStart: !(options && options.trigger === "call"), trigger: (options && options.trigger) || "manual" }
  };
  if (options && options.trigger === "call") attachCallToSession(options.call || {});
  // Surface a capture failure to the popup. The session still runs -- the
  // timeline is the primary artifact -- but the operator must know that no
  // video is being recorded rather than discovering it at replay time.
  if (!capture.success) {
    pendingCaptureWarning = capture.error || "Video capture did not start";
  } else {
    pendingCaptureWarning = null;
  }
  if (capture.success && capture.startedAt) {
    activeSession.video.startOffset = capture.startedAt - activeSession.startTime;
  }

  // Inject the recorder into every currently open tab
  injectedTabs.clear();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
    activeSession.tabs[tab.id] = { url: tab.url, title: tab.title };
    activeSession.events.push({
      type: "tabEntered",
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      relativeTime: 0
    });
    injectedTabs.add(tab.id);
    initializeTab(tab.id, sopSteps);
  }

  updateBadge(true);

  // Always on: an unattended recording that nobody stops fills the disk and
  // buries the useful minutes in an hour of idle screen.
  armContinueAlarm();

  return {
    success: true,
    recordingId: activeSession.id,
    videoCapturing: !!(activeSession.video && activeSession.video.captured),
    captureWarning: pendingCaptureWarning
  };
}


// Record a call against the running session, wherever the session came from.
// Also visible on the timeline, so the replay shows when the phone rang.
function attachCallToSession(call) {
  if (!activeSession) return;
  const entry = {
    id: call.id || null,
    direction: call.direction || "in",
    from: call.from || null,
    to: call.to || null,
    startedAt: call.startedAt || Date.now(),
    ticketRef: call.ticketRef || null
  };
  activeSession.calls.push(entry);
  activeSession.events.push({
    type: "call",
    action: entry.direction === "out" ? "Called out" : "Answered a call",
    label: entry.from || entry.to || "",
    tabId: null,
    timestamp: entry.startedAt,
    relativeTime: entry.startedAt - activeSession.startTime
  });
  // Measure the nag from the call, which is when the clock that matters starts.
  armContinueAlarm();
}

// Send initializeRecorder to a tab; if the content script is unreachable
// (classic case: the extension was updated/reloaded and the tab's old content
// script is ORPHANED), programmatically re-inject the recorder files and retry.
// Without this, a tab that was already open before the extension reload records
// NOTHING until it is manually refreshed.
async function initializeTab(tabId, sopSteps) {
  const msg = { type: "initializeRecorder", recordingId: activeSession.id, sopSteps };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return;
  } catch (e) {
    // No live content script in this tab -> inject fresh copies.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["ws-hook.js"]
    });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["tagger.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // chrome:// pages, PDF viewer, etc. -- cannot inject, safe to skip.
    injectedTabs.delete(tabId);
  }
}

async function stopSession(options) {
  if (!activeSession) return { success: false, error: "No active session" };

  activeSession.endTime = Date.now();
  const id = activeSession.id;

  // Stop the encoder BEFORE saving so the video's final size/duration can be
  // recorded on the session itself.
  if (activeSession.video && activeSession.video.captured) {
    const res = await stopCapture(id);
    activeSession.video.size = res && res.size ? res.size : 0;
    activeSession.video.saved = !!(res && res.success);
    activeSession.video.durationMs = activeSession.endTime - (activeSession.video.startedAt || activeSession.startTime);
  }

  // The recording is persisted here, before anyone chooses a ticket. Ticket
  // assignment, download and upload all happen afterwards against the stored
  // session, so closing the dialog -- or a failed upload -- never loses a video.
  activeSession.ticket = null;
  // Whatever ends the session ends our interest in its call: without this a
  // late hangup would prompt against the NEXT recording.
  followedCallId = null;
  const hadVideo = !!(activeSession.video && activeSession.video.saved);
  await saveRecording(activeSession);
  activeSession = null;

  clearContinueAlarm();
  closeContinueWindow();

  // Tell every tab to remove the floating tagger and stop rrweb.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "teardownRecorder" }).catch(() => {});
  }

  updateBadge(false);

  broadcastRecordingsChanged();

  if (hadVideo && !(options && options.skipTicketDialog)) {
    openTicketWindow(id);
  }
  return { success: true, id, ticketDialog: hadVideo };
}

// ---- Post-recording: ticket dialog -------------------------------------------
let ticketWindowId = null;

async function openTicketWindow(recordingId) {
  const url = chrome.runtime.getURL(`ticket.html?rec=${encodeURIComponent(recordingId)}`);
  // Wide enough for the ticket table's five columns without horizontal scroll.
  const W = 1000, H = 640;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round(cur.left + (cur.width - W) / 2));
    top = Math.max(0, Math.round(cur.top + (cur.height - H) / 2));
  } catch (e) {}
  try {
    const win = await chrome.windows.create({ url, type: "popup", width: W, height: H, left, top, focused: true });
    ticketWindowId = win.id;
  } catch (e) { /* nothing to do: the recording is already stored */ }
}

// Next free number for a ticket, e.g. 1234_001 then 1234_002. Derived from the
// recordings we have already assigned rather than from the download folder,
// which the extension is not allowed to read.
async function nextTicketSequence(ticketRef) {
  if (!ticketRef) return { next: 1 };
  const all = await getAllRecordings();
  let max = 0;
  for (const r of all) {
    if (r.ticket && String(r.ticket.ref) === String(ticketRef) && r.ticket.seq > max) max = r.ticket.seq;
  }
  return { next: max + 1 };
}

// Tell any open popup that the recordings list changed. sendMessage throws
// when nothing is listening, which is the normal case; swallow it.
function broadcastRecordingsChanged() {
  chrome.runtime.sendMessage({ type: "recordingsChanged" }).catch(() => {});
}

async function finishRecording(id, ticket) {
  const all = await getAllRecordings();
  const rec = all.find((r) => r.id === id);
  if (!rec) return { success: false, error: "Recording not found" };
  rec.ticket = Object.assign({ assignedAt: Date.now() }, ticket);
  await saveRecording(rec);
  broadcastRecordingsChanged();
  return { success: true };
}

// ---- "Keep recording?" reminder ----------------------------------------------
// chrome.alarms, not setTimeout: the service worker is torn down between
// events, and an alarm survives that. It can fire a little late, which for a
// five-minute nag is irrelevant.
const CONTINUE_ALARM = "continuePrompt";
let continueWindowId = null;

async function armContinueAlarm() {
  const minutes = FIXED.continueMinutes;
  chrome.alarms.create(CONTINUE_ALARM, { delayInMinutes: minutes });
  return minutes;
}

function clearContinueAlarm() {
  chrome.alarms.clear(CONTINUE_ALARM).catch(() => {});
}

async function closeContinueWindow() {
  if (continueWindowId == null) return;
  try { await chrome.windows.remove(continueWindowId); } catch (e) {}
  continueWindowId = null;
}

// `reason` changes only the wording: "the call ended" is a different question
// from "you have been recording a while", and answering the wrong one is how an
// operator ends up stopping a recording they meant to keep.
async function openContinueWindow(minutes, reason) {
  if (!activeSession) return;
  await closeContinueWindow();
  const url = chrome.runtime.getURL(
    `continue.html?min=${minutes}&why=${encodeURIComponent(reason || "timer")}`);
  const W = 460, H = 220;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round(cur.left + (cur.width - W) / 2));
    top = Math.max(0, Math.round(cur.top + (cur.height - H) / 3));
  } catch (e) {}
  try {
    const win = await chrome.windows.create({ url, type: "popup", width: W, height: H, left, top, focused: true });
    continueWindowId = win.id;
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_KEEPALIVE_ALARM) { ensureCallPollerAlive(); return; }
  if (alarm.name !== CONTINUE_ALARM) return;
  if (!activeSession) return;
  openContinueWindow(FIXED.continueMinutes, "timer");
  // Re-arm: if the operator ignores the window entirely we still ask again
  // rather than going quiet for the rest of the session.
  armContinueAlarm();
});

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === continueWindowId) continueWindowId = null;
  if (winId === ticketWindowId) ticketWindowId = null;
});

// Toolbar state, same language the desktop tool used: green dot = installed and
// watching, red dot = recording. The icon is the whole status display; the
// tooltip spells it out for anyone who cannot rely on the colour.
const ICON_IDLE = {
  16: "icons/idle16.png", 32: "icons/idle32.png",
  48: "icons/idle48.png", 128: "icons/idle128.png"
};
const ICON_RECORDING = {
  16: "icons/recording16.png", 32: "icons/recording32.png",
  48: "icons/recording48.png", 128: "icons/recording128.png"
};

function updateBadge(recording) {
  chrome.action.setIcon({ path: recording ? ICON_RECORDING : ICON_IDLE }).catch(() => {});
  chrome.action.setTitle({
    title: recording ? "SORT - recording" : "SORT - ready"
  }).catch(() => {});
  // No badge text. The red dot on the icon already says "recording", and "REC"
  // stacked on top of it was the same fact twice.
  chrome.action.setBadgeText({ text: "" });
}

// A service worker restart loses the icon, so restore it whenever the worker
// wakes: without this the toolbar can sit on the red dot after a crash.
chrome.runtime.onStartup.addListener(() => updateBadge(false));
chrome.runtime.onInstalled.addListener(() => updateBadge(false));

// ---- Keyboard shortcut -------------------------------------------------------
// Declared in the manifest as "toggle-recording". Chrome owns the key binding:
// an extension can read it but cannot set it, so the settings tab shows the
// current combination and links to chrome://extensions/shortcuts to change it.
//
// A shortcut cannot skip the share picker. Chrome requires a real click inside
// the capture window before it hands over a stream, so the shortcut gets the
// operator to the picker one keystroke instead of three, and stopping is fully
// hands-free.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-recording") return;
  if (activeSession) {
    await stopSession();
  } else {
    // No focusCaptureWindow() here. startSession() does not return until the
    // encoder is running, and by then captureStarted has already minimized the
    // window -- so focusing afterwards un-minimized it and left the picker
    // window sitting on screen for the whole session. The window is brought
    // forward at creation time instead, while the picker is still the thing
    // the operator needs (see openCaptureWindow).
    await startSession({ trigger: "shortcut" });
  }
});

// The shortcut and the call trigger can start a session with no UI open at
// all. A silent refusal there looks exactly like a broken shortcut, so it has
// to surface somewhere the operator will see it.
async function notifyNameMissing() {
  // Three channels, because no single one is dependable here.
  //
  // A notification is the obvious choice and the least reliable: macOS gates
  // Chrome's notifications behind its own Focus/Do Not Disturb and per-app
  // permission, Windows does the same through Focus assist, and Chrome itself
  // suppresses banners while a screen is being shared or presented. It can
  // fail completely silently -- create() succeeds, nothing appears.
  //
  // So the badge is the source of truth (always visible, no permission can
  // hide it), the popup is opened when Chrome allows it, and the notification
  // is a bonus when the OS is willing.

  // 1. Badge. Unmissable and unblockable.
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#E21A82" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: "SORT: add your Sipgate name in Settings before recording"
    });
  } catch (e) {}

  // 2. The popup itself, on the field that is missing.
  //
  // The flag is set BEFORE the popup is opened, and it is set whether or not
  // opening succeeds: a popup started by openPopup() gets no message and no
  // arguments, so it has to find out for itself why it was opened. Without
  // this it loads on Recordings and the operator is told nothing. Storing it
  // also covers the case where Chrome refuses to open and the operator clicks
  // the badge themselves a moment later.
  //
  // chrome.storage.session, not a worker variable: the worker can be torn down
  // between the refusal and the popup reading it.
  try { await chrome.storage.session.set({ nameWarning: true }); } catch (e) {}

  // openPopup() needs a recent user gesture; pressing the shortcut counts, but
  // Chrome refuses in some window states, so a failure here is expected and
  // not worth reporting.
  let popupOpened = false;
  try {
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      popupOpened = true;
    }
  } catch (e) {}

  // 3. Notification. Skipped when the popup is already showing the problem.
  if (popupOpened) return;
  try {
    const id = await new Promise((resolve) => {
      chrome.notifications.create("sort-needs-name", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/idle128.png"),
        title: "SORT did not start recording",
        message: "Add your Sipgate name in SORT's settings, then press the shortcut again.",
        priority: 2,
        requireInteraction: true
      }, (createdId) => {
        // Swallowing lastError is what hid this failing in the first place.
        if (chrome.runtime.lastError) {
          console.warn("SORT: notification suppressed:", chrome.runtime.lastError.message);
          resolve(null);
        } else resolve(createdId);
      });
    });

    // Nothing was shown and no popup opened: the operator has only the badge.
    // Say so in the worker log so this is diagnosable rather than mysterious.
    if (!id) console.warn("SORT: could not show a notification; the toolbar badge is the only signal.");
  } catch (e) {
    console.warn("SORT: notification failed:", e);
  }
}

// Clicking the notification should land on the field it is complaining about.
chrome.notifications.onClicked.addListener((id) => {
  if (id !== "sort-needs-name") return;
  chrome.notifications.clear(id);
  try { chrome.action.openPopup(); } catch (e) {}
});

// The badge is a standing complaint: clear it as soon as a name exists.
async function clearNameWarning() {
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "SORT - ready" });
    chrome.notifications.clear("sort-needs-name");
    await chrome.storage.session.remove("nameWarning");
  } catch (e) {}
}

// ---- Import ------------------------------------------------------------------
let importWindowId = null;

async function openImportWindow() {
  // Focus the one already open rather than stacking windows.
  if (importWindowId !== null) {
    try { await chrome.windows.update(importWindowId, { focused: true }); return; }
    catch (e) { importWindowId = null; }
  }
  const url = chrome.runtime.getURL("import.html");
  const W = 560, H = 620;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round(cur.left + (cur.width - W) / 2));
    top = Math.max(0, Math.round(cur.top + (cur.height - H) / 2));
  } catch (e) {}
  try {
    const win = await chrome.windows.create({ url, type: "popup", width: W, height: H, left, top, focused: true });
    importWindowId = win.id;
  } catch (e) {}
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === importWindowId) importWindowId = null;
});

// Only meaningful while the picker is still waiting for a click. Once
// captureStarted has minimized the window, raising it again would put a window
// the operator is finished with back on top of their work -- and into the
// recording, if they chose to capture this screen.
async function focusCaptureWindow() {
  if (captureWindowId == null) return;
  if (captureMinimized) return;
  try {
    await chrome.windows.update(captureWindowId, { focused: true, drawAttention: true });
  } catch (e) {}
}

// ---- Message handler ---------------------------------------------------------
// ---- Call trigger ------------------------------------------------------------
// Sipgate pushes reach n8n, n8n keeps the live-call state, and SORT polls it.
// The extension has no public URL, so it cannot be pushed to -- and polling is
// the better fit anyway: it is self-healing. A missed event is invisible two
// seconds later, whereas a missed push is a recording that never started.
//
// What the payloads actually look like on our hotline (verified against real
// n8n executions):
//
//   inbound newCall  user: [16 agents]   the group is ringing, nobody has it
//   inbound answer   user: "Rahel Mueller"   <- the only event that assigns
//   outbound newCall user: "Christoph Armschat"
//   hangup           no user at all, only callId
//
// Hence: recording starts on a SCALAR user matching the configured name, and
// stops by matching the callId we are following. Ringing never starts anything;
// on a busy hotline that would open a picker on sixteen machines at once.

// The call we started this session for, so a hangup for a DIFFERENT call
// (a colleague's, or one we joined mid-way) cannot end our recording.
let followedCallId = null;

// A hangup asks rather than stops: the operator is usually still writing up
// what just happened, and killing the recording at the moment the customer
// hangs up would cut off the part that explains the fix.
async function handleCallEnded(callId) {
  if (!activeSession) { followedCallId = null; return; }
  if (followedCallId && callId && callId !== followedCallId) return;
  followedCallId = null;
  // Same prompt as the five-minute reminder, so there is one way to end a
  // recording rather than two that behave slightly differently.
  await armContinueAlarm();
  openContinueWindow(FIXED.continueMinutes, "call");
}

async function handleCallStarted(call) {
  const res = await startSession({
    trigger: "call",
    call: {
      id: call.callId,
      direction: call.direction,
      from: call.from,
      to: call.to,
      startedAt: call.at || Date.now()
    }
  });
  // Follow this call whether it opened a session or joined the running one:
  // either way its hangup is the one that concerns us.
  if (res && res.success) followedCallId = call.callId;
  return res;
}

// Push the current settings at the poller. Called on install, on startup, and
// whenever settings are saved, so a changed name or URL takes effect at once.
async function syncCallPoller() {
  const config = await getConfig();
  const enabled = !!(config.callTrigger && config.callTrigger.url && (config.sipgateName || "").trim());
  try {
    await ensureOffscreen();
  } catch (e) {
    return { polling: false, error: "The background worker could not be started." };
  }
  if (!enabled) {
    chrome.runtime.sendMessage({ target: "callpoll", type: "stop" }).catch(() => {});
    return { polling: false };
  }
  chrome.runtime.sendMessage({
    target: "callpoll",
    type: "configure",
    config: {
      url: config.callTrigger.url,
      apiKey: config.callTrigger.apiKey || "",
      name: (config.sipgateName || "").trim(),
      intervalMs: Math.max(1000, Number(config.callTrigger.intervalMs) || 2000)
    }
  }).catch(() => {});
  return { polling: true };
}

// The offscreen document can be closed by Chrome under memory pressure, and a
// worker that was woken by some unrelated event never ran onStartup. A slow
// heartbeat re-creates the document and re-arms the poller, so call recording
// cannot quietly stop working until the next browser restart. One minute is the
// fastest chrome.alarms allows and is plenty: this only repairs, it never
// detects.
const POLL_KEEPALIVE_ALARM = "callPollKeepalive";

async function ensureCallPollerAlive() {
  const config = await getConfig();
  if (!(config.callTrigger && config.callTrigger.url && (config.sipgateName || "").trim())) return;
  let alive = false;
  try {
    const res = await chrome.runtime.sendMessage({ target: "callpoll", type: "status" });
    alive = !!(res && res.polling);
  } catch (e) { /* no offscreen document listening */ }
  if (!alive) await syncCallPoller();
}

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_KEEPALIVE_ALARM, { periodInMinutes: 1 });
  syncCallPoller();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_KEEPALIVE_ALARM, { periodInMinutes: 1 });
  syncCallPoller();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages addressed to another context (the offscreen document, the capture
  // window) travel through every listener in the extension. Ignore them here or
  // an unhandled type in this switch answers on their behalf.
  if (message && message.target && message.target !== "worker") return false;
  switch (message.type) {

    case "startSession":
      startSession(message.options).then(sendResponse);
      return true;

    // Entry point for the Sipgate/n8n trigger. Starts a recording, or attaches
    // the call to the one already running.
    case "callStarted":
      handleCallStarted(message.call || {}).then(sendResponse);
      return true;

    // ---- from the offscreen poller ----
    // Only fires on a CHANGE, so this is "I just answered", not "still on a
    // call". The poller has already checked the name.
    case "callStateStarted":
      handleCallStarted(message.call || {}).then(() => sendResponse({ success: true }));
      return true;

    case "callStateEnded":
      handleCallEnded(message.callId || null).then(() => sendResponse({ success: true }));
      return true;

    // First poll after a reload: a call may already be running. Follow it so
    // its hangup still prompts, but do not open a picker for a call the
    // operator answered minutes ago.
    case "callStateAdopted":
      if (message.call && activeSession) followedCallId = message.call.callId;
      sendResponse({ success: true });
      return false;

    case "callPollError":
      console.warn("SORT: call-state endpoint unreachable:", message.error);
      sendResponse({ success: true });
      return false;

    case "syncCallPoller":
      syncCallPoller().then(sendResponse);
      return true;

    case "probeCallEndpoint":
      (async () => {
        try { await ensureOffscreen(); } catch (e) {
          sendResponse({ success: false, error: "The background worker could not be started." });
          return;
        }
        chrome.runtime.sendMessage({ target: "callpoll", type: "probe", config: message.config })
          .then(sendResponse)
          .catch((e) => sendResponse({ success: false, error: String(e.message || e) }));
      })();
      return true;

    // The operator ended the share from Chrome's own "Stop sharing" bar. The
    // encoder is already finished; persist what it produced and mark the
    // session so the player knows the video ends early.
    // capture.js reports the encoder actually began.
    case "captureStarted":
      // The picker is done and the encoder is running, so this window has
      // nothing left to ask. Get it out of the operator's way -- and out of
      // the recording, if they chose to capture this screen -- but keep it
      // alive, because closing it would end the stream.
      minimizeCaptureWindow();
      if (capturePending) {
        capturePending({
          success: true,
          startedAt: message.startedAt,
          mimeType: message.mimeType
        });
      }
      return false;

    // The operator cancelled or denied the picker.
    case "captureFailed":
      if (capturePending) capturePending({ success: false, error: message.error });
      closeCaptureWindow();
      return false;

    case "captureEndedByUser":
      if (activeSession && activeSession.video && activeSession.video.captured) {
        stopCapture(activeSession.id).then((res) => {
          if (activeSession && activeSession.video) {
            activeSession.video.saved = !!(res && res.success);
            activeSession.video.endedEarly = true;
          }
        });
      }
      return false;

    case "stopSession":
      stopSession(message.options).then(sendResponse);
      return true;

    // "Keep recording" on the reminder: re-arm and carry on.
    case "keepRecording":
      armContinueAlarm().then((min) => sendResponse({ success: true, minutes: min }));
      return true;

    case "promptContinue":
      armContinueAlarm().then((min) => {
        openContinueWindow(min);
        sendResponse({ success: true });
      });
      return true;

    case "nextTicketSequence":
      nextTicketSequence(message.ticketRef).then(sendResponse);
      return true;

    case "finishRecording":
      finishRecording(message.id, message.ticket).then(sendResponse);
      return true;

    // Downloads must be started from the worker: the ticket window closes and
    // would cancel an in-flight download of its own.
    case "downloadVideo":
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false,
        conflictAction: "uniquify"
      }).then((downloadId) => sendResponse({ success: true, downloadId }))
        .catch((e) => sendResponse({ success: false, error: String(e.message || e) }));
      return true;

    case "openTicketDialog":
      openTicketWindow(message.id);
      sendResponse({ success: true });
      return false;

    // The popup shows the live binding rather than a hardcoded string, so it
    // cannot drift from whatever the operator set in Chrome.
    case "getShortcut":
      chrome.commands.getAll().then((cmds) => {
        const c = cmds.find((x) => x.name === "toggle-recording");
        sendResponse({ shortcut: (c && c.shortcut) || "" });
      });
      return true;

    case "getSessionStatus":
      sendResponse({
        active: !!activeSession,
        tabCount: activeSession ? Object.keys(activeSession.tabs).length : 0,
        eventCount: activeSession ? activeSession.events.length : 0,
        startTime: activeSession ? activeSession.startTime : null
      });
      return false;

    case "recordEvent":
      if (!activeSession || message.recordingId !== activeSession.id) {
        sendResponse({ ok: false });
        return false;
      }
      activeSession.events.push({
        ...message.event,
        tabId: sender.tab ? sender.tab.id : null,
        timestamp: Date.now(),
        relativeTime: Date.now() - activeSession.startTime
      });
      if (sender.tab) {
        activeSession.tabs[sender.tab.id] = activeSession.tabs[sender.tab.id] || {
          url: sender.tab.url,
          title: sender.tab.title
        };
      }
      sendResponse({ ok: true });
      return false;

    case "getRecordings":
      getAllRecordings().then(sendResponse);
      return true;

    case "deleteRecording":
      deleteRecording(message.id)
        .then(() => deleteVideo(message.id))
        .then(() => { broadcastRecordingsChanged(); return { success: true }; })
        .then(sendResponse);
      return true;

    case "getConfig":
      getConfig().then(sendResponse);
      return true;

    case "saveConfig":
      saveConfig(message.config).then(() => {
        // The "!" badge is a standing complaint about a missing name; retire it
        // the moment one exists.
        if (message.config && (message.config.sipgateName || "").trim()) clearNameWarning();
        // If recording, push new SOP steps to every tab's live tagger.
        if (activeSession && message.config && message.config.sopSteps) {
          activeSession.sopSteps = message.config.sopSteps.length
            ? message.config.sopSteps
            : DEFAULT_SOP_STEPS;
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, {
                type: "updateSopSteps",
                sopSteps: activeSession.sopSteps
              }).catch(() => {});
            }
          });
        }
        // A changed name, URL or key must take effect now, not at next restart.
        syncCallPoller();
        sendResponse({ success: true });
      });
      return true;

    case "exportRecording":
      handleExportRecording(message.id).then(sendResponse);
      return true;

    // The popup asks, on open, whether it was summoned by a refused recording.
    // Read-and-clear: the warning is for this one opening, not forever.
    case "consumeNameWarning":
      chrome.storage.session.get("nameWarning").then((v) => {
        const pending = !!(v && v.nameWarning);
        if (pending) chrome.storage.session.remove("nameWarning");
        sendResponse({ pending });
      }).catch(() => sendResponse({ pending: false }));
      return true;

    case "openImport":
      openImportWindow();
      sendResponse({ success: true });
      return false;

    case "importFinished":
      broadcastRecordingsChanged();
      sendResponse({ success: true });
      return false;
  }
});

// ---- Export: .sortz session bundle -------------------------------------------
// The bundle is built in an offscreen document, not here. A service worker has
// no URL.createObjectURL, and it is torn down after ~30s idle -- which is well
// inside the time a 300 MB bundle takes to write. The offscreen document has
// both, and unlike the popup it does not die when the operator clicks away.
let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    if (existing && existing.length) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["BLOBS"],
      justification: "Assemble session bundles and watch the call-state endpoint on a short timer."
    });
  })();
  try { await offscreenReady; } catch (e) { offscreenReady = null; throw e; }
  return offscreenReady;
}

async function handleExportRecording(recordingId) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen", type: "buildBundle", id: recordingId
    });
    if (!res || !res.success) {
      return { success: false, error: (res && res.error) || "The bundle could not be built." };
    }

    const downloadId = await chrome.downloads.download({
      url: res.url,
      filename: res.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });

    // Hold the blob URL until the bytes are on disk, then let it go: an
    // un-revoked bundle URL pins the whole video in memory.
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.runtime.sendMessage({ target: "offscreen", type: "revokeUrl", url: res.url }).catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    return { success: true, filename: res.filename, size: res.size };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
}

// ---- Tab lifecycle: inject into new tabs while recording ---------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!activeSession) return;
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return;

  // A real document load starts in the "loading" state -> the content script
  // context is fresh and must be (re)initialized once it completes.
  if (changeInfo.status === "loading") {
    injectedTabs.delete(tabId); // page is reloading/navigating for real
  }

  if (changeInfo.status !== "complete") return;

  // Record the URL change either way (covers SPA route changes too)
  activeSession.tabs[tabId] = { url: tab.url, title: tab.title };
  activeSession.events.push({
    type: "tabNavigated",
    tabId,
    url: tab.url,
    title: tab.title,
    timestamp: Date.now(),
    relativeTime: Date.now() - activeSession.startTime
  });

  // Only (re)initialize the recorder for a genuine fresh document load.
  // SPA route changes keep the same content-script context, so rrweb's
  // mutation observer already captures the new view — re-injecting would
  // restart rrweb and lose the running DOM stream.
  if (!injectedTabs.has(tabId)) {
    injectedTabs.add(tabId);
    initializeTab(tabId, activeSession.sopSteps);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeSession) return;
  activeSession.events.push({
    type: "tabSwitch",
    tabId: activeInfo.tabId,
    timestamp: Date.now(),
    relativeTime: Date.now() - activeSession.startTime
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  if (!activeSession) return;
  activeSession.events.push({
    type: "tabClosed",
    tabId,
    timestamp: Date.now(),
    relativeTime: Date.now() - activeSession.startTime
  });
});

// The operator closed the capture window by hand. Unblock a pending start and
// mark the running session so the player knows the video is short.
chrome.windows.onRemoved.addListener((winId) => {
  if (winId !== captureWindowId) return;
  captureWindowId = null;
  if (capturePending) capturePending({ success: false, error: "Capture window was closed" });
  if (activeSession && activeSession.video && activeSession.video.captured) {
    activeSession.video.endedEarly = true;
  }
});

// Restore badge state after service worker wakes up
updateBadge(!!activeSession);
