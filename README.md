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

Early. Building the core library first.

| Area | State |
|---|---|
| FSRS-6 memory model (`src/fsrs.js`) | ✅ implemented, matches fsrs-rs golden vectors |
| Formula reference (`docs/FSRS6.md`) | ✅ |
| Data model (col/notes/cards/revlog/decks/models) | ✅ schema-v11 entities, csum/base91/GUID match rslib |
| `.apkg` / `.colpkg` import (read real collections) | ✅ reads a real deck; recomputed csum/sfld match Anki |
| `.apkg` export (write real collections) | ✅ schema-v11; real deck round-trips import→export→import |
| Scheduler (v3: SM-2 + FSRS card lifecycle) | ✅ matches rslib state-machine vectors; answer-card flow + revlog |
| IndexedDB persistence | ⬜ planned |
| Browser UI | ⬜ planned |

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
