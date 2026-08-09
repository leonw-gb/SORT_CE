# SORT session format and the upload server

Reference for two audiences: whoever changes the upload server so it can host
sessions, and whoever changes SORT next.

Current format version: **1**

---

## 1. The `.sortz` bundle

A plain ZIP with exactly three members, always at the root, never in a folder.

```
manifest.json     what this is, who made it, and how to sync the video
session.json      the recording: events, tabs, SOP steps, ticket
session.webm      the screen capture (absent when the session has no video)
```

Two rules worth keeping when you write a reader:

- **`session.webm` is STORED, not deflated.** VP9 is already compressed;
  deflating it costs seconds per hundred megabytes and saves nothing. The two
  JSON members *are* deflated (method 8, raw deflate) because event streams are
  repetitive text and compress by roughly 10x. A reader must handle both
  methods per member.
- **The video is embedded, never linked.** Uploaded videos are deleted from the
  upload server after the retention period. A bundle that carried only a link
  would decay into a timeline with a dead player. The bundle is the durable
  copy of a session.

### `manifest.json`

```jsonc
{
  "formatVersion": 1,          // integer. Refuse anything higher than you know.
  "producedBy": "SORT",
  "producedAt": 1754769600000, // ms epoch, when the bundle was written
  "sourceId": "recording_1754…_a1b2c3d4e",  // id on the machine that recorded it
  "recorder": "Leon Weber",    // Sipgate name, stamped at RECORD time. May be
                               // null only for sessions recorded before 2.23.
  "machine": null,             // reserved: which RKA the session was recorded against
  "startTime": 1754769000000,
  "endTime":   1754770200000,
  "videoStartOffset": 240,     // ms; see "Sync" below
  "videoMimeType": "video/webm",
  "hasVideo": true,
  "eventCount": 1483,
  "ticket": { "ref": "1234", "seq": 1 }   // or null
}
```

### `session.json`

The recording object as SORT stores it: `events[]`, `tabs{}`, `sopSteps[]`,
`video{}`, `ticket`. Events carry `relativeTime` in ms from session start, which
is what the timeline is built on.

Treat this as the payload, not the contract. A viewer should read identity,
timing and sync from `manifest.json` and only reach into `session.json` for the
event stream itself.

### Sync

`relativeTime` is ms from **session start**. The encoder begins a moment after
that, so:

```
videoTimeSeconds = (event.relativeTime - videoStartOffset) / 1000
```

Clamp at zero. Events before the first frame belong at 0:00.

### Version handling

A reader must check `formatVersion` **before** touching anything else and refuse
a higher number with a sentence the operator can act on — not a stack trace
halfway through a half-rendered timeline. Reading an older version is fine.

Bump the version when a field changes meaning or disappears. Adding an optional
field does not need a bump.

---

## 2. What the upload server needs

Today the server accepts a video and returns a link to it. The goal is to accept
a whole session and return a link that plays the timeline next to the video, so
the ticket points at a session rather than a bare file.

### `POST /api/session`

`multipart/form-data`:

| field      | contents                                         |
|------------|--------------------------------------------------|
| `bundle`   | the `.sortz` file, exactly as SORT wrote it       |
| `ticket`   | optional, e.g. `1234`                             |
| `recorder` | optional, convenience copy of `manifest.recorder` |

Unpack server-side rather than asking the client to send parts separately: the
bundle is already a validated unit and the same file is what people hand each
other by other means.

**Response, 200 or 201:**

```json
{
  "session_url": "http://roupload.gdbz.network/s/aB3xQ9",
  "raw_url":     "http://roupload.gdbz.network/raw/aB3xQ9.webm",
  "expires_at":  1757361600000
}
```

`session_url` is the field that matters. **SORT already prefers it** — see
`upload.js`. The day the server starts returning it, tickets get session links
with no extension change.

Keep `POST /api/upload` working. Older installs will use it for a while, and its
`watch_url` / `raw_url` response is still the fallback.

### `GET /s/<id>` — the viewer

Serve the timeline and the video on one page, the way the extension's
`player.html` does.

- Stream the video from its own URL with **range requests**. Do not inline it —
  a viewer that downloads 300 MB before the first frame is unusable on the VPN.
- Serve the events as JSON the page fetches, not embedded in the HTML.
- Show the recorder's name and the record date. A session viewed by someone who
  did not record it must say whose it is.
- Apply the same retention as videos, and make an expired session say so plainly
  instead of 404-ing into a broken player.

`player.js` in this repo loads through a small source table (`SOURCES` at the
top). Adding a `remote` entry that fetches `/api/session/<id>/events` and points
the video at a URL is the intended path — the rendering code below that line is
already source-agnostic, so the web viewer can reuse it rather than
reimplementing the timeline.

### Auth

Reachable only over the VPN, same as the upload endpoint. No tokens. Unguessable
ids, not sequential ones, so a session URL pasted into a ticket is not a map of
every other session.

---

## 3. Recorder identity

`manifest.recorder` is the Sipgate name from SORT's settings, stamped when the
recording **starts** — so it records who made it, not who exported it. The name
is mandatory from 2.23.0: `startSession` refuses without one, on every trigger
including the keyboard shortcut and the call trigger.

Sessions recorded before 2.23.0 have `recorder: null`, and both the import
window and the viewer show "Unknown" rather than guessing.

---

## 4. Import

Importing rewrites the local id and keeps the original:

- new `id`, minted locally (`imported_<ts>_<rand>`) — recording ids are minted
  per machine, so an imported session can otherwise collide with a local one and
  silently overwrite it
- `sourceId` = `manifest.sourceId`, which also makes a repeat import detectable
- `imported: true`, `recorder` from the manifest
- `ticket.uploadUrl` is dropped: it points at a video the retention policy will
  delete, and the ticket belongs to whoever recorded it

Imported sessions cannot be re-exported or assigned to a ticket. They are
someone else's record; SORT shows them and lets you delete them, nothing more.
