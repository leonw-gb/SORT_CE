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

async function prepareVideo(recordingId) {
  const session = await getFrom(RECORDINGS_STORE, recordingId);
  if (!session) throw new Error("That recording is no longer stored.");
  const video = await getFrom(VIDEOS_STORE, recordingId);
  const blob = video?.blob;
  if (!(blob instanceof Blob) || !blob.size) throw new Error("No saved video is available for this session.");
  const mime = (blob.type || session.video?.mimeType || "video/webm").toLowerCase().split(";")[0];
  const ext = mime === "video/mp4" ? ".mp4" : mime === "video/webm" ? ".webm" : null;
  if (!ext) throw new Error("This stored video format is not supported for direct export.");
  const ref = String(session.ticket?.ref || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0,80);
  const seq = Number.isSafeInteger(session.ticket?.seq) && session.ticket.seq > 0 ? session.ticket.seq : 1;
  const filename = ref ? `${ref}_${String(seq).padStart(3,"0")}${ext}`
    : SORTZ.filenameFor({...session, ticket: null}, session.recorder).replace(/\.sortz$/i, ext);
  return {blob, filename};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;
  if (!SortSecurity.worker(sender)) return false;

  if (message.type === "supportBlob") {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    try {
      const text = JSON.stringify(message.report, null, 2);
      if (!text || text.length > 16 * 1024 * 1024) throw new Error("Support report too large");
      const url = URL.createObjectURL(new Blob([text], {type: "application/json"}));
      // Safety net for downloads interrupted by a browser restart or worker crash.
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
      sendResponse({success: true, url});
    } catch (e) {
      void SortDiagnostics.error("support.export", e);
      sendResponse({success: false});
    }
    return false;
  }

  if (message.type === "buildBundle" || message.type === "prepareVideo") {
    (message.type === "prepareVideo" ? prepareVideo(message.id) : buildBundle(message.id))
      .then(({ blob, filename }) => {
        // The blob: URL must outlive this message. The worker revokes it once
        // chrome.downloads reports the write finished.
        const url = URL.createObjectURL(blob);
        setTimeout(() => URL.revokeObjectURL(url), 60 * 60 * 1000);
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

// Diagnostics wrappers preserve return values and thrown errors; arguments are never logged.
buildBundle = SortDiagnostics.trace("bundle.build", buildBundle);
