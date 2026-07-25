---
title: when creating new note type, specify default values for each fields
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:45:15Z
updated: 2026-07-25T20:00:00Z
---

## Description

When creating a new note type, specify default values for each field.
(Combined with the "cloze button should be yes/no" task — same dialog.)

## Progress

- (2026-07-25T20:00Z) Built the popout.

## Writeup

The "+ New" button on the Note Types screen used two native popups:
`prompt()` for the name and `confirm("Cloze type? OK=Cloze Cancel=Standard")`.
Both are replaced by one popout panel (`.pop-panel`, anchored under the
button like the tag popout):

- name input (Enter creates),
- **Cloze? Yes / No** toggle buttons (no more OK/Cancel semantics),
- a default-value input per field — Front/Back for Standard, Text/Back Extra
  for Cloze, rebuilt when the toggle flips (entered values kept by position),
- Create / Cancel.

Defaults are stored as `f.default` on the field objects of the note type —
plain extra JSON keys, so they persist in the native JSON backup and ride
along in `.apkg` model JSON (Anki ignores unknown keys; verified by a round-
trip test). `renderAddCard` prefills each field's editor with
`f.default ?? ""` when the note type is selected.

Assumptions / not done:
- Defaults only set at creation time; editing defaults later means editing
  JSON or re-creating. An "edit default" affordance in the note-type editor
  would be a natural follow-up.
- Defaults prefill the EDITOR (they're part of the note content once saved),
  not a display-time fallback.

Verified: 185/185 node tests green (new round-trip test for `f.default`),
syntax checked. Not browser-tested — popout positioning (`.pop-anchor`) is
the thing to eyeball.
