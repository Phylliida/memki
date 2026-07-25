---
title: cards seem to auto-bold when I click
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:13:14Z
updated: 2026-07-25T19:29:00Z
---

## Description

the create card menu after clicking **** is applied to whatever I click on, this is wrong, it should just let me type in text and only apply bold if I press the bold button

## Progress

- (2026-07-25T19:13Z) Reported by human during markdown-editor testing.
- (2026-07-25T19:29Z) Root cause found and fixed.

## Writeup

Root cause was NOT the bold button logic — it was HTML `<label>` activation
behavior. The field rows in the create-card and edit-note screens wrapped the
editor in `el("label", {}, f.name, ed.el)`. Clicking anywhere inside a
`<label>` activates its first labelable control, and the first `<button>`
inside the editor was the Bold toolbar button — so every click into the text
field fired Bold at the caret (`****` inserted, subsequent text bolded).

Fix (in the commits the human made, "fixup bold weirdness 2" / "fixup button
weirdness"):

- Editor rows are now `<div class="fld">` instead of `<label>` (both add-note
  and edit-note screens), with a CSS comment documenting the trap.
- Same bug pattern fixed in the `field()` helper on the Custom Study and Deck
  Options screens (clicking a field label there toggled the info-bubble button
  instead of focusing the input).
- Additionally, formatting buttons were made stateless per the human's request:
  with no selection they do nothing but show a status hint; with a selection
  they wrap exactly the selection.

Verified: 180/180 node tests green, syntax checked. Not verified: actual
browser click-through (no scriptable browser in this environment) — the human
confirmed the fix by testing.
