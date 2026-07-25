---
title: give default deck also a delete deck icon that is just grayed out
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:46:39Z
updated: 2026-07-25T20:00:00Z
---

so all the deck icons are aligned with each other

## Progress

- (2026-07-25T20:00Z) Done.

## Writeup

In the deck list (web/app.js), the Default deck (id 1) previously rendered no
trash icon at all, shifting its other action icons one slot left. It now
renders a `disabled` trash button (tooltip: "The Default deck can't be
deleted"), which the existing `button:disabled { opacity: 0.5 }` rule grays
out. The click handler only stops propagation (so the row doesn't open the
deck); it can't fire a delete.

Verified: syntax checked; DOM-only change.
