SORT 2.26.11 - Local support diagnostics
======================================
Package build (SHA-256): 2cefb00c732fd008767ef2539138c33ba8c6ed5b915697ce7ddd2afd05db8fbc

INSTALL THIS PATCH
1. Finish any active recording and wait for saves/uploads to finish. Close SORT
   capture, player, ticket and import windows.
2. Back up your existing unpacked SORT extension folder.
3. Copy the extension files from this ZIP into that SAME folder, replacing files
   when prompted. This ZIP is a patch, not a standalone extension.
4. Keep your existing defaults.js, icons/ and lib/. They are deliberately not
   included. Your Sipgate endpoint/key and other deployment values remain intact.
5. Open chrome://extensions and click Reload on SORT. Do not remove/uninstall
   the extension: uninstalling removes local data.
6. Refresh the work tabs you want to record, so they use the new content scripts.
7. Open SORT > Settings > Support > Export support logs. Check Chrome Downloads
   for the resulting JSON file. The export does not depend on settings validation.

WHAT IS NEW
- Persistent local diagnostic breadcrumbs and errors, separate from recordings.
- Covers recording start/stop/save/delete, capture/encoding/video-save failures,
  content initialization and message failures, injection fallback, poll failure/
  recovery/repair/configuration, connection probe, bundle building/downloading,
  import parsing/storage, ticket workflow, upload, Odoo operations, and player
  loading/media errors. Extension-context uncaught exceptions are captured too.
- Normal successful call polls are NOT logged. Identical events are suppressed
  for ten seconds. The worker accepts at most 180 distinct events/minute, with
  a bounded queue. Suppression/drop counters are reported for its current lifetime.
- Retains up to seven days, 5 MiB of serialized log state or 5,000 events,
  whichever limit is reached first. Oldest entries are removed first. Under quota
  pressure diagnostics shrink to at most 100 entries, then fail without breaking
  the wrapped operation. Physical browser-storage overhead is additional.
- Expiry runs on worker startup, writes, exports and an hourly alarm while Chrome
  is running; no code runs to delete expired entries while Chrome is shut down.
- Export is a local JSON download. No telemetry, automatic uploads, sign-in,
  distribution changes or automatic updater are added.

PRIVACY BOUNDARY
New diagnostics accept only fixed operation/outcome/source labels, selected
numeric/boolean fields and known exception categories. They discard arbitrary
fields BEFORE persistence and revalidate stored entries BEFORE export.
No credentials, typed values, names, ticket/session IDs, page URLs, recording
contents, DOM, video, request headers, response bodies, raw errors or stacks are
included. Source files are hashed, never included as text. The support file does
contain timestamps, browser/OS information and numeric operation metadata.
Existing recording contents, callTrail/pollLog and application console output are
not exported and are not rewritten or scrubbed by this patch. Logging is local,
but not an encryption/security boundary against someone with browser/profile access.
Review the JSON before manually sharing it with support.

RELEASE AND EXACT INSTALLED BUILD
Each export contains:
- Release version and the full deterministic packageBuild identifier above.
- SHA-256 hashes of the installed inventory, including defaults.js, plus a combined
  installedFingerprint. Deployment values affect the hash but are never disclosed.
- workerBuild: inventory fingerprint captured at worker startup.
- installedAtExport: inventory re-read when Export support logs is clicked.
- filesChangedSinceWorkerStart: identifies local edits made since the worker began.
- Every event carries its emitter release/packageBuild and the worker fingerprint.
  History from previous versions is not relabeled as the current version.

The inventory covers the known packaged first-party JS/HTML/CSS, manifest and
build metadata. This version does not reference the dormant lib/rrweb assets in
its manifest/page scripts; those and icons are outside the fingerprint. Unlisted
local files are also outside it. Missing inventory files are explicitly marked
unavailable and complete=false. This is NOT a Git commit identifier.

A file edited on disk may differ from JavaScript already running. Reload SORT and
refresh tabs after code changes. packageBuild identifies this shipped patch;
local edits change installedFingerprint, not that static release identifier.
Build identities from older retained events remain in the event rows; full old
file inventories are not retained. No manual build step is needed to export logs.

OPERATIONAL LIMITATIONS
Chrome/process crashes, a worker that cannot start, orphaned/restricted tabs,
storage/message failures, or abrupt page closure can prevent logging. In-flight
entries can be lost; persistence is not a guarantee to capture every crash.
A started event with no terminal outcome can indicate interruption or early return.
The current-worker health counters reset on worker restart; committed events do not.
If storage is unavailable, export still attempts a build/environment report and
marks history unavailable. If the worker cannot run at all, use SORT's errors in
chrome://extensions instead. Downloads interrupted by the user are not success.

VALIDATION PERFORMED
- All 19 JavaScript files in the staged extension passed node --check.
- All seven HTML pages load diagnostics before application scripts; local script
  references and combined-script lexical declarations were checked.
- Manifest and dynamic content injection use the same diagnostic bootstrap.
- 13 automated test groups passed using mocked Chrome/storage APIs: privacy
  allowlists, retention by age/count/bytes, concurrent writes, deduplication,
  service-worker restart persistence, safe export, fingerprint verification,
  local deployment changes, missing files, download cleanup, quota/failure
  isolation, sender validation, unavailable storage, and page-error exclusion.
- Six existing field-label fixtures still pass, preserving Amount (g) and skill
  labels without changing typed values.
- Live Chrome capture/download and real Sipgate/Odoo/upload integration were NOT
  tested here. Windows/macOS smoke testing is still required before wider rollout.

QUICK CHROME SMOKE TEST
1. Confirm SORT reports 2.26.11 and has no extension startup errors.
2. Start/stop a short recording; save it and open its timeline/video.
3. Test call connectivity; briefly disconnect/reconnect networking and confirm
   the exported log contains a poll failure/recovery rather than every poll.
4. Export support logs; close the popup while export runs and confirm Chrome
   completes the JSON download. Check release, fingerprints and health.
5. Reload SORT, export again, and confirm earlier committed events remain.
6. Exercise your usual import/upload/Odoo path and check any failures have safe
   categories/statuses, with no recording content, keys or response messages.

FILES REPLACED OR ADDED
- background.js
- build-info.js
- callpoll.js
- capture.html
- capture.js
- content.js
- continue.html
- diagnostics-core.js
- diagnostics.js
- import.html
- import.js
- manifest.json
- odoo.js
- offscreen.html
- offscreen.js
- player.html
- player.js
- popup.html
- popup.js
- ticket.html
- ticket.js
- upload.js
