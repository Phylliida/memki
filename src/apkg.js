// Read real Anki packages (.apkg / .colpkg) into our data model.
//
// A package is a ZIP containing:
//   - a SQLite collection database: collection.anki21b (Zstd-compressed, newest),
//     collection.anki21, or collection.anki2 (legacy schema v11)
//   - a `media` JSON file mapping "0","1",... -> original filenames
//   - numbered blob files (the media payloads)
//
// Dependencies (only this interop layer pulls them in): fflate (unzip),
// fzstd (Zstd for .anki21b), sql.js (SQLite in WASM).
//
// sql.js needs a one-time async init that locates its .wasm differently per
// environment, so the caller initializes it and passes the module in; this
// function itself is synchronous and reusable across many packages.

import { unzipSync, zipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";

import { Collection, Note, Card, Revlog } from "./model.js";

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

  for (const r of rows(db, `select ${NOTE_COLS} from notes`)) col.addNote(Note.fromRow(r));
  for (const r of rows(db, `select ${CARD_COLS} from cards`)) col.addCard(Card.fromRow(r));
  for (const r of rows(db, `select ${REVLOG_COLS} from revlog`)) col.addRevlog(Revlog.fromRow(r));

  return col;
}

/** Map media blobs by their original filename. @returns {Map<string, Uint8Array>} */
function readMedia(files) {
  const media = new Map();
  const manifest = files["media"];
  if (!manifest) return media;
  const map = parseJsonOr(new TextDecoder().decode(manifest), {});
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
