// defaults.js - Fixed deployment settings.
//
// These are properties of our infrastructure, not preferences: every operator
// points at the same upload server and the same Odoo database. Keeping them
// here rather than in the settings form removes five ways to typo a hostname
// and keeps infrastructure addresses consistent across operators.
//
// The call-state endpoint (Sipgate -> n8n -> SORT) lives here too. Operators
// enter their Sipgate name and their separately provisioned call-state token.
// This audit package also accepts the endpoint in Settings because it was redacted.
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
  continueMinutes: 5,
  // Call trigger polling floor. Faster than this buys nothing -- the delay is
  // dominated by Sipgate's push and n8n's hop -- and costs a request per second
  // per operator against the same small endpoint.
  callPollMinMs: 1000,
  callPollDefaultMs: 2000,
  // Non-secret endpoint may be fixed here. The shared token is always entered locally.
  callTrigger: {
    url: "https://j32j4jh324jh4j3j3j24cj34jc23j4cj234cj4hkj121212.replit.app/api/events",   // <-- your n8n call-state address
    intervalMs: 2000
  }
};

// Fixed infrastructure values win; user-entered call-state credentials persist.
function withFixedSettings(config) {
  const c = config || {};
  return Object.assign({}, c, {
    continueMinutes: FIXED.continueMinutes,
    theme: c.theme === "light" ? "light" : "dark",
    downloadFolder: c.downloadFolder || "Recordings",
    upload: { url: FIXED.upload.url },
    // Never distribute the call-state token in this file. Preserve local credentials.
    // A public endpoint can optionally be fixed above; empty means use local Settings.
    callTrigger: {
      url: FIXED.callTrigger.url || String(c.callTrigger?.url || "").trim(),
      apiKey: String(c.callTrigger?.apiKey || "").trim(),
      intervalMs: Math.max(FIXED.callPollMinMs, Number(FIXED.callTrigger.intervalMs) || FIXED.callPollDefaultMs)
    },
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
