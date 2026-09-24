// whatsnew.js - Renders the packaged UPDATE.md. Deliberately a tiny Markdown
// subset built with DOM nodes (never innerHTML), so the file cannot inject markup.
const current = chrome.runtime.getManifest().version;
document.getElementById("installed").textContent = "Installed version: SORT " + current;
loadTheme();

function inline(parent, text) {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    let node;
    if (m[1] !== undefined) { node = document.createElement("strong"); node.textContent = m[1]; }
    else if (m[2] !== undefined) { node = document.createElement("code"); node.textContent = m[2]; }
    else { node = document.createElement("a"); node.textContent = m[3]; node.href = m[4];
      node.target = "_blank"; node.rel = "noopener noreferrer"; node.referrerPolicy = "no-referrer"; }
    parent.appendChild(node); last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function render(md) {
  const out = document.createDocumentFragment();
  let list = null, para = null, currentHeading = null;
  const close = () => { list = null; para = null; };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      close();
      const el = document.createElement("h" + h[1].length);
      inline(el, h[2]);
      if (h[1].length === 2) {
        el.id = "v" + h[2].trim().replace(/[^0-9.]/g, "");
        if (h[2].trim() === current) {
          el.classList.add("current"); currentHeading = el;
          const b = document.createElement("span"); b.className = "badge"; b.textContent = "Installed"; el.appendChild(b);
        }
      }
      out.appendChild(el); continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      para = null;
      if (!list) { list = document.createElement("ul"); out.appendChild(list); }
      const item = document.createElement("li"); inline(item, li[1]); list.appendChild(item); continue;
    }
    if (!line.trim()) { close(); continue; }
    list = null;
    if (!para) { para = document.createElement("p"); out.appendChild(para); }
    else para.appendChild(document.createTextNode(" "));
    inline(para, line.trim());
  }
  const notes = document.getElementById("notes");
  notes.textContent = ""; notes.appendChild(out);
  if (currentHeading && location.hash !== "#top") currentHeading.scrollIntoView({block: "start"});
}

fetch(chrome.runtime.getURL("UPDATE.md"))
  .then(r => { if (!r.ok) throw new Error(); return r.text(); })
  .then(render)
  .catch(() => { document.getElementById("notes").textContent = "Release notes are not available in this package."; });
