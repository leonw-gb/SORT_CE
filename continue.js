// continue.js - "The call ended, are you done?" prompt.
// Stop now hands off to the ticket dialog; Keep recording re-arms the alarm.
loadTheme();
const qs = new URLSearchParams(location.search);
const minutes = Number(qs.get("min") || "5");
// Two ways to get here, and they are different questions. After a hangup the
// operator is usually still writing up the call, so "keep recording" is the
// likely answer; on the timer it is a plain are-you-still-there.
const why = qs.get("why") === "call" ? "call" : "timer";

document.getElementById("head").textContent =
  why === "call" ? "The call ended" : "Still recording";
document.getElementById("detail").textContent =
  (why === "call"
    ? "The recording is still running. Stop now to pick a ticket and save the video, or keep recording while you finish up"
    : "Stop now to pick a ticket and save the video, or keep recording")
  + ` and we will ask again in ${minutes} minutes.`;

document.getElementById("stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stopSession" }, () => window.close());
});
document.getElementById("cont").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "keepRecording" }, () => window.close());
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
