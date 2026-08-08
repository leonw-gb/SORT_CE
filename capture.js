// capture.js - Screen capture host, running in a real extension PAGE.
//
// Why a page and not the offscreen document:
// chrome.desktopCapture.chooseDesktopMedia() needs a targetTab whose URL uses a
// SECURE scheme. The RKA dashboards are served over plain http://, so that call
// always failed with "URL scheme for the specified tab is not secure". An
// extension page is chrome-extension:// (secure) and can call
// navigator.mediaDevices.getDisplayMedia() itself, which needs no targetTab.
//
// A visible window is also required: getDisplayMedia only runs after a real user
// gesture, which an offscreen document cannot provide.
//
// Video only. No audio track is ever requested.
//
// The stream itself comes from chrome.desktopCapture, not getDisplayMedia:
// see chooseSource() below for why.

const RECORDINGS_DB = "MultiTabRecorder";
const VIDEOS_STORE = "videos";

let recorder = null;
let stream = null;
let chunks = [];
let startedAt = null;
let stopResolve = null;
let recordingId = null;

const btn = document.getElementById("btnShare");
const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const specEl = document.getElementById("spec");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.className = isError ? "err" : "";
}

recordingId = new URLSearchParams(location.search).get("rec");

// ---- Capture settings --------------------------------------------------------
// Fixed, no user-facing knobs: the operator's job is to demonstrate the work,
// not to configure an encoder.
//
// Resolution is NOT capped. The stream is taken at the monitor's own pixel
// size, because readability of small dashboard text is set by resolution and
// nothing else. A 1440p monitor records at 1440p, a 1080p one at 1080p.
//
// Bitrate scales with the pixel count so a large monitor is not starved and a
// small one does not waste space. 0.11 bits per pixel per frame at 15 fps sits
// just above where VP9 starts smearing small text during scrolling.
const FPS = 15;
const BITS_PER_PIXEL = 0.11;
const MIN_BITRATE = 1200000;
const MAX_BITRATE = 12000000;

function bitrateFor(width, height) {
  if (!width || !height) return 3500000;
  const bps = width * height * FPS * BITS_PER_PIXEL;
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, bps)));
}

// Source selection goes through chrome.desktopCapture rather than
// getDisplayMedia(). chooseDesktopMedia() needs a targetTab on a SECURE scheme
// -- this page is chrome-extension://, which qualifies, so we anchor the picker
// to ourselves rather than to an http:// dashboard that would be rejected.
//
// Note on the "SORT is sharing your screen" bubble: current Chrome shows it for
// desktopCapture streams too, and there is no API that suppresses it. It is
// browser-owned UI, deliberately outside any page's reach -- if an extension
// could hide it, silent screen recording would be one line of JavaScript away.
// Pressing "Hide" on the bubble dismisses it for that share. See README.
function chooseSource() {
  return new Promise((resolve, reject) => {
    chrome.tabs.getCurrent((tab) => {
      const cb = (streamId) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!streamId) { reject(Object.assign(new Error("Picker cancelled"), { name: "NotAllowedError" })); return; }
        resolve(streamId);
      };
      // "screen" first so the entire display is the default choice.
      const sources = ["screen", "window", "tab"];
      if (tab) chrome.desktopCapture.chooseDesktopMedia(sources, tab, cb);
      else chrome.desktopCapture.chooseDesktopMedia(sources, cb);
    });
  });
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  setStatus("Opening the picker\u2026");
  try {
    const streamId = await chooseSource();
    // audio:false is the whole privacy contract: no microphone prompt, no tab
    // audio in the file, nothing to redact later.
    //
    // The legacy chromeMediaSource constraints are the only way to consume a
    // desktopCapture stream id, and they are exactly what keeps the sharing
    // bar off the screen. Resolution is NOT capped: readability of small
    // dashboard text is set by resolution and nothing else.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: streamId,
          maxFrameRate: FPS
        }
      }
    });
  } catch (e) {
    btn.disabled = false;
    const msg = e && e.name === "NotAllowedError"
      ? "You cancelled the picker. Click again to share your screen."
      : String((e && e.message) || e);
    setStatus(msg, true);
    chrome.runtime.sendMessage({ type: "captureFailed", error: msg }).catch(() => {});
    return;
  }

  startEncoder();
});

function startEncoder() {
  const track = stream.getVideoTracks()[0];
  const s = (track && track.getSettings) ? track.getSettings() : {};
  const bitrate = bitrateFor(s.width, s.height);

  // VP9 is ~30% smaller than VP8 at equal quality; fall back if unavailable.
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime });
    const done = stopResolve;
    stopResolve = null;
    if (done) done(blob);
  };

  // The operator can also end the share from Chrome's own "Stop sharing" bar.
  // Treat that exactly like pressing Stop so the video is still saved.
  if (track) {
    track.addEventListener("ended", () => {
      setStatus("Sharing stopped. Saving the video\u2026");
      chrome.runtime.sendMessage({ type: "captureEndedByUser" }).catch(() => {});
    });
  }

  if (specEl && s.width) {
    specEl.textContent =
      `${s.width}\u00D7${s.height} \u00B7 ${Math.round(s.frameRate || FPS)} fps \u00B7 ` +
      `${(bitrate / 1e6).toFixed(1)} Mbps`;
  }

  // 2s timeslice: bounded memory growth and a recoverable file if the browser
  // is killed mid-session.
  recorder.start(2000);
  startedAt = Date.now();

  btn.style.display = "none";
  dot.classList.add("live");
  setStatus("Recording. This window is minimized; leave it running.");
  startSizeMeter();

  chrome.runtime.sendMessage({
    type: "captureStarted", startedAt, mimeType: mime, recordingId
  }).catch(() => {});
}

// Running size read-out so a long session cannot silently balloon.
let sizeTimer = null;
function startSizeMeter() {
  const el = document.getElementById("size");
  if (!el) return;
  sizeTimer = setInterval(() => {
    const bytes = chunks.reduce((n, c) => n + c.size, 0);
    const mins = (Date.now() - startedAt) / 60000;
    const mb = bytes / (1024 * 1024);
    el.textContent = mins > 0.2
      ? `${mb.toFixed(0)} MB \u00B7 ${(mb / mins).toFixed(0)} MB per minute`
      : `${mb.toFixed(0)} MB`;
  }, 2000);
}

// ---- Storage -----------------------------------------------------------------
// The Blob is written to IndexedDB from THIS page. Two reasons:
//   1. A Blob cannot cross chrome.runtime.sendMessage, and the previous
//      base64 data-URL workaround inflated every file by 33% and had to be
//      built as one string in memory -- which breaks around 300-400 MB, well
//      inside a 30-minute session.
//   2. This page shares an origin with the service worker, so it writes to the
//      same database the player reads from.
// IndexedDB stores Blobs natively: no size inflation, no giant string.
function openDB() {
  return new Promise((resolve, reject) => {
    // No version: background.js owns the schema. Opening with a hardcoded
    // number breaks as soon as the writer moves ahead.
    const r = indexedDB.open(RECORDINGS_DB);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function saveBlob(id, blob, mimeType, startedAtMs) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(VIDEOS_STORE)) {
      reject(new Error("Video store missing — reload the extension"));
      return;
    }
    const tx = db.transaction(VIDEOS_STORE, "readwrite");
    tx.objectStore(VIDEOS_STORE).put({
      recordingId: id,
      blob,
      mimeType,
      size: blob.size,
      startedAt: startedAtMs
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function stopCapture() {
  if (!recorder) return { success: false, error: "No capture running" };
  if (sizeTimer) { clearInterval(sizeTimer); sizeTimer = null; }

  const blob = await new Promise((resolve) => {
    stopResolve = resolve;
    if (recorder.state !== "inactive") recorder.stop();
    else resolve(new Blob(chunks, { type: recorder.mimeType }));
  });
  try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}

  const mimeType = recorder.mimeType;
  const startedAtCopy = startedAt;
  recorder = null; stream = null;
  chunks = [];
  dot.classList.remove("live");

  setStatus("Saving\u2026");
  try {
    await saveBlob(recordingId, blob, mimeType, startedAtCopy);
  } catch (e) {
    setStatus("Could not save the video: " + (e.message || e), true);
    return { success: false, error: String(e.message || e), size: blob.size };
  }

  setStatus("Saved. You can close this window.");
  return { success: true, mimeType, size: blob.size, startedAt: startedAtCopy };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "capture") return;
  if (msg.type === "stopCapture") {
    stopCapture().then(sendResponse);
    return true;
  }
  if (msg.type === "captureStatus") {
    sendResponse({
      active: !!recorder && recorder.state === "recording",
      startedAt,
      chunks: chunks.length
    });
    return false;
  }
});

// Opening the picker straight away saves the operator a click: the window was
// opened by their press of Start Recording, which counts as the user gesture.
btn.click();
