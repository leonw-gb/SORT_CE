// defaults.js - Fixed deployment settings.
//
// These are properties of our infrastructure, not preferences: every operator
// points at the same upload server and the same Odoo database. Keeping them
// here rather than in the settings form removes five ways to typo a hostname
// and makes a fresh install work with nothing but an API key.
//
// Loaded by the popup, the ticket dialog, and the service worker
// (importScripts), so there is exactly one copy of each value.

const FIXED = {
  upload: {
    url: "http://roupload.gdbz.network"
  },
  odoo: {
    url: "https://odoo.goodbytz.com",
    db: "gdbytz",
    model: "helpdesk.ticket",
    limit: 50
  },
  // The "still recording?" reminder is always on, every 5 minutes.
  continueMinutes: 5
};

// Merge the stored config with the fixed values. The fixed values always win,
// so an older stored config cannot resurrect a stale hostname.
function withFixedSettings(config) {
  const c = config || {};
  return Object.assign({}, c, {
    continueMinutes: FIXED.continueMinutes,
    theme: c.theme === "light" ? "light" : "dark",
    downloadFolder: c.downloadFolder || "Recordings",
    upload: { url: FIXED.upload.url },
    odoo: Object.assign({}, c.odoo, {
      url: FIXED.odoo.url,
      db: FIXED.odoo.db,
      model: FIXED.odoo.model,
      limit: FIXED.odoo.limit
    })
  });
}

if (typeof globalThis !== "undefined") {
  globalThis.FIXED = FIXED;
  globalThis.withFixedSettings = withFixedSettings;
}
