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
