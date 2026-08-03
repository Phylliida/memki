# Memki

Open-source, framework-free implementation of [Anki](https://apps.ankiweb.net/):
a precise spaced-repetition core with the goal of **full round-trip interop** with
real Anki collections (`.apkg` / `.colpkg`).

- **Vanilla** — plain ES modules, no framework, no build step. The scheduling
  core has **zero runtime dependencies**.
- **Local-first** — browser app with data in IndexedDB (planned).
- **Precise** — the FSRS-6 scheduler is a faithful port of
  [`fsrs-rs`](https://github.com/open-spaced-repetition/fsrs-rs), the crate Anki
  itself links against, validated against its golden test vectors.

## Status

A working, local-first Anki: import/create decks, study with FSRS-6 or SM-2, and
export back to `.apkg`.

| Area | State |
|---|---|
| FSRS-6 memory model (`src/fsrs.js`) | ✅ matches fsrs-rs golden vectors |
| Data model (col/notes/cards/revlog/decks/models) | ✅ schema-v11; csum/base91/GUID match rslib |
| `.apkg` / `.colpkg` import + export | ✅ legacy **and modern (schema-18) packages**; import adds decks (notes dedup by GUID, decks match by name). Export is a **lossy compatibility snapshot** — see Formats |
| JSON backup / restore | ✅ one-file backup of collection + media — **the native format** |
| Sync merge engine | ✅ static-file sync core: deterministic, order-insensitive merge (revlog unions, notes by GUID, cards by note/deck/ord, delete-wins) |
| CSV / TSV import | ✅ via the header Import button (or direct screen): delimiter detect, header, column→field mapping |
| Markdown field editor (`src/markdown.js`) | ✅ fields are **markdown** (CommonMark + GFM, vendored marked — offline, no build). Media tokens are inline widgets: resizable images (`{width=N}`), audio/video players with volume; drag-drop / paste media; cloze shortcut; own **undo/redo** stack (Ctrl+Z / Ctrl+Shift+Z, toolbar ↶ ↷). LaTeX in `$…$` / `$$…$$` / `\(...\)` / `\[...\]` / `[latex]` (MathJax at render; `$` normalized to `\(` so Anki understands it too). Fenced code blocks are **syntax-highlighted** (vendored highlight.js, 192 languages). Legacy HTML fields pass through untouched |
| Day rollover | ✅ local days, configurable rollover hour (default 4 AM), creationOffset |
| Stock note types | ✅ Basic, and-reversed, optional-reversed, type-in, Cloze; conditional card generation |
| Scheduler (v3: SM-2 + FSRS, fuzz, daily limits, burying, learn-ahead) | ✅ matches rslib state-machine + fuzz vectors |
| Template renderer (fields, conditionals, **cloze**, **type-in**, MathJax) | ✅ |
| IndexedDB persistence | ✅ whole-collection + incremental card/revlog/media |
| Browser study UI (`web/`) | ✅ study (keyboard shortcuts, audio/video, note-type CSS, **undo**) |
| Browse (Anki search syntax) / edit / delete + deck management | ✅ `deck:`/`tag:`/`is:`/`prop:`/`-`/`or`; edit notes; deck tree |
| Card operations | ✅ suspend, bury, flag, forget, set due date, move deck (browser + review) |
| Deck options UI | ✅ steps, limits, intervals, ease, leech, FSRS retention/params |
| Note-type / template editor | ✅ fields (add/remove/rename), templates, CSS, with note/card migration |
| Filtered decks + custom study | ✅ build/empty (odid/odue), review-ahead / all / search presets |
| Image occlusion | ✅ self-contained editor (rectangle masks, hide-one-guess-one) |
| Statistics | ✅ counts, retention, review history + due forecast |

Not implemented (by request): AnkiWeb sync, FSRS optimizer, add-ons, TTS.

## Formats

**The JSON backup is the native format** — it captures everything, including
the parts of our model that Anki's cannot express: notes living in multiple
decks and per-deck scheduling memory. Flags are exclusive (0–7), exactly like
Anki. **`.apkg` export is a lossy compatibility snapshot** for moving cards
into Anki: the per-deck memory rides opaquely in `notes.data`, and legacy
multi-flag cards (from before flags became exclusive) degrade to their lowest
flag. Prefer JSON for backups and device-to-device transfer; use `.apkg` to
share decks with Anki users.

**Fields are markdown source.** Cards render them through marked (with math,
`[sound:]`, and image `{width=N}` extensions) at display time, and `.apkg`
export converts every field to HTML with recomputed `sfld`/`csum`, so Anki
receives its native format. In the other direction, HTML fields are converted
to markdown with turndown — on `.apkg` import and via a one-time migration of
existing collections on app load — so every note is markdown-mode. (The
HTML→markdown step is lossy for styled markup like colors and font tags;
math, `[sound:]`, cloze markers, and image widths are preserved.)

## Run the app

```bash
npm run serve   # no-cache static server on :8000 (web/serve.py)
# then open http://localhost:8000/web/
```

The whole app runs fully offline. `.apkg` import/export lazily loads vendored
sql.js + fflate + fzstd builds from `vendor/` (see the import map in
`web/index.html`); MathJax is vendored there too.

## Android app (Capacitor) / desktop save file

The same web app also runs as an Android app (Capacitor 6), and in desktop
Chrome/Edge it can use the same file-backed storage via the File System
Access API. In both, persistence switches from IndexedDB to a **save folder
you choose**: on first launch you're asked to pick a folder (SAF picker on
Android, directory picker on the web), and the collection lives there as
`memki.json` — read at startup and rewritten (debounced, atomic
tmp+rename) as you study and edit. **Media is NOT in the JSON**: images and
audio are individual files in an `memki.media/` subfolder, written when
added and fetched lazily when displayed, so reviewing a card only rewrites
the small text JSON even for huge media libraries. (Save files from before
the split are migrated on first load.)

Point a sync tool like Syncthing at that folder to keep devices in sync;
while the app is open a 3-second poll picks up external changes
(last-writer-wins, no merge). The header's **Folder** button shows/changes
the folder; **Backup** writes a fixed-name `memki-backup.json` into it
(also refreshed automatically every 15 min and on backgrounding) and greys
out when it's already up to date; **History** shows recent saves/loads. On
the web, the folder grant may need one click per browser session (none when
installed as a PWA with a persistent grant); browsers without the File
System Access API (Firefox/Safari) keep using IndexedDB.

```bash
npm install
npm run build:android   # assembles dist/ (scripts/build-capacitor.sh) + npx cap sync
# then open android/ in Android Studio, or: cd android && ./gradlew assembleDebug
```

How it fits together: `web/storage.js` picks the backend at runtime —
IndexedDB (`src/storage.js`) in plain browsers, or `web/storage-file.js`
(same function surface over the save folder) on Android, when
`showOpenFilePicker` exists, or when the companion server is reachable.
The bridge behind it is `web/native-bridge.js` (talking to the `SaveFolder`
plugin at `android/app/src/main/java/dev/phylliida/anki/SaveFolderPlugin.java`)
on Android, `web/fs-access-bridge.js` (File System Access API) on Chrome/Edge,
or `web/http-bridge.js` (companion server) on Firefox/Safari.
The save file is the standard `src/backup.js` format (minus media) plus a
`history` field, so Backup/Restore stays compatible across platforms.

### Firefox / Safari: companion file server

Those browsers don't implement the File System Access API, so they can't
write a user-chosen folder directly. Run the minimal (~100-line, audit-
friendly) Flask companion instead — the app detects it automatically:

```bash
python3 web/file-server.py /path/to/save-folder
# prints a connect URL like http://127.0.0.1:8787/web/?token=… — open it
# (serves the app too), or paste it into the app's connect gate when using
# the hosted site.
```

It binds to loopback only, requires the per-start token in an `X-Auth`
header for all `/api/*` calls (so random websites can't talk to it), and
writes atomically via tmp+rename. Detection order: native app → companion
server (when paired, or the page is served by it) → File System Access API
→ IndexedDB fallback. If the token is missing or stale (server restarted),
the app blocks with a connect gate rather than silently saving to browser
storage.

## Usage

```js
import { FSRS, Rating } from "memki/fsrs";

const fsrs = new FSRS(); // default FSRS-6 weights, 0.9 desired retention

// Review a brand-new card with "Good":
let state = fsrs.nextState(null, 0, Rating.Good);

// Some days later, see what each button would do:
const elapsedDays = 7;
const outcomes = fsrs.nextStates(state, elapsedDays);
console.log(outcomes.good.interval); // days until next review if rated "Good"
console.log(outcomes.again.state);   // memory state {stability, difficulty} if lapsed
```

`FSRS` is the pure DSR memory model (stability/difficulty/retrievability + interval
math). Queues, learning steps, due dates, fuzz, and interval caps belong to the
scheduler layer that sits on top of it — see [`docs/FSRS6.md`](docs/FSRS6.md).

## Develop

```bash
npm test   # node --test, no dependencies required
```

## License

MIT © Phylliida Dev
