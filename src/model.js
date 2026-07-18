// Anki data model — schema v11 entities, faithful to the SQLite layout Anki
// reads and writes. These structures are what the .apkg/.colpkg importer fills
// and the exporter serializes, and what the scheduler layer operates on.
//
// Column references (anki/rslib + AnkiDroid Database-Structure):
//   notes:  id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data
//   cards:  id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps,
//           lapses, left, odue, odid, flags, data
//   revlog: id, cid, usn, ease, ivl, lastIvl, factor, time, type
//   col:    id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags

import { joinFields, splitFields, fieldChecksum, sortField } from "./text.js";
import { newGuid, nowSec, nowMs } from "./ids.js";
import { tzOffsetMinutes, localDayStart } from "./timing.js";

// --- Enums (exact integer encodings) ---

/** cards.type */
export const CardType = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });

/** cards.queue */
export const CardQueue = Object.freeze({
  UserBuried: -3, SchedBuried: -2, Suspended: -1,
  New: 0, Learning: 1, Review: 2, DayLearning: 3, Preview: 4,
});

/** revlog.type */
export const RevlogType = Object.freeze({
  Learn: 0, Review: 1, Relearn: 2, Filtered: 3, Manual: 4, Rescheduled: 5,
});

/** models[*].type */
export const NoteTypeKind = Object.freeze({ Standard: 0, Cloze: 1 });

// --- card flags (non-exclusive) ---
//
// Anki stores a single flag number in the low 3 bits of cards.flags. We allow
// multiple flags at once: bits 3–9 hold a bitmask (bit n+2 = flag n), and the
// low 3 bits mirror the lowest active flag so exports stay Anki-readable.

/** The set of active flags on a card (numbers 1–7). */
export function cardFlagSet(card) {
  const mask = (card.flags >> 3) & 0x7f;
  if (mask) {
    const s = new Set();
    for (let n = 1; n <= 7; n++) if (mask & (1 << (n - 1))) s.add(n);
    return s;
  }
  const low = card.flags & 7; // legacy single-flag encoding
  return low ? new Set([low]) : new Set();
}

/** Write a set of flags (1–7) back into card.flags. */
export function writeCardFlags(card, set) {
  let mask = 0;
  for (const n of set) if (n >= 1 && n <= 7) mask |= 1 << (n - 1);
  const lowest = mask ? Math.min(...set) : 0;
  card.flags = (card.flags & ~0x3ff) | (mask << 3) | lowest;
}

/** Does the card carry flag n? (n = 0 means: no flags at all.) */
export function cardHasFlag(card, n) {
  const s = cardFlagSet(card);
  return n === 0 ? s.size === 0 : s.has(n);
}

// --- tags <-> string ---

/** Anki stores tags space-joined with a leading and trailing space (or ""). */
export function joinTags(tags) {
  return tags && tags.length ? ` ${tags.join(" ")} ` : "";
}
export function splitTags(s) {
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

// --- cards.data (FSRS memory state + extras) ---
// rslib CardData keys: pos, s, d, dr, decay, lrt, cd. Absent keys are omitted.

/** Parse a cards.data JSON string into a plain object ({} on empty/invalid). */
export function parseCardData(s) {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** Serialize a cards.data object, omitting unset keys (matches Anki's output). */
export function serializeCardData(d) {
  const o = {};
  if (d.pos != null) o.pos = d.pos;
  if (d.s != null) o.s = d.s;
  if (d.d != null) o.d = d.d;
  if (d.dr != null) o.dr = d.dr;
  if (d.decay != null) o.decay = d.decay;
  if (d.lrt != null) o.lrt = d.lrt;
  if (d.cd) o.cd = d.cd;
  return Object.keys(o).length ? JSON.stringify(o) : "";
}

// --- Note ---

export class Note {
  constructor({
    id = nowMs(), guid = newGuid(), mid = 0, mod = nowSec(), usn = -1,
    tags = [], fields = [], sfld = null, csum = null, flags = 0, data = "",
  } = {}) {
    this.id = id;
    this.guid = guid;
    this.mid = mid;          // note type (model) id
    this.mod = mod;
    this.usn = usn;
    this.tags = tags;        // string[]
    this.fields = fields;    // string[]
    this.sfld = sfld;        // sort field text (computed by normalize)
    this.csum = csum;        // u32 (computed by normalize)
    this.flags = flags;
    this.data = data;
  }

  /** Recompute sfld + csum from the current fields. @param {number} [sortIdx] */
  normalize(sortIdx = 0) {
    this.sfld = sortField(this.fields, sortIdx);
    this.csum = fieldChecksum(this.fields[0] ?? "");
    return this;
  }

  /** Row in `notes` column order. */
  toRow() {
    return [
      this.id, this.guid, this.mid, this.mod, this.usn,
      joinTags(this.tags), joinFields(this.fields),
      this.sfld, this.csum, this.flags, this.data,
    ];
  }

  static fromRow(r) {
    return new Note({
      id: r[0], guid: r[1], mid: r[2], mod: r[3], usn: r[4],
      tags: splitTags(r[5]), fields: splitFields(r[6]),
      sfld: r[7], csum: r[8], flags: r[9], data: r[10] ?? "",
    });
  }
}

// --- Card ---

export class Card {
  constructor({
    id = nowMs(), nid = 0, did = 1, ord = 0, mod = nowSec(), usn = -1,
    type = CardType.New, queue = CardQueue.New, due = 0, ivl = 0, factor = 0,
    reps = 0, lapses = 0, left = 0, odue = 0, odid = 0, flags = 0, data = "",
  } = {}) {
    this.id = id;
    this.nid = nid;          // note id
    this.did = did;          // deck id
    this.ord = ord;          // template/cloze index
    this.mod = mod;
    this.usn = usn;
    this.type = type;
    this.queue = queue;
    this.due = due;
    this.ivl = ivl;          // interval (days; review cards)
    this.factor = factor;    // ease in permille (SM-2)
    this.reps = reps;
    this.lapses = lapses;
    this.left = left;        // a*1000+b (learning steps)
    this.odue = odue;
    this.odid = odid;
    this.flags = flags;
    this.data = data;        // JSON: FSRS state + extras
  }

  /** FSRS memory state from data, or null. @returns {{stability:number,difficulty:number}|null} */
  get memoryState() {
    const d = parseCardData(this.data);
    return d.s != null && d.d != null ? { stability: d.s, difficulty: d.d } : null;
  }

  /** Write FSRS memory state into data (pass null to clear). */
  set memoryState(state) {
    const d = parseCardData(this.data);
    if (state == null) {
      delete d.s;
      delete d.d;
    } else {
      d.s = state.stability;
      d.d = state.difficulty;
    }
    this.data = serializeCardData(d);
  }

  /** Per-card desired retention (data.dr), or null. */
  get desiredRetention() {
    const d = parseCardData(this.data);
    return d.dr ?? null;
  }
  set desiredRetention(v) {
    const d = parseCardData(this.data);
    if (v == null) delete d.dr; else d.dr = v;
    this.data = serializeCardData(d);
  }

  toRow() {
    return [
      this.id, this.nid, this.did, this.ord, this.mod, this.usn,
      this.type, this.queue, this.due, this.ivl, this.factor,
      this.reps, this.lapses, this.left, this.odue, this.odid, this.flags, this.data,
    ];
  }

  static fromRow(r) {
    return new Card({
      id: r[0], nid: r[1], did: r[2], ord: r[3], mod: r[4], usn: r[5],
      type: r[6], queue: r[7], due: r[8], ivl: r[9], factor: r[10],
      reps: r[11], lapses: r[12], left: r[13], odue: r[14], odid: r[15],
      flags: r[16], data: r[17] ?? "",
    });
  }
}

// --- Revlog ---

export class Revlog {
  constructor({
    id = nowMs(), cid = 0, usn = -1, ease = 0, ivl = 0, lastIvl = 0,
    factor = 0, time = 0, type = RevlogType.Review,
  } = {}) {
    this.id = id;            // ms timestamp of the review
    this.cid = cid;
    this.usn = usn;
    this.ease = ease;        // button: 1..4 (review) / 1..3 (learn)
    this.ivl = ivl;          // interval used (negative = seconds, positive = days)
    this.lastIvl = lastIvl;
    this.factor = factor;
    this.time = time;        // duration in ms (capped at 60000)
    this.type = type;
  }

  toRow() {
    return [this.id, this.cid, this.usn, this.ease, this.ivl, this.lastIvl, this.factor, this.time, this.type];
  }

  static fromRow(r) {
    return new Revlog({
      id: r[0], cid: r[1], usn: r[2], ease: r[3], ivl: r[4],
      lastIvl: r[5], factor: r[6], time: r[7], type: r[8],
    });
  }
}

// --- Defaults for a fresh collection (genanki-proven shapes, valid for import) ---

export function defaultConf() {
  return {
    activeDecks: [1], addToCur: true, collapseTime: 1200, curDeck: 1,
    curModel: null, dueCounts: true, estTimes: true, newBury: true,
    newSpread: 0, nextPos: 1, rollover: 4, sortBackwards: false,
    sortType: "noteFld", timeLim: 0,
  };
}

export function defaultDeck(id = 1, name = "Default") {
  return {
    id, name, collapsed: false, conf: 1, desc: "", dyn: 0,
    extendNew: 10, extendRev: 50, lrnToday: [0, 0], newToday: [0, 0],
    revToday: [0, 0], timeToday: [0, 0], mod: nowSec(), usn: -1,
  };
}

export function defaultDeckConfig(id = 1, name = "Default") {
  return {
    id, name, autoplay: true, maxTaken: 60, mod: 0, replayq: true, timer: 0, usn: -1,
    new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
    rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
  };
}

const DEFAULT_CSS =
  ".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n";
const DEFAULT_LATEX_PRE =
  "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n" +
  "\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n";
const DEFAULT_LATEX_POST = "\\end{document}";

function mkField(name, ord) {
  return { name, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [] };
}
function mkTemplate(name, ord, qfmt, afmt) {
  return { name, ord, qfmt, afmt, bqfmt: "", bafmt: "", did: null, bfont: "", bsize: 0 };
}

/** A standard two-field "Basic" note type (Front/Back, one template). */
export function basicNoteType(id, name = "Basic") {
  return {
    id, name, type: NoteTypeKind.Standard, mod: nowSec(), usn: -1, sortf: 0, did: null,
    flds: [mkField("Front", 0), mkField("Back", 1)],
    tmpls: [mkTemplate("Card 1", 0, "{{Front}}", "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}")],
    css: DEFAULT_CSS, latexPre: DEFAULT_LATEX_PRE, latexPost: DEFAULT_LATEX_POST, latexsvg: false,
    req: [[0, "any", [0]]], vers: [], tags: [],
  };
}

/** "Basic (and reversed card)": Front→Back plus Back→Front. */
export function basicReversedNoteType(id, name = "Basic (and reversed card)") {
  const nt = basicNoteType(id, name);
  nt.tmpls.push(mkTemplate("Card 2", 1, "{{Back}}", "{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}"));
  nt.req = [[0, "any", [0]], [1, "any", [1]]];
  return nt;
}

/** "Basic (optional reversed card)": the reverse only exists when Add Reverse is set. */
export function basicOptionalReversedNoteType(id, name = "Basic (optional reversed card)") {
  const nt = basicNoteType(id, name);
  nt.flds.push(mkField("Add Reverse", 2));
  nt.tmpls.push(mkTemplate("Card 2", 1,
    "{{#Add Reverse}}{{Back}}{{/Add Reverse}}",
    "{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}"));
  nt.req = [[0, "any", [0]], [1, "all", [1, 2]]];
  return nt;
}

/** "Basic (type in the answer)". */
export function basicTypeNoteType(id, name = "Basic (type in the answer)") {
  const nt = basicNoteType(id, name);
  nt.tmpls[0].qfmt = "{{Front}}\n\n{{type:Back}}";
  nt.tmpls[0].afmt = "{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}";
  return nt;
}

const CLOZE_CSS = `${DEFAULT_CSS}.cloze {\n font-weight: bold;\n color: blue;\n}\n.nightMode .cloze {\n color: lightblue;\n}\n`;

/** A "Cloze" note type (Text / Back Extra, one cloze template). */
export function clozeNoteType(id, name = "Cloze") {
  return {
    id, name, type: NoteTypeKind.Cloze, mod: nowSec(), usn: -1, sortf: 0, did: null,
    flds: [mkField("Text", 0), mkField("Back Extra", 1)],
    tmpls: [mkTemplate("Cloze", 0, "{{cloze:Text}}", "{{cloze:Text}}<br>\n{{Back Extra}}")],
    css: CLOZE_CSS, latexPre: DEFAULT_LATEX_PRE, latexPost: DEFAULT_LATEX_POST, latexsvg: false,
    req: [], vers: [], tags: [],
  };
}

/**
 * An image-occlusion note type (oss-anki's own, marked with `ossIO: true`).
 * Fields: Image (media filename), Masks (JSON array of {x,y,w,h} fractions),
 * Header, Back Extra. The UI renders these specially (image + SVG masks); one
 * card is generated per mask. Not wire-compatible with Anki's own IO format.
 */
export function imageOcclusionNoteType(id, name = "Image Occlusion") {
  return {
    id, name, type: NoteTypeKind.Standard, mod: nowSec(), usn: -1, sortf: 2, did: null,
    ossIO: true,
    flds: [mkField("Image", 0), mkField("Masks", 1), mkField("Header", 2), mkField("Back Extra", 3)],
    tmpls: [mkTemplate("Occlusion", 0, "{{Header}}", "{{Header}}<br>{{Back Extra}}")],
    css: DEFAULT_CSS, latexPre: DEFAULT_LATEX_PRE, latexPost: DEFAULT_LATEX_POST, latexsvg: false,
    req: [], vers: [], tags: [],
  };
}

// --- Collection container ---

export class Collection {
  constructor() {
    this.crt = 0;            // creation time (seconds; day boundary)
    this.mod = nowMs();      // last modified (ms)
    this.scm = nowMs();      // schema modification time (ms)
    this.ver = 11;           // schema version
    this.dty = 0;
    this.usn = 0;
    this.ls = 0;             // last sync
    this.conf = defaultConf();
    this.models = {};        // id(string) -> note type
    this.decks = {};         // id(string) -> deck
    this.dconf = {};         // id(string) -> deck config
    this.tags = {};          // tag cache
    /** @type {Map<number, Note>} */
    this.notes = new Map();
    /** @type {Map<number, Card>} */
    this.cards = new Map();
    /** @type {Revlog[]} */
    this.revlog = [];
    /** Deletion tombstones for sync ({ usn, oid, type }); type 0=card 1=note 2=deck. */
    this.graves = [];
  }

  /** A fresh, empty collection with the Default deck, default options, and Basic note type. */
  static createDefault() {
    const col = new Collection();
    // crt at the start of the *local* day (midnight), like Anki; the rollover
    // hour in conf shifts the scheduling-day boundary (default 4 AM).
    const now = Math.floor(Date.now() / 1000);
    col.crt = localDayStart(now);
    col.conf.creationOffset = tzOffsetMinutes(now);
    const deck = defaultDeck(1, "Default");
    col.decks["1"] = deck;
    col.dconf["1"] = defaultDeckConfig(1, "Default");
    // The stock note types Anki ships with.
    let id = nowMs();
    for (const factory of [basicNoteType, basicReversedNoteType, basicOptionalReversedNoteType, basicTypeNoteType, clozeNoteType]) {
      const nt = factory(id++);
      col.models[String(nt.id)] = nt;
    }
    col.conf.curModel = String(Object.values(col.models).find((m) => m.name === "Basic").id);
    return col;
  }

  /** Add one of the stock note types by factory, skipping if the name exists. */
  addStockNoteType(factory) {
    const probe = factory(0);
    const existing = Object.values(this.models).find((m) => m.name === probe.name);
    if (existing) return existing;
    const nt = factory(this.nextId());
    this.models[String(nt.id)] = nt;
    return nt;
  }

  /**
   * A unique, strictly-increasing millisecond id. Anki derives ids from the
   * clock but bumps forward to avoid collisions when creating many at once.
   */
  nextId() {
    this._lastId = Math.max((this._lastId ?? 0) + 1, nowMs());
    return this._lastId;
  }

  /** Add a note, assigning a fresh unique id if it's missing or already taken. */
  addNote(note) {
    if (note.id == null || this.notes.has(note.id)) note.id = this.nextId();
    else this._lastId = Math.max(this._lastId ?? 0, note.id);
    this.notes.set(note.id, note);
    return note;
  }
  /** Add a card, assigning a fresh unique id if it's missing or already taken. */
  addCard(card) {
    if (card.id == null || this.cards.has(card.id)) card.id = this.nextId();
    else this._lastId = Math.max(this._lastId ?? 0, card.id);
    this.cards.set(card.id, card);
    return card;
  }
  addRevlog(entry) {
    this.revlog.push(entry);
    return entry;
  }

  /** Cards belonging to a note. */
  cardsForNote(noteId) {
    return [...this.cards.values()].filter((c) => c.nid === noteId);
  }

  // --- per-deck scheduling memory (stored on the note, never discarded) ---
  //
  // The note is the durable home of scheduling state: note.data holds a
  // "sched" map keyed by `deckName \x1f ord` with the card's scheduling
  // columns (and its id, so review history re-links). Removing a note from a
  // deck archives there; re-adding restores it. Keyed by deck NAME so the
  // memory survives even deleting and recreating a deck.

  _noteData(note) {
    try {
      const o = JSON.parse(note.data || "{}");
      return o && typeof o === "object" ? o : {};
    } catch {
      return {};
    }
  }

  _deckKey(did, ord) {
    return `${this.decks[String(did)]?.name ?? String(did)}\x1f${ord}`;
  }

  /** Snapshot a card's scheduling onto its note, keyed by deck name + ord. */
  _archiveCardState(note, card) {
    const d = this._noteData(note);
    d.sched ??= {};
    d.sched[this._deckKey(card.did, card.ord)] = {
      id: card.id, type: card.type, queue: card.queue, due: card.due,
      ivl: card.ivl, factor: card.factor, reps: card.reps, lapses: card.lapses,
      left: card.left, data: card.data,
    };
    note.data = JSON.stringify(d);
  }

  /**
   * Remove a note's cards from a deck, archiving their scheduling on the
   * note first (the metadata never goes away). Returns the deleted card ids.
   */
  removeNoteFromDeck(noteId, did) {
    const note = this.notes.get(noteId);
    const cards = this.cardsForNote(noteId).filter((c) => c.did === did);
    for (const c of cards) {
      if (note) this._archiveCardState(note, c);
      this.cards.delete(c.id);
      this.graves.push({ usn: -1, oid: c.id, type: 0 });
    }
    return cards.map((c) => c.id);
  }

  /**
   * Materialize a note's card for (deck, ord): restores the scheduling the
   * note remembers for that deck if it has any (including the old card id,
   * so revlog history reattaches), else creates a fresh new card.
   */
  addNoteCardToDeck(note, did, ord) {
    const snap = this._noteData(note).sched?.[this._deckKey(did, ord)];
    if (snap) {
      const props = {
        nid: note.id, did, ord, type: snap.type, queue: snap.queue, due: snap.due,
        ivl: snap.ivl, factor: snap.factor, reps: snap.reps, lapses: snap.lapses,
        left: snap.left, data: snap.data ?? "",
      };
      if (snap.id != null && !this.cards.has(snap.id)) {
        props.id = snap.id;
        // The old removal tombstoned this id; clear it so a sync's
        // delete-wins pass doesn't kill the restored card.
        this.graves = this.graves.filter((g) => !(g.type === 0 && g.oid === snap.id));
      }
      return this.addCard(new Card(props));
    }
    const due = this.conf.nextPos ?? 1;
    this.conf.nextPos = due + 1;
    return this.addCard(new Card({ nid: note.id, did, ord, due }));
  }

  /** Create a filtered (dynamic) deck. Returns the deck. */
  createFilteredDeck(name) {
    const id = this.nextId();
    const d = defaultDeck(id, name);
    d.dyn = 1;
    this.decks[String(id)] = d;
    return d;
  }

  /**
   * Create an independent deck containing fresh copies of the given cards
   * (one per note/template pair): same notes, brand-new scheduling, and its
   * own options group. The original cards are untouched — decks are their
   * own thing.
   * @returns {{ deck: object, count: number }}
   */
  cloneCardsIntoNewDeck(name, cards) {
    const deck = this.addDeck(name);
    const dcId = this.nextId();
    this.dconf[String(dcId)] = defaultDeckConfig(dcId, name);
    deck.conf = dcId;
    const seen = new Set();
    let count = 0;
    for (const c of cards) {
      const key = `${c.nid}:${c.ord}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const note = this.notes.get(c.nid);
      if (!note) continue;
      // Fresh cards — unless the note remembers scheduling for a previous
      // deck of this same name, which is restored.
      this.addNoteCardToDeck(note, deck.id, c.ord);
      count++;
    }
    return { deck, count };
  }

  /** Create a deck (name may contain "::" for subdecks). Returns the deck. */
  addDeck(name) {
    const existing = Object.values(this.decks).find((d) => d.name === name);
    if (existing) return existing;
    const id = this.nextId();
    this.decks[String(id)] = defaultDeck(id, name);
    return this.decks[String(id)];
  }

  /** Rename a deck, carrying its subdecks along (prefix rewrite). */
  renameDeck(id, newName) {
    const deck = this.decks[String(id)];
    if (!deck) return;
    const prefix = `${deck.name}::`;
    const renames = [];
    for (const d of Object.values(this.decks)) {
      if (d.id === id) {
        renames.push([d.name, newName]);
        d.name = newName;
      } else if (d.name.startsWith(prefix)) {
        const nn = newName + "::" + d.name.slice(prefix.length);
        renames.push([d.name, nn]);
        d.name = nn;
      }
    }
    // The notes' per-deck scheduling memory is keyed by deck name — carry it.
    for (const note of this.notes.values()) {
      const d = this._noteData(note);
      if (!d.sched) continue;
      let changed = false;
      for (const [oldN, newN] of renames) {
        for (const key of Object.keys(d.sched)) {
          if (key.startsWith(`${oldN}\x1f`)) {
            d.sched[newN + key.slice(oldN.length)] = d.sched[key];
            delete d.sched[key];
            changed = true;
          }
        }
      }
      if (changed) note.data = JSON.stringify(d);
    }
  }

  /**
   * Delete a deck and its subdecks, along with their cards (and any notes left
   * with no cards). Records graves. The Default deck (id 1) is not deletable.
   */
  removeDeck(id) {
    const deck = this.decks[String(id)];
    if (!deck || Number(id) === 1) return;
    const prefix = `${deck.name}::`;
    const ids = new Set([Number(id)]);
    for (const d of Object.values(this.decks)) if (d.name.startsWith(prefix)) ids.add(d.id);

    const affectedNotes = new Set();
    for (const c of [...this.cards.values()]) {
      if (ids.has(c.did)) {
        affectedNotes.add(c.nid);
        // Archive scheduling on the note — recreating a same-named deck and
        // re-adding the note restores it.
        const note = this.notes.get(c.nid);
        if (note) this._archiveCardState(note, c);
        this.cards.delete(c.id);
        this.graves.push({ usn: -1, oid: c.id, type: 0 });
      }
    }
    for (const nid of affectedNotes) {
      if (this.cardsForNote(nid).length === 0) {
        this.notes.delete(nid);
        this.graves.push({ usn: -1, oid: nid, type: 1 });
      }
    }
    for (const did of ids) {
      delete this.decks[String(did)];
      this.graves.push({ usn: -1, oid: did, type: 2 });
    }
  }

  /** Remove a note and all its cards, recording graves. Returns deleted card ids. */
  removeNote(noteId) {
    const cardIds = this.cardsForNote(noteId).map((c) => c.id);
    for (const id of cardIds) {
      this.cards.delete(id);
      this.graves.push({ usn: -1, oid: id, type: 0 });
    }
    this.notes.delete(noteId);
    this.graves.push({ usn: -1, oid: noteId, type: 1 });
    return cardIds;
  }

  /** Note type (model) lookup by numeric id. */
  noteType(mid) {
    return this.models[String(mid)] ?? null;
  }

  /**
   * Change a note's type. Fields are remapped per `fieldMap` (index into the
   * old fields for each new field, or -1/null for blank). All old cards are
   * deleted (scheduling starts fresh — including the note's per-deck memory);
   * tags stay on the note, and the caller recreates cards in the returned
   * decks, carrying the returned flag set.
   * @param {number[]} fieldMap newFieldIdx -> oldFieldIdx | -1
   * @returns {{ decks: number[], flags: Set<number>, deletedIds: number[] } | null}
   */
  changeNoteType(noteId, newMid, fieldMap) {
    const note = this.notes.get(noteId);
    const newModel = this.noteType(newMid);
    if (!note || !newModel) return null;
    const oldCards = this.cardsForNote(noteId);
    const decks = [...new Set(oldCards.map((c) => c.did))];
    const flags = new Set();
    for (const c of oldCards) for (const f of cardFlagSet(c)) flags.add(f);
    const deletedIds = oldCards.map((c) => c.id);
    for (const c of oldCards) {
      this.cards.delete(c.id);
      this.graves.push({ usn: -1, oid: c.id, type: 0 });
    }
    const oldFields = note.fields;
    note.fields = newModel.flds.map((_f, i) => {
      const src = fieldMap[i];
      return src != null && src >= 0 ? oldFields[src] ?? "" : "";
    });
    note.mid = newMid;
    note.mod = nowSec();
    const d = this._noteData(note);
    delete d.sched; // fresh metadata everywhere, per the type change's meaning
    note.data = Object.keys(d).length ? JSON.stringify(d) : "";
    note.normalize(newModel.sortf ?? 0);
    return { decks, flags, deletedIds };
  }

  /** Notes of a given note type. */
  notesOfType(mid) {
    return [...this.notes.values()].filter((n) => n.mid === mid);
  }

  // --- note-type editing (migrates affected notes/cards) ---

  /** Create a Standard or Cloze note type. */
  addNoteType(name, kind = NoteTypeKind.Standard) {
    const id = this.nextId();
    const nt = kind === NoteTypeKind.Cloze ? clozeNoteType(id, name) : basicNoteType(id, name);
    this.models[String(id)] = nt;
    return nt;
  }

  renameField(mid, ord, name) {
    const f = this.noteType(mid)?.flds[ord];
    if (f) f.name = name;
  }

  /** Append a field to a note type; existing notes get a trailing empty field. */
  addField(mid, name) {
    const nt = this.noteType(mid);
    if (!nt) return;
    nt.flds.push(mkField(name, nt.flds.length));
    for (const note of this.notesOfType(mid)) note.fields.push("");
  }

  /** Remove a field (and that field's value from every note), reindexing. */
  removeField(mid, ord) {
    const nt = this.noteType(mid);
    if (!nt || nt.flds.length <= 1) return;
    nt.flds.splice(ord, 1);
    nt.flds.forEach((f, i) => { f.ord = i; });
    if ((nt.sortf ?? 0) >= nt.flds.length) nt.sortf = 0;
    for (const note of this.notesOfType(mid)) {
      note.fields.splice(ord, 1);
      note.normalize(nt.sortf ?? 0);
    }
  }

  setTemplate(mid, ord, { name, qfmt, afmt } = {}) {
    const t = this.noteType(mid)?.tmpls[ord];
    if (!t) return;
    if (name != null) t.name = name;
    if (qfmt != null) t.qfmt = qfmt;
    if (afmt != null) t.afmt = afmt;
  }

  /** Add a template to a Standard note type; generates a card per existing note. */
  addTemplate(mid, name, qfmt, afmt) {
    const nt = this.noteType(mid);
    if (!nt || nt.type === NoteTypeKind.Cloze) return;
    const ord = nt.tmpls.length;
    nt.tmpls.push(mkTemplate(name, ord, qfmt, afmt));
    for (const note of this.notesOfType(mid)) {
      const did = this.cardsForNote(note.id)[0]?.did ?? 1;
      const due = this.conf.nextPos ?? 1;
      this.conf.nextPos = due + 1;
      this.addCard(new Card({ nid: note.id, did, ord, due, type: CardType.New, queue: CardQueue.New }));
    }
  }

  /** Remove a template (and its cards), shifting higher ordinals down. */
  removeTemplate(mid, ord) {
    const nt = this.noteType(mid);
    if (!nt || nt.type === NoteTypeKind.Cloze || nt.tmpls.length <= 1) return;
    nt.tmpls.splice(ord, 1);
    nt.tmpls.forEach((t, i) => { t.ord = i; });
    for (const c of [...this.cards.values()]) {
      const note = this.notes.get(c.nid);
      if (!note || note.mid !== mid) continue;
      if (c.ord === ord) {
        this.cards.delete(c.id);
        this.graves.push({ usn: -1, oid: c.id, type: 0 });
      } else if (c.ord > ord) {
        c.ord -= 1;
      }
    }
  }

  setCss(mid, css) {
    const nt = this.noteType(mid);
    if (nt) nt.css = css;
  }
  /** Sort-field index for a note type (defaults to 0). */
  sortFieldIndex(mid) {
    return this.noteType(mid)?.sortf ?? 0;
  }
}
