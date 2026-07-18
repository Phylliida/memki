# oss-anki

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
| CSV / TSV import | ✅ delimiter detect, header, column→field mapping |
| Rich-text field editor | ✅ contenteditable (bold/italic/lists/cloze/HTML toggle, **drag-drop / paste images & audio**) |
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
the parts of our model that Anki's cannot express: non-exclusive flags, notes
living in multiple decks, and per-deck scheduling memory. **`.apkg` export is a
lossy compatibility snapshot** for moving cards into Anki: multi-flags degrade
to the lowest flag, and the per-deck memory rides opaquely in `notes.data`.
Prefer JSON for backups and device-to-device transfer; use `.apkg` to share
decks with Anki users.

## Run the app

```bash
npm run serve   # no-cache static server on :8000 (web/serve.py)
# then open http://localhost:8000/web/
```

The study app (create/add cards, study, persistence) runs fully offline. `.apkg`
import/export lazily loads sql.js + fflate + fzstd from a CDN (see the import map
in `web/index.html`).

## Usage

```js
import { FSRS, Rating } from "oss-anki/fsrs";

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
