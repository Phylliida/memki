---
title: Will create 1 card · previewing "Cloze"
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:50:25Z
updated: 2026-07-25T20:00:00Z
---

put this below the header but above the previews (instead of below the previews)

## Progress

- (2026-07-25T20:00Z) Moved.

## Writeup

In `renderAddCard` (web/app.js) the `Will create N cards · previewing "..."`
muted line now renders between the `Preview` h2 and the card pair (it sat
below the cards after the previous preview-clarity task — that guess was
wrong, the human wanted it as a sub-caption directly under the header).

Verified: syntax checked; DOM-only change.
