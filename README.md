# SORT — Session Observer Recorder Tracker

**Version 2.30.3 · Chrome extension · Manifest V3 · Chrome 116 or later**

SORT is goodBytz’s internal support-session recorder. It combines screen video with a searchable browser-activity timeline, groups recordings by support ticket, and supports local session bundles, uploads to ROUpload, and recording links on Odoo tickets.

This README describes the supplied **2.30.3** package. The installed version comes from [`manifest.json`](manifest.json); release notes are maintained separately in [`UPDATE.md`](UPDATE.md).

> **Recording scope:** Video contains the screen, window or tab selected in Chrome’s sharing dialog, without audio. The activity timeline can include other eligible browser tabs—not just the selected video source. Read the recording disclosure before enabling SORT.

## Contents

- [Requirements and installation](#requirements-and-installation)
- [First-time setup](#first-time-setup)
- [Recording a session](#recording-a-session)
- [Finding recordings](#finding-recordings)
- [Saving, uploading and linking tickets](#saving-uploading-and-linking-tickets)
- [Reviewing and exchanging sessions](#reviewing-and-exchanging-sessions)
- [Updates and release notes](#updates-and-release-notes)
- [Privacy, storage and deletion](#privacy-storage-and-deletion)
- [Troubleshooting](#troubleshooting)
- [Maintainer reference](#maintainer-reference)

## Requirements and installation

- Google Chrome **116 or later**.
- Permission to install SORT in the relevant Chrome profile.
- Company VPN access for the recording server, as required by the recording disclosure.
- An Odoo login and personal API key for ticket lookup and ticket-link creation.
- A separately supplied call-state token for call-triggered recording.

Odoo credentials and the call-state token are not required merely to save a session locally. A configured recorder name and accepted disclosure are required to start recording.

### Normal installation

Use the approved Chrome Web Store or managed deployment provided by your administrator. Pin SORT to the Chrome toolbar for quick access. Store-delivered updates are managed by Chrome.

### Local testing / unpacked installation

1. Extract the release ZIP into a dedicated folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Pin SORT to the toolbar.

For subsequent local builds, replace the files in the same folder and click **Reload**. Stop recordings and finish exports/uploads first. Refresh the web pages you plan to record so they receive the updated content scripts.

Do not uninstall SORT or clear its extension data just to test an update: locally stored recordings and settings may be lost. Unpacked builds do not receive normal Store updates.

## First-time setup

Open SORT → **Settings**.

| Setting | Purpose |
|---|---|
| **Theme** | Choose Dark or Light. Preview changes immediately; use **Save settings** to persist them. |
| **Keyboard shortcut** | Shows Chrome’s current shortcut. **Change** opens Chrome’s extension-shortcut settings. |
| **Folder inside Downloads** | Subfolder used for downloaded session bundles; defaults to `Recordings`. |
| **Odoo login / API key** | Your Odoo credentials. Use **Test the Odoo connection** to check access. |
| **Sipgate name** | Required recorder identity and the name used for call matching. Enter it as it appears in Sipgate. |
| **Shared call-state token** | Separately provisioned credential for the fixed call-state service. Use **Test the call connection** to check it. |

The upload address, Odoo address/database/model and call-state endpoint are fixed deployment values—not editable user preferences.

Click **Save settings** when finished. Unsaved edits are kept as a local recovery draft after the draft write completes; they do not become live configuration until saved. **Discard unsaved changes** restores saved values. Chrome can close its toolbar popup immediately, so drafts are best-effort recovery rather than a guarantee against every interruption.

### Enable SORT

SORT remains off until the first-use disclosure is accepted with **Agree and enable SORT**. Acceptance is stored in the current Chrome profile. Enabling SORT does not itself start a recording.

Turning SORT off stops and saves an active recording and blocks new manual and call-triggered recordings. Normal restarts and off/on changes do not require acceptance again; a revised disclosure or cleared acceptance can require a new review.

Source: [`popup.html`](popup.html), [`popup.js`](popup.js), [`defaults.js`](defaults.js), [`background.js`](background.js).

## Recording a session

### Manual recording

1. Confirm SORT is **On** and your name has been saved.
2. Click **Start Recording**, or use the configured shortcut.
3. In Chrome’s sharing dialog, select the screen, window or tab to capture.
4. Carry out the support task.
5. Stop using SORT or the shortcut. Use the ticket window to save, upload or link the session.

Cancelling the sharing dialog cancels the recording start. SORT does not record microphone, system or tab audio.

### Keyboard shortcut

The manifest suggests **Ctrl+Shift+9**, or **Command+Shift+9** on macOS. Chrome determines the actual assignment; it may differ or be unset.

Change the binding at `chrome://extensions/shortcuts`:

- **In Chrome:** use the shortcut while Chrome is active.
- **Global:** request use outside the active Chrome window as well.

Saving SORT settings does not save or change Chrome’s shortcut assignment. If a shortcut behaves inconsistently, check for competing assignments or applications; a displayed key binding alone does not prove that it is working globally on that machine.

### Call-triggered recording and reminders

When SORT is on and configured, the call watcher checks the fixed call-state service and matches calls to the saved Sipgate name. A matching answered call can initiate the recording flow; Chrome still requires a video-source selection. Ringing alone does not start recording.

Call-end handling prompts whether to stop or continue rather than blindly ending the recording. The build also includes five-minute continuation reminders, subject to its active-call and prompt-state checks.

Keep the capture window open during recording and avoid reloading the extension during an active session.

Source: [`capture.js`](capture.js), [`callpoll.js`](callpoll.js), [`callmatch.js`](callmatch.js), [`background.js`](background.js), [`continue.js`](continue.js).

## Finding recordings

The **Recordings** tab groups sessions under their ticket number, with an **Unassigned** group for sessions without a ticket. Open a group to access its session actions.

### Ticket search

The search field matches **ticket number and ticket title**:

- Matching is case-insensitive and supports partial text.
- Every whitespace-separated search term must match.
- Example: `4821 fryer` requires both terms to appear in that recording’s ticket information.

Dates are selected through the calendar, not parsed from this text field.

### Calendar date filter

Click the calendar icon at the left of the search field:

1. Click a start date.
2. Click an end date. Click the same date twice to select only that day.

Either selection order works. The filter uses the recording’s **start time**, in the computer’s local time, and includes the entire first and last days. Use the month arrows to select ranges across months.

Today is underlined; dots mark days with locally stored recordings. The selected range appears below the search field. Remove it using **×** or **Clear** in the calendar. Escape or an outside click closes an unfinished selection without applying it.

Ticket search and the date filter work together. Matching folders open automatically while filtering. These filters do not change stored recordings.

Source: [`popup.js`](popup.js), [`popup.html`](popup.html).

## Saving, uploading and linking tickets

The ticket window offers three workflows:

| Action | Requirements | Result |
|---|---|---|
| **Save locally** | A stored recording; no ticket selection required | Requests a local `.sortz` download. |
| **Save and upload session** | A selected or manually entered ticket number | Requests a local download, then uploads the session bundle. |
| **Upload session and add link to ticket** | Valid Odoo credentials and an explicitly confirmed, loaded Odoo ticket | Requests a local download, uploads the bundle, then adds the returned link to the Odoo ticket. |

For Odoo linking, select a ticket row or enter the exact number of a ticket in the loaded list. An arbitrary typed number does not authorize Odoo write-back. A ticket suggested by call metadata must still be confirmed. Reloading the ticket list clears the selection.

A typical downloaded path is:

```text
Downloads/Recordings/1234/1234_001.sortz
```

The prefix comes from **Folder inside Downloads**; the suffix is a ticket sequence number. Check Chrome Downloads to confirm that the local download completed. Sessions without video can still be saved or uploaded as timeline-only bundles.

The upload destination is **ROUpload**, at `http://roupload.gdbz.network`. Odoo receives a recording **link**, not a copy of the session. Keep the ticket window open until the operation finishes. If an operation fails, the session remains stored locally so it can be reopened and retried.

Source: [`ticket.js`](ticket.js), [`upload.js`](upload.js), [`odoo.js`](odoo.js).

## Reviewing and exchanging sessions

### Session Timeline

Open a recording to review its video, when available, alongside the activity timeline. The viewer includes:

- Search across actions, labels and URLs.
- Event-type filters and a tab selector.
- **Fold to tabs** for a compact tab-activity view.
- **Copy log** and a technical **Debug** display.
- Video/timeline synchronization and a resizable split view.

Recognized services have readable tab names:

| Host | Timeline name |
|---|---|
| `odoo.goodbytz.com` | Odoo GoodBytz |
| `rka-links.gdbz.network` | RKA Webservice |
| `rkt.gdbz.network` | Rocket Dashboard |
| `roupload.gdbz.network` | ROUpload |

Additional mappings identify supported machine tools by their port or subdomain. Rocket system-card clicks can show **Clicked RKA05-N0038**, and accessible sub-tabs use their visible labels, such as **Clicked Control**, instead of generated Radix IDs.

Labels depend on the page structure and captured data. New capture rules cannot reconstruct information missing from older recordings.

### Export and import

Use **Export** on an eligible local recording to create a `.sortz` bundle. To review a shared session, choose **Import a session…**, select the bundle, inspect its metadata and confirm the import. Imported sessions retain provenance information; importing a duplicate can create another local copy.

A `.sortz` file is a ZIP-based session container, format version **1**:

```text
manifest.json   Session metadata and format version
session.json    Timeline, tabs and recording metadata
session.webm    Video, when present
```

The bundle contains the video rather than merely linking to it. It is **not an encrypted archive** and may contain sensitive support information. Share it only through approved channels.

Source: [`player.js`](player.js), [`content.js`](content.js), [`sortz.js`](sortz.js), [`import.js`](import.js).

## Updates and release notes

Chrome checks for Store updates automatically. **Settings → Updates → Check manually for updates** requests a check; SORT throttles repeated manual requests to once per five minutes.

When a genuine update is pending, SORT can show update-marked toolbar icons, a notification and a popup panel with **Restart SORT now** / **Later**. Its restart checks guard against active work, relevant open SORT windows and ongoing downloads. **Later** postpones SORT’s own restart action; it does not guarantee that Chrome will never install an update automatically.

After a version-changing update, the popup displays an **Updated to SORT … / What’s new** notice until opened or dismissed. A fresh install does not show that update notice. Release notes remain accessible through **Settings → Updates → What’s new**.

### Maintaining `UPDATE.md`

Release notes are read locally from the packaged, case-sensitive **`UPDATE.md`** file. No external news service is required. Keep newest releases first, with a heading that exactly matches the manifest version:

```markdown
# SORT update news

## 2.30.3

- Describe the changes included in this release.
```

The renderer supports headings `#` through `###`, unordered bullet lists, paragraphs, **bold**, inline `code`, and HTTPS links. It renders text through DOM nodes rather than executing HTML. It is a small Markdown subset, not a full Markdown engine.

A matching version heading is highlighted as **Installed**. Editing packaged notes requires distributing a new build to users.

Source: [`updates.js`](updates.js), [`whatsnew.js`](whatsnew.js), [`UPDATE.md`](UPDATE.md), [`background.js`](background.js).

## Privacy, storage and deletion

Read the [SORT privacy notice](https://leonw-gb.github.io/) and the in-extension disclosure before use.

- **Video:** selected screen/window/tab only, without audio.
- **Timeline:** may capture interactions, entered field values, page titles, URLs, navigation, network-request details and WebSocket payloads across eligible browser tabs. Chrome-protected pages and some embedded contexts are outside ordinary content-script access.
- **Redaction:** password-field masking is not comprehensive redaction. Avoid unrelated personal or sensitive content.
- **Credentials and drafts:** stored in the current Chrome profile, not Chrome Sync, without additional application-level encryption. Unsaved drafts may contain credentials.
- **Local recordings:** timeline records and video are stored locally in extension storage. Downloads are separate files.
- **Uploads:** the server endpoint uses HTTP. The disclosure requires the company VPN; SORT does not itself enforce VPN connectivity.
- **Deletion:** deleting a recording in SORT removes its locally stored timeline and video. It does not remove downloaded files, uploaded server copies or Odoo links.
- **Retention policy:** the disclosure states one month from the original recording date for uploaded recordings and AI extracts, and requires manual cleanup of local recordings and exports within the same period. Server retention and Odoo-link cleanup are organizational/server processes, not proven by the extension code alone.

The disclosure describes support, troubleshooting, product improvement and coaching uses, and human-reviewed, de-identified timeline extracts for authorized AI work. It explicitly excludes video from AI use. De-identification is not the same as guaranteed anonymity.

### Support diagnostics

Use **Settings → Support → Export support logs** to request a local diagnostic JSON download. The version and build fingerprint appear below the export button.

The structured diagnostic log is bounded by **7 days**, **5 MiB**, or **5,000 entries**. It is separate from recorded session contents and uses restricted diagnostic fields. Exporting it does not automatically upload it. Review the file before sharing and use approved support channels.

Source: the disclosure in [`popup.html`](popup.html), [`background.js`](background.js), [`security.js`](security.js), [`diagnostics-core.js`](diagnostics-core.js), [`diagnostics.js`](diagnostics.js).

## Troubleshooting

| Symptom | Check |
|---|---|
| Recording will not start | SORT is on, disclosure is accepted, the Sipgate name is saved, and Chrome’s sharing dialog was not cancelled. |
| Automatic call recording does not start | Check the saved name and token, then **Test the call connection**. Already-running calls may be adopted without reopening a capture picker. |
| Shortcut does not respond | Review the binding and scope in Chrome’s shortcut settings; check competing shortcuts. SORT’s Save button does not configure Chrome shortcuts. |
| Odoo-link button stays grey | Test the credentials, load tickets, then explicitly select a row or type an exact loaded ticket number. |
| Upload fails | Check VPN/network access, the ROUpload service and the reported error. Confirm the local download separately before retrying. |
| Recordings appear missing | Clear both the text search and date filter. Expand ticket folders and check Unassigned. Confirm you are using the original Chrome profile and extension installation. |
| A label is still technical | Refresh the page after updating, make a new test recording, and inspect Debug output. Older sessions may lack the required captured text. |
| Restart is unavailable | Stop recordings, finish transfers and close capture, ticket, import, player or reminder windows. Resolve unsaved settings. |
| No update-news banner | It appears after a version-changing update, not a fresh install or once dismissed. Use Settings → Updates → What’s new. |

For unresolved issues, note the version/build, reproduction steps and exact error, and export support logs. Internal contact: **Leon Weber — leon.weber@goodbytz.com**.

## Maintainer reference

### Main files

| Files | Responsibility |
|---|---|
| `manifest.json`, `build-info.js` | Extension version, permissions, entry points and generated build fingerprint. |
| `background.js`, `security.js` | Session lifecycle, persistence, message authorization and tool/disclosure state. |
| `popup.html`, `popup.js` | Session controls, recordings, search/calendar, settings and update notices. |
| `capture.html`, `capture.js` | Video-source flow, recording and video persistence. |
| `content.js`, `ws-hook.js` | Browser interaction and page-world WebSocket capture. |
| `offscreen.html`, `offscreen.js`, `callpoll.js`, `callmatch.js` | Offscreen work and call-state monitoring/matching. |
| `continue.html`, `continue.js` | Stop/continue prompts. |
| `ticket.html`, `ticket.js`, `odoo.js`, `upload.js` | Ticket assignment, downloads, uploads and Odoo linking. |
| `player.html`, `player.js` | Session Timeline and video review. |
| `sortz.js`, `import.html`, `import.js` | Session-bundle serialization and import. |
| `updates.js`, `whatsnew.html`, `whatsnew.js`, `UPDATE.md` | Update handling and packaged release notes. |
| `defaults.js`, `theme.js` | Deployment constants and theme helpers. |
| `diagnostics-core.js`, `diagnostics.js`, `icons/` | Diagnostic policy/reporting and toolbar-state artwork. |

### Deployment values and permissions

`defaults.js` fixes the upload server, Odoo server, database `gdbytz`, model `helpdesk.ticket`, call-state endpoint and timing defaults. Do not distribute personal Odoo API keys or the shared call-state token in source files.

The manifest requests `tabs`, `scripting`, `storage`, `downloads`, `desktopCapture`, `alarms`, `offscreen`, `notifications`, and `<all_urls>` host access. Its content scripts are top-frame only (`all_frames: false`); the WebSocket hook runs in the page’s main world.

Uploads primarily use `POST /api/session` with multipart field `bundle`. Only HTTP 404/405 causes a fallback attempt to `/api/upload` with field `file`; legacy-server compatibility still depends on what that server accepts.

### Release checklist

1. Increase `manifest.json` to the intended release version.
2. Add accurate release notes under the identical version heading in `UPDATE.md`.
3. Review deployment constants and ensure no credentials have entered the package.
4. Run JavaScript syntax checks and test the changed workflows in Chrome.
5. Rebuild `build-info.js` using the maintained release builder. Its inventory must include `UPDATE.md`, `whatsnew.html` and `whatsnew.js` as well as the other runtime files.
6. Package the complete extension with `manifest.json` at the ZIP root and preserve all icon assets.
7. Test the install/update path, disclosure, recording, save/upload, import, search/calendar, settings and release-note links before distribution.

No build script or automated test suite is included in the supplied ZIP. Use the separately maintained release tooling; an older whitelist-based builder may omit newer files. Do not modify release contents after generating their fingerprint without rebuilding it.