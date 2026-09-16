// defaults.js - Fixed deployment settings.
//
// These are properties of our infrastructure, not preferences: every operator
// points at the same upload server and the same Odoo database. Keeping them
// here rather than in the settings form removes five ways to typo a hostname
// and makes a fresh install work with nothing but an API key.
//
// The call-state endpoint (Sipgate -> n8n -> SORT) lives here too. Operators
// only enter their Sipgate name; the address and key are ours to manage.
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
  // Call-state endpoint. Not shown in the settings form.
  callTrigger: {
    url: "https://j32j4jh324jh4j3j3j24cj34jc23j4cj234cj4hkj121212.replit.app/api/events",   // <-- your n8n call-state address
    apiKey: "chk_e22cd3ce9641a41621b871511e21a4b931ee2fa9216e05a2",                       // <-- sent as X-API-Key
    intervalMs: 2000
  }
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
    // Fixed like the upload server and Odoo. Older stored configs that still
    // carry a url/apiKey from the test phase are overwritten here.
    callTrigger: {
      url: FIXED.callTrigger.url,
      apiKey: FIXED.callTrigger.apiKey,
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
