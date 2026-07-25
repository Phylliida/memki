---
title: make code left aligned (instead of center-aligned)
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:32:29Z
updated: 2026-07-25T19:45:00Z
---

## Description

Code blocks on cards were center-aligned (they inherit the card face's
`text-align: center`, which is also Anki's default card alignment).

## Progress

- (2026-07-25T19:45Z) Fixed with one CSS rule.

## Writeup

Added `.card-face pre { text-align: left; }` to web/styles.css, right after
the other `.card-face` content rules. Scoped to card faces, so it applies in
study, the add-card preview, and the note-type editor preview — but not to
app chrome. Specificity matches note-type CSS injection order, so a note
type's own stylesheet can still override it.

Verified: 184/184 node tests green. Visual check not done (no browser
automation here) — trivial CSS, but worth a glance.
