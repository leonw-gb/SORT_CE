// Strict diagnostics schema. No free-text error messages, URLs or payloads.
(() => {
  'use strict';
  const MAX_BYTES = 5 * 1024 * 1024, MAX_EVENTS = 5000;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const operations = new Set([
    'runtime','session.start','session.stop','session.save','session.delete','config.save',
    'capture.start','capture.stop','capture.choose','capture.encode','capture.save',
    'tab.initialize','poll.probe','poll.connection','poll.configure','poll.stop','poll.repair','poll.trigger',
    'offscreen.ensure','bundle.build','bundle.download','import.parse','import.save',
    'ticket.load','ticket.action','upload.request','upload.bundle','upload.fallback',
    'odoo.rpc','odoo.auth','odoo.tickets','odoo.link','player.load','player.video',
    'content.initialize','content.teardown','content.send','support.export','support.download'
  ]);
  const outcomes = new Set(['started','ok','failed','recovered','unavailable','cancelled','ready','changed']);
  const errors = new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError',
    'AbortError','TimeoutError','NotAllowedError','NotFoundError','NotReadableError',
    'SecurityError','InvalidStateError','QuotaExceededError','UnknownError','DataError',
    'TransactionInactiveError','ConstraintError','VersionError','NetworkError','EncodingError']);
  const sources = new Set(['background','popup','offscreen','capture','ticket','import','continue','player','content']);
  const numeric = new Set(['status','durationMs','bytes','count','failures','line','column','intervalMs']);
  const boolean = new Set(['recording','captured','saved','configured','polling','video','network']);
  function details(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [key, value] of Object.entries(input)) {
      if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0)
        out[key] = Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
      else if (boolean.has(key) && typeof value === 'boolean') out[key] = value;
      else if (key === 'errorName' && errors.has(value)) out.errorName = value;
      else if (key === 'file' && /^(?:background|popup|offscreen|capture|ticket|import|continue|player|content|callpoll|callmatch|upload|odoo|sortz|defaults|theme|diagnostics|diagnostics-core|build-info|ws-hook)\.js$/.test(value)) out.file = value;
    }
    return out;
  }
  function identity(x) {
    return x && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(x.version) && /^[a-f0-9]{64}$/.test(x.packageBuild)
      ? {version: x.version, packageBuild: x.packageBuild} : null;
  }
  function clean(input) {
    if (!input || !operations.has(input.operation) || !outcomes.has(input.outcome) || !sources.has(input.source)) return null;
    const emitter = identity(input.emitter);
    if (!emitter) return null;
    return {source: input.source, operation: input.operation, outcome: input.outcome,
      level: input.outcome === 'failed' ? 'error' : input.outcome === 'unavailable' ? 'warn' : 'info',
      emitter, details: details(input.details)};
  }
  function size(x) { return new TextEncoder().encode(JSON.stringify(x)).length; }
  function prune(state, now = Date.now()) {
    state.events = state.events.filter(e => Number.isFinite(e.timestamp) && e.timestamp >= now - MAX_AGE_MS && e.timestamp <= now);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    while (size(state) > MAX_BYTES && state.events.length) state.events.splice(0, Math.max(1, Math.ceil(state.events.length / 10)));
    return state;
  }
  function errorDetails(error) {
    // Never copy message, stack, cause, arguments, response, or arbitrary names.
    try { return details({errorName: error && error.name, status: error && error.status, network: error && error.network}); }
    catch (_) { return {}; }
  }
  globalThis.SortDiagnosticsPolicy = Object.freeze({MAX_BYTES, MAX_EVENTS, MAX_AGE_MS, details, identity, clean, size, prune, errorDetails});
})();
