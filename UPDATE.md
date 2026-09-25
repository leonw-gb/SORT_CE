## 2.32.0

- Replaced the Recordings list Export action with Export video: downloads the stored video without rebuilding a session bundle. Available for imported recordings with video; disabled for timeline-only sessions. The normal save/upload flow still uses .sortz.
- Added Open ticket links in the recording list and local session player using the assigned Odoo database ID, never the displayed reference. Assignment metadata is included before saving/uploading a new bundle and preserved on import. Old files lacking an Odoo ID cannot gain a link automatically.
- Added a Calls timeline filter, visible by default, with Sipgate answered/outgoing-started, already-in-progress and ended events from the existing call-state watcher. End times are detection times and can lag due to polling. Poll failures are not treated as hangups; ringing/hold/transfer events are not inferred.
- Call events remain visible when filtering a browser tab and when folding tab lanes. Calls before recording start are shown at the start with a context label, not negative video positions. Existing recorded call-start events are now readable; missing historical call-end events cannot be reconstructed.
- No new permissions. Seven-day ticket matching, fallback modes and manual confirmation are unchanged.

## 2.31.1

- Shortened the Match mode candidate window from 14 to 7 days before recording start, through recording end, to reduce ticket retrieval and ranking work.
- Newest first and Find older tickets remain unchanged. Matching weights, box mappings and manual confirmation safeguards are unchanged.

## 2.31.0

- Test build: added Match mode / Newest first toggle next to Reload tickets.
- Match mode reads all accessible tickets created from 14 days before recording start through recording end and shows the top 10 suggestions.
- Local heuristic relevance uses active RKA interactions, displayed error names or opening requests, affected component, confirmed box mappings and weak time evidence. Scores are not probabilities.
- Added RKA01 module-aware box numbering, RKA02/RKA04 mappings, and simple multi-box detail parsing. Ambiguous details remain unknown.
- Newest first retains the recent-ticket fallback. Find older tickets searches references/subjects without a date limit (up to 100 results).
- Switching modes preserves search text and entered reference, but clears selection confirmation. No automatic linking or selection.
- Ticket references only in the list; internal IDs remain API keys. No new permissions, external AI requests, or saved ranking history.

# SORT update news

## 2.30.4

- **Theme fix:** the What's new page now follows the saved Dark or Light theme.

## 2.30.3

- **What's new:** after an update, the popup shows a short notice with a link to these release notes. They are also available anytime under Settings > Updates.

## 2.30.1

- **Date filter:** the calendar button in the Recordings search selects a date range. Click the same day twice to show a single day.
- The search field now searches ticket number and title.

## 2.29.20

- **Recordings search:** filter the Recordings list as you type.

## 2.29.19

- Rocket sub-tabs (e.g. **Control**) are labeled by their visible name in the session timeline.

## 2.29.18

- Rocket tabs are named **Rocket Dashboard**; clicking a system card shows **Clicked RKA05-N0038**.

## 2.29.17

- New timeline tab names: **Odoo GoodBytz**, **RKA Webservice**, **Rocket Dashboard** and **ROUpload**.
