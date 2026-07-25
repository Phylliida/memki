---
title: cloze button should be yes/no instead of cancel ok
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:44:40Z
updated: 2026-07-25T20:00:00Z
---

doesn't need to be popup instead a popout panel

## Progress

- (2026-07-25T20:00Z) Done — see the note-type-defaults task for details
  (implemented as one popout covering both tasks).

## Writeup

The offending dialog was `confirm("Cloze type? (OK = Cloze, Cancel =
Standard)")` in the Note Types "+ New" flow. The whole flow (name prompt +
cloze confirm) is now a single anchored popout panel with explicit
**Cloze? Yes / No** toggle buttons — no native popups at all. See
`when-creating-new-note-type-specify-default-valu.md` for the full writeup.

Verified: 185/185 node tests green, syntax checked.
