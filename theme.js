// theme.js - Two themes, dark and light. No system-follow mode: the operator
// picks one and it stays picked, on every machine they log into.
//
// The document ships with data-theme="dark" in the markup, so the default
// never flashes while the stored config loads.
function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", normalized);
  return normalized;
}

function loadTheme() {
  // Saved configuration is authoritative. An unsaved popup preview/draft must
  // not change other windows; the legacy "theme" key can be stale.
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({type: "getConfig"}, config => {
        if (!chrome.runtime.lastError && config && config.success !== false) {
          resolve(applyTheme(config.theme));
          return;
        }
        resolve(applyTheme("dark"));
      });
    } catch (_) { resolve(applyTheme("dark")); }
  });
}

function saveTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  applyTheme(t);
  chrome.storage.local.set({ theme: t });
  return t;
}

if (typeof globalThis !== "undefined") {
  globalThis.applyTheme = applyTheme;
  globalThis.loadTheme = loadTheme;
  globalThis.saveTheme = saveTheme;
}
