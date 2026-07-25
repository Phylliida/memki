---
title: In Browse above Front and below Basic · 2 cards share this note · edits save automatically put a "Preview" button that pulls up a popout panel that shows the front and back card (like is shown below in create card)
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:53:02Z
updated: 2026-07-25T20:05:00Z
---

## Description

In the note editor, between the "Basic · N cards share this note · edits save
automatically" header and the first field, add a "Preview" button that opens
a popout panel showing the front and back card, like the create-card preview.

## Progress

- (2026-07-25T20:05Z) Implemented.

## Writeup

`noteEditorForm` (web/app.js — used by both the browse side pane and the
full-page editor) now has a Preview button in a row directly under the
ne-head line, above the first field. It toggles an anchored popout panel
(`.ne-pv-pop`, 560px, cards stacked) that renders the note's first card:

- Fields are read live from the editors (`ed.getText()`), rendered through
  the same pipeline as the add-card preview: `renderCard` (markdown→HTML,
  cloze/type-in handling) → `displayHtml` (math, sounds, media) → model CSS +
  MathJax typeset + volume wiring.
- While the panel is open it re-renders (debounced) on every edit, so it
  tracks your typing like the add-card preview does.
- Image-occlusion note types (`ossIO`) can't go through `renderCard`; the
  panel shows their `occlusionFace` question side of the saved note instead.

Assumption: previews the first card ordinal (cloze 1 / template 0), same
choice the add-card preview makes. A card-picker could be a follow-up.

Verified: 185/185 node tests green, syntax checked. Not browser-tested —
check the popout position in the narrow browse side pane (`.ne-pv-pop` is
left-anchored, 560px wide, capped by the panel's max-width rule).
