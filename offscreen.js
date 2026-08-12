// offscreen.js - Builds .sortz bundles off the service worker.
//
// Two things the worker cannot do and this document can:
//   1. URL.createObjectURL - unavailable in a service worker, and a 300 MB
//      bundle cannot go through a data: URL.
//   2. Stay alive for the length of a large write. The worker is torn down
//      after ~30s idle; an offscreen document lives until it is closed.
//
// The popup is deliberately NOT involved: Chrome closes it the moment focus
// moves, which would abort an export mid-write.

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const VIDEOS_STORE = "videos";

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(RECORDINGS_DB);   // reader: never pin a version
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function getFrom(store, key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// Named for what it reports. It used to be plain "report" -- and because this
// file and callpoll.js are plain <script>s sharing ONE global scope in the
// offscreen document, whichever loaded last silently replaced the other's.
// offscreen.js loads last, so every call trigger the watcher "sent" was in
// fact posted as an export-progress message and thrown away.
function reportExportProgress(stage, loaded, total) {
  chrome.runtime.sendMessage({
    type: "exportProgress", stage, loaded, total
  }).catch(() => {});
}

async function buildBundle(recordingId) {
  const session = await getFrom(RECORDINGS_STORE, recordingId);
  if (!session) throw new Error("That recording is no longer stored.");

  const videoRec = await getFrom(VIDEOS_STORE, recordingId);
  const videoBlob = videoRec && videoRec.blob ? videoRec.blob : null;

  // Recorder identity is stamped from what the session was recorded WITH, not
  // from whoever happens to be exporting it. A session recorded before the
  // name became mandatory has none, and says so rather than borrowing mine.
  const manifest = {
    formatVersion: SORTZ.FORMAT_VERSION,
    producedBy: "SORT",
    producedAt: Date.now(),
    sourceId: session.id,
    recorder: session.recorder || null,
    machine: session.machine || null,
    startTime: session.startTime || null,
    endTime: session.endTime || null,
    // The player subtracts this to line the video up with the timeline. It
    // travels in the manifest so a viewer can sync without parsing the
    // session object at all.
    videoStartOffset: (session.video && session.video.startOffset) || 0,
    videoMimeType: (session.video && session.video.mimeType) || "video/webm",
    hasVideo: !!videoBlob,
    eventCount: (session.events || []).length,
    ticket: session.ticket
      ? { ref: session.ticket.ref, seq: session.ticket.seq }
      : null
  };

  reportExportProgress("hashing", 0, videoBlob ? videoBlob.size : 0);
  const blob = await SORTZ.build({
    manifest,
    session,
    videoBlob,
    onProgress: (loaded, total) => reportExportProgress("hashing", loaded, total)
  });

  return { blob, filename: SORTZ.filenameFor(session, session.recorder) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.type === "buildBundle") {
    buildBundle(message.id)
      .then(({ blob, filename }) => {
        // The blob: URL must outlive this message. The worker revokes it once
        // chrome.downloads reports the write finished.
        const url = URL.createObjectURL(blob);
        sendResponse({ success: true, url, filename, size: blob.size });
      })
      .catch((e) => sendResponse({ success: false, error: String(e.message || e) }));
    return true;
  }

  if (message.type === "revokeUrl") {
    try { URL.revokeObjectURL(message.url); } catch (e) {}
    sendResponse({ success: true });
    return false;
  }

  return false;
});
