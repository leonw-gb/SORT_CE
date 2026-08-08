// theme.js - Two themes, dark and light. No system-follow mode: the operator
// picks one and it stays picked, on every machine they log into.
//
// The document ships with data-theme="dark" in the markup, so the default
// never flashes while the stored config loads.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
}

function loadTheme() {
  return new Promise((resolve) => {
    chrome.storage.local.get("theme", (r) => {
      const t = r && r.theme === "light" ? "light" : "dark";
      applyTheme(t);
      resolve(t);
    });
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
