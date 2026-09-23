// Store delivery remains automatic. This only controls SORT-initiated reloads.
(() => {
  const KEY = 'sortUpdate.v1', NOTICE = 'sort-update-ready';
  let busyReader = () => 'SORT is initializing.', jobs = 0, locked = false, checkJob = null;
  const local = chrome.storage.local;
  const version = () => chrome.runtime.getManifest().version;
  async function state() { return (await local.get(KEY))[KEY] || {}; }
  async function save(s) { await local.set({[KEY]: s}); }
  // Both real and simulated notifications use the same visual options.
  function noticeOptions(test = false, delayed = false) {
    return {type: 'basic', iconUrl: 'icons/idle128.png',
      title: test ? 'TEST - SORT update notification' : 'SORT update ready',
      message: test
        ? (delayed ? 'Delayed test after Chrome/worker resumed. ' : '') +
          'Notification test only. Click to open SORT. No update or restart will run.'
        : 'Open SORT to restart now or choose Later. Active work will not be interrupted by the button.'};
  }
  async function openUpdateControls(test = false) {
    try {
      if (typeof chrome.action.openPopup !== 'function') throw new Error('Popup API unavailable');
      await chrome.action.openPopup();
      return 'popup';
    } catch (_) {
      // Chrome 116-126 or no suitable browser window: user-clicked fallback.
      await chrome.windows.create({url: chrome.runtime.getURL('popup.html') +
        (test ? '?notificationTest=1' : ''), type: 'popup', width: 390, height: 620, focused: true});
      return 'window';
    }
  }
  async function available(details) {
    if (!details || !/^\d+(\.\d+){0,3}$/.test(details.version) || details.version === version()) return;
    const s = await state(), isNew = s.pending !== details.version;
    await save({...s, pending: details.version, ...(isNew ? {later: false} : {})});
    if (isNew) {
      try { await chrome.notifications.create(NOTICE, noticeOptions()); } catch (_) {}
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
    void openUpdateControls().catch(() => {});
  });

  // LOCAL TEST BUILD ONLY. Separate key, alarm and notification from real updates.
  // No simulated pending version and no path from this module to reload/check().
  const TEST_KEY = 'sortNotificationTest.v1';
  const TEST_ALARM = 'sort-notification-test';
  const TEST_NOTICE = 'sort-notification-test-notice';
  let testQueue = Promise.resolve();
  function testSerial(fn) {
    const job = testQueue.then(fn);
    testQueue = job.catch(() => {});
    return job;
  }
  const testState = async () => (await local.get(TEST_KEY))[TEST_KEY] || {};
  const saveTest = s => local.set({[TEST_KEY]: s});
  const testError = e => String(e?.message || e || 'Unknown error').slice(0, 300);
  async function permission() {
    try { return await chrome.notifications.getPermissionLevel(); }
    catch (_) { return 'unknown'; }
  }
  async function notificationTestStatus() {
    return testSerial(async () => {
      try { return {success: true, test: await testState(), permission: await permission()}; }
      catch (e) { return {success: false, error: testError(e)}; }
    });
  }
  async function scheduleNotificationTest() {
    return testSerial(async () => {
      try {
        await chrome.alarms.clear(TEST_ALARM);
        await chrome.notifications.clear(TEST_NOTICE);
        const scheduledAt = Date.now();
        const s = {phase: 'scheduled', indicator: true, scheduledAt, dueAt: scheduledAt + 10000};
        await saveTest(s);
        try { await chrome.alarms.create(TEST_ALARM, {when: s.dueAt}); }
        catch (e) {
          await saveTest({...s, phase: 'failed', error: 'Could not schedule alarm: ' + testError(e)});
          throw e;
        }
        return {success: true, test: s, permission: await permission()};
      } catch (e) { return {success: false, error: testError(e)}; }
    });
  }
  async function clearNotificationTest() {
    return testSerial(async () => {
      try {
        // Persist cancellation first; an already queued alarm must not deliver.
        await saveTest({phase: 'cleared', indicator: false, clearedAt: Date.now()});
        await chrome.alarms.clear(TEST_ALARM);
        await chrome.notifications.clear(TEST_NOTICE);
        return {success: true, test: await testState(), permission: await permission()};
      } catch (e) { return {success: false, error: testError(e)}; }
    });
  }
  async function runNotificationTest(reason) {
    const s = await testState();
    if (s.phase === 'sending') {
      // Do not replay an ambiguous send if the worker died after Chrome accepted it.
      await saveTest({...s, phase: 'interrupted', error:
        'Worker stopped during delivery. The notification may have appeared. Schedule a new test.'});
      return;
    }
    if (s.phase !== 'scheduled' || !Number.isFinite(s.dueAt)) return;
    if (Date.now() < s.dueAt) {
      await chrome.alarms.create(TEST_ALARM, {when: s.dueAt});
      return;
    }
    // A persisted due time survives lost alarms and a fully stopped browser.
    const delayed = reason !== 'alarm' || Date.now() > s.dueAt + 5000;
    const attempt = {...s, phase: 'sending', attemptedAt: Date.now(), delayed,
      permission: await permission()};
    await saveTest(attempt);
    await chrome.alarms.clear(TEST_ALARM);
    if (attempt.permission === 'denied') {
      await saveTest({...attempt, phase: 'blocked', error: 'Chrome reports notifications are disabled for SORT.'});
      return;
    }
    try {
      await chrome.notifications.create(TEST_NOTICE, noticeOptions(true, delayed));
    } catch (e) {
      await saveTest({...attempt, phase: 'failed', error: 'Notification request failed: ' + testError(e)});
      return;
    }
    // API success means accepted by Chrome, not proven visible on the desktop.
    await saveTest({...attempt, phase: 'requested', requestedAt: Date.now()});
  }
  function resumeNotificationTest(reason) {
    return testSerial(async () => {
      try { await runNotificationTest(reason); }
      catch (e) { console.warn('SORT notification test:', testError(e)); }
    });
  }
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === TEST_ALARM) void resumeNotificationTest('alarm');
  });
  chrome.runtime.onStartup.addListener(() => { void resumeNotificationTest('startup'); });
  chrome.notifications.onClicked.addListener(id => {
    if (id !== TEST_NOTICE) return;
    void testSerial(async () => {
      try {
        const s = await testState();
        if (!['requested', 'sending', 'interrupted'].includes(s.phase)) return;
        await saveTest({...s, clickedAt: Date.now()});
        try {
          const opened = await openUpdateControls(true);
          await saveTest({...await testState(), opened});
        } catch (e) {
          await saveTest({...await testState(), openError: testError(e)});
        }
      } catch (e) { console.warn('SORT notification test click:', testError(e)); }
    });
  });
  chrome.notifications.onClosed.addListener((id, byUser) => {
    if (id !== TEST_NOTICE) return;
    void testSerial(async () => {
      const s = await testState();
      if (['requested', 'interrupted'].includes(s.phase))
        await saveTest({...s, closedAt: Date.now(), closedByUser: byUser});
    }).catch(() => {});
  });
  // Also recover on worker wake: browser startup is not the only wake-up path.
  void resumeNotificationTest('worker-resumed');

  globalThis.SortUpdates = Object.freeze({status, check, restart, defer,
    notificationTestStatus, scheduleNotificationTest, clearNotificationTest,
    get locked() { return locked; }, cancelRestart() { locked = false; }, beginJob() { jobs++; }, endJob() { jobs = Math.max(0, jobs - 1); },
    setBusyReader(fn) { busyReader = fn; }});
})();
