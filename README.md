# Memki

Memki is an open-source, self-hosted MIT Licened implementation of spaced repetition,
with an emphasis on feature parity with Anki (including a faithful implementation of FSRS).
You can import and export .apkg and continue where you left off,
create decks, browse cards and create filtered decks, etc.,
all implemented in vanilla js with zero runtime dependencies.

Desktop Mode and the Mobile App both store to a folder you pick. I recommend
using something like [SyncThings](https://syncthing.net/) to sync between Mobile and Desktop.

## Screenshots

<p>
  <img src="demo/Title%20Screen.jpg" width="230" alt="Deck list with per-deck due counts">
  <img src="demo/Review%20Screen.jpg" width="230" alt="Reviewing a card (question side)">
  <img src="demo/Review%20Screen%202.jpg" width="230" alt="Answer side with rendered math and grade buttons">
  <img src="demo/Edit%20Card%20Screen.jpg" width="230" alt="Add Card editor with live preview">
</p>

## Mobile App

The android apk is available in the Releases tab, and soon on various android stores. iOS is coming soon.

## Desktop App

There is a simple webui, the only dependencies are python+flask. Simply run

```
git clone https://github.com/Phylliida/memki.git
cd memki
```

Now you have the desktop app downloaded, you can run

```
python web/file-server.py
```

It will print out a link like

```
http://127.0.0.1:8787/web/?token=zS_ABCuDDBnsjsjaaFFAF
```

paste that in your browser to open the desktop app.

You can click on the path at the top to change the directory your files are stored in,
ideally pick a directory you're synchronizing with mobile via [SyncThings](https://syncthing.net/).
I recommend turning on versioning in SyncThings to help avoid accidental data loss by you accidentally deleting a file.

## Divergences from Anki

Your notes are stored in markdown (with a few extra features like left/center/right alignment and font size),
instead of the html Anki uses. Decks are auto-converted to markdown on import, and converted back to html on apkg export.

This should rarely matter in practice, but if you notice certain cases where the conversion is failing to faithfully
represent the notes feel free to make a PR or Issue and we can look into it.

Instead of having a database file, we simply have a `memki.media` folder that contains all the media, and a `memki.json`
that contains all card and deck metadata. This ensures we can write the .json very frequently (automatically) because it has no heavy media.
You can still export any deck to an .apkg compatible with Anki by going into that deck's settings.

## Library usage (npm)

The scheduling core is also a plain JS library:

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
npm test   # node --test
```

## License

MIT © Phylliida Dev
