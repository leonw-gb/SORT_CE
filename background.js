// background.js - Service Worker
// Session is started/stopped manually via the popup button.
// ALL tabs are recorded once a session is active.

// Fixed deployment values (upload host, Odoo host/db/model, reminder interval).
importScripts("defaults.js");

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

async function openCaptureWindow(recordingId) {
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
  try {
    await chrome.windows.update(captureWindowId, { state: "minimized" });
  } catch (e) { /* the operator may have closed it already */ }
}

async function closeCaptureWindow() {
  if (captureWindowId == null) return;
  try { await chrome.windows.remove(captureWindowId); } catch (e) {}
  captureWindowId = null;
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

async function openContinueWindow(minutes) {
  if (!activeSession) return;
  await closeContinueWindow();
  const url = chrome.runtime.getURL(`continue.html?min=${minutes}`);
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
  if (alarm.name !== CONTINUE_ALARM) return;
  if (!activeSession) return;
  openContinueWindow(FIXED.continueMinutes);
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
    await startSession({});
    // The capture window opens focused with the Share button ready; the picker
    // still needs the operator's click.
    focusCaptureWindow();
  }
});

async function focusCaptureWindow() {
  if (captureWindowId == null) return;
  try {
    await chrome.windows.update(captureWindowId, { focused: true, drawAttention: true });
  } catch (e) {}
}

// ---- Message handler ---------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case "startSession":
      startSession(message.options).then(sendResponse);
      return true;

    // Entry point for the future Sipgate/n8n trigger. Starts a recording, or
    // attaches the call to the one already running. Nothing calls it yet.
    case "callStarted":
      startSession({ trigger: "call", call: message.call })
        .then(sendResponse);
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
        sendResponse({ success: true });
      });
      return true;

    case "exportRecording":
      handleExportRecording(message.id).then(sendResponse);
      return true;
  }
});

// ---- Export ------------------------------------------------------------------
async function handleExportRecording(recordingId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECORDINGS_STORE, "readonly");
    const req = tx.objectStore(RECORDINGS_STORE).get(recordingId);
    req.onsuccess = () => {
      const recording = req.result;
      if (!recording) { reject(new Error("Recording not found")); return; }
      const jsonStr = JSON.stringify(recording, null, 2);
      const url = "data:application/json;charset=utf-8," + encodeURIComponent(jsonStr);
      const timestamp = new Date(recording.startTime).toISOString().replace(/[:.]/g, "-");
      chrome.downloads.download({ url, filename: `recording_${timestamp}.json`, saveAs: false }, () => {
        resolve({ success: true });
      });
    };
    req.onerror = () => reject(req.error);
  });
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
