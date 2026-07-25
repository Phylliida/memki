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

(Revised after the human clarified the intended design: defaults belong in
the Edit Note Type screen, not the creation popout.)

The "+ New" button on the Note Types screen used two native popups:
`prompt()` for the name and `confirm("Cloze type? OK=Cloze Cancel=Standard")`.
Both are replaced by one anchored popout panel: name input (Enter creates),
**Cloze? Yes / No** toggle buttons, Create / Cancel. Nothing else.

Default field values live in the Edit Note Type screen: each field row is
`[name input] [default-value input] [remove]`, default blank. On Save, a
non-empty value is stored as `f.default` on the field object (plain extra
JSON key — persists in the native JSON backup, rides along in `.apkg` model
JSON where Anki ignores unknown keys; round-trip test in
apkg-roundtrip.test.js). Blank clears the key. `renderAddCard` prefills each
field's editor with `f.default ?? ""` when the note type is selected.

Assumption: defaults prefill the EDITOR (they become note content on save),
not a display-time fallback.

Verified: 185/185 node tests green, syntax checked. Not browser-tested.
