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
    if (!res.ok) throw Object.assign(new Error(`Odoo returned HTTP ${res.status}`), {status: res.status});
    const data = await res.json();
    if (data.error) {
      const d = data.error.data || {};
      throw new Error(d.message || data.error.message || "Odoo rejected the call");
    }
    return data.result;
  }

  jsonrpc = SortDiagnostics.trace("odoo.rpc", jsonrpc);

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

    ticketRow(t) {
      return {
        id: t.id, ref: String(t.ticket_ref || "").trim(), name: t.name || "Untitled",
        agent: rel(t.user_id, "Unassigned"), system: rel(t.system_project_id, "No system"),
        stage: rel(t.stage_id, "Unknown"), part: rel(t.affected_part_id, ""),
        detail: t.detailed_affected_part || "", incident: t.incident_time || "",
        created: t.create_date || ""
      };
    }

    async recentTickets(limit = 50, model = "helpdesk.ticket", query = "") {
      const fields = ["id", "name", "user_id", "system_project_id", "stage_id", "ticket_ref", "create_date"];
      const domain = query ? ["|", ["ticket_ref", "ilike", query], ["name", "ilike", query]] : [];
      const rows = await this.call(model, "search_read", [domain], {
        fields, limit, order: "create_date desc, id desc", context: {active_test: false}
      });
      return rows.map(t => this.ticketRow(t)).filter(t => t.ref);
    }

    // Read the complete time window, including closed/archived tickets. IDs
    // are pagination/API keys only, never user-facing references or features.
    async matchingTickets(start, end, model = "helpdesk.ticket") {
      const meta = await this.call(model, "fields_get", [], {attributes: ["type"]});
      const requested = ["id", "ticket_ref", "name", "user_id", "system_project_id", "stage_id",
        "affected_part_id", "detailed_affected_part", "incident_time", "create_date"];
      for (const key of ["id", "ticket_ref", "create_date"]) {
        if (!meta[key]) throw new Error(`Required ticket field unavailable: ${key}. Use Newest first.`);
      }
      const fields = requested.filter(k => meta[k]);
      const utc = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
      const domain = [["create_date", ">=", utc(start)], ["create_date", "<=", utc(end)]];
      const result = []; let last = 0;
      for (;;) {
        const page = await this.call(model, "search_read", [[...domain, ["id", ">", last]]], {
          fields, limit: 100, order: "id asc", context: {active_test: false}
        });
        if (!Array.isArray(page)) throw new Error("Invalid Odoo ticket response.");
        if (!page.length) break;
        const next = Math.max(...page.map(t => Number(t.id)));
        if (!Number.isSafeInteger(next) || next <= last) throw new Error("Ticket pagination did not advance.");
        result.push(...page.map(t => this.ticketRow(t)).filter(t => t.ref));
        last = next;
      }
      return {tickets: result, missing: requested.filter(k => !meta[k])};
    }

    // Add the recording link to the TOP of the ticket description, matching
    // what the desktop tool wrote so old and new entries read the same.
    // The link points at a hosted SESSION (timeline + video) since 2.25.1, not
    // a bare video file. The heading in the ticket says "Session Recording"
    // for new entries; existing tickets keep whatever heading they already
    // have, because rewriting old ticket descriptions to match is not worth
    // touching every record for.
    async addRecordingLink(ticketId, videoUrl, filename, model = "helpdesk.ticket") {
      const read = await this.call(model, "read", [[ticketId]], { fields: ["description"] });
      if (!read || !read.length) throw new Error("Ticket not found");
      let desc = read[0].description || "";
      const link = `<a href='${esc(videoUrl)}' target='_blank'>${esc(filename)}</a><br/>\n`;
      const RULE = "=======================";

      let next;
      if ((desc.includes("Video Recording") || desc.includes("Session Recording")) && desc.includes(RULE)) {
        if (desc.includes("Video Recording:") && !desc.includes("Video Recordings:")) {
          desc = desc.replace("Video Recording: <a", "Video Recordings:<br/>\n<a");
        }
        if (desc.includes("Session Recording:") && !desc.includes("Session Recordings:")) {
          desc = desc.replace("Session Recording: <a", "Session Recordings:<br/>\n<a");
        }
        next = desc.replace(`${RULE}</p>`, `${link}${RULE}</p>`);
      } else {
        next = `<p>${RULE}<br/>\nSession Recording: ${link}${RULE}</p>` + desc;
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

  OdooClient.prototype.authenticate = SortDiagnostics.trace("odoo.auth", OdooClient.prototype.authenticate);
  OdooClient.prototype.recentTickets = SortDiagnostics.trace("odoo.tickets", OdooClient.prototype.recentTickets);
  OdooClient.prototype.addRecordingLink = SortDiagnostics.trace("odoo.link", OdooClient.prototype.addRecordingLink);

  function ticketUrl(ticket) {
    const id = ticket?.odooId;
    if (!Number.isSafeInteger(id) || id <= 0 || !String(ticket?.ref || "").trim()) return "";
    return `https://odoo.goodbytz.com/web#id=${id}&cids=1&menu_id=486&action=754&active_id=3&model=helpdesk.ticket&view_type=form`;
  }
  return { OdooClient, ticketUrl };
})();

if (typeof globalThis !== "undefined") globalThis.Odoo = Odoo;
