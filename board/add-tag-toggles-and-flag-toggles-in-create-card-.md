---
title: add tag toggles and flag toggles in create card menu
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:04:32Z
updated: 2026-07-25T19:35:00Z
---

also goes in the top right by the save button

## Progress

- (2026-07-25T19:35Z) Implemented alongside the save-button-top-right task
  (same header bar).

## Writeup

The create-card screen (`renderAddCard`, web/app.js) now has tag and flag
toggles in the top-right action cluster, next to Save:

- **Tags**: the tag-bubble UI from the edit-note screen was extracted into a
  shared `tagBubblePicker(selected, onChange)` helper. Edit-note passes an
  `onChange` that persists immediately (unchanged behavior); add-card keeps a
  local `newTags` set that is written to the note on Save
  (`addNoteWithCards` already accepted a tags parameter).
- **Flags**: a `flagPicker` over a local `newFlags` set; on Save the chosen
  flags are written to every created card with `writeCardFlags` before the
  cards are persisted.

Assumption: flags apply to ALL cards of the new note (there's no per-card
distinction at creation time — matches how the edit screen toggles flags
across a note's cards). Empty selection = no flags, as before.

Verified: 184/184 node tests green, syntax checked. Not verified: browser
click-through of the new header layout (no scriptable browser here) — worth a
quick look at narrow widths since the action cluster wraps.
