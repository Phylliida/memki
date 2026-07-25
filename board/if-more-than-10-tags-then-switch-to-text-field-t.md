---
title: if more than 10 tags then switch to text field to search for tags (in the create card and browse card menus instead of all the toggles)
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:05:39Z
updated: 2026-07-25T19:50:00Z
---

## Description

If more than 10 tags then switch to text field to search for tags, in the
create card and browse card menus, instead of showing all the toggles.

## Progress

- (2026-07-25T19:50Z) Implemented in the shared tag picker.

## Writeup

Both menus use the shared `tagBubblePicker` (web/app.js): create-card uses it
in the top-right action bar, and browse/edit-note uses it in `noteEditorForm`
(which is both the full-page editor and the browse side pane). So one change
covers the task:

- **≤ 10 tags** in the collection: unchanged — one toggle bubble per tag.
- **> 10 tags**: only the SELECTED tags render as bubbles (click to remove),
  followed by a "Search tags…" input. Typing filters the remaining tags
  (case-insensitive substring) and shows up to 10 matches as bubbles that
  click to add. The search input is a stable DOM node across refreshes, so
  focus and the in-progress query survive each re-render; the query is kept
  after adding so several matches can be added in a row.

"+ New tag" works the same in both modes.

Out of scope (deliberately): the deck-toggle modal reuses the tag-bubble CSS
but toggles decks, not tags.

Verified: 184/184 node tests green, syntax checked. Not verified: browser
behavior with a real >10-tag collection (no browser automation here) — logic
is straightforward DOM, but worth a click-through.
