---
title: remove the import csv button in create card
status: done
claimed_by: kimi-cli
created: 2026-07-25T18:59:22Z
updated: 2026-07-25T19:40:00Z 2026-07-25T18:59:22Z
---

keep the code we'll add import csv elsewhere later

## Writeup

The button was removed from the bottom button row of `renderAddCard`
(web/app.js) — with Save moving to the top-right and both secondary buttons
removed, the bottom row no longer exists. The underlying screen/function is
untouched: `renderImportCsv` is still in the code (currently unreachable), ready to be wired into the Import flow by the 'import also supports csv' task.

Verified: 184/184 node tests green, syntax checked.
