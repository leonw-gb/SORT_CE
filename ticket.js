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
let ticketsLoading = false;
let selectionConfirmed = false;
let ticketMode = "match";
let matchFeatures = null;
let matchMissing = [];
let olderSearch = false;

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
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(msg, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}

// ---- ticket list -------------------------------------------------------------
function render() {
  updateActions();
  const q = $("q").value.trim().toLowerCase();
  let rows = tickets.filter((t) => !q ||
    [t.ref, t.name, t.system, t.agent, t.stage].join(" ").toLowerCase().includes(q));

  const matched = ticketMode === "match" && !olderSearch;
  if (matched) rows = SortTicketMatch.rank(rows, matchFeatures || SortTicketMatch.extract(recording || {})).slice(0, 10);
  else rows.sort((a,b) => (b.created || "").localeCompare(a.created || ""));
  $("matchInfo").textContent = ticketsLoading ? "Loading tickets..." : olderSearch
    ? `Odoo search results: ${tickets.length} (up to 100), newest first; no date limit. Clear the filter or Reload tickets to return.`
    : matched ? `Top ${rows.length} of ${tickets.length} candidates from the recording's one-week window. Scores are relevance, not probabilities.${!matchFeatures?.system ? " No active RKA identified: limited evidence." : ""}${matchFeatures?.ambiguousSystem ? " Multiple active systems: check suggestions carefully." : ""}${matchMissing.length ? " Some ticket fields are unavailable; scores use partial evidence." : ""}`
    : `${tickets.length} recent tickets, newest first. Use Find older tickets to search beyond this list.`;
  if (!rows.length) {
    $("list").innerHTML =
      `<div style="padding:20px;color:#9aa4b2">${tickets.length
        ? "No ticket matches that filter. Try Find older tickets, or enter a reference for a plain upload."
        : "No tickets loaded. Add your Odoo login in the extension settings, or type the ticket number."}</div>`;
    return;
  }

  $("list").innerHTML =
    `<table><thead><tr>
      <th>Ticket</th><th>Subject</th>${matched ? "<th>Relevance</th>" : ""}<th>System</th><th>Agent</th><th>Stage</th>
    </tr></thead><tbody>` +
    rows.map((t) => `<tr tabindex="0" data-ref-row="${esc(t.ref)}" data-ref="${esc(t.ref)}"
        ${selected && selected.id === t.id ? 'class="sel"' : ""}>
        <td class="ref">${esc(t.ref)}</td>
        <td class="subj">${esc(t.name)}${matched ? `<span class="match-reasons">${esc(t.match.reasons.join(" · "))}</span>` : ""}</td>
        ${matched ? `<td class="ref" title="Heuristic relevance; not a probability">${Math.round(t.match.score)} / 100</td>` : ""}
        <td class="dim">${esc(t.system)}</td>
        <td class="dim">${esc(t.agent)}</td>
        <td class="dim">${esc(t.stage)}</td>
      </tr>`).join("") +
    `</tbody></table>`;

  $("list").querySelectorAll("tr[data-ref-row]").forEach((tr) => {
    const pick = () => choose(tr.dataset.refRow);
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
}

function choose(ref) {
  if (busy || ticketsLoading) return;
  selected = tickets.find((t) => t.ref === ref) || null;
  selectionConfirmed = !!selected;
  if (selected) $("manual").value = selected.ref;
  render();
}

async function loadTickets(searchOlder = false) {
  searchOlder = searchOlder === true;
  const query = $("q").value.trim();
  if (searchOlder && !query) { setStatus("Enter a ticket reference or subject in the filter, then choose Find older tickets."); $("q").focus(); return; }
  if (ticketsLoading || busy) return;
  void SortDiagnostics.emit("ticket.load", "started");
  // Reloading invalidates previous authorization to write back to a ticket.
  selected = null;
  selectionConfirmed = false;
  tickets = [];
  ticketsLoading = true;
  olderSearch = searchOlder;
  matchMissing = [];
  render();
  try {
    if (!cfg.odoo?.username || !cfg.odoo?.apiKey) {
      setStatus("Add your Odoo login and API key in the extension settings, or type a ticket number for a plain upload.");
      return;
    }
    setStatus(searchOlder ? "Searching Odoo without a date limit..." : ticketMode === "match" ? "Loading all tickets in the recording window..." : "Loading newest tickets from Odoo...");
    const client = new Odoo.OdooClient(cfg.odoo);
    const model = cfg.odoo.model || "helpdesk.ticket";
    if (ticketMode === "match" && !searchOlder) {
      const start = Number(recording?.startTime), end = Number(recording?.endTime || start);
      if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end < start) throw new Error("Recording time unavailable. Switch to Newest first.");
      const result = await client.matchingTickets(start - 7*86400000, end, model);
      tickets = result.tickets; matchMissing = result.missing;
      matchFeatures = SortTicketMatch.extract(recording || {});
    } else tickets = await client.recentTickets(searchOlder ? 100 : (cfg.odoo.limit || 50), model, searchOlder ? query : "");
    void SortDiagnostics.emit("ticket.load", "ok", {count: tickets.length});
    setStatus(`${tickets.length} tickets loaded. Select a row or enter a matching ticket number.`);
  } catch (e) {
    void SortDiagnostics.error("ticket.load", e);
    tickets = [];
    setStatus(`Odoo: ${e.message}`, "err");
  } finally {
    ticketsLoading = false;
    render();
  }
}

// ---- the four actions --------------------------------------------------------
function ticketRef() {
  const typed = $("manual").value.trim();
  if (typed) return typed;
  return selected ? selected.ref : "";
}

function canLinkOdoo() {
  const typed = $("manual").value.trim();
  return !ticketsLoading && !!recording && !!cfg.odoo?.username && !!cfg.odoo?.apiKey &&
    selectionConfirmed && !!selected && Number.isInteger(selected.id) && selected.id > 0 &&
    typed !== "" && String(selected.ref) === typed &&
    tickets.some(t => t.id === selected.id && String(t.ref) === typed);
}
function updateActions() {
  const validTicket = canLinkOdoo();
  $("saveLocal").disabled = busy || !recording;
  $("saveUpload").disabled = busy || !recording || !ticketRef();
  const odooButton = $("saveUploadOdoo");
  odooButton.disabled = busy || !validTicket;
  odooButton.setAttribute("aria-disabled", String(odooButton.disabled));
  odooButton.title = validTicket ? `Add the recording link to Odoo ticket ${selected.ref}`
    : "Select an Odoo ticket row or type the number of a loaded ticket first.";
  $("odooSelectionStatus").textContent = ticketsLoading ? "Loading tickets - Odoo action unavailable."
    : validTicket ? `Selected Odoo ticket: ${selected.ref}${selected.name ? " - " + selected.name : ""}`
    : !cfg.odoo?.username || !cfg.odoo?.apiKey ? "Odoo credentials are missing."
    : "No Odoo ticket selected. Select a row or enter a matching loaded ticket number.";
  $("discard").disabled = busy || !recording;
  $("reload").disabled = busy || ticketsLoading;
  $("ticketMode").disabled = busy || ticketsLoading;
  $("ticketMode").textContent = ticketMode === "match" ? "Match mode" : "Newest first";
  $("ticketMode").setAttribute("aria-pressed", String(ticketMode === "match"));
  $("ticketMode").title = ticketMode === "match" ? "Switch to newest tickets first" : "Switch to match mode";
  $("findOlder").disabled = busy || ticketsLoading;
  for (const id of ["manual", "q"]) $(id).disabled = busy || ticketsLoading;
}
function setBusy(on) { busy = on; updateActions(); }

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
    ticket: recording.ticket ? { ref: recording.ticket.ref, seq: recording.ticket.seq, odooId: recording.ticket.odooId || null, odooUrl: Odoo.ticketUrl(recording.ticket) || null } : null
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
  void SortDiagnostics.emit("ticket.action", "started");
  if (busy) return;
  const ref = ticketRef();
  if (!ref && action !== "local") {
    setStatus("Pick a ticket or type a ticket number first.", "err");
    return;
  }
  if (action === "odoo" && !canLinkOdoo()) {
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
    recording = {...recording, ticket: {
      ref, seq: seq.next, odooId: selectionConfirmed && selected?.ref === ref ? selected.id : null,
      subject: selectionConfirmed && selected?.ref === ref ? selected.name : null
    }};
    recording.ticket.odooUrl = Odoo.ticketUrl(recording.ticket) || null;
    bundleBlob = null; // A retry/reassignment must not reuse old ticket metadata.
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
        odooId: recording.ticket.odooId,
        odooUrl: recording.ticket.odooUrl,
        subject: selected ? selected.name : null,
        uploadUrl: link, linkKind, odooUpdated: odooDone
      }
    });

    statusEl.innerHTML =
      `<span style="color:var(--ok)">Done.</span> Saved as ${esc(path)}` +
      (link ? ` · <a href="${esc(link)}" target="_blank">Open the ${linkKind === "session" ? "session" : "video"}</a>` : "") +
      (odooDone ? ` · added to ticket ${esc(ref)}` : "") +
      (Odoo.ticketUrl(recording.ticket) ? ` · <a href="${esc(Odoo.ticketUrl(recording.ticket))}" target="_blank" rel="noopener noreferrer">Open ticket ${esc(ref)}</a>` : "");
    void SortDiagnostics.emit("ticket.action", "ok");
    setTimeout(() => window.close(), 4000);

  } catch (e) {
    void SortDiagnostics.error("ticket.action", e);
    barEl.classList.remove("on");
    setStatus(e.message, "err");
    setBusy(false);
    // The recording stays in the extension. Nothing is lost: the operator can
    // reopen this dialog from the popup and retry once the cause is fixed.
    await ask({ type: "finishRecording", id: recId, ticket: { ...(recording.ticket?.ref === ref ? recording.ticket : {}), ref, error: e.message, pending: true } });
  }
}


// Diagnostics wrappers preserve return values and thrown errors; arguments are never logged.
buildBundle = SortDiagnostics.trace("bundle.build", buildBundle);
saveToDisk = SortDiagnostics.trace("bundle.download", saveToDisk);

// ---- wiring ------------------------------------------------------------------
$("q").addEventListener("input", () => { if (olderSearch && !$("q").value.trim()) void loadTickets(); else render(); });
function handleTicketNumberEdit() {
  if (busy || ticketsLoading) return;
  const value = $("manual").value.trim();
  selected = value ? tickets.find(t => String(t.ref) === value) || null : null;
  selectionConfirmed = !!selected;
  render();
}
$("manual").addEventListener("input", handleTicketNumberEdit);
$("manual").addEventListener("change", handleTicketNumberEdit);
$("reload").addEventListener("click", () => loadTickets());
$("ticketMode").addEventListener("click", () => {
  if (busy || ticketsLoading) return;
  ticketMode = ticketMode === "match" ? "newest" : "match";
  // Retain the query/manual reference; reloading requires fresh confirmation.
  void loadTickets();
});
$("findOlder").addEventListener("click", () => loadTickets(true));
$("saveLocal").addEventListener("click", () => run("local"));
$("saveUpload").addEventListener("click", () => run("upload"));
$("saveUploadOdoo").addEventListener("click", () => run("odoo"));
const deleteDialog = $("deleteConfirm");
$("discard").addEventListener("click", () => {
  if (busy || !recording) return;
  $("deleteError").textContent = "";
  deleteDialog.showModal();
});
function cancelDelete() {
  if (busy) return;
  deleteDialog.close();
  $("discard").focus();
}
$("cancelDelete").addEventListener("click", cancelDelete);
deleteDialog.addEventListener("cancel", e => { e.preventDefault(); cancelDelete(); });
$("confirmDelete").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  $("confirmDelete").disabled = $("cancelDelete").disabled = true;
  $("deleteError").textContent = "Deleting local recording and video...";
  try {
    const response = await ask({type: "deleteRecording", id: recId});
    if (!response?.success) throw new Error(response?.error || "Recording could not be deleted. Try again.");
    window.close();
  } catch (e) {
    $("deleteError").textContent = String(e.message || e);
    setBusy(false);
    $("confirmDelete").disabled = $("cancelDelete").disabled = false;
  }
});
window.addEventListener("keydown", e => {
  if (e.key === "Escape" && !busy && !deleteDialog.open) window.close();
});
updateActions();

(async function init() {
  cfg = withFixedSettings(await ask({ type: "getConfig" }));
  applyTheme(cfg.theme);
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

  // A call ticket is a suggestion, not an operator-confirmed Odoo selection.
  const fromCall = (recording && recording.calls || []).map(c => c.ticketRef).find(Boolean);
  if (fromCall) {
    $("callTicketSuggestion").textContent = `Call suggested ticket ${fromCall}. Select it from the list or enter its number to confirm.`;
    $("callTicketSuggestion").hidden = false;
  }
  updateActions();
})();
