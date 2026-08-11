// ticket.js - Post-recording dialog: pick the ticket, then save / upload.
//
// Runs in its own extension window, not the service worker, for two reasons:
// a Blob needs a document to become an object URL, and an upload of several
// hundred megabytes outlives any service worker.

const RECORDINGS_DB = "MultiTabRecorder";
const RECORDINGS_STORE = "recordings";
const VIDEOS_STORE = "videos";

const recId = new URLSearchParams(location.search).get("rec") || "";

let cfg = {};
let tickets = [];
let selected = null;      // { id, ref, name } or null when typed manually
let videoBlob = null;
let recording = null;
let busy = false;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const barEl = $("bar");

function setStatus(text, kind) {
  statusEl.innerHTML = "";
  statusEl.appendChild(document.createTextNode(text));
  statusEl.appendChild(barEl);
  statusEl.className = kind || "";
}
function setProgress(loaded, total) {
  barEl.classList.add("on");
  barEl.firstElementChild.style.width = `${Math.round((loaded / total) * 100)}%`;
}
function mb(n) { return (n / (1024 * 1024)).toFixed(0); }
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- data --------------------------------------------------------------------
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(RECORDINGS_DB);   // background owns the version
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function loadVideoBlob(id) {
  return openDB().then((db) => new Promise((resolve) => {
    if (!db.objectStoreNames.contains(VIDEOS_STORE)) { resolve(null); return; }
    const req = db.transaction(VIDEOS_STORE, "readonly").objectStore(VIDEOS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  }));
}

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ---- ticket list -------------------------------------------------------------
function render() {
  const q = $("q").value.trim().toLowerCase();
  const rows = tickets.filter((t) => !q ||
    [t.ref, t.name, t.system, t.agent, t.stage].join(" ").toLowerCase().includes(q));

  if (!rows.length) {
    $("list").innerHTML =
      `<div style="padding:20px;color:#9aa4b2">${tickets.length
        ? "No ticket matches that filter. Type the number on the right instead."
        : "No tickets loaded. Add your Odoo login in the extension settings, or type the ticket number."}</div>`;
    return;
  }

  $("list").innerHTML =
    `<table><thead><tr>
      <th>Ticket</th><th>Subject</th><th>System</th><th>Agent</th><th>Stage</th>
    </tr></thead><tbody>` +
    rows.map((t) => `<tr tabindex="0" data-id="${t.id}" data-ref="${esc(t.ref)}"
        ${selected && selected.id === t.id ? 'class="sel"' : ""}>
        <td class="ref">${esc(t.ref)}</td>
        <td class="subj">${esc(t.name)}</td>
        <td class="dim">${esc(t.system)}</td>
        <td class="dim">${esc(t.agent)}</td>
        <td class="dim">${esc(t.stage)}</td>
      </tr>`).join("") +
    `</tbody></table>`;

  $("list").querySelectorAll("tr[data-id]").forEach((tr) => {
    const pick = () => choose(Number(tr.dataset.id));
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
}

function choose(id) {
  selected = tickets.find((t) => t.id === id) || null;
  if (selected) $("manual").value = selected.ref;
  render();
}

async function loadTickets() {
  if (!cfg.odoo || !cfg.odoo.username || !cfg.odoo.apiKey) {
    setStatus("Add your Odoo login and API key in the extension settings, or type the ticket number here.");
    render();
    return;
  }
  setStatus("Loading the last tickets from Odoo…");
  try {
    const client = new Odoo.OdooClient(cfg.odoo);
    tickets = await client.recentTickets(cfg.odoo.limit || 50, cfg.odoo.model || "helpdesk.ticket");
    setStatus(`${tickets.length} tickets loaded. Pick one, or type a number.`);
  } catch (e) {
    tickets = [];
    setStatus(`Odoo: ${e.message}`, "err");
  }
  render();
}

// ---- the four actions --------------------------------------------------------
function ticketRef() {
  const typed = $("manual").value.trim();
  if (typed) return typed;
  return selected ? selected.ref : "";
}

function setBusy(on) {
  busy = on;
  ["saveLocal", "saveUpload", "saveUploadOdoo", "discard", "reload"].forEach((id) => {
    $(id).disabled = on;
  });
}

// The .sortz bundle for this recording: timeline, metadata and video in one
// file. Built once and reused for both the local copy and the upload -- a
// session video is hundreds of megabytes and hashing it twice is minutes.
let bundleBlob = null;

async function buildBundle() {
  if (bundleBlob) return bundleBlob;
  const manifest = {
    formatVersion: SORTZ.FORMAT_VERSION,
    producedBy: "SORT",
    producedAt: Date.now(),
    sourceId: recording.id,
    // Stamped from what the session was recorded WITH, never from whoever is
    // uploading it.
    recorder: recording.recorder || null,
    machine: recording.machine || null,
    startTime: recording.startTime || null,
    endTime: recording.endTime || null,
    videoStartOffset: (recording.video && recording.video.startOffset) || 0,
    videoMimeType: (recording.video && recording.video.mimeType) || "video/webm",
    hasVideo: !!videoBlob,
    eventCount: (recording.events || []).length,
    ticket: recording.ticket ? { ref: recording.ticket.ref, seq: recording.ticket.seq } : null
  };
  setStatus("Packing the session\u2026");
  bundleBlob = await SORTZ.build({
    manifest,
    session: recording,
    videoBlob,
    onProgress: (loaded, total) => { if (total) setProgress(loaded, total); }
  });
  barEl.classList.remove("on");
  return bundleBlob;
}

// Local copy first, always: an upload can fail, a file on disk cannot.
//
// The saved file is the .sortz bundle, not the bare .webm. A loose video is
// only the pixels: no timeline, no tab lanes, no SOP steps, and nothing saying
// who recorded it. The bundle is the durable copy of a session.
async function saveToDisk(ref, seq) {
  const name = `${ref}_${String(seq).padStart(3, "0")}.sortz`;
  const root = (cfg.downloadFolder || "Recordings").replace(/^\/+|\/+$/g, "");
  const path = ref ? `${root}/${ref}/${name}` : `${root}/${name}`;
  const blob = await buildBundle();
  const url = URL.createObjectURL(blob);
  try {
    await ask({ type: "downloadVideo", url, filename: path });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { name, path };
}

async function run(action) {
  if (busy) return;
  const ref = ticketRef();
  if (!ref && action !== "local") {
    setStatus("Pick a ticket or type a ticket number first.", "err");
    return;
  }
  if (action === "odoo" && !(selected && selected.id)) {
    setStatus("Choose the ticket from the list. A typed number alone cannot be written back to Odoo.", "err");
    return;
  }
  // No video is no longer a dead end: the bundle still carries the timeline,
  // the tab lanes and the SOP steps, which is the half of a session that a
  // ticket is usually read for. Only a recording that vanished from storage
  // has nothing to offer.
  if (!recording) {
    setStatus("This recording is no longer stored, so there is nothing to save or upload.", "err");
    return;
  }

  setBusy(true);
  try {
    const seq = await ask({ type: "nextTicketSequence", ticketRef: ref });
    const { name, path } = await saveToDisk(ref, seq.next);
    setStatus(`Saved as ${path}.`, "ok");

    // ONE link goes on the ticket, whatever it points at. Today the upload
    // server returns a video URL; when it can host a session (timeline plus
    // video, see SESSION-FORMAT.md) it returns a session URL instead and this
    // stays a single value that the rest of the flow does not have to know
    // about. That is the whole reason it is not called videoUrl.
    let link = null;
    let linkKind = "video";
    if (action === "upload" || action === "odoo") {
      setStatus(`Uploading ${name}…`);
      const up = await uploadVideo({
        baseUrl: cfg.upload.url,
        blob: await buildBundle(),
        filename: name,
        onProgress: setProgress
      });
      // uploadVideo resolves to a string today. Accept the richer shape too so
      // the server can start returning a session URL without a lockstep
      // extension release.
      if (up && typeof up === "object") {
        link = up.sessionUrl || up.url || null;
        linkKind = up.sessionUrl ? "session" : "video";
      } else {
        link = up;
      }
      barEl.classList.remove("on");
      setStatus(`Uploaded. Link: ${link}`, "ok");
    }

    let odooDone = false;
    if (action === "odoo") {
      setStatus("Adding the link to the ticket…");
      const client = new Odoo.OdooClient(cfg.odoo);
      await client.addRecordingLink(selected.id, link, name, cfg.odoo.model || "helpdesk.ticket");
      odooDone = true;
    }

    await ask({
      type: "finishRecording",
      id: recId,
      ticket: {
        ref, seq: seq.next, filename: name, path,
        odooId: selected ? selected.id : null,
        subject: selected ? selected.name : null,
        uploadUrl: link, linkKind, odooUpdated: odooDone
      }
    });

    statusEl.innerHTML =
      `<span style="color:var(--ok)">Done.</span> Saved as ${esc(path)}` +
      (link ? ` · <a href="${esc(link)}" target="_blank">Open the ${linkKind === "session" ? "session" : "video"}</a>` : "") +
      (odooDone ? ` · added to ticket ${esc(ref)}` : "");
    setTimeout(() => window.close(), 4000);

  } catch (e) {
    barEl.classList.remove("on");
    setStatus(e.message, "err");
    setBusy(false);
    // The recording stays in the extension. Nothing is lost: the operator can
    // reopen this dialog from the popup and retry once the cause is fixed.
    await ask({ type: "finishRecording", id: recId, ticket: { ref, error: e.message, pending: true } });
  }
}

// ---- wiring ------------------------------------------------------------------
$("q").addEventListener("input", render);
$("manual").addEventListener("input", () => {
  const v = $("manual").value.trim();
  if (!selected || selected.ref !== v) selected = tickets.find((t) => t.ref === v) || null;
  render();
});
$("reload").addEventListener("click", loadTickets);
$("saveLocal").addEventListener("click", () => run("local"));
$("saveUpload").addEventListener("click", () => run("upload"));
$("saveUploadOdoo").addEventListener("click", () => run("odoo"));
$("discard").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  await ask({ type: "deleteRecording", id: recId });
  window.close();
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !busy) window.close(); });

(async function init() {
  loadTheme();
  cfg = withFixedSettings(await ask({ type: "getConfig" }));
  const recs = (await ask({ type: "getRecordings" })) || [];
  recording = recs.find((r) => r.id === recId) || null;

  const v = await loadVideoBlob(recId);
  videoBlob = v && v.blob ? v.blob : null;

  document.querySelectorAll(".ticket-hint").forEach((n) => n.remove());
  const dur = recording && recording.endTime
    ? Math.round((recording.endTime - recording.startTime) / 1000) : 0;
  $("recMeta").innerHTML =
    `<b>${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}</b> long · ` +
    (videoBlob ? `<b>${mb(videoBlob.size)}</b> MB video · ` : `<span style="color:var(--warn)">no video, timeline only</span> · `) +
    `<b>${recording ? recording.events.length : 0}</b> actions`;

  await loadTickets();

  // A call-triggered recording may already know its ticket. Pre-select it so
  // the operator only has to confirm.
  const fromCall = (recording && recording.calls || []).map(c => c.ticketRef).find(Boolean);
  if (fromCall) {
    $("manual").value = fromCall;
    const match = tickets.find(t => t.ref === String(fromCall));
    if (match) choose(match.id); else render();
  }
})();
