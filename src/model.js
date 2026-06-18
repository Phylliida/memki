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
    newSpread: 0, nextPos: 1, sortBackwards: false, sortType: "noteFld", timeLim: 0,
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
  }

  /** A fresh, empty collection with the Default deck, default options, and Basic note type. */
  static createDefault() {
    const col = new Collection();
    const startOfDay = Math.floor(Date.now() / 86400000) * 86400; // crt at a day boundary (UTC)
    col.crt = startOfDay;
    const deck = defaultDeck(1, "Default");
    col.decks["1"] = deck;
    col.dconf["1"] = defaultDeckConfig(1, "Default");
    const modelId = nowMs();
    const nt = basicNoteType(modelId, "Basic");
    col.models[String(modelId)] = nt;
    col.conf.curModel = String(modelId);
    return col;
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

  /** Note type (model) lookup by numeric id. */
  noteType(mid) {
    return this.models[String(mid)] ?? null;
  }
  /** Sort-field index for a note type (defaults to 0). */
  sortFieldIndex(mid) {
    return this.noteType(mid)?.sortf ?? 0;
  }
}
