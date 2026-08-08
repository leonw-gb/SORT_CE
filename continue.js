// continue.js - "The call ended, are you done?" prompt.
// Stop now hands off to the ticket dialog; Keep recording re-arms the alarm.
loadTheme();
const minutes = Number(new URLSearchParams(location.search).get("min") || "5");
document.getElementById("detail").textContent =
  `Stop now to pick a ticket and save the video, or keep recording and we will ask again in ${minutes} minutes.`;

document.getElementById("stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stopSession" }, () => window.close());
});
document.getElementById("cont").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "keepRecording" }, () => window.close());
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
