// Internal trust boundary: content scripts never receive credentials.
(() => {
  const root = (() => { try { return chrome.runtime.getURL(""); } catch (_) {
    return new URL(".", location.href).href;
  } })();
  function page(sender, names) {
    if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
    try {
      const u = new URL(sender.url);
      return names.some(n => u.href.split(/[?#]/)[0] === root + n);
    } catch (_) { return false; }
  }
  function worker(sender) {
    return !!sender && sender.id === chrome.runtime.id && !sender.tab &&
      (!sender.url || sender.url === root + "background.js");
  }
  function content(sender) {
    return !!sender && sender.id === chrome.runtime.id && !!sender.tab &&
      typeof sender.url === "string" && /^(https?|file):/.test(sender.url);
  }
  globalThis.SortSecurity = Object.freeze({page, worker, content});
})();
