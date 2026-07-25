---
title: move flags and tags below the preview
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:49:48Z
updated: 2026-07-25T20:00:00Z
---

## Description

Move the Flags and Tags rows below the preview in the create card menu.

## Progress

- (2026-07-25T20:00Z) Moved.

## Writeup

In `renderAddCard` (web/app.js), the Tags and Flags rows moved out of the
top-right `.add-actions` cluster (which now holds only the Save button) to
the bottom of the form, below the preview box, in this order: fields →
Preview → Tags → Flags. Same `tagBubblePicker` / `flagPicker` components,
same `newTags`/`newFlags` state, Save behavior unchanged.

Verified: syntax checked; DOM-only change.
