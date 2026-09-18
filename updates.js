// Store delivery remains automatic. This only controls SORT-initiated reloads.
(() => {
  const KEY = 'sortUpdate.v1', NOTICE = 'sort-update-ready';
  let busyReader = () => 'SORT is initializing.', jobs = 0, locked = false, checkJob = null;
  const local = chrome.storage.local;
  const version = () => chrome.runtime.getManifest().version;
  async function state() { return (await local.get(KEY))[KEY] || {}; }
  async function save(s) { await local.set({[KEY]: s}); }
  async function available(details) {
    if (!details || !/^\d+(\.\d+){0,3}$/.test(details.version) || details.version === version()) return;
    const s = await state(), isNew = s.pending !== details.version;
    await save({...s, pending: details.version, ...(isNew ? {later: false} : {})});
    if (isNew) {
      try { await chrome.notifications.create(NOTICE, {type: 'basic', iconUrl: 'icons/idle128.png',
        title: 'SORT update ready', message: 'Open SORT to restart now or choose Later. Active work will not be interrupted by the button.'}); } catch (_) {}
    }
  }
  async function busy() {
    let reason = busyReader();
    if (reason) return reason;
    if (jobs) return 'An export is being prepared.';
    const contexts = await chrome.runtime.getContexts({});
    if (contexts.some(c => /\/(capture|ticket|import|player|continue)\.html(?:[?#]|$)/.test(c.documentUrl || '')))
      return 'Close the capture, ticket, import, player or reminder window before restarting.';
    // This catches downloads that outlive the popup or the worker that initiated them.
    const downloads = await chrome.downloads.search({state: 'in_progress'});
    if (downloads.some(d => d.byExtensionId === chrome.runtime.id ||
      String(d.url || '').startsWith('blob:' + chrome.runtime.getURL('')))) return 'A SORT download is still running.';
    // Verify call state at the point of restart, not just the worker's cached flag.
    try {
      const status = await Promise.race([
        chrome.runtime.sendMessage({target: 'callpoll', type: 'status'}),
        new Promise(resolve => setTimeout(() => resolve(null), 2000))
      ]);
      if (status?.onCall) return 'A call is active.';
    } catch (_) {}
    return busyReader();
  }
  async function status() {
    try {
      const s = await state();
      return {success: true, current: version(), pending: s.pending || null,
        later: !!s.later, busy: locked ? 'SORT is restarting.' : await busy(), lastCheck: s.lastCheck || null};
    } catch (_) { return {success: false, error: 'Update status is unavailable. Try again.'}; }
  }
  async function check() {
    if (checkJob) return checkJob;
    checkJob = (async () => {
      try {
        const s = await state();
        if (Date.now() - (s.lastCheck || 0) < 5 * 60 * 1000)
          return {...await status(), checkResult: 'throttled'};
        await save({...s, lastCheck: Date.now()});
        const result = await chrome.runtime.requestUpdateCheck();
        if (result?.status === 'update_available') await available({version: result.version});
        return {...await status(), checkResult: result?.status || 'unavailable'};
      } catch (_) { return {success: false, error: 'Could not check. Store updates require a Store-managed installation.'}; }
    })();
    try { return await checkJob; } finally { checkJob = null; }
  }
  async function restart() {
    if (locked) return {success: false, error: 'A restart is already pending.'};
    // Lock synchronously: new recording/user operations cannot slip past the check.
    locked = true;
    let reloading = false;
    try {
      const s = await state();
      if (!s.pending) return {success: false, error: 'No downloaded update is pending.'};
      const reason = await busy();
      if (reason) return {success: false, error: reason};
      await chrome.notifications.clear(NOTICE);
      // Final synchronous check after the last await, allowing call events to cancel.
      const finalReason = busyReader();
      if (!locked) return {success: false, error: "New activity cancelled the restart."};
      if (finalReason || jobs) return {success: false, error: finalReason || 'An operation has started.'};
      chrome.runtime.reload();
      reloading = true;
      return {success: true};
    } catch (_) { return {success: false, error: 'SORT could not restart. Try again after finishing your work.'}; }
    finally { if (!reloading) locked = false; }
  }
  async function defer() {
    const s = await state(); await save({...s, later: true});
    await chrome.notifications.clear(NOTICE); return {success: true};
  }
  chrome.runtime.onUpdateAvailable.addListener(d => { void available(d).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => { void check(); });
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => { const s = await state();
      await save({...s, pending: null, later: false}); await chrome.notifications.clear(NOTICE);
    })().catch(() => {});
  });
  chrome.notifications.onClicked.addListener(id => {
    if (id !== NOTICE) return;
    // Clicking the notification only opens the UI, never restarts the extension.
    try { const opened = chrome.action.openPopup?.(); opened?.catch(() => {}); } catch (_) {}
  });
  globalThis.SortUpdates = Object.freeze({status, check, restart, defer,
    get locked() { return locked; }, cancelRestart() { locked = false; }, beginJob() { jobs++; }, endJob() { jobs = Math.max(0, jobs - 1); },
    setBusyReader(fn) { busyReader = fn; }});
})();
