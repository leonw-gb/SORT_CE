// background.js - Service Worker
// Session is started/stopped manually via the popup button.
// ALL tabs are recorded once a session is active.

// Fixed deployment values (upload host, Odoo host/db/model, reminder interval).
// Suppress persistent diagnostic events until the disclosure has been accepted.
globalThis.SortDisclosureAllowsDiagnostics = () => false;
importScripts("build-info.js", "diagnostics-core.js", "diagnostics.js");
importScripts("defaults.js", "security.js", "updates.js");
// Content scripts must not write call-trigger storage or read diagnostic state.
chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"}).catch(() => {});
// Shared with the offscreen poller: one copy of the "is this call mine" rule.
importScripts("callmatch.js");

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const CONFIG_STORE = "config";
// Screen-capture videos live in their OWN store: a session video is megabytes,
// and the player must be able to load the (small) event timeline without
// pulling the video into memory.
const VIDEOS_STORE = "videos";

// Disclosure version is independent of the extension release version.
// Change it only when the disclosed practices materially change.
const DISCLOSURE_VERSION = "1.0";
let disclosureAcceptance = null;
function validDisclosureAcceptance(value) {
  return !!value && value.version === DISCLOSURE_VERSION &&
    Number.isFinite(value.acceptedAt) && value.acceptedAt > 0 &&
    value.action === "agree-and-enable";
}
function hasAcceptedDisclosure() { return validDisclosureAcceptance(disclosureAcceptance); }
globalThis.SortDisclosureAllowsDiagnostics = hasAcceptedDisclosure;

// The worker, not just the popup, enforces the gate. Older enabled installs
// have no agreement record and migrate to OFF without deleting their settings.
let toolEnabled = false;
let toolEnabledSince = 0;
let toolStateError = null;
let toolTransition = false;
let toolStateQueue = Promise.resolve();
const toolReady = chrome.storage.local.get("sortToolState").then(async ({sortToolState}) => {
  disclosureAcceptance = validDisclosureAcceptance(sortToolState?.disclosure)
    ? sortToolState.disclosure : null;
  toolEnabled = hasAcceptedDisclosure() && sortToolState?.enabled === true;
  toolEnabledSince = Number(sortToolState?.since) || 0;
  if (!hasAcceptedDisclosure() && sortToolState?.enabled === true) {
    // Persist migration so an older enabled flag cannot silently reactivate.
    await chrome.storage.local.set({sortToolState: {enabled: false, since: Date.now()}});
  }
}).catch(() => {
  toolEnabled = false;
  disclosureAcceptance = null;
  toolStateError = "Could not read SORT's saved state. SORT remains off; reopen the popup to retry.";
}).then(() => updateBadge(false));

function disclosureRequired() {
  return {success: false, enabled: false, needsDisclosure: true,
    disclosureVersion: DISCLOSURE_VERSION,
    error: "Read and agree to the recording disclosure before enabling SORT."};
}
function acceptDisclosureAndEnable(version, affirmative) {
  const operation = toolStateQueue.then(async () => {
    await toolReady;
    if (affirmative !== true || version !== DISCLOSURE_VERSION)
      return {success: false, enabled: toolEnabled, error: "The disclosure changed or agreement was not supplied. Reopen the popup and try again."};
    // Preserve the original acceptance time on repeated clicks or ordinary toggles.
    const acceptance = hasAcceptedDisclosure() ? disclosureAcceptance : {
      version: DISCLOSURE_VERSION, acceptedAt: Date.now(), action: "agree-and-enable"
    };
    return applyToolEnabled(true, acceptance);
  });
  toolStateQueue = operation.catch(() => {});
  return operation;
}
function toolUnavailable() {
  if (!hasAcceptedDisclosure()) return {...disclosureRequired(), disabled: true};
  return {success: false, disabled: true, error: "SORT is off. Switch it on in the popup to record."};
}
function publishToolState() {
  updateBadge(!!activeSession);
  chrome.runtime.sendMessage({type: "toolStateChanged"}).catch(() => {});
}
function setToolEnabled(enabled) {
  if (typeof enabled !== "boolean") return Promise.resolve({success: false, error: "Invalid on/off state."});
  const operation = toolStateQueue.then(() => applyToolEnabled(enabled));
  toolStateQueue = operation.catch(() => {});
  return operation;
}
async function applyToolEnabled(enabled, newAcceptance = null) {
  await toolReady;
  if (enabled && !hasAcceptedDisclosure() && !validDisclosureAcceptance(newAcceptance))
    return disclosureRequired();
  if (enabled === toolEnabled && !toolStateError && !(activeSession && !enabled))
    return {success: true, enabled: toolEnabled};
  toolTransition = true;
  SortUpdates.beginJob();
  let stopped = null;
  try {
    // Block every new start immediately, even during the storage write.
    if (!enabled) toolEnabled = false;
    publishToolState();
    const since = Date.now();
    let persistenceError = null;
    try {
      const acceptance = validDisclosureAcceptance(newAcceptance) ? newAcceptance : disclosureAcceptance;
      const state = {enabled, since};
      if (validDisclosureAcceptance(acceptance)) state.disclosure = acceptance;
      // Acceptance and enabled state are committed together before polling starts.
      await chrome.storage.local.set({sortToolState: state});
      disclosureAcceptance = validDisclosureAcceptance(acceptance) ? acceptance : null;
      toolEnabled = enabled && hasAcceptedDisclosure();
      toolEnabledSince = since;
      toolStateError = null;
    } catch (_) {
      toolEnabled = false;
      persistenceError = new Error("SORT is off for now, but its state could not be saved. Retry before restarting Chrome.");
      toolStateError = persistenceError.message;
    }
    if (!toolEnabled) {
      // Poll shutdown must not delay stopping a recording or share picker.
      const pollStop = syncCallPoller();
      clearContinueAlarm();
      void closeContinueWindow();
      pendingCallEndPrompt = false;
      callActive = false;
      followedCallId = null;
      if (capturePending) {
        capturePending({success: false, cancelled: true, error: "SORT was switched off."});
        await closeCaptureWindow();
      }
      // A picker/initialization already in flight must settle before the
      // normal stop/save flow. A late encoder start is saved, not discarded.
      if (sessionStartPromise) await sessionStartPromise.catch(() => {});
      if (activeSession || sessionStopPromise) stopped = await stopSession();
      await pollStop;
    } else {
      await syncCallPoller();
    }
    if (persistenceError) throw persistenceError;
    return {success: true, enabled: toolEnabled, stopped: !!stopped?.success, ticketDialog: !!stopped?.ticketDialog};
  } catch (e) {
    return {success: false, enabled: toolEnabled, error: String(e.message || e)};
  } finally {
    toolTransition = false;
    SortUpdates.endJob();
    publishToolState();
  }
}

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
// A visible extension window anchors the desktopCapture picker on a secure
// chrome-extension origin and hosts the video encoder.
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

  if (!toolEnabled) throw new Error("SORT was switched off.");
  const win = await chrome.windows.create({
    url, type: "popup", width: W, height: H, left, top, focused: true
  });
  captureWindowId = win.id;
  if (!toolEnabled) {
    await closeCaptureWindow();
    throw new Error("SORT was switched off.");
  }
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
  const closingId = captureWindowId;
  captureWindowId = null;
  try { await chrome.windows.remove(closingId); } catch (e) {}
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
      done({ success: false, error: "No source chosen. Recording cancelled." });
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
  const endpoint = config?.callTrigger?.url || "";
  if (endpoint) {
    const u = new URL(endpoint);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("Use an HTTP or HTTPS call-state endpoint without embedded credentials.");
  }
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, "readwrite");
    tx.objectStore(CONFIG_STORE).put({ key: "recordingConfig", value: withFixedSettings({
      theme: config?.theme, downloadFolder: String(config?.downloadFolder || "Recordings"),
      sipgateName: String(config?.sipgateName || "").trim(),
      callTrigger: {url: String(config?.callTrigger?.url || "").trim(), apiKey: String(config?.callTrigger?.apiKey || "").trim()},
      odoo: {username: String(config?.odoo?.username || "").trim(), apiKey: String(config?.odoo?.apiKey || "").trim()}
    }) });
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
  if (typeof id !== "string" || !id) throw new Error("Invalid recording ID.");
  if (activeSession?.id === id) throw new Error("Stop the recording before deleting it.");
  const db = await initDB();
  return new Promise((resolve, reject) => {
    // Timeline and video disappear together, or neither deletion commits.
    const tx = db.transaction([RECORDINGS_STORE, VIDEOS_STORE], "readwrite");
    tx.objectStore(RECORDINGS_STORE).delete(id);
    tx.objectStore(VIDEOS_STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("Deletion failed.")); };
  });
}

// Popup drafts are local only and never used as live recording configuration.
const SETTINGS_DRAFT_KEY = "sortSettingsDraft.v1";
const SETTINGS_FIELDS = ["downloadFolder", "sipgateName", "odooUser", "odooKey", "callStateUrl", "callStateToken", "theme"];
let settingsQueue = Promise.resolve();
function queueSettings(work) {
  SortUpdates.beginJob();
  const result = settingsQueue.then(work).finally(() => SortUpdates.endJob());
  settingsQueue = result.catch(() => {});
  return result;
}
async function storeSettingsDraft(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Invalid draft.");
  const clean = {};
  for (const key of SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    if (typeof fields[key] !== "string" || fields[key].length > 16384) throw new Error("Draft field is too long.");
    clean[key] = fields[key];
  }
  if (!Object.keys(clean).length) await chrome.storage.local.remove(SETTINGS_DRAFT_KEY);
  else await chrome.storage.local.set({[SETTINGS_DRAFT_KEY]: {version: 1, fields: clean, updatedAt: Date.now()}});
  return {success: true};
}

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
// session so the ticket dialog can pre-select its ticket later. Reminders are
// suspended for the whole call, not merely delayed from the time it began.
//
// The reverse order needs no special case: a call-started recording is a normal
// active session, so a later manual Start hits the same guard.
// Coalesce concurrent starts while the screen picker is open. Call state is
// tracked independently, including a hangup before a session has been created.
let sessionStartPromise = null;
let pendingCallEndPrompt = false;
async function startSession(options) {
  await toolReady;
  if (!toolEnabled) return toolUnavailable();
  if (SortUpdates.locked && options?.trigger === "call") SortUpdates.cancelRestart();
  if (SortUpdates.locked) return {success: false, error: "SORT is restarting for an update."};
  if (sessionStopPromise) return {success: false, error: "The previous recording is still saving."};
  if (sessionStartPromise) {
    const result = await sessionStartPromise;
    if (result.success && activeSession && options && options.trigger === "call" &&
        !activeSession.calls.some(c => c.id === (options.call || {}).id)) {
      attachCallToSession(options.call || {});
    }
    return result.success ? {...result, joinedExisting: true} : result;
  }
  sessionStartPromise = startSessionImpl(options);
  try {
    const result = await sessionStartPromise;
    if (result.success && pendingCallEndPrompt && canRemind()) await requestContinuePrompt("call");
    return result;
  } finally { sessionStartPromise = null; pendingCallEndPrompt = false; }
}

async function startSessionImpl(options) {
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
  if (!toolEnabled) return toolUnavailable();

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

  // Screen capture first: the operator picks a window BEFORE the clock starts,
  // so the video's zero point and the timeline's zero point stay aligned.
  // Cancelling or failing the picker cancels the entire recording attempt.
  const sessionId = makeSessionId();

  // Always captured. The picker is the only step the operator has to complete.
  const capture = await startCapture(sessionId);
  if (!capture.success) {
    await closeCaptureWindow();
    clearContinueAlarm();
    await closeContinueWindow();
    updateBadge(false);
    pendingCaptureWarning = null;
    return {success: false, cancelled: true, error: capture.error || "Recording cancelled. Nothing was recorded."};
  }

  activeSession = {
    id: sessionId,
    startTime: Date.now(),
    endTime: null,
    tabs: {},
    events: [],
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

  // If switched off just as the encoder started, let shutdown save it.
  if (!toolEnabled) return {success: true, recordingId: activeSession.id};

  // Inject the recorder into every currently open tab
  injectedTabs.clear();
  const tabs = await chrome.tabs.query({});
  if (!toolEnabled || !activeSession || activeSession.endTime) return {success: false, cancelled: true};
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
    initializeTab(tab.id);
  }

  // Seed the active-tab memo so the FIRST switch of the session is recorded
  // relative to where the operator actually started, not against null.
  lastActiveTabId = null;
  try {
    const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (cur) lastActiveTabId = cur.id;
  } catch (e) { /* no focused window */ }

  if (!toolEnabled || !activeSession || activeSession.endTime) return {success: false, cancelled: true};
  updateBadge(true);

  // Only remind while off-call. A hangup during the share picker still gets
  // its prompt once there is an actual recording to continue or stop.
  void armContinueAlarm();

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
  if (!toolEnabled || !activeSession || activeSession.endTime) return;
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
  // This records historical context only. Live call state is established by
  // the trigger BEFORE awaiting the share picker; never revive it here after
  // a hangup which arrived while the picker was open.
}

// Send initializeRecorder to a tab; if the content script is unreachable
// (classic case: the extension was updated/reloaded and the tab's old content
// script is ORPHANED), programmatically re-inject the recorder files and retry.
// Without this, a tab that was already open before the extension reload records
// NOTHING until it is manually refreshed.
async function initializeTab(tabId) {
  const session = activeSession;
  const isCurrent = () => toolEnabled && !!session && activeSession === session && !session.endTime;
  if (!isCurrent()) return;
  const msg = {type: "initializeRecorder", recordingId: session.id};
  const cancelStale = async () => {
    if (isCurrent()) return false;
    try { await chrome.tabs.sendMessage(tabId, {type: "teardownRecorder", recordingId: session.id}); } catch (_) {}
    return true;
  };
  try {
    const response = await chrome.tabs.sendMessage(tabId, msg);
    if (await cancelStale()) return;
    if (response?.success === true) {
      void SortDiagnostics.emit("tab.initialize", "ok");
      return;
    }
    if (response?.cancelled) return;
    // Older/orphaned scripts may not acknowledge: inject the current version.
  } catch (_) {}
  if (!isCurrent()) return;
  try {
    await chrome.scripting.executeScript({target: {tabId}, world: "MAIN", files: ["ws-hook.js"]});
    if (!isCurrent()) return;
    await chrome.scripting.executeScript({target: {tabId},
      files: ["build-info.js", "diagnostics-core.js", "diagnostics.js", "content.js"]});
    if (!isCurrent()) return;
    const response = await chrome.tabs.sendMessage(tabId, msg);
    if (await cancelStale()) return;
    void SortDiagnostics.emit("tab.initialize", response?.success ? "recovered" : "unavailable");
    if (!response?.success) injectedTabs.delete(tabId);
  } catch (_) {
    if (isCurrent()) {
      void SortDiagnostics.emit("tab.initialize", "unavailable");
      injectedTabs.delete(tabId);
    }
  }
}

let sessionStopPromise = null;
async function stopSession(options) {
  if (sessionStopPromise) return sessionStopPromise;
  sessionStopPromise = stopSessionImpl(options);
  try { return await sessionStopPromise; } finally { sessionStopPromise = null; }
}
async function stopSessionImpl(options) {
  if (!activeSession) return { success: false, error: "No active session" };

  activeSession.endTime = Date.now();
  clearContinueAlarm();
  void closeContinueWindow();
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
  // Keep live call state independently of recordings. If the operator starts
  // another manual recording during this same call it must also stay quiet.
  const hadVideo = !!(activeSession.video && activeSession.video.saved);
  await saveRecording(activeSession);
  activeSession = null;

  clearContinueAlarm();
  closeContinueWindow();

  // Tell every tab to stop recording.
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
let reminderEpoch = 0;
let reminderDueAt = 0;
let reminderAlarmQueue = Promise.resolve();

function canRemind(session = activeSession) {
  return toolEnabled && !!session && activeSession === session && !session.endTime && !callActive;
}

function queueReminderAlarm(work) {
  reminderAlarmQueue = reminderAlarmQueue.then(work, work).catch(() => {});
  return reminderAlarmQueue;
}

async function armContinueAlarm() {
  const minutes = FIXED.continueMinutes;
  if (!canRemind()) { clearContinueAlarm(); return minutes; }
  const epoch = ++reminderEpoch;
  const dueAt = reminderDueAt = Date.now() + minutes * 60000;
  await queueReminderAlarm(async () => {
    if (epoch !== reminderEpoch || !canRemind()) return;
    await chrome.alarms.create(CONTINUE_ALARM, { when: dueAt });
  });
  return minutes;
}

function clearContinueAlarm() {
  ++reminderEpoch;
  reminderDueAt = 0;
  // Serialize Chrome API calls: a delayed clear must not erase a newer timer.
  return queueReminderAlarm(() => chrome.alarms.clear(CONTINUE_ALARM));
}

async function closeContinueWindow() {
  const id = continueWindowId;
  continueWindowId = null;
  if (id == null) return;
  try { await chrome.windows.remove(id); } catch (_) {}
}

async function openContinueWindow(minutes, reason, session = activeSession, epoch = reminderEpoch) {
  const current = () => epoch === reminderEpoch && canRemind(session);
  if (!current()) return;
  await closeContinueWindow();
  if (!current()) return;
  const url = chrome.runtime.getURL(
    `continue.html?min=${minutes}&why=${encodeURIComponent(reason || "timer")}` +
    `&rec=${encodeURIComponent(session.id)}&prompt=${epoch}`);
  const W = 460, H = 220;
  let left, top;
  try {
    const cur = await chrome.windows.getLastFocused();
    left = Math.max(0, Math.round(cur.left + (cur.width - W) / 2));
    top = Math.max(0, Math.round(cur.top + (cur.height - H) / 3));
  } catch (_) {}
  if (!current()) return;
  try {
    const win = await chrome.windows.create({ url, type: "popup", width: W, height: H, left, top, focused: true });
    if (!win || win.id == null) return;
    // A call can start while Chrome is creating the window. Retire that window
    // immediately; its token also prevents its buttons acting on the session.
    if (!current()) { try { await chrome.windows.remove(win.id); } catch (_) {} return; }
    continueWindowId = win.id;
  } catch (_) {}
}

async function requestContinuePrompt(reason) {
  const session = activeSession;
  if (!canRemind(session)) return;
  const arming = armContinueAlarm();
  const epoch = reminderEpoch;
  const minutes = await arming;
  if (epoch !== reminderEpoch || !canRemind(session)) return;
  await openContinueWindow(minutes, reason, session, epoch);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_KEEPALIVE_ALARM) {
    chrome.storage.local.get("callTrigger").then(({ callTrigger }) => {
      if (callTrigger && Date.now() - Number(String(callTrigger.id).split("_")[0]) < 60000) {
        consumeTrigger(callTrigger);
      }
    }).catch(() => {});
    ensureCallPollerAlive();
    return;
  }
  if (alarm.name !== CONTINUE_ALARM) return;
  if (!canRemind()) { clearContinueAlarm(); return; }
  // Ignore an already-queued notification from an earlier timer/call/session.
  if (!reminderDueAt || Date.now() < reminderDueAt ||
      (Number.isFinite(alarm.scheduledTime) && alarm.scheduledTime < reminderDueAt)) return;
  await requestContinuePrompt("timer");
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
const ICON_INACTIVE = {
  16: "icons/inactive16.png", 32: "icons/inactive32.png",
  48: "icons/inactive48.png", 128: "icons/inactive128.png"
};
const ICON_RECORDING = {
  16: "icons/recording16.png", 32: "icons/recording32.png",
  48: "icons/recording48.png", 128: "icons/recording128.png"
};

// Keep one icon writer so state transitions cannot overwrite the update marker.
let toolbarQueue = Promise.resolve();
let toolbarRevision = 0;
let toolbarRecording = false;
// User-supplied PNGs, not a generated overlay. Keep all three recording states.
const ICON_UPDATE_IDLE = {
  16: "icons/update_idle16.png", 32: "icons/update_idle32.png",
  48: "icons/update_idle48.png", 128: "icons/update_idle128.png"
};
const ICON_UPDATE_INACTIVE = {
  16: "icons/update_inactive16.png", 32: "icons/update_inactive32.png",
  48: "icons/update_inactive48.png", 128: "icons/update_inactive128.png"
};
const ICON_UPDATE_RECORDING = {
  16: "icons/update_recording16.png", 32: "icons/update_recording32.png",
  48: "icons/update_recording48.png", 128: "icons/update_recording128.png"
};
function updateBadge(recording) {
  toolbarRecording = !!recording;
  const revision = ++toolbarRevision;
  const task = toolbarQueue.then(async () => {
    if (revision !== toolbarRevision) return;
    const saved = await chrome.storage.local.get('sortUpdate.v1');
    if (revision !== toolbarRevision) return;
    const pending = saved['sortUpdate.v1']?.pending;
    const realUpdate = typeof pending === 'string' && /^\d+(\.\d+){0,3}$/.test(pending) &&
      pending !== chrome.runtime.getManifest().version;
    const recordingNow = toolEnabled && toolbarRecording;
    const paths = !toolEnabled ? ICON_INACTIVE : recordingNow ? ICON_RECORDING : ICON_IDLE;
    const label = !toolEnabled ? 'off' : recordingNow ? 'recording' : 'ready';
    const updatePaths = !toolEnabled ? ICON_UPDATE_INACTIVE
      : recordingNow ? ICON_UPDATE_RECORDING : ICON_UPDATE_IDLE;
    if (revision !== toolbarRevision) return;
    try {
      await chrome.action.setIcon({path: realUpdate ? updatePaths : paths});
    } catch (e) {
      console.warn('SORT toolbar icon:', String(e.message || e));
      // Keep recording state visible if a local asset is missing/cannot be read.
      await chrome.action.setIcon({path: paths});
    }
    await chrome.action.setTitle({title: `SORT - ${label}` + (realUpdate
      ? ` - update ${pending} ready. Click to review.`
      : '')});
    // No text badge: the update indication is part of the supplied PNG.
    await chrome.action.setBadgeText({text: ''});
  });
  toolbarQueue = task.catch(e => console.warn('SORT toolbar:', String(e.message || e)));
  return toolbarQueue;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['sortUpdate.v1'])
    void updateBadge(!!activeSession);
});

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

// Live call state is independent of activeSession and is updated before any
// asynchronous recording startup. Poll errors do not mean the call ended.
let followedCallId = null;
let callActive = false;

function markCallActive(call) {
  callActive = true;
  followedCallId = call.callId || call.id || null;
  pendingCallEndPrompt = false;
  clearContinueAlarm();
  void closeContinueWindow();
}

async function handleCallEnded(callId) {
  if (!callActive) return; // duplicate or unrelated hangup: no extra prompt
  if (followedCallId && callId && callId !== followedCallId) return;
  callActive = false;
  followedCallId = null;
  if (sessionStartPromise) { pendingCallEndPrompt = true; return; }
  if (canRemind()) await requestContinuePrompt("call");
}

function handleCallAdopted(call) {
  if (call) { markCallActive(call); return Promise.resolve(); }
  // A successful re-adoption of "no call" also reconciles a missed hangup.
  // Poll failures never enter this path.
  return handleCallEnded(null);
}

// ---- worker trail --------------------------------------------------------------
// Mirrors the watcher's flight recorder on the worker side, in chrome.storage
// because the worker is destroyed between events and an in-memory array would
// vanish exactly when it is needed.
async function trail(what, extra) {
  try {
    const { callTrail = [] } = await chrome.storage.local.get("callTrail");
    callTrail.push(Object.assign({ t: Date.now(), what }, extra || {}));
    while (callTrail.length > 40) callTrail.shift();
    await chrome.storage.local.set({ callTrail });
  } catch (e) { /* a lost log line must never break a recording */ }
}

async function handleCallStarted(call) {
  await toolReady;
  if (!toolEnabled) return toolUnavailable();
  markCallActive(call);
  void trail("worker received callStarted", { callId: call.callId, event: call.event });
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
  await trail(res && res.success ? "recording started" : "recording REFUSED", {
    callId: call.callId,
    joined: !!(res && res.joinedExisting),
    error: res && res.error,
    needsName: !!(res && res.needsName)
  });
  return res;
}


// ---- trigger intake --------------------------------------------------------------
// The offscreen watcher writes its decision to chrome.storage.local as well as
// sending it. A storage write WAKES a torn-down service worker; a message from
// an offscreen document does not, which is how "answered -> start recording"
// could be the last line in the log with no recording behind it.
//
// Both paths land here. The nonce makes the duplicate harmless: whichever
// arrives first does the work, the second is dropped.
let lastTriggerId = null;
const recentTriggerIds = new Set();
let lastTriggerTimestamp = 0;

async function consumeTrigger(t) {
  await toolReady;
  if (!toolEnabled) return;
  const issued = Number(String(t?.id || "").split("_")[0]);
  if (toolEnabledSince && (!Number.isFinite(issued) || issued <= toolEnabledSince)) return;
  if (!t || !t.id || t.id === lastTriggerId || recentTriggerIds.has(t.id)) return;
  const timestamp = Number(String(t.id).split("_")[0]);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    if (timestamp < lastTriggerTimestamp) return;
    lastTriggerTimestamp = timestamp;
  }
  recentTriggerIds.add(t.id);
  if (recentTriggerIds.size > 256) recentTriggerIds.delete(recentTriggerIds.values().next().value);
  lastTriggerId = t.id;
  void trail("trigger picked up", { via: t._via || "storage", type: t.type });
  if (t.type === "callStateStarted") {
    try {
      await handleCallStarted(t.call || {});
    } catch (e) {
      await trail("handler THREW", { error: String((e && e.message) || e) });
    }
  } else if (t.type === "callStateEnded") {
    await handleCallEnded(t.callId || null);
  } else if (t.type === "callStateAdopted") {
    await handleCallAdopted(t.call || null);
  }
}


// The watcher holds a port open so this worker cannot be torn down while a
// call is being watched. Triggers arrive over it directly -- same shape, same
// nonce, same de-duplication as the message and storage paths.
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== "callpoll-keepalive" || !SortSecurity.page(p.sender, ["offscreen.html"])) return;
  trail("watcher connected");
  p.onMessage.addListener((msg) => {
    consumeTrigger(Object.assign({ _via: "port" }, msg));
  });
  p.onDisconnect.addListener(() => { /* the watcher reconnects on its own */ });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.sortToolState) return;
  if (validDisclosureAcceptance(changes.sortToolState.newValue?.disclosure)) return;
  if (!hasAcceptedDisclosure() && !toolEnabled) return;
  disclosureAcceptance = null;
  toolEnabled = false;
  toolStateError = "Recording disclosure acceptance was cleared. SORT remains off.";
  // Block immediately, then queue normal stop/save and poll shutdown.
  void setToolEnabled(false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.callTrigger) return;
  consumeTrigger(changes.callTrigger.newValue);
});

// A trigger written while the worker was down and gone by the time any event
// woke it: check once on every worker start.
(async () => {
  try {
    const { callTrigger } = await chrome.storage.local.get("callTrigger");
    // Only recent triggers. An old one must not open a picker on a browser
    // restart hours later.
    if (callTrigger && Date.now() - Number(String(callTrigger.id).split("_")[0]) < 60000) {
      consumeTrigger(callTrigger);
    } else if (callTrigger) {
      lastTriggerId = callTrigger.id;   // remember it so it is never replayed
    }
  } catch (e) { /* nothing queued */ }
})();

// Push the current settings at the poller. Called on install, on startup, and
// whenever settings are saved, so a changed name or URL takes effect at once.
let pollSyncQueue = Promise.resolve();
function syncCallPoller() {
  const work = pollSyncQueue.then(syncCallPollerImpl);
  pollSyncQueue = work.catch(() => {});
  return work;
}
async function syncCallPollerImpl() {
  await toolReady;
  if (!toolEnabled) {
    await chrome.runtime.sendMessage({target: "callpoll", type: "stop"}).catch(() => {});
    return {polling: false, disabled: true};
  }
  const config = await getConfig();
  const enabled = !!(config.callTrigger && /^https?:\/\//.test(config.callTrigger.url || "") && config.callTrigger.apiKey && (config.sipgateName || "").trim());
  try {
    await ensureOffscreen();
  } catch (e) {
    return { polling: false, error: "The background worker could not be started." };
  }
  if (!enabled || !toolEnabled) {
    chrome.runtime.sendMessage({ target: "callpoll", type: "stop" }).catch(() => {});
    return { polling: false };
  }
  await chrome.runtime.sendMessage({
    target: "callpoll",
    type: "configure",
    config: {
      url: config.callTrigger.url,
      apiKey: config.callTrigger.apiKey || "",
      name: (config.sipgateName || "").trim(),
      resumeAfter: toolEnabledSince,
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
  await toolReady;
  if (!toolEnabled) return;
  const config = await getConfig();
  if (!(config.callTrigger && /^https?:\/\//.test(config.callTrigger.url || "") && config.callTrigger.apiKey && (config.sipgateName || "").trim())) return;
  let alive = false;
  try {
    const res = await chrome.runtime.sendMessage({ target: "callpoll", type: "status" });
    alive = !!(res && res.polling);
  } catch (e) { /* no offscreen document listening */ }
  if (!alive) {
    void SortDiagnostics.emit("poll.repair", "started");
    await syncCallPoller();
  }
}


// Diagnostics wrappers preserve return values and thrown errors; arguments are never logged.
startSession = SortDiagnostics.trace("session.start", startSession);
stopSession = SortDiagnostics.trace("session.stop", stopSession);
saveRecording = SortDiagnostics.trace("session.save", saveRecording);
deleteRecording = SortDiagnostics.trace("session.delete", deleteRecording);
saveConfig = SortDiagnostics.trace("config.save", saveConfig);
startCapture = SortDiagnostics.trace("capture.start", startCapture);
stopCapture = SortDiagnostics.trace("capture.stop", stopCapture);
const ensureOffscreenWithoutDiagnostics = ensureOffscreen;
ensureOffscreen = async function (...args) {
  try { return await ensureOffscreenWithoutDiagnostics.apply(this, args); }
  catch (e) { void SortDiagnostics.error("offscreen.ensure", e); throw e; }
};
handleExportRecording = SortDiagnostics.trace("bundle.download", handleExportRecording);

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_KEEPALIVE_ALARM, { periodInMinutes: 1 });
  syncCallPoller();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_KEEPALIVE_ALARM, { periodInMinutes: 1 });
  syncCallPoller();
});

// Neither of the two events above fires when the worker is merely WOKEN -- by
// a popup opening, a message, an alarm. A worker that starts that way would
// have no poller and no keepalive until the next browser restart, which is
// precisely the "the test passes but nothing records" state. Arm both on every
// worker start; create() on an existing alarm is a no-op.
chrome.alarms.create(POLL_KEEPALIVE_ALARM, { periodInMinutes: 1 });
syncCallPoller();

const WORKER_MESSAGE_PAGES = {
  startSession: ["popup.html"], stopSession: ["popup.html"], setToolEnabled: ["popup.html"],
  acceptDisclosureAndEnable: ["popup.html"],
  callStarted: ["offscreen.html"], callStateStarted: ["offscreen.html"],
  callStateEnded: ["offscreen.html"], callStateAdopted: ["offscreen.html"], callPollError: ["offscreen.html"],
  syncCallPoller: ["popup.html"], callPollerStatus: ["popup.html"], probeCallEndpoint: ["popup.html"],
  captureStarted: ["capture.html"], captureFailed: ["capture.html"], captureEndedByUser: ["capture.html"],
  reminderResponse: ["continue.html"], keepRecording: ["continue.html"], promptContinue: ["popup.html"],
  nextTicketSequence: ["ticket.html"], finishRecording: ["ticket.html"], downloadVideo: ["ticket.html"],
  openTicketDialog: ["popup.html"], getShortcut: ["popup.html"], getSessionStatus: ["popup.html"],
  getRecordings: ["popup.html", "ticket.html", "player.html"], deleteRecording: ["popup.html", "ticket.html"],
  getConfig: ["popup.html", "ticket.html", "player.html", "import.html", "continue.html", "capture.html"],
  getSettingsDraft: ["popup.html"], saveSettingsDraft: ["popup.html"], clearSettingsDraft: ["popup.html"],
  saveConfig: ["popup.html"], clearCredentials: ["popup.html"], setTheme: ["popup.html"],
  exportRecording: ["popup.html", "player.html"], consumeNameWarning: ["popup.html"],
  openImport: ["popup.html"], importFinished: ["import.html"],
  getUpdateStatus: ["popup.html"], checkForUpdate: ["popup.html"], restartForUpdate: ["popup.html"],
  deferUpdate: ["popup.html"]
};
function allowWorkerMessage(message, sender) {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "recordEvent" || message.type === "isRecordingSession") return SortSecurity.content(sender);
  return SortSecurity.page(sender, WORKER_MESSAGE_PAGES[message.type] || []);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages addressed to another context (the offscreen document, the capture
  // window) travel through every listener in the extension. Ignore them here or
  // an unhandled type in this switch answers on their behalf.
  if (message && message.target && message.target !== "worker") return false;
  if (!allowWorkerMessage(message, sender)) {
    if (message && WORKER_MESSAGE_PAGES[message.type]) sendResponse({success: false, error: "Not authorized"});
    return false;
  }
  if (SortUpdates.locked && !["getUpdateStatus", "getSessionStatus", "callStateStarted", "callStateEnded", "callStateAdopted", "callPollError"].includes(message.type)) {
    sendResponse({success: false, error: "SORT is restarting for an update. Try again shortly."});
    return false;
  }
  switch (message.type) {

    case "acceptDisclosureAndEnable":
      acceptDisclosureAndEnable(message.version, message.affirmative).then(sendResponse);
      return true;

    case "setToolEnabled":
      setToolEnabled(message.enabled).then(sendResponse);
      return true;

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
    case "callStateEnded":
      // The storage write carries the same decision and the same nonce, so
      // whichever path is faster wins and the other is a no-op.
      consumeTrigger(Object.assign({ _via: "message" }, message,
        { id: message.id || `msg_${message.callId || (message.call && message.call.callId)}_${message.type}` }))
        .then(() => sendResponse({ success: true }));
      return true;

    // First poll after a reload: a call may already be running. Follow it so
    // its hangup still prompts, but do not open a picker for a call the
    // operator answered minutes ago.
    case "callStateAdopted":
      consumeTrigger(Object.assign({ _via: "message" }, message,
        { id: message.id || `msg_adopt_${message.call && message.call.callId || "none"}` }))
        .then(() => sendResponse({ success: true }));
      return true;

    case "callPollError":
      console.warn("SORT: call-state endpoint unreachable:", message.error);
      sendResponse({ success: true });
      return false;

    case "syncCallPoller":
      syncCallPoller().then(sendResponse);
      return true;

    // Is the poller actually running right now? The test button asks the
    // endpoint; this asks the thing that is supposed to be asking it. A green
    // test with a dead poller is the exact failure this exposes.
    case "callPollerStatus":
      (async () => {
        try { await ensureOffscreen(); } catch (e) {
          sendResponse({ polling: false, error: "The background worker could not be started." });
          return;
        }
        const { callTrail = [] } = await chrome.storage.local.get("callTrail");
        chrome.runtime.sendMessage({ target: "callpoll", type: "status" })
          .then((r) => sendResponse(Object.assign({ polling: false }, r, { trail: callTrail.slice(-20) })))
          .catch(() => sendResponse({ polling: false, trail: callTrail.slice(-20) }));
      })();
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
      void SortDiagnostics.emit("capture.encode", "ok");
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
      void SortDiagnostics.emit("capture.choose", "unavailable");
      if (capturePending) capturePending({ success: false, error: message.error });
      closeCaptureWindow();
      return false;

    case "captureEndedByUser":
      void SortDiagnostics.emit("capture.stop", "cancelled");
      if (activeSession && !activeSession.endTime) void stopSession().catch(() => {});
      return false;

    case "stopSession":
      stopSession(message.options).then(sendResponse);
      return true;

    // Scope reminder buttons to the session and prompt which created them.
    // A stale prompt must not stop a newer recording or interrupt a new call.
    case "reminderResponse": {
      if (!canRemind() || message.recordingId !== activeSession.id ||
          String(message.promptToken) !== String(reminderEpoch)) {
        sendResponse({ success: false, cancelled: true });
        return false;
      }
      if (message.action === "stop") {
        stopSession().then(sendResponse);
      } else if (message.action === "keep") {
        void closeContinueWindow();
        armContinueAlarm().then(min => sendResponse({ success: true, minutes: min }));
      } else {
        sendResponse({ success: false });
        return false;
      }
      return true;
    }

    // Backward-compatible entry point; call guard still applies.
    case "keepRecording":
      armContinueAlarm().then((min) => sendResponse({ success: true, minutes: min }));
      return true;

    case "promptContinue":
      requestContinuePrompt("timer").then(() => sendResponse({ success: true }));
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

    case "isRecordingSession":
      sendResponse({active: toolEnabled && !!activeSession && !activeSession.endTime &&
        message.recordingId === activeSession.id});
      return false;

    case "getSessionStatus":
      toolReady.then(() => sendResponse({
        enabled: toolEnabled, transitioning: toolTransition, stateError: toolStateError,
        disclosureRequired: !hasAcceptedDisclosure(), disclosureVersion: DISCLOSURE_VERSION,
        disclosureAcceptedAt: hasAcceptedDisclosure() ? disclosureAcceptance.acceptedAt : null,
        active: !!activeSession,
        tabCount: activeSession ? Object.keys(activeSession.tabs).length : 0,
        eventCount: activeSession ? activeSession.events.length : 0,
        startTime: activeSession ? activeSession.startTime : null
      }));
      return true;

    case "recordEvent":
      if (!toolEnabled || !activeSession || activeSession.endTime || message.recordingId !== activeSession.id) {
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
        .then(() => { broadcastRecordingsChanged(); return { success: true }; })
        .then(sendResponse)
        .catch(e => sendResponse({success: false, error: String(e.message || "Recording could not be deleted.")}));
      return true;

    case "getConfig":
      queueSettings(() => getConfig()).then(c => sendResponse(
        SortSecurity.page(sender, ["popup.html"]) ? c :
        SortSecurity.page(sender, ["ticket.html"]) ? {theme: c.theme, downloadFolder: c.downloadFolder,
          sipgateName: c.sipgateName, upload: c.upload, odoo: c.odoo} : {theme: c.theme})).catch(() => sendResponse({success: false, error: "Settings could not be loaded."}));
      return true;

    case "getUpdateStatus":
      SortUpdates.status().then(sendResponse); return true;
    case "checkForUpdate":
      SortUpdates.check().then(sendResponse); return true;
    case "restartForUpdate":
      SortUpdates.restart().then(sendResponse); return true;
    case "deferUpdate":
      SortUpdates.defer().then(sendResponse); return true;
    case "setTheme":
      getConfig().then(c => saveConfig({...c, theme: message.theme})).then(() => sendResponse({success: true}))
        .catch(() => sendResponse({success: false, error: "Theme could not be saved."})); return true;
    case "clearCredentials":
      queueSettings(async () => {
        const c = await getConfig();
        await saveConfig({...c, odoo: {...c.odoo, apiKey: ""}, callTrigger: {...c.callTrigger, apiKey: ""}});
        const draft = (await chrome.storage.local.get(SETTINGS_DRAFT_KEY))[SETTINGS_DRAFT_KEY];
        if (draft?.fields) await storeSettingsDraft({...draft.fields, odooKey: "", callStateToken: ""});
        await syncCallPoller();
        return {success: true};
      }).then(sendResponse).catch(() => sendResponse({success: false, error: "Could not finish removing tokens. Reopen Settings to verify."}));
      return true;
    case "getSettingsDraft":
      queueSettings(async () => ({success: true, draft: (await chrome.storage.local.get(SETTINGS_DRAFT_KEY))[SETTINGS_DRAFT_KEY] || null}))
        .then(sendResponse).catch(() => sendResponse({success: false, error: "Could not read the local settings draft."}));
      return true;
    case "saveSettingsDraft":
      queueSettings(() => storeSettingsDraft(message.fields)).then(sendResponse)
        .catch(() => sendResponse({success: false, error: "Draft could not be saved locally. Save your settings before closing."}));
      return true;
    case "clearSettingsDraft":
      queueSettings(async () => { await chrome.storage.local.remove(SETTINGS_DRAFT_KEY); return {success: true}; })
        .then(sendResponse).catch(() => sendResponse({success: false, error: "Draft could not be discarded."}));
      return true;
    case "saveConfig":
      queueSettings(async () => {
        await saveConfig(message.config);
        let draftCleared = true;
        try { await chrome.storage.local.remove(SETTINGS_DRAFT_KEY); } catch (_) { draftCleared = false; }
        if ((message.config?.sipgateName || "").trim()) clearNameWarning();
        void syncCallPoller();
        return {success: true, config: await getConfig(), draftCleared};
      }).then(sendResponse).catch(() => sendResponse({success: false, error: "Settings could not be saved. Check the endpoint."}));
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
  SortUpdates.beginJob();
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
  } finally { SortUpdates.endJob(); }
}

// ---- Tab lifecycle: inject into new tabs while recording ---------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!toolEnabled || !activeSession || activeSession.endTime) return;
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
    initializeTab(tabId);
  }
});

// ---- Which tab is the operator looking at? ----------------------------------
// "Switched tab" is one question, but Chrome answers it with three different
// events. tabs.onActivated only fires for a switch WITHIN a window, so moving
// focus to a second window -- or dragging a tab out into one -- left the
// timeline claiming the operator was still on the old tab.
//   - tabs.onActivated      : switch inside the focused window
//   - windows.onFocusChanged: switch between windows (the missing case)
//   - tabs.onAttached       : a tab dragged into another window
// All three funnel through recordTabSwitch, which dedupes so one physical
// switch never lands twice (a drag-out fires several of these at once).
let lastActiveTabId = null;
let switchSettleTimer = null;

// Dragging a tab into its own window is ONE action to the operator, but Chrome
// narrates it as a burst: the old window activates its remaining tab, focus
// flicks between windows, and the moved tab activates in its new home. Logging
// each signal produced the A -> B -> A stutter.
//
// So no signal is trusted on its own. Each one just restarts a short settle
// timer; when the dust clears we ask Chrome ONE question -- which tab is
// actually focused right now -- and record only that. A burst that ends where
// it began records nothing, which is correct: the operator never left the tab.
const SWITCH_SETTLE_MS = 250;

function noteFocusChange(reason) {
  if (!toolEnabled || !activeSession || activeSession.endTime) return;
  clearTimeout(switchSettleTimer);
  switchSettleTimer = setTimeout(() => settleTabSwitch(reason), SWITCH_SETTLE_MS);
}

async function settleTabSwitch(reason) {
  if (!toolEnabled || !activeSession || activeSession.endTime) return;
  let tab = null;
  try {
    // The focused window is the authority. If Chrome itself lost focus (the
    // operator alt-tabbed away), fall back to the last focused window so a
    // drag-out that ends outside Chrome still resolves.
    const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = focused || null;
  } catch (e) { /* no window to query */ }
  if (!toolEnabled || !activeSession || activeSession.endTime || !tab || tab.id == null || tab.id === lastActiveTabId) return;

  lastActiveTabId = tab.id;
  activeSession.events.push({
    type: "tabSwitch",
    tabId: tab.id,
    reason: reason || null,
    timestamp: Date.now(),
    relativeTime: Date.now() - activeSession.startTime
  });
}

// Switch inside a window.
chrome.tabs.onActivated.addListener(() => noteFocusChange("tab-activated"));

// Switch between windows. WINDOW_ID_NONE means focus left Chrome entirely --
// not a tab switch, and settling on it would misread the drag-out, so ignore.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  noteFocusChange("window-focus");
});

// A tab was dragged into another window (including a brand-new one).
chrome.tabs.onAttached.addListener(() => noteFocusChange("tab-moved-window"));

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  // Forget the memo if the active tab is gone, otherwise re-entering that tab
  // id later (or the dedupe comparing against a dead tab) silently drops the
  // next switch.
  if (tabId === lastActiveTabId) {
    lastActiveTabId = null;
    // Whatever gains focus next is a real switch, so let it settle.
    noteFocusChange("tab-closed");
  }
  if (!toolEnabled || !activeSession || activeSession.endTime) return;
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
  if (activeSession && !activeSession.endTime) {
    activeSession.video.endedEarly = true;
    void stopSession().catch(() => {});
  }
});

// Restore badge state after service worker wakes up
updateBadge(!!activeSession);

SortDiagnostics.setHealthReader(async () => {
  const cfg = await getConfig();
  let polling = false;
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({target: "callpoll", type: "status"}),
      new Promise(resolve => setTimeout(() => resolve(null), 1500))
    ]);
    polling = !!(status && status.polling);
  } catch (_) {}
  return {recording: !!activeSession, captured: !!(activeSession && activeSession.video && activeSession.video.captured),
    configured: !!(cfg.callTrigger && cfg.callTrigger.url && cfg.sipgateName), polling};
});

SortUpdates.setBusyReader(() => {
  if (callActive) return "A call is active.";
  if (sessionStartPromise || capturePending) return "The recording picker is open.";
  if (sessionStopPromise || (activeSession && activeSession.endTime)) return "A recording is saving.";
  if (activeSession) return "A recording is active.";
  return "";
});
