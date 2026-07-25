---
title: import also supports import csv (in addition to .apkg)
status: done
claimed_by: kimi-cli
created: 2026-07-25T19:03:10Z
updated: 2026-07-25T19:55:00Z
---

## Description

The header Import button should also accept CSV files, in addition to
.apkg/.colpkg packages and .json backups.

## Progress

- (2026-07-25T19:55Z) Wired the existing CSV import screen into the header
  Import flow.

## Writeup

The CSV import screen (`renderImportCsv`) already existed (it used to be
reachable from the add-card screen before that button was removed). Changes:

- `renderImportCsv(file = null)` now accepts a preselected file: it parses
  immediately, labels the file input with the file's name, and the input can
  still override with a different file. Its back-crumb now goes to Decks
  (it previously pointed at the add-card screen its button was removed from).
- `doImport` routes `*.csv` / `*.tsv` / `*.txt` to that screen instead of
  trying to parse them as Anki packages; `.json` still goes to backup
  restore, everything else to .apkg/.colpkg import.
- The header file input's `accept` gained `.csv,.tsv,.txt` and the Import
  button tooltip mentions spreadsheets.

Design choice: CSVs route to the mapping screen (delimiter / header /
column→field mapping) rather than importing blindly with defaults — a wrong
bulk import is much more annoying than one extra click.

Verified: 184/184 node tests green, syntax checked. Not verified: browser
end-to-end with a real CSV (no browser automation here) — parseCsv itself is
covered by csv.test.js, the wiring is DOM plumbing.
