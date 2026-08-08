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
    chrome.runtime.sendMessage({ type: "startSession", options: {} }, (res) => {
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
      [r.id, r.endTime, r.events.length, r.ticket ? [r.ticket.ref, r.ticket.seq, r.ticket.pending, r.ticket.uploadUrl] : 0]));
    if (sig === lastListSignature) return;
    lastListSignature = sig;
    if (!recordings || recordings.length === 0) {
      list.innerHTML = '<div class="empty-state">No recordings yet — press Start to begin.</div>';
      return;
    }

    list.innerHTML = recordings
      .sort((a, b) => b.startTime - a.startTime)
      .map(rec => {
        const tabCount = Object.keys(rec.tabs || {}).length;
        const dur = rec.endTime ? formatDuration(rec.endTime - rec.startTime) : "—";
        const t = rec.ticket;
        // A recording with a video but no ticket, or one whose upload failed,
        // is unfinished business. Say so, and offer the way back in.
        const unfinished = !!(rec.video && rec.video.saved) && (!t || t.pending);
        const tag = t && t.ref && !t.pending
          ? `<span class="ticket-tag">${t.ref}_${String(t.seq).padStart(3, "0")}</span>`
          : (unfinished ? `<span class="ticket-tag pending">Not assigned</span>` : "");
        const link = t && t.uploadUrl
          ? ` &middot; <a href="${t.uploadUrl}" target="_blank" style="color:#2b6cb0">video link</a>` : "";
        return `
        <div class="recording-item">
          <div class="recording-item-header">
            <span>${formatDate(rec.startTime)}</span>
            <span style="color:#aaa">${dur}</span>
          </div>
          <div class="recording-meta">${tag}${tabCount} tab(s) &middot; ${rec.events.length} events${link}</div>
          <div class="recording-actions">
            ${unfinished ? `<button data-action="ticket" data-id="${rec.id}">Assign ticket</button>` : ""}
            <button data-action="replay" data-id="${rec.id}">▶ Replay</button>
            <button data-action="export" data-id="${rec.id}">Export JSON</button>
            <button data-action="delete" data-id="${rec.id}" class="danger">Delete</button>
          </div>
        </div>`;
      })
      .join("");

    list.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const { action, id } = btn.dataset;
        if (action === "ticket")  {
          chrome.runtime.sendMessage({ type: "openTicketDialog", id });
          window.close();
        }
        if (action === "replay")  openReplay(id);
        if (action === "export")  exportRecording(id);
        if (action === "delete")  deleteRecording(id);
      });
    });
  });
}

function openReplay(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?id=${encodeURIComponent(id)}`) });
}

function exportRecording(id) {
  chrome.runtime.sendMessage({ type: "exportRecording", id }, (res) => {
    showToast(res?.success ? "Exported to Downloads" : "Export failed");
  });
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
    theme: currentTheme,
    odoo: { username: val("odooUser"), apiKey: val("odooKey") }
  });
}

document.getElementById("saveConfig").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "saveConfig", config: currentConfig() }, () => {
    showToast("Settings saved");
  });
});

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
