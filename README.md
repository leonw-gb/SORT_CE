# SORT — Session Observer Recorder Tracker (Chrome Extension)

Records expert problem-solving across multiple tabs on ONE correlated timeline:
clicks (with resolved labels, incl. Flutter semantics), inputs, tab switches,
navigation/SPA routes, network calls, WebSocket action frames (NiceGUI ground
truth), and SOP step tags.

VISUAL capture is intentionally NOT part of this build - use any external
screen recorder alongside it. This keeps recordings small and 100% reliable
(no DOM-replay edge cases). The player page still shows the full correlated
timeline; the visual replay pane shows a notice instead.


Goals: (1) verify experts follow the correct SOP, (2) build a labeled action dataset
to later train an AI to solve the issues itself.

## Files
  manifest.json        MV3 manifest
  background.js        Service worker: shared session, storage, export
  content.js           Per-page capture + rrweb + floating SOP tagger
  tagger.css           Styling for the floating SOP tagger
  popup.html/.js       Settings, live session controls, recordings list
  player.html/.js      Visual replay + correlated SOP timeline viewer
  sortz.js             .sortz session bundle: read and write (no DOM, reusable)
  offscreen.html/.js   Builds bundles off the worker (blob URLs + survives idle)
  import.html/.js      Import window: preview a bundle, then store it
  SESSION-FORMAT.md    Bundle schema + the upload-server contract
  lib/                 rrweb + rrweb-player (PLACEHOLDERS - see below)

## Enable rrweb DOM replay (one-time, needs internet on your machine)
This was built offline, so lib/ contains placeholders. To enable pixel-perfect replay:
  1. rrweb.min.js
       https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js  -> lib/rrweb.min.js
  2. rrweb-player.min.js
       https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/index.js -> lib/rrweb-player.min.js
  3. rrweb-player.css
       https://cdn.jsdelivr.net/npm/rrweb-player@1.0.0-alpha.4/dist/style.css -> lib/rrweb-player.css
Overwrite the placeholder files with the same names. If you skip this, everything still
works EXCEPT the visual DOM replay - the correlated SOP timeline and JSON export are unaffected.

## Install
  1. Unzip. Open chrome://extensions -> enable Developer mode -> Load unpacked -> select folder.
  2. Click the icon -> Settings:
       - Add URL patterns (regex or plain text), one per line.
       - Optionally edit the SOP Steps shown in the tagger.
       - Save Configuration.

## How it works
- Open any tab whose URL matches a pattern -> it auto-joins ONE shared session.
- A floating SOP tagger appears bottom-right. The expert clicks the current step as
  they work; every event after that is labeled with the active step. They can add notes.
- All tabs share one clock: each event has tabId + relativeTime from session start.
- In the popup, a red bar shows the live session (tab count, event count) with
  "Stop & Save Session". Stopping writes the session to IndexedDB.

## Review, replay & export
- Recordings tab lists saved sessions.
    Replay      -> opens the viewer: rrweb DOM playback + clickable SOP timeline,
                   filter by tab, click any event to jump the replay to that moment.
    Export JSON -> downloads the full session for your training pipeline.
    Delete      -> removes from IndexedDB.

## Data format (one JSON object per session)
  id, startTime, endTime, sopSteps[]
  tabs: { tabId: { url, title } }
  events[]: each with tabId, timestamp, relativeTime, and sopStep (active step label).
    Types: interaction (click/input/change/submit + xpath + element identity),
    rrweb (DOM snapshot stream), sopStep, sopNote, scroll, tabEntered, tabSwitch,
    tabClosed, visibilityChange, historyChange, networkRequest, snapshot.

## Privacy / PII
- All form input/change/submit VALUES are masked by default (length-preserving). Passwords never captured.
- rrweb records with maskAllInputs=true.
- To capture a field in cleartext: add its id/name to SAFE_FIELD_ALLOWLIST in content.js,
  or add the attribute data-record-safe to the element.
- Add class "record-block" to any element that must never be recorded/replayed.

## Limits
- Cannot record chrome:// pages, the Web Store, or other extensions' pages.
- Cross-origin iframes not captured (all_frames off).
- rrweb alpha pins above are examples; any recent matching rrweb / rrweb-player pair works.

## v1.14.0 - Camera <video> feed replay
Camera pages render the live stream into an HTML <video> fed by a blob:/MSE/WebRTC
source. rrweb records the tag but not its pixels, and the blob URL dies with the
session, so the feed replayed BLACK. Fixes:
  * content.js samples each playable <video> at ~5 fps (webp q=0.5), downscaled to
    <=640px wide, and emits it as "videoFrame" custom events (dedup on unchanged
    frames). Detection pierces shadow roots and waits for the stream to attach.
  * player.js positions an overlay <canvas> exactly over the replayed <video> and
    paints the frame matching the playhead (play, pause, seek, scrub).
  * WebSocket recording is now SUPPRESSED only on video-feed pages (the media
    frames are binary/truncated and can't be reconstructed - they caused the
    17MB/2562-event sessions). All other pages keep full WS action capture.

## v1.16.0 - SPA replay empty after login->feed route change
The camera portal is a single-page app (login -> dashboard -> camera feed are
in-place route changes on ONE document). rrweb records ONE full DOM snapshot at
Start plus incremental mutations; when you start on the login page, only the
login DOM is snapshotted, and the router later rebuilds the whole view (incl.
<head>/stylesheets). Rebuilding the later route from the login snapshot alone is
unreliable, so its REPLAY came up empty (starting recording already on the feed
worked because it got its own snapshot). Fixes:
  * Force a fresh rrweb full snapshot (checkout) shortly after every route
    change, so each route has a complete, self-contained checkpoint to replay
    from. Detected via pushState/replaceState/popstate/hashchange plus a URL
    poll safety net (some routers don't call a history API we can wrap).
  * Video + Flutter detectors remain persistent and are re-armed per route; WS
    media-frame suppression toggles dynamically when a live <video> is present.
  * MAIN-world hooks (ws-hook.js) wrapped in extra try-guards so instrumentation
    can never throw into the host app (defensive; the live app was never the
    problem here).

## v1.17.0 - Live camera feed replay: "split second then black"
The live feed replayed for a moment then went black, while the History scrubber
(which re-renders on each drag) always showed frames. Root cause: the live player
SWAPS the <video> element as the stream connects, so the rrweb node id in early
videoFrame events goes stale, and the overlay stayed bound to the old/detached
element. The route-change checkout snapshot also rebuilt the iframe DOM, wiping
the overlay. Fixes (player.js):
  * Video painter is now element-agnostic: resolves the largest ATTACHED/visible
    <video> in the replay each paint (not a fixed id), and keys its overlay by
    the live node so element swaps re-target automatically.
  * A lightweight requestAnimationFrame driver keeps the overlay painting the
    current-playhead frame, so continuous playback and post-rebuild states can no
    longer leave it black. paint() dedups so idle cost stays low.
  * On fullsnapshot-rebuilded (route checkout) the overlay is re-created and
    repainted for the current time.

## v1.18.0 - Live feed route replayed all-white (settled snapshot)
The live feed is the DEFAULT route right after login, so the route-change
checkout snapshot (v1.16) was firing on a blind 600ms timer WHILE the SPA was
still tearing down the login view - capturing a transient empty DOM. That empty
snapshot became the replay checkpoint for the feed route -> all white, no
interface. History worked because it's opened by a deliberate click later, when
the DOM is stable. Fix (content.js):
  * Replaced the fixed-delay checkout with a "settled" snapshot: it waits until
    the body has real content whose size stopped changing for two consecutive
    checks (the new view finished mounting), with a hard cap so a continuously
    -mutating view still gets a checkpoint.
  * On a video-feed route it additionally waits for a playable <video> before
    snapshotting, so the checkpoint captures the mounted feed, not a placeholder.

## v1.19.0 - Remove per-route checkout; single settled base snapshot
Evidence: a session STARTED with the feed already loaded replays every route
(login -> history -> back to live) perfectly from incremental mutations alone.
So incremental replay is reliable for this app; the per-route checkout snapshot
added in v1.16-v1.18 was itself CAUSING the live-feed route to replay white
(mid-stream checkout FullSnapshots are a known rrweb cause of blank replay -
events after the checkpoint fail to apply). Changes (content.js):
  * Removed the route-change checkout snapshot entirely. Camera pixels come from
    the videoFrame overlay, not the DOM snapshot, so no checkpoint is needed for
    the feed to be visible.
  * Added ONE non-checkout full snapshot, taken only when the app auto-navigated
    after recording started (login -> feed) AND once the first app view has
    settled (non-empty, stable body). This gives login-start sessions the same
    good base an already-loaded session has, without per-route churn. Sessions
    that start already on the app view skip it (their initial snapshot is good).

## v1.20.0 - Live feed area white on first view (until navigate away+back)
After v1.19 the interface reconstructs correctly, but the LIVE feed content area
stayed white on first view and only appeared after navigating to History and
back. Two causes, both fixed:
  * Recorder: the one-time base snapshot fired once the body was merely "stable",
    but the UniFi Protect live player mounts its <video> asynchronously AFTER
    that - so the snapshot captured an empty feed shell. It now also waits for a
    playable <video> on video-feed routes before snapshotting.
  * Player: the replayed <video> often has a 0x0 layout box on first render (the
    app sizes it via JS that doesn't run offline), so the overlay was placed at
    0x0 and was invisible. The overlay now sizes/positions to the video's
    nearest sized ancestor (the player holder), falling back to the replay
    viewport, and prefers the exact captured element by mirror id.



## Sharing sessions (v2.23.0)

A session can be handed to someone else as a **`.sortz` bundle**: a ZIP holding
the manifest, the event timeline and the video, complete enough to open on a
machine that never saw the recording.

**Export** — the Export button on any of your own recordings. The bundle is
built in an offscreen document, not in the popup, because Chrome closes a popup
the moment focus moves and a few hundred megabytes takes longer than that.
Clicking away no longer kills the export.

**Import** — *Import a session…* above the recordings list. The bundle is shown
first (who recorded it, when, how long, how big) and only stored once you
confirm, because an import costs the same disk as a recording.

An imported session gets a **fresh local id**; recording ids are minted per
machine, so without a remap an import can collide with one of your own and
silently overwrite it. The original travels on as `sourceId`, which is also how
a repeat import is recognised. Imported sessions are marked in the list with the
recorder's name and cannot be re-exported or assigned to a ticket — they are
someone else's record.

The video is embedded in the bundle rather than linked. Uploaded videos are
deleted from the upload server after the retention period, and a bundle that
carried only a link would decay into a timeline with a dead player. **The bundle
is the durable copy of a session.**

Long term the upload server hosts sessions itself and the ticket gets a session
link instead of a video link. `SESSION-FORMAT.md` has the schema and the
endpoint contract; `upload.js` already prefers a `session_url` when the server
returns one, so that switch needs no extension release.

## The Sipgate name is required (v2.23.0)

Recording will not start without it. The check sits in `startSession`, so it
covers the popup button, the keyboard shortcut and the call trigger alike —
putting it in the popup would leave the shortcut free to produce anonymous
sessions. Refusal happens *before* the screen picker opens, so nobody chooses a
window for a recording that is about to be turned down. Started by shortcut, the
refusal arrives as a Chrome notification, since there is no popup to show it in.

The name is stamped onto the session when recording starts, so a bundle says who
made it, not who sent it on. Sessions recorded before 2.23.0 have no name and
show as "Unknown".

## v2.23.1 - Imported sessions had no video

Two bugs from the 2.23.0 sharing work.

**No video on an imported session.** The source-agnostic loader wired
`getVideo` to `loadVideo` -- the render function that calls it -- instead of
`loadVideoBlob`, the one that reads the store. The recursion threw, the catch
turned it into "no video", and the player reported a capture failure for a file
that was sitting in IndexedDB the whole time. Hence a bundle whose .webm played
perfectly when unzipped by hand.

Three things were hardened at the same time, because that one message was
covering for all of them:

- Imported sessions no longer trust `video.captured` from the bundle. That flag
  describes the machine that recorded it; what matters locally is whether a blob
  actually arrived, so the store is checked directly.
- The video blob is materialised before it is written. `SORTZ.parse` slices the
  video out of the zip, so the blob is a view over the File the operator picked
  -- and that File goes away when the import window closes.
- The write is read straight back and the size compared. A silent storage
  failure now fails the import instead of producing a session with a dead
  player.

**Ticket showed as 9741_002.** The `_NNN` counts repeat recordings of a ticket
and belongs to the video filename, not the ticket. Pasted into Odoo it finds
nothing. The import preview now shows `9741 (recording 2)` and the recordings
list shows `9741 · #2`, with the suffix omitted entirely for a first recording.

## v2.23.2 - Import wording and flow

- The import preview's **Ticket** row is now **Session**, and shows the full
  session identifier again (`9741_002`). It is the same string as the video
  filename and the ticket link, so it is a thing you can search for; the earlier
  split into "9741 (recording 2)" made it unmatchable.
- The recordings list shows the same identifier after the recorder's name.
- **Importing no longer opens the timeline.** The session lands in the list and
  the operator opens it if they want to. Importing several bundles in a row no
  longer opens several tabs.

## Toolbar icon states

Green dot = installed and ready. Red dot = recording. The service worker swaps
`chrome.action.setIcon` on start and stop and restores the idle icon when it
wakes, so a worker restart cannot strand the toolbar on the red dot.

The files in `icons/` are placeholders. See `icons/README.md` for what to drop
in and how to resize the existing artwork.

## The "SORT is sharing your screen" bubble

Chrome shows this bubble whenever any extension or page captures the screen, and
**no API can hide it**. It is browser-owned UI, deliberately out of reach of
page and extension JavaScript: if code could suppress it, silent screen
recording would be trivial. `chrome.desktopCapture` and `getDisplayMedia()`
behave the same way on current Chrome.

Two things that do help:

1. **Press "Hide"** on the bubble. It stays dismissed for that share, so it is
   one click per recording, not a permanent fixture.
2. **Enterprise policy.** On managed machines, admins can pre-approve this
   extension for screen capture, which removes the picker prompt for the listed
   origins. The bubble itself still appears; the policy only removes the
   permission step. Relevant policies: `ScreenCaptureAllowedByOrigins` and
   force-install via `ExtensionInstallForcelist`.

The capture window minimizes itself as soon as the encoder starts, so it does
not sit in the middle of the recording either.

## Keyboard shortcut

`Ctrl+Shift+9` (`Cmd+Shift+9` on macOS) starts or stops a recording. Declared
`"global": true`, so it also fires when no Chrome window has focus.

Chrome owns the binding: `chrome.commands` can read it but not set it. The
settings tab therefore shows the live value and links to
`chrome://extensions/shortcuts`, which is the only place it can be changed. On
managed machines the default can be pre-set with the `ExtensionSettings` policy.

The shortcut cannot skip the share picker. Chrome requires a genuine click
inside the capture window before it releases a stream, so starting is
"keystroke, then one click", while stopping is fully hands-free.
