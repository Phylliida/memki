// Read real Anki packages (.apkg / .colpkg) into our data model.
//
// A package is a ZIP containing:
//   - a SQLite collection database: collection.anki21b (Zstd-compressed, newest),
//     collection.anki21, or collection.anki2 (legacy schema v11)
//   - a `media` manifest mapping "0","1",... -> original filenames: legacy
//     packages use plain JSON; modern ones a Zstd-compressed protobuf
//   - numbered blob files (the media payloads; Zstd-compressed in modern packages)
//
// Modern exports (schema `ver` 18) leave the col table's JSON columns empty and
// store note types, decks, and options in separate tables (notetypes, fields,
// templates, decks, deck_config, config) whose config columns are protobuf
// messages; a small wire-format reader below converts them back into the
// legacy v11 JSON shapes our Collection uses.
//
// Dependencies (only this interop layer pulls them in): fflate (unzip),
// fzstd (Zstd for .anki21b), sql.js (SQLite in WASM).
//
// sql.js needs a one-time async init that locates its .wasm differently per
// environment, so the caller initializes it and passes the module in; this
// function itself is synchronous and reusable across many packages.

import { unzipSync, zipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";

import {
  Collection, Note, Card, Revlog,
  defaultConf, defaultDeck, defaultDeckConfig,
} from "./model.js";

// Exact schema-v11 DDL (genanki's, proven to import into every Anki version).
const APKG_SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null,
  usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null, flds text not null,
  sfld integer not null, csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
  type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const Q = (n) => Array(n).fill("?").join(",");

// Explicit column orders — sql.js returns columns as written, and our
// Note/Card/Revlog.fromRow expect this exact order.
const NOTE_COLS = "id,guid,mid,mod,usn,tags,flds,sfld,csum,flags,data";
const CARD_COLS =
  "id,nid,did,ord,mod,usn,type,queue,due,ivl,factor,reps,lapses,left,odue,odid,flags,data";
const REVLOG_COLS = "id,cid,usn,ease,ivl,lastIvl,factor,time,type";

/** Pick and decompress the collection database from the unzipped entries. */
function extractCollectionDb(files) {
  if (files["collection.anki21b"]) return zstdDecompress(files["collection.anki21b"]);
  if (files["collection.anki21"]) return files["collection.anki21"];
  if (files["collection.anki2"]) return files["collection.anki2"];
  throw new Error("no collection database (collection.anki2/.anki21/.anki21b) found in package");
}

/** Run a query and return rows as arrays (empty array if no result set). */
function rows(db, sql) {
  const res = db.exec(sql);
  return res.length ? res[0].values : [];
}

const parseJsonOr = (s, fallback) => {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// --- minimal protobuf wire-format reader (modern-schema packages) ---

const utf8 = new TextDecoder();

/**
 * Decode one protobuf message into Map<fieldNo, values[]>: varints as numbers,
 * length-delimited fields as Uint8Array (caller decides string vs submessage);
 * fixed32/64 are skipped (nothing we read uses them).
 */
function pbFields(bytes) {
  const fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0n;
    let s = 0n;
    for (;;) {
      const b = bytes[i++];
      if (b === undefined) throw new Error("truncated protobuf varint");
      v |= BigInt(b & 0x7f) << s;
      if ((b & 0x80) === 0) return v;
      s += 7n;
    }
  };
  while (i < bytes.length) {
    const tag = Number(varint());
    const no = tag >>> 3;
    const wire = tag & 7;
    let val;
    if (wire === 0) val = Number(varint());
    else if (wire === 1) { i += 8; continue; }
    else if (wire === 5) { i += 4; continue; }
    else if (wire === 2) {
      const len = Number(varint());
      val = bytes.subarray(i, i + len);
      i += len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (!fields.has(no)) fields.set(no, []);
    fields.get(no).push(val);
  }
  return fields;
}

const pbStr = (f, no, dflt = "") => {
  const v = f.get(no)?.[0];
  return v instanceof Uint8Array ? utf8.decode(v) : dflt;
};
const pbInt = (f, no, dflt = 0) => {
  const v = f.get(no)?.[0];
  return typeof v === "number" ? v : dflt;
};

/** True if the open database contains a table with this name. */
const hasTable = (db, name) =>
  rows(db, `select 1 from sqlite_master where type='table' and name='${name}'`).length > 0;

/**
 * Read note types, decks, deck options, and conf from a modern-schema database
 * (the col JSON columns are empty) into the legacy v11 shapes Collection uses.
 */
function readModernTables(db, col) {
  // Fields and templates, grouped by note type id. Exports can contain stray
  // rows for note types absent from `notetypes`; grouping by ntid and joining
  // from `notetypes` ignores them.
  const fldsBy = new Map();
  for (const [ntid, ord, name, config] of rows(db, "select ntid, ord, name, config from fields order by ntid, ord")) {
    const f = pbFields(config); // NoteField.Config: 2=rtl, 3=font_name, 4=font_size
    if (!fldsBy.has(ntid)) fldsBy.set(ntid, []);
    fldsBy.get(ntid).push({
      name, ord, sticky: false, rtl: pbInt(f, 2) !== 0,
      font: pbStr(f, 3, "Arial"), size: pbInt(f, 4, 20), media: [],
    });
  }
  const tmplsBy = new Map();
  for (const [ntid, ord, name, config] of rows(db, "select ntid, ord, name, config from templates order by ntid, ord")) {
    const t = pbFields(config); // Template.Config: 1=q_format, 2=a_format, 3/4=browser formats, 6/7=browser font
    if (!tmplsBy.has(ntid)) tmplsBy.set(ntid, []);
    tmplsBy.get(ntid).push({
      name, ord, qfmt: pbStr(t, 1), afmt: pbStr(t, 2),
      bqfmt: pbStr(t, 3), bafmt: pbStr(t, 4), did: null, bfont: pbStr(t, 6), bsize: pbInt(t, 7),
    });
  }
  for (const [id, name, mtime, config] of rows(db, "select id, name, mtime_secs, config from notetypes")) {
    const c = pbFields(config); // Notetype.Config: 1=kind, 2=sort_field_idx, 3=css, 5/6=latex pre/post
    const tmpls = tmplsBy.get(id) ?? [];
    col.models[String(id)] = {
      id, name, type: pbInt(c, 1), mod: mtime, usn: -1, sortf: pbInt(c, 2), did: null,
      flds: fldsBy.get(id) ?? [], tmpls,
      css: pbStr(c, 3), latexPre: pbStr(c, 5), latexPost: pbStr(c, 6), latexsvg: false,
      req: tmpls.map((t) => [t.ord, "any", [0]]), vers: [], tags: [],
    };
  }

  // Deck options: keep our defaults per group (the protobuf holds scheduling
  // knobs we don't map yet); decks reference groups by id below.
  for (const [id, name, mtime] of rows(db, "select id, name, mtime_secs from deck_config")) {
    col.dconf[String(id)] = { ...defaultDeckConfig(id, name), mod: mtime };
  }
  if (!col.dconf["1"]) col.dconf["1"] = defaultDeckConfig(1, "Default");

  // Decks: names use "\x1f" as the subdeck separator instead of "::"; `kind`
  // is a oneof — field 1 = Normal { 1: config_id }, field 2 = Filtered.
  for (const [id, name, mtime, kindBlob] of rows(db, "select id, name, mtime_secs, kind from decks")) {
    const normal = pbFields(kindBlob).get(1)?.[0];
    const deck = defaultDeck(id, name.replace(/\x1f/g, "::"));
    deck.mod = mtime;
    if (normal instanceof Uint8Array) deck.conf = pbInt(pbFields(normal), 1, 1) || 1;
    else deck.dyn = 1;
    col.decks[String(id)] = deck;
  }

  // conf: the config table stores each key's value as JSON bytes.
  col.conf = defaultConf();
  for (const [key, val] of rows(db, "select key, val from config")) {
    const parsed = parseJsonOr(typeof val === "string" ? val : utf8.decode(val), undefined);
    if (parsed !== undefined) col.conf[key] = parsed;
  }
}

/** Build a Collection from an open sql.js database. */
function readCollection(db) {
  const col = new Collection();

  const [c] = rows(db, "select crt,mod,scm,ver,dty,usn,ls,conf,models,decks,dconf,tags from col");
  if (!c) throw new Error("package has no col row");
  col.crt = c[0];
  col.mod = c[1];
  col.scm = c[2];
  col.ver = c[3];
  col.dty = c[4];
  col.usn = c[5];
  col.ls = c[6];
  col.conf = parseJsonOr(c[7], {});
  col.models = parseJsonOr(c[8], {});
  col.decks = parseJsonOr(c[9], {});
  col.dconf = parseJsonOr(c[10], {});
  col.tags = parseJsonOr(c[11], {});

  if (!Object.keys(col.models).length && hasTable(db, "notetypes")) {
    readModernTables(db, col);
    col.ver = 11; // converted to the legacy in-memory shapes we serialize
  }

  for (const r of rows(db, `select ${NOTE_COLS} from notes`)) col.addNote(Note.fromRow(r));
  for (const r of rows(db, `select ${CARD_COLS} from cards`)) col.addCard(Card.fromRow(r));
  for (const r of rows(db, `select ${REVLOG_COLS} from revlog`)) col.addRevlog(Revlog.fromRow(r));

  return col;
}

/** zstd frame magic — marks the modern media manifest and blob encoding. */
const isZstd = (b) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

/** Map media blobs by their original filename. @returns {Map<string, Uint8Array>} */
function readMedia(files) {
  const media = new Map();
  const manifest = files["media"];
  if (!manifest) return media;
  if (isZstd(manifest)) {
    // Modern package: the manifest is a Zstd-compressed protobuf MediaEntries
    // (repeated field 1 = MediaEntry { 1: name }); entry index i is blob file
    // "i", and each blob is itself Zstd-compressed.
    const entries = pbFields(zstdDecompress(manifest)).get(1) ?? [];
    entries.forEach((entry, i) => {
      const name = pbStr(pbFields(entry), 1);
      const blob = files[String(i)];
      if (name && blob) media.set(name, isZstd(blob) ? zstdDecompress(blob) : blob);
    });
    return media;
  }
  const map = parseJsonOr(utf8.decode(manifest), {});
  for (const [key, name] of Object.entries(map)) {
    if (files[key]) media.set(name, files[key]);
  }
  return media;
}

/**
 * Parse an .apkg / .colpkg package into a Collection plus its media.
 * @param {Uint8Array} bytes The package file contents.
 * @param {{ SQL: { Database: new (data: Uint8Array) => any } }} opts
 *   `SQL` is an initialized sql.js module (from `initSqlJs(...)`).
 * @returns {{ collection: Collection, media: Map<string, Uint8Array> }}
 */
export function importPackage(bytes, { SQL } = {}) {
  if (!SQL || typeof SQL.Database !== "function") {
    throw new Error("importPackage requires an initialized sql.js module: pass { SQL }");
  }
  const files = unzipSync(bytes);
  const db = new SQL.Database(extractCollectionDb(files));
  try {
    return { collection: readCollection(db), media: readMedia(files) };
  } finally {
    db.close();
  }
}

/** Serialize a Collection into a schema-v11 SQLite file (Uint8Array). */
function writeCollectionDb(SQL, col) {
  const db = new SQL.Database();
  try {
    db.run(APKG_SCHEMA);
    db.run(`INSERT INTO col VALUES (${Q(13)})`, [
      1, col.crt, col.mod, col.scm, col.ver, col.dty, col.usn, col.ls,
      JSON.stringify(col.conf), JSON.stringify(col.models),
      JSON.stringify(col.decks), JSON.stringify(col.dconf), JSON.stringify(col.tags),
    ]);

    const insertAll = (sql, rows) => {
      const stmt = db.prepare(sql);
      try {
        for (const r of rows) stmt.run(r);
      } finally {
        stmt.free();
      }
    };
    insertAll(`INSERT INTO notes VALUES (${Q(11)})`, [...col.notes.values()].map((n) => n.toRow()));
    insertAll(`INSERT INTO cards VALUES (${Q(18)})`, [...col.cards.values()].map((c) => c.toRow()));
    insertAll(`INSERT INTO revlog VALUES (${Q(9)})`, col.revlog.map((r) => r.toRow()));

    return db.export();
  } finally {
    db.close();
  }
}

/**
 * Serialize a Collection + media into an .apkg (legacy collection.anki2, schema
 * v11 — maximum compatibility; imports into every Anki version).
 * @param {Collection} collection
 * @param {Map<string, Uint8Array>} [media] filename -> bytes
 * @param {{ SQL: { Database: new (data?: Uint8Array) => any } }} opts initialized sql.js
 * @returns {Uint8Array} the .apkg file bytes
 */
export function exportPackage(collection, media = new Map(), { SQL } = {}) {
  if (!SQL || typeof SQL.Database !== "function") {
    throw new Error("exportPackage requires an initialized sql.js module: pass { SQL }");
  }
  const entries = { "collection.anki2": writeCollectionDb(SQL, collection) };

  // Media: numbered blobs + a JSON manifest mapping "0","1",... -> filename.
  const manifest = {};
  let i = 0;
  for (const [name, blob] of media) {
    const key = String(i++);
    manifest[key] = name;
    entries[key] = blob;
  }
  entries["media"] = new TextEncoder().encode(JSON.stringify(manifest));

  return zipSync(entries);
}
