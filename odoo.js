// odoo.js - Browser-side Odoo client for the Behavior Recorder.
//
// The desktop tool talked XML-RPC (odoo_api.py). A browser cannot speak
// XML-RPC without hand-rolling a serializer, so this uses Odoo's /jsonrpc
// endpoint instead. It is the SAME backend service ("object" / execute_kw)
// with the same credentials -- database, login, API key -- just JSON on the
// wire. No session cookie, so nothing to keep alive between calls.
//
// Loaded as a plain script (no modules) so it works in both extension pages
// and, if ever needed, the service worker via importScripts().

const Odoo = (() => {

  async function jsonrpc(baseUrl, service, method, args) {
    const url = baseUrl.replace(/\/+$/, "") + "/jsonrpc";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: Date.now(),
        params: { service, method, args }
      })
    });
    if (!res.ok) throw new Error(`Odoo returned HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) {
      const d = data.error.data || {};
      throw new Error(d.message || data.error.message || "Odoo rejected the call");
    }
    return data.result;
  }

  class OdooClient {
    constructor(cfg) {
      this.url = (cfg.url || "").replace(/\/+$/, "");
      this.db = cfg.db || "";
      this.username = cfg.username || "";
      this.apiKey = cfg.apiKey || "";
      this.uid = null;
    }

    get configured() {
      return !!(this.url && this.db && this.username && this.apiKey);
    }

    async authenticate() {
      if (!this.configured) throw new Error("Odoo is not fully configured");
      const uid = await jsonrpc(this.url, "common", "login",
        [this.db, this.username, this.apiKey]);
      if (!uid) throw new Error("Odoo rejected the credentials: check database, login and API key");
      this.uid = uid;
      return uid;
    }

    async call(model, method, args, kwargs) {
      if (!this.uid) await this.authenticate();
      return jsonrpc(this.url, "object", "execute_kw",
        [this.db, this.uid, this.apiKey, model, method, args || [], kwargs || {}]);
    }

    // Most recent tickets, newest first. The dialog fetches once and filters
    // locally, so typing in the search box never waits on the network.
    async recentTickets(limit = 50, model = "helpdesk.ticket") {
      const fields = ["id", "name", "user_id", "system_project_id", "stage_id", "ticket_ref"];
      const rows = await this.call(model, "search_read", [[]], {
        fields, limit, order: "create_date desc"
      });
      return rows.map((t) => ({
        id: t.id,
        name: t.name || "Untitled",
        ref: String(t.ticket_ref || t.id),
        agent: rel(t.user_id, "Unassigned"),
        system: rel(t.system_project_id, "No system"),
        stage: rel(t.stage_id, "Unknown")
      }));
    }

    // Add the recording link to the TOP of the ticket description, matching
    // what the desktop tool wrote so old and new entries read the same.
    async addRecordingLink(ticketId, videoUrl, filename, model = "helpdesk.ticket") {
      const read = await this.call(model, "read", [[ticketId]], { fields: ["description"] });
      if (!read || !read.length) throw new Error("Ticket not found");
      let desc = read[0].description || "";
      const link = `<a href='${esc(videoUrl)}' target='_blank'>${esc(filename)}</a><br/>\n`;
      const RULE = "=======================";

      let next;
      if (desc.includes("Video Recording") && desc.includes(RULE)) {
        if (desc.includes("Video Recording:") && !desc.includes("Video Recordings:")) {
          desc = desc.replace("Video Recording: <a", "Video Recordings:<br/>\n<a");
        }
        next = desc.replace(`${RULE}</p>`, `${link}${RULE}</p>`);
      } else {
        next = `<p>${RULE}<br/>\nVideo Recording: ${link}${RULE}</p>` + desc;
      }

      await this.call(model, "write", [[ticketId], { description: next }]);
      return true;
    }
  }

  function rel(v, fallback) {
    return Array.isArray(v) && v.length > 1 ? v[1] : fallback;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
  }

  return { OdooClient };
})();

if (typeof globalThis !== "undefined") globalThis.Odoo = Odoo;
