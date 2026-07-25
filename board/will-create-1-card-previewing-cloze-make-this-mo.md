---
title: Will create 1 card · previewing "Cloze" make this more clear it is preview
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:06:38Z
updated: 2026-07-25T19:45:00Z
---

Basically we have a header2 that says Preview and then below the preview text it says "will create _ cards"

## Progress

- (2026-07-25T19:45Z) Done as specified.

## Writeup

In `renderAddCard` (web/app.js):

- Added an `h2 "Preview"` between the field editors and the preview box, so
  the rendered cards are clearly labeled as a preview.
- Moved the `Will create N cards · previewing "<template>"` line from above
  the cards to below them (it now reads as a caption for the preview, not a
  title for the page).

The "No cards yet — fill the first field." empty state is unchanged.
Note: the note-type editor (Types screen) has its own similar preview; the
task was about the create-card menu, so that one was left alone.

Verified: 184/184 node tests green, syntax checked.
