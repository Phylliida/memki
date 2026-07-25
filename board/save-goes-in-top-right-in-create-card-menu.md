---
title: save goes in top right in create card menu
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:04:12Z
updated: 2026-07-25T19:35:00Z
---

## Description

Move the Save button to the top right of the create card menu.

## Progress

- (2026-07-25T19:35Z) Implemented alongside the tag/flag toggle task (same
  header bar).

## Writeup

`renderAddCard` (web/app.js) previously rendered `h2 "Add Card"` then a form
with a bottom button row (Save / Import CSV/TSV / Image Occlusion). Now the
screen has a header bar (`.add-head`): title on the left, action cluster on
the right (`.add-actions`) containing the tag toggles, flag toggles, and the
Save button. Save was removed from the bottom row; Import CSV/TSV and Image
Occlusion remain there for now (separate board tasks cover removing them).

The header uses flexbox with wrap, so on narrow screens the action cluster
wraps under the title. No JS behavior changes to Save itself.
