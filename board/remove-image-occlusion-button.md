---
title: remove image occlusion button
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:03:48Z
updated: 2026-07-25T19:40:00Z 2026-07-25T19:03:48Z
---

you can keep the functaionality in the code if you want but we don't support interfacing with it yet

## Writeup

The button was removed from the bottom button row of `renderAddCard`
(web/app.js) — with Save moving to the top-right and both secondary buttons
removed, the bottom row no longer exists. The underlying screen/function is
untouched: `renderImageOcclusion` and the occlusion card rendering are still in the code (currently unreachable), so the functionality can be re-exposed later.

Verified: 184/184 node tests green, syntax checked.
