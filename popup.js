// popup.js

let sessionActive = false;
let sessionStartTime = null;
let pollTimer = null;

// ---- Tab switching -----------------------------------------------------------
document.querySelectorAll(".tab-button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "recordings") loadRecordings();
  });
});

// ---- Record button -----------------------------------------------------------
document.getElementById("btnRecord").addEventListener("click", () => {
  if (!sessionActive) {
    // Video is not optional: a timeline without the screen it happened on is
    // half a recording, and the operator should not be able to ship one.
    chrome.runtime.sendMessage({ type: "startSession", options: { trigger: "popup" } }, (res) => {
      // No name, no recording. Send the operator to the field rather than
      // telling them a rule and leaving them to find it.
      if (res && res.needsName) {
        showSettingsTab();
        flagNameField(res.error);
        return;
      }
      if (res && res.success) {
        setSessionUI(true);
        // A capture failure must be loud: the session runs either way, but the
        // operator should not find out at replay time that there is no video.
        if (res.captureWarning) {
          showToast("Recording started WITHOUT video: " + res.captureWarning, 6000);
        } else {
          showToast(res.videoCapturing ? "Recording started with video" : "Recording started");
        }
        loadRecordings();
      } else {
        showToast(res?.error || "Could not start");
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: "stopSession" }, (res) => {
      if (res && res.success) {
        setSessionUI(false);
        showToast(res.ticketDialog ? "Stopped. Pick a ticket in the window that opened." : "Session saved");
        loadRecordings();
      } else {
        showToast(res?.error || "Could not stop");
      }
    });
  }
});

// ---- Session status UI -------------------------------------------------------
function setSessionUI(active) {
  sessionActive = active;
  const btn = document.getElementById("btnRecord");
  const dot = document.getElementById("statusDot");
  const stats = document.getElementById("sessionStats");

  if (active) {
    btn.textContent = "⏹ Stop Recording";
    btn.classList.add("recording");
    dot.classList.add("active");
    stats.classList.add("visible");
    startElapsedTimer();
  } else {
    btn.textContent = "▶ Start Recording";
    btn.classList.remove("recording");
    dot.classList.remove("active");
    stats.classList.remove("visible");
    sessionStartTime = null;
    stopElapsedTimer();
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getSessionStatus" }, (s) => {
    if (!s) return;
    if (s.active !== sessionActive) setSessionUI(s.active);
    if (s.active) {
      if (!sessionStartTime && s.startTime) sessionStartTime = s.startTime;
      document.getElementById("statTabs").textContent = s.tabCount;
      document.getElementById("statEvents").textContent = s.eventCount;
    }
  });
}

function startElapsedTimer() {
  stopElapsedTimer();
  pollTimer = setInterval(() => {
    refreshStatus();
    if (sessionStartTime) {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      document.getElementById("statTime").textContent = `${m}:${String(s).padStart(2, "0")}`;
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---- Recordings list ---------------------------------------------------------
let lastListSignature = "";

function loadRecordings() {
  chrome.runtime.sendMessage({ type: "getRecordings" }, (recordings) => {
    const list = document.getElementById("recordingList");
    // Redraw only on real change. Rewriting innerHTML on a timer would swallow
    // a click that lands in the same tick.
    const sig = JSON.stringify((recordings || []).map(r =>
      [r.id, r.endTime, r.events.length, r.imported ? 1 : 0,
       r.ticket ? [r.ticket.ref, r.ticket.seq, r.ticket.pending, r.ticket.uploadUrl] : 0]));
    if (sig === lastListSignature) return;
    lastListSignature = sig;
    if (!recordings || recordings.length === 0) {
      list.innerHTML = importBar() +
        '<div class="empty-state">No recordings yet — press Start to begin, or import a colleague\'s session.</div>';
      wireImport(list);
      return;
    }

    list.innerHTML = importBar() + recordings
      .sort((a, b) => b.startTime - a.startTime)
      .map(rec => {
        const tabCount = Object.keys(rec.tabs || {}).length;
        const dur = rec.endTime ? formatDuration(rec.endTime - rec.startTime) : "—";
        const t = rec.ticket;
        // A recording with a video but no ticket, or one whose upload failed,
        // is unfinished business. Say so, and offer the way back in.
        const unfinished = !!(rec.video && rec.video.saved) && (!t || t.pending);
        // ticket_seq: the session identifier, same string as the video
        // filename and the ticket link.
        const tag = t && t.ref && !t.pending
          ? `<span class="ticket-tag">${esc(t.ref)}_${String(t.seq || 1).padStart(3, "0")}</span>`
          : (unfinished ? `<span class="ticket-tag pending">Not assigned</span>` : "");
        const link = t && t.uploadUrl
          ? ` &middot; <a href="${t.uploadUrl}" target="_blank" style="color:var(--link)">video link</a>` : "";
        // Someone else's session sitting in my list is confusing unless it says
        // so. The name comes from the bundle, so it is the recorder's, not mine.
        const from = rec.imported
          ? `<span class="ticket-tag imported">from ${esc(rec.recorder || "unknown")}</span>` : "";
        return `
        <div class="recording-item${rec.imported ? " imported" : ""}">
          <div class="recording-item-header">
            <span>${formatDate(rec.startTime)}</span>
            <span style="color:var(--ink-faint)">${dur}</span>
          </div>
          <div class="recording-meta">${from}${tag}${tabCount} tab(s) &middot; ${rec.events.length} events${link}</div>
          <div class="recording-actions">
            ${unfinished && !rec.imported ? `<button data-action="ticket" data-id="${rec.id}">Assign ticket</button>` : ""}
            <button data-action="replay" data-id="${rec.id}">▶ Replay</button>
            ${rec.imported ? "" : `<button data-action="export" data-id="${rec.id}">Export</button>`}
            <button data-action="delete" data-id="${rec.id}" class="danger">Delete</button>
          </div>
        </div>`;
      })
      .join("");

    wireImport(list);

    list.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const { action, id } = btn.dataset;
        if (action === "ticket")  {
          chrome.runtime.sendMessage({ type: "openTicketDialog", id });
          window.close();
        }
        if (action === "replay")  openReplay(id);
        if (action === "export")  exportRecording(id, btn);
        if (action === "delete")  deleteRecording(id);
      });
    });
  });
}

function importBar() {
  return `<div class="import-bar">
      <button id="btnImport" class="btn-import">Import a session…</button>
      <span>Open a .sortz bundle from a colleague</span>
    </div>`;
}

function wireImport(list) {
  const b = list.querySelector("#btnImport");
  if (b) b.addEventListener("click", openImport);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function openReplay(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?id=${encodeURIComponent(id)}`) });
}

function exportRecording(id, btn) {
  // A bundle with video is hundreds of megabytes and takes a few seconds to
  // write. The worker keeps going if this popup closes; the button just stops
  // reporting. Say so rather than looking frozen.
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  showToast("Building the bundle. This keeps running if you close SORT.", 4000);

  chrome.runtime.sendMessage({ type: "exportRecording", id }, (res) => {
    if (btn) { btn.disabled = false; btn.textContent = "Export"; }
    if (res && res.success) showToast(`Saved ${res.filename} to Downloads`, 4000);
    else showToast(res?.error || "The export did not finish.", 5000);
  });
}

function openImport() {
  chrome.runtime.sendMessage({ type: "openImport" }, () => window.close());
}

// ---- Settings validation -----------------------------------------------------
function showSettingsTab() {
  document.querySelectorAll(".tab-button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === "settings"));
  document.querySelectorAll(".tab-content").forEach(c =>
    c.classList.toggle("active", c.id === "settings"));
}

function flagNameField(message) {
  const field = document.getElementById("sipgateName");
  const err = document.getElementById("sipgateError");
  field.classList.add("invalid");
  if (err) err.textContent = message || "Enter the name your recordings are shared under.";
  // After the tab switch has laid out, or the field is still display:none and
  // both the scroll and the focus are dropped on the floor.
  requestAnimationFrame(() => {
    field.scrollIntoView({ block: "center" });
    field.focus();
  });
}

function clearNameFlag() {
  document.getElementById("sipgateName").classList.remove("invalid");
  const err = document.getElementById("sipgateError");
  if (err) err.textContent = "";
}

function deleteRecording(id) {
  if (!confirm("Delete this recording?")) return;
  chrome.runtime.sendMessage({ type: "deleteRecording", id }, () => {
    showToast("Deleted");
    loadRecordings();
  });
}

// ---- Settings ----------------------------------------------------------------
// Everything the ticket dialog needs lives in one config object, so the dialog
// can read it with a single getConfig and never has to ask the operator twice.
const val = (id) => document.getElementById(id).value.trim();

function currentConfig() {
  // Only what the operator actually controls. Server addresses, the database,
  // the ticket model and the 5-minute reminder are fixed in defaults.js.
  return withFixedSettings({
    sopSteps: document.getElementById("sopSteps").value
      .split("\n").map(l => l.trim()).filter(l => l.length)
      .map((label, i) => ({ id: "step_" + (i + 1), label })),
    downloadFolder: val("downloadFolder") || "Recordings",
    sipgateName: val("sipgateName"),
    callTrigger: {
      url: val("callUrl"),
      apiKey: val("callKey"),
      intervalMs: Math.max(1000, (Number(val("callInterval")) || 2) * 1000)
    },
    theme: currentTheme,
    odoo: { username: val("odooUser"), apiKey: val("odooKey") }
  });
}

document.getElementById("saveConfig").addEventListener("click", () => {
  // Required, because it is the only thing that says whose session a shared
  // bundle is. Everything else here has a sane default; this cannot.
  if (!val("sipgateName")) {
    flagNameField("Enter your name before saving. Recordings are shared under it.");
    return;
  }
  clearNameFlag();
  chrome.runtime.sendMessage({ type: "saveConfig", config: currentConfig() }, () => {
    showToast("Settings saved");
  });
});

document.getElementById("sipgateName").addEventListener("input", clearNameFlag);

// ---- Keyboard shortcut -------------------------------------------------------
// Read-only here by design: chrome.commands has no setter, and Chrome's own
// shortcuts page is the only place a binding can be changed. Showing the live
// value and linking straight to it beats a fake input that cannot take effect.
function loadShortcut() {
  chrome.runtime.sendMessage({ type: "getShortcut" }, (res) => {
    const el = document.getElementById("shortcutValue");
    const s = res && res.shortcut;
    el.textContent = s || "not set";
    el.classList.toggle("unset", !s);
  });
}

document.getElementById("editShortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});

// ---- Theme -------------------------------------------------------------------
let currentTheme = "dark";

function markTheme(theme) {
  currentTheme = saveTheme(theme);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === currentTheme));
  });
}

document.querySelectorAll("[data-theme-choice]").forEach((b) => {
  // Applied on click, not on Save: a theme you have to confirm is a theme you
  // cannot preview.
  b.addEventListener("click", () => {
    markTheme(b.dataset.themeChoice);
    chrome.runtime.sendMessage({ type: "saveConfig", config: currentConfig() });
  });
});

// Answer the one question the operator actually has: do these credentials work?
document.getElementById("testOdoo").addEventListener("click", async () => {
  const btn = document.getElementById("testOdoo");
  const cfg = currentConfig().odoo;
  btn.disabled = true;
  btn.textContent = "Testing\u2026";
  try {
    const client = new Odoo.OdooClient(cfg);
    const tickets = await client.recentTickets(5, cfg.model);
    showToast(`Connected. ${tickets.length ? "Newest ticket: " + tickets[0].ref : "No tickets found."}`, 5000);
  } catch (e) {
    showToast(e.message, 6000);
  }
  btn.disabled = false;
  btn.textContent = "Test the Odoo connection";
});

// The test hits the endpoint exactly as the poller will, and reports what it
// found rather than a bare "OK": whether the JSON parsed, how many live calls
// came back, and -- the useful part -- whether the configured name matches one
// of them. Run it while on a call and it tells you the whole thing works.
// Print the headline plus what actually came back, so a failing test can be
// diagnosed from the popup instead of from devtools.
function showCallResult(headline, res) {
  const out = document.getElementById("callStatus");
  out.textContent = "";
  const h = document.createElement("div");
  h.textContent = headline;
  out.appendChild(h);

  const facts = [];
  if (res.contentType) facts.push(`Content type: ${res.contentType}`);
  if (res.redirected && res.finalUrl) facts.push(`Redirected to: ${res.finalUrl}`);
  if (facts.length) {
    const f = document.createElement("div");
    f.textContent = facts.join(" · ");
    f.style.marginTop = "4px";
    out.appendChild(f);
  }

  // Addresses on the same server that DID answer JSON. Offering them as
  // buttons is the fix itself, not a hint about it.
  if (res.candidates && res.candidates.length) {
    const c = document.createElement("div");
    c.style.marginTop = "6px";
    c.textContent = res.candidates.length === 1
      ? "This address on the same server answers JSON:"
      : "These addresses on the same server answer JSON:";
    out.appendChild(c);
    res.candidates.forEach((cand) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `Use ${cand.url}`;
      b.style.cssText =
        "display:block; width:100%; text-align:left; margin-top:4px; padding:6px 8px; " +
        "font-size:11px; font-family:inherit; cursor:pointer; border-radius:6px; " +
        "border:1px solid var(--line2); background:var(--panel2); color:var(--txt);";
      b.addEventListener("click", () => {
        document.getElementById("callUrl").value = cand.url;
        out.textContent = "Address updated. Save the settings, then test again.";
      });
      out.appendChild(b);
    });
  }

  if (res.sample) {
    const pre = document.createElement("pre");
    pre.textContent = res.sample;
    pre.style.cssText =
      "margin:6px 0 0; padding:8px; max-height:140px; overflow:auto; " +
      "white-space:pre-wrap; word-break:break-all; font-size:11px; " +
      "border:1px solid var(--line2); border-radius:6px; background:var(--panel2);";
    out.appendChild(pre);
  } else {
    const e = document.createElement("div");
    e.textContent = "The response body was empty.";
    e.style.marginTop = "4px";
    out.appendChild(e);
  }
}


// The endpoint answered but nothing matched. Print what it offered, so a
// spelling difference or an unexpected field is read off the screen.
function showNoMatch(res, myName) {
  const out = document.getElementById("callStatus");
  out.textContent = "";
  const d = res.detail || {};

  const line = (text, top) => {
    const e = document.createElement("div");
    e.textContent = text;
    if (top) e.style.marginTop = "4px";
    out.appendChild(e);
  };

  // The row count is not the call count: the endpoint is an event log, so one
  // call is several rows. Report both, or "51 calls" reads as chaos.
  line(d.distinct !== undefined
    ? `Connected. ${d.rows} events covering ${d.distinct} call${d.distinct === 1 ? "" : "s"}.`
    : `Connected. ${res.calls} calls returned.`);

  line(d.live
    ? `${d.live} call${d.live === 1 ? " is" : "s are"} still open, none answered by "${myName}".`
    : `No call is open right now.`, true);

  if (d.liveSummary && d.liveSummary.length) {
    const pre = document.createElement("pre");
    pre.textContent = d.liveSummary.join("\n");
    pre.style.cssText =
      "margin:4px 0 0; padding:8px; max-height:110px; overflow:auto; white-space:pre-wrap; " +
      "font-size:11px; border:1px solid var(--line2); border-radius:6px; background:var(--panel2);";
    out.appendChild(pre);
  }

  if (d.nearly && d.nearly.length) {
    line(`Close to your name in the log: ${d.nearly.join(", ")} — copy that exact spelling into the name field.`, true);
  } else if (d.names && d.names.length) {
    line(`Names the log has seen: ${d.names.slice(0, 12).join(", ")}${d.names.length > 12 ? ", …" : ""}`, true);
    if (!d.names.some((n) => n.toLowerCase().includes(myName.toLowerCase().split(" ")[0]))) {
      line(`"${myName}" is not among them. Answer a call and test again, or check the spelling against the list.`, true);
    }
  } else {
    line("The log carries no agent names at all, so no call can be attributed to you.", true);
  }
  reportPollerHealth();
}

// The test button proves the endpoint answers. This proves something is
// actually watching it -- the two fail independently, and only one of them
// starts recordings.
function reportPollerHealth() {
  const out = document.getElementById("callStatus");
  chrome.runtime.sendMessage({ type: "callPollerStatus" }, (st) => {
    const box = document.createElement("div");
    box.style.marginTop = "8px";

    const head = document.createElement("div");
    if (!st || !st.polling) {
      head.textContent = "The watcher is NOT running, so nothing would start a recording. Save the settings to start it.";
    } else {
      const ago = st.lastPollAt ? Math.round((Date.now() - st.lastPollAt) / 1000) : null;
      head.textContent = `The watcher is running${ago === null ? "" : `, last checked ${ago}s ago`}` +
        (st.consecutiveFailures ? ` · ${st.consecutiveFailures} failed checks (${st.lastError || "unknown"})` : "") + ".";
    }
    box.appendChild(head);

    // The watcher matches against the SAVED name, the test against the one in
    // the form. When those differ, the test passes and nothing records -- so
    // show what the watcher is actually using rather than assuming they agree.
    if (st && st.polling) {
      const typed = document.getElementById("sipgateName").value.trim();
      const w = document.createElement("div");
      w.style.marginTop = "4px";
      w.textContent = `Watching as "${st.name || "(no name)"}" · ${st.url || "(no address)"}`;
      box.appendChild(w);
      if (typed && st.name && typed.toLowerCase() !== String(st.name).toLowerCase()) {
        const warn = document.createElement("div");
        warn.style.marginTop = "4px";
        warn.textContent = `The name in the form ("${typed}") is not the one the watcher is using. Save the settings.`;
        box.appendChild(warn);
      }
      if (st.onCall) {
        const c = document.createElement("div");
        c.style.marginTop = "4px";
        c.textContent = `The watcher currently sees you on call ${st.onCall}.`;
        box.appendChild(c);
      }
    }

    // The decision trail: what the watcher saw and what the worker did with
    // it. This is the only view of the two-second window where a trigger is
    // either delivered or lost.
    const entries = []
      .concat((st && st.log) || [])
      .concat((st && st.trail) || [])
      .sort((a, b) => a.t - b.t)
      .slice(-18);
    if (entries.length) {
      const label = document.createElement("div");
      label.style.marginTop = "6px";
      label.textContent = "What the watcher did:";
      box.appendChild(label);

      const pre = document.createElement("pre");
      pre.textContent = entries.map((e) => {
        const d = new Date(e.t);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        const bits = Object.keys(e)
          .filter((k) => k !== "t" && k !== "what" && e[k] !== undefined && e[k] !== null && e[k] !== false)
          .map((k) => `${k}=${e[k]}`)
          .join(" ");
        return `${hh}:${mm}:${ss}  ${e.what}${bits ? "  " + bits : ""}`;
      }).join("\n");
      pre.style.cssText =
        "margin:4px 0 0; padding:8px; max-height:170px; overflow:auto; white-space:pre-wrap; " +
        "word-break:break-all; font-size:11px; border:1px solid var(--line2); " +
        "border-radius:6px; background:var(--panel2);";
      box.appendChild(pre);
    }

    out.appendChild(box);
  });
}

document.getElementById("testCall").addEventListener("click", async () => {
  const btn = document.getElementById("testCall");
  const out = document.getElementById("callStatus");
  const cfg = currentConfig();
  if (!cfg.callTrigger.url) {
    out.textContent = "Enter the call-state address first.";
    return;
  }
  if (!cfg.sipgateName) {
    flagNameField("Enter your Sipgate name first: the test matches calls against it.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Testing\u2026";
  out.textContent = "";
  chrome.runtime.sendMessage({
    type: "probeCallEndpoint",
    config: { url: cfg.callTrigger.url, apiKey: cfg.callTrigger.apiKey, name: cfg.sipgateName }
  }, (res) => {
    btn.disabled = false;
    btn.textContent = "Test the call connection";
    if (!res) { out.textContent = "No answer from the background worker."; return; }
    if (!res.success && res.error) { out.textContent = `Could not reach it: ${res.error}`; return; }
    if (!res.success) {
      showCallResult(
        res.status === 401 || res.status === 403
          ? `Rejected (HTTP ${res.status}). Check the API key.`
          : `The address answered HTTP ${res.status}.`,
        res);
      return;
    }
    // Not JSON is the interesting failure: the address is reachable but is
    // answering with something else -- a login page, an HTML error, an XML
    // body. Printing the first lines of it is the difference between "wrong
    // path" and "not signed in", so it is shown rather than summarised away.
    if (!res.parsed) {
      const page = /text\/html/i.test(res.contentType || "");
      showCallResult(page
        ? "That address returns the CallHub web page, not call data. The poller needs the address that answers JSON."
        : "Reached it, but the answer was not JSON.", res);
      return;
    }
    if (res.mine) {
      out.textContent = "Connected. You are on a call right now.";
      reportPollerHealth();
      return;
    }
    // "None under your name" while you are on a call is the confusing case:
    // the endpoint answered, so the fault is in the matching, not the wiring.
    // Show the names it did return -- the mismatch is then visible.
    showNoMatch(res, cfg.sipgateName);
  });
});

function loadConfig() {
  chrome.runtime.sendMessage({ type: "getConfig" }, (config) => {
    const c = withFixedSettings(config);
    if (c.sopSteps?.length) {
      document.getElementById("sopSteps").value = c.sopSteps.map(s => s.label).join("\n");
    }
    document.getElementById("downloadFolder").value = c.downloadFolder;
    document.getElementById("sipgateName").value = c.sipgateName || "";
    document.getElementById("odooUser").value = c.odoo?.username || "";
    document.getElementById("odooKey").value = c.odoo?.apiKey || "";
    document.getElementById("callUrl").value = c.callTrigger?.url || "";
    document.getElementById("callKey").value = c.callTrigger?.apiKey || "";
    document.getElementById("callInterval").value =
      Math.round((c.callTrigger?.intervalMs || 2000) / 1000);
    markTheme(c.theme);
  });
}

// ---- Helpers -----------------------------------------------------------------
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function showToast(msg, ms) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || 2000);
}

// ---- Staying current ---------------------------------------------------------
// The ticket dialog is a separate window: when it assigns a ticket, uploads, or
// deletes a recording, this list is already on screen and would otherwise keep
// showing "Not assigned" until the popup is reopened. The worker broadcasts
// after every change; we just redraw.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "recordingsChanged") loadRecordings();
});

// A popup gets no messages while it is closed, and Chrome may also drop one if
// the worker was asleep. Re-read whenever the window regains focus, and poll
// gently while a ticket window is plausibly open.
window.addEventListener("focus", () => { loadRecordings(); refreshStatus(); });
setInterval(() => { if (!document.hidden) loadRecordings(); }, 3000);

// ---- Init -------------------------------------------------------------------
loadTheme();
loadShortcut();
loadConfig();
loadRecordings();
refreshStatus();

// A popup opened by the worker (after a recording was refused for a missing
// name) arrives with no message and no arguments -- it looks exactly like the
// operator clicking the toolbar icon. So it asks the worker whether it was
// summoned, and lands on the field that caused it rather than on Recordings.
//
// This runs after loadConfig() so the field is already populated; the flag is
// read-and-cleared, so reopening the popup later shows the normal Recordings
// tab.
chrome.runtime.sendMessage({ type: "consumeNameWarning" }, (res) => {
  if (!res || !res.pending) return;
  showSettingsTab();
  flagNameField("Add your name to start recording. Recordings are shared under it.");
});
