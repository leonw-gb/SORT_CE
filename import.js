// import.js - Reads a .sortz bundle and stores it as a local recording.
//
// A window, not the popup: parsing and writing hundreds of megabytes takes
// long enough that Chrome would close a popup out from under it the moment
// focus moved.
//
// The bundle is shown BEFORE anything is written. An import costs the same
// disk as a recording, so the operator sees whose session it is and how big
// it is first.

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const VIDEOS_STORE = "videos";

let parsed = null;

const $ = (id) => document.getElementById(id);

(function applyTheme() {
  chrome.runtime.sendMessage({ type: "getConfig" }, (cfg) => {
    if (cfg && cfg.theme === "light") document.documentElement.dataset.theme = "light";
  });
})();

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(RECORDINGS_DB);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function getAll(store) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}
function put(store, value) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function fmtDur(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
function fmtSize(b) {
  if (!b) return "none";
  const mb = b / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function setNote(text, kind) {
  const n = $("note");
  n.textContent = text || "";
  n.className = "note" + (kind ? " " + kind : "");
}

// ---- pick and preview ---------------------------------------------------------
$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
});
["dragenter", "dragover"].forEach((t) =>
  $("drop").addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((t) =>
  $("drop").addEventListener(t, () => $("drop").classList.remove("over")));
$("drop").addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) preview(f);
});
$("file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) preview(f);
});
$("cancel").addEventListener("click", () => {
  parsed = null;
  $("panel").classList.remove("show");
  $("file").value = "";
});

async function preview(file) {
  $("status").textContent = "Reading the bundle…";
  $("panel").classList.add("show");
  $("confirm").disabled = true;
  setNote("");

  try {
    parsed = await SORTZ.parse(file);
  } catch (e) {
    parsed = null;
    setNote(String(e.message || e), "err");
    $("status").textContent = "";
    ["mRecorder","mDate","mDur","mEvents","mTicket","mVideo"].forEach((k) => $(k).textContent = "—");
    return;
  }

  const { manifest, session, videoBlob } = parsed;
  const dur = (session.endTime || 0) - (session.startTime || 0);

  $("mRecorder").textContent = manifest.recorder || "Unknown";
  $("mDate").textContent = fmtDate(session.startTime);
  $("mDur").textContent = fmtDur(dur);
  $("mEvents").textContent = String((session.events || []).length);
  $("mTicket").textContent = manifest.ticket && manifest.ticket.ref
    ? `${manifest.ticket.ref}_${String(manifest.ticket.seq || 1).padStart(3, "0")}`
    : "not assigned";
  $("mVideo").textContent = videoBlob ? fmtSize(videoBlob.size) : "none";

  // Already here? The source id survives import, so the same bundle imported
  // twice is recognisable even though its local id was remapped.
  const existing = await getAll(RECORDINGS_STORE);
  const dupe = existing.find((r) => r.sourceId && r.sourceId === manifest.sourceId);
  if (dupe) {
    setNote("You already imported this session. Importing again will store a second copy.", "warn");
  } else if (!manifest.recorder) {
    setNote("This bundle carries no recorder name — it was exported from a SORT older than 2.23.", "warn");
  }

  $("status").textContent = "";
  $("confirm").disabled = false;
}

// ---- import -------------------------------------------------------------------
$("confirm").addEventListener("click", async () => {
  if (!parsed) return;
  $("confirm").disabled = true;
  $("cancel").disabled = true;
  $("bar").classList.add("show");
  $("barFill").style.width = "35%";
  $("status").textContent = "Storing the session…";

  try {
    const { manifest, session, videoBlob } = parsed;

    // A fresh local id. Recording ids are minted per machine, so an imported
    // session can collide with one of my own and silently overwrite it. The
    // original travels on as sourceId, which is also what makes a repeat
    // import detectable.
    const localId = `imported_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    const record = Object.assign({}, session, {
      id: localId,
      sourceId: manifest.sourceId || session.id || null,
      imported: true,
      importedAt: Date.now(),
      recorder: manifest.recorder || null,
      machine: manifest.machine || null,
      // Ticket assignment belongs to the person who recorded it. Keeping the
      // reference is useful context; keeping the upload link is not, because
      // it points at a video that the retention policy will delete.
      ticket: session.ticket
        ? { ref: session.ticket.ref, seq: session.ticket.seq, assignedAt: session.ticket.assignedAt || null }
        : null
    });

    await put(RECORDINGS_STORE, record);
    $("barFill").style.width = "70%";

    if (videoBlob && videoBlob.size) {
      await put(VIDEOS_STORE, {
        recordingId: localId,
        blob: videoBlob,
        mimeType: manifest.videoMimeType || "video/webm",
        size: videoBlob.size,
        startedAt: manifest.startTime || session.startTime || null
      });
    }

    $("barFill").style.width = "100%";
    $("status").textContent = "Imported. Opening the timeline…";
    chrome.runtime.sendMessage({ type: "importFinished", id: localId });

    setTimeout(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?id=${encodeURIComponent(localId)}`) });
      window.close();
    }, 600);
  } catch (e) {
    // Quota is the realistic failure: a few imported sessions fill the bucket.
    const msg = String(e && e.name === "QuotaExceededError"
      ? "Not enough browser storage for this session. Delete a recording and try again."
      : (e.message || e));
    setNote(msg, "err");
    $("status").textContent = "";
    $("bar").classList.remove("show");
    $("confirm").disabled = false;
    $("cancel").disabled = false;
  }
});
