// Local-only diagnostics. The worker is the sole persistent writer.
// This file is safe to inject repeatedly; never listen to MAIN-world messages.
(() => {
  'use strict';
  if (globalThis.SortDiagnostics) return;
  const P = globalThis.SortDiagnosticsPolicy;
  const B = globalThis.SORT_BUILD_INFO;
  const worker = typeof document === 'undefined';
  const extensionPage = !worker && location.protocol === 'chrome-extension:';
  const page = extensionPage ? location.pathname.split('/').pop().replace(/\.html$/, '') : 'content';
  const source = worker ? 'background' : page;
  const KEY = 'sortDiagnostics.v1';
  const ALARM = 'sortDiagnosticsPrune';
  let queue = Promise.resolve(), pending = 0, writeFailures = 0, dropped = 0;
  let currentBuild = null, buildPromise;
  let healthReader = () => ({});
  const recent = new Map();
  let rateStart = Date.now(), rateCount = 0;
  let lastLocalKey = '', lastLocalTime = 0;
  const timeout = (promise, ms = 8000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Diagnostics timeout')), ms);
    Promise.resolve(promise).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
  const hex = buffer => Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, '0')).join('');
  const hash = async value => hex(await crypto.subtle.digest('SHA-256', value));
  async function fingerprint() {
    const entries = [];
    // Sequential reads bound memory. No file content is persisted or exported.
    for (const file of B.inventory) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2000);
        let bytes;
        try {
          const r = await fetch(chrome.runtime.getURL(file), {cache: 'no-store', signal: ctl.signal});
          if (!r.ok) throw new Error('Unavailable file');
          bytes = await r.arrayBuffer();
        } finally { clearTimeout(timer); }
        entries.push({file, sha256: await hash(bytes), bytes: bytes.byteLength});
      } catch (_) { entries.push({file, unavailable: true}); }
    }
    const installedFingerprint = await hash(new TextEncoder().encode(JSON.stringify(entries)));
    return {version: chrome.runtime.getManifest().version, packageBuild: B.packageBuild,
      installedFingerprint, fingerprintAlgorithm: 'SHA-256 of UTF-8 JSON file inventory, in listed order',
      capturedAt: new Date().toISOString(), files: entries,
      complete: entries.every(x => !x.unavailable),
      scope: 'Listed packaged code, styles, manifest, build metadata and deployment defaults. Not a Git commit; unlisted/unreferenced local files are outside this fingerprint.'};
  }
  function getBuild() {
    if (!buildPromise) buildPromise = fingerprint().then(b => (currentBuild = b));
    return buildPromise;
  }
  function enqueue(fn) {
    if (pending >= 200) { dropped++; return Promise.resolve(false); }
    pending++;
    const task = queue.then(fn).catch(() => { writeFailures++; return false; });
    queue = task.then(() => { pending--; });
    return task;
  }
  async function loadState() {
    const data = await timeout(chrome.storage.local.get(KEY));
    const s = data[KEY];
    // Do not export arbitrary data even if another module overwrote this key.
    const state = {schema: 1, events: []};
    if (s && s.schema === 1 && Array.isArray(s.events)) {
      for (const row of s.events.slice(-P.MAX_EVENTS)) {
        const clean = P.clean(row);
        if (!clean || !Number.isFinite(row.timestamp) || !/^[a-f0-9]{64}$/.test(row.workerFingerprint || '')) continue;
        state.events.push({...clean, timestamp: row.timestamp, workerFingerprint: row.workerFingerprint});
      }
    }
    return P.prune(state);
  }
  async function saveState(state) {
    P.prune(state);
    try { await timeout(chrome.storage.local.set({[KEY]: state})); }
    catch (_) {
      // Give recording data priority when the shared storage quota is tight.
      writeFailures++;
      state.events = state.events.slice(-Math.min(100, Math.ceil(state.events.length / 2)));
      await timeout(chrome.storage.local.set({[KEY]: state}));
    }
  }
  function receive(input) {
    const clean = P.clean(input);
    if (!clean) return Promise.resolve(false);
    const now = Date.now();
    if (now - rateStart >= 60000) { rateStart = now; rateCount = 0; recent.clear(); }
    const key = JSON.stringify(clean);
    if (recent.has(key) && now - recent.get(key) < 10000) { dropped++; return Promise.resolve(true); }
    if (++rateCount > 180) { dropped++; return Promise.resolve(false); }
    recent.set(key, now);
    return enqueue(async () => {
      const build = await getBuild();
      const state = await loadState();
      state.events.push({...clean, timestamp: now, workerFingerprint: build.installedFingerprint});
      await saveState(state);
      return true;
    });
  }
  function emit(operation, outcome = 'ok', input = {}) {
    try {
      const clean = P.clean({source, operation, outcome, details: P.details(input), emitter: B});
      if (!clean) return Promise.resolve(false);
      if (worker) return receive(clean);
      const key = JSON.stringify(clean), now = Date.now();
      if (key === lastLocalKey && now - lastLocalTime < 10000) return Promise.resolve(true);
      lastLocalKey = key; lastLocalTime = now;
      return timeout(chrome.runtime.sendMessage({target: 'diagnostics', type: 'append', event: clean}), 4000)
        .then(r => !!(r && r.success)).catch(() => false);
    } catch (_) { return Promise.resolve(false); }
  }
  function error(operation, e, extra = {}) { return emit(operation, 'failed', {...P.errorDetails(e), ...P.details(extra)}); }
  function trace(operation, fn) {
    return async function (...args) {
      const start = Date.now();
      void emit(operation, 'started');
      try {
        const result = await fn.apply(this, args);
        void emit(operation, result && result.success === false ? 'failed' : 'ok', {durationMs: Date.now() - start});
        return result;
      } catch (e) {
        void error(operation, e, {durationMs: Date.now() - start});
        throw e;
      }
    };
  }
  function safeSite(filename, line, column) {
    try {
      const url = new URL(filename);
      const own = new URL(chrome.runtime.getURL(''));
      if (url.protocol !== own.protocol || url.host !== own.host) return null;
      const file = url.pathname.slice(1);
      if (!B.inventory.includes(file)) return null;
      return P.details({file, line, column});
    } catch (_) { return null; }
  }
  globalThis.SortDiagnostics = Object.freeze({emit, error, trace,
    setHealthReader(fn) { if (worker && typeof fn === 'function') healthReader = fn; }
  });
  globalThis.addEventListener('error', event => {
    const site = safeSite(event.filename, event.lineno, event.colno);
    // A content-script listener must not collect the visited website's errors.
    if (!worker && !extensionPage && !site) return;
    void error('runtime', event.error, site || {});
  });
  globalThis.addEventListener('unhandledrejection', event => {
    // Content-world promises can be ambiguous; explicit content instrumentation
    // covers them instead. Never read or persist a raw rejection/stack.
    if (!worker && !extensionPage) return;
    void error('runtime', event.reason);
  });
  if (!worker) {
    if (extensionPage) void emit('runtime', 'ready');
    return;
  }

  async function environment() {
    let platform = {};
    try { platform = await chrome.runtime.getPlatformInfo(); } catch (_) {}
    const os = ['mac','win','android','cros','linux','openbsd','fuchsia'].includes(platform.os) ? platform.os : 'unknown';
    const arch = ['arm','arm64','x86-32','x86-64','mips','mips64'].includes(platform.arch) ? platform.arch : 'unknown';
    const match = String(navigator.userAgent).match(/(?:Chrome|Chromium)\/([0-9.]+)/);
    return {os, arch, chromiumVersion: match ? match[1] : 'unknown'};
  }
  async function makeReport() {
    await getBuild();
    const installedAtExport = await fingerprint();
    return enqueue(async () => {
      let state = {schema: 1, events: []}, storageAvailable = true;
      try { state = await loadState(); await saveState(state); } catch (_) { writeFailures++; storageAvailable = false; }
      let health = {};
      try { health = P.details(await timeout(healthReader(), 3000)); } catch (_) {}
      return {format: 'SORT support diagnostics', schemaVersion: 1, exportedAt: new Date().toISOString(),
        release: {version: B.version, packageBuild: B.packageBuild},
        workerBuild: currentBuild, installedAtExport,
        filesChangedSinceWorkerStart: currentBuild.installedFingerprint !== installedAtExport.installedFingerprint,
        environment: await environment(),
        health: {...health, storageAvailable, diagnosticWriteFailuresSinceWorkerStart: writeFailures,
          suppressedOrDroppedSinceWorkerStart: dropped, retainedEvents: state.events.length, retainedJsonBytes: P.size(state)},
        retention: {maxAgeDays: 7, maxSerializedBytes: P.MAX_BYTES, maxEvents: P.MAX_EVENTS,
          note: 'Oldest entries removed first; physical storage overhead is additional. Expiry checked on writes, export, worker start and an hourly alarm while Chrome runs.'},
        privacy: 'No session contents, video, DOM, URLs, names, ticket IDs, credentials, request headers, response bodies, raw error messages or stacks. Source files are hashed, never included. Export is local; sharing is manual.',
        limitations: ['Abrupt browser/process termination can lose in-flight entries.',
          'A worker that cannot start cannot collect logs; crashes and silent failures are not all observable.',
          'Content delivery may fail on restricted pages or after an extension reload.',
          'Emitter packageBuild identifies the shipped release. workerFingerprint identifies the installed inventory at worker startup; files edited without a reload may differ from code already running.',
          'Build metadata for older retained events is limited to their release and fingerprint identifiers.',
          'A started event without a matching outcome can indicate interruption or an early return; repeated events are rate-limited.',
          'Unlisted local files are outside the fingerprint. No existing recording data or historical callTrail/pollLog is exported.'],
        events: state.events};
    });
  }
  let exportJob = null;
  async function doExport() {
    await emit('support.export', 'started');
    try {
      const report = await makeReport();
      if (!report || typeof report !== 'object') throw new Error('Diagnostics queue unavailable');
      // Health reader is supplied by background.js, as is offscreen creation.
      await ensureOffscreen();
      const response = await timeout(chrome.runtime.sendMessage({target: 'offscreen', type: 'supportBlob', report}), 15000);
      if (!response || !response.success) throw new Error('Support blob unavailable');
      const stamp = report.exportedAt.replace(/[:.]/g, '-');
      try {
        const id = await chrome.downloads.download({url: response.url,
          filename: `SORT-support-${B.version}-${report.installedAtExport.installedFingerprint.slice(0, 12)}-${stamp}.json`,
          saveAs: false, conflictAction: 'uniquify'});
        await chrome.storage.session.set({['sortSupportDownload.' + id]: response.url});
        // Also check for completion that beat listener registration/state storage.
        const found = await chrome.downloads.search({id});
        if (found[0] && ['complete','interrupted'].includes(found[0].state)) await finishDownload(id, found[0].state);
        void emit('support.export', 'ok');
        return {success: true};
      } catch (e) {
        void chrome.runtime.sendMessage({target: 'offscreen', type: 'revokeUrl', url: response.url}).catch(() => {});
        throw e;
      }
    } catch (e) {
      void error('support.export', e);
      return {success: false, error: 'Support export failed. Retry, or check the extension errors in chrome://extensions.'};
    }
  }
  async function finishDownload(id, state) {
    try {
      const key = 'sortSupportDownload.' + id;
      const data = await chrome.storage.session.get(key);
      if (!data[key]) return;
      await chrome.runtime.sendMessage({target: 'offscreen', type: 'revokeUrl', url: data[key]}).catch(() => {});
      await chrome.storage.session.remove(key);
      void emit('support.download', state === 'complete' ? 'ok' : 'failed');
    } catch (_) {}
  }
  chrome.downloads.onChanged.addListener(delta => {
    if (delta.state && ['complete','interrupted'].includes(delta.state.current)) void finishDownload(delta.id, delta.state.current);
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'diagnostics') return false;
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === 'append') {
      const clean = P.clean(message.event);
      // Sender URL is used for validation only and is never retained.
      let expected = 'content';
      if (sender.url && sender.url.startsWith(chrome.runtime.getURL(''))) {
        expected = sender.url.slice(chrome.runtime.getURL('').length).split(/[?#]/)[0].replace(/\.html$/, '');
      }
      if (!clean || clean.source !== expected) { sendResponse({success: false}); return false; }
      receive(clean).then(success => sendResponse({success}));
      return true;
    }
    if (message.type === 'export' && sender.url === chrome.runtime.getURL('popup.html')) {
      if (!exportJob) exportJob = doExport().finally(() => { exportJob = null; });
      exportJob.then(sendResponse);
      return true;
    }
    return false;
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) void enqueue(async () => saveState(await loadState()));
  });
  chrome.alarms.create(ALARM, {periodInMinutes: 60});
  void emit('runtime', 'ready');
})();
