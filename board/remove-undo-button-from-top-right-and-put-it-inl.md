---
title: remove undo button from top right and put it inline
status: done
claimed_by: kimi-cli
created: 2026-07-25T20:20:17Z
updated: 2026-07-25T20:30:00Z
---

<goes here> edit bury suspend (as one of those buttons down there)

this is specifically just for when viewing cards (practicing/quizzing etc.)

## Progress

- (2026-07-25T20:30Z) Moved.

## Writeup

The header `#btn-undo` (index.html) is gone. Undo now lives inline in the
review operations bar (`reviewMoreBar`, web/app.js), first in the row:
**Undo · Edit · Bury · Suspend · Forget · Set Due · flags**, exactly where
the task sketch put it.

Details:

- New shared `undoButton()` helper builds the button with `disabled`
  computed from `state.lastAction` at render time; the old
  `updateUndoButton()` (which poked the header button) is deleted — the bar
  is rebuilt by `renderStudy()` after every grade and every undo, so the
  state is always fresh.
- Also added the same inline Undo to the "All caught up — nothing due"
  screen: previously the header button was reachable there, and losing it
  would have stranded anyone who graded their last card and wanted to undo.
- Ctrl+Z during review is unchanged (still calls `doUndo`).

Verified: 187/187 node tests green, syntax checked, no stray `btn-undo`
references. Not browser-tested — check the disabled/enabled transition after
grading a card (the bar should rebuild with Undo enabled).
