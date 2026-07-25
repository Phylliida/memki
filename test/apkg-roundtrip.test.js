// Round-trip: import the real fixture, export it, re-import, and assert the
// collection survives byte-for-byte at the data-model level. Also exercises
// exporting a collection we build from scratch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { importPackage, exportPackage } from "../src/apkg.js";
import { initSqlJsNode } from "../src/sqljs-node.js";
import { Collection, Note, Card, NoteTypeKind } from "../src/model.js";
import { fieldChecksum } from "../src/text.js";

const SQL = await initSqlJsNode();
const fixture = fileURLToPath(new URL("./fixtures/Ukulele_Chords.apkg", import.meta.url));

const NOTE_KEYS = ["id", "guid", "mid", "mod", "usn", "tags", "fields", "sfld", "csum", "flags", "data"];
const CARD_KEYS = [
  "id", "nid", "did", "ord", "mod", "usn", "type", "queue", "due", "ivl",
  "factor", "reps", "lapses", "left", "odue", "odid", "flags", "data",
];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

test("real deck round-trips through export → re-import unchanged", () => {
  const original = importPackage(new Uint8Array(readFileSync(fixture)), { SQL });

  const out = exportPackage(original.collection, original.media, { SQL });
  assert.ok(out instanceof Uint8Array && out.length > 0);

  const round = importPackage(out, { SQL });
  const a = original.collection;
  const b = round.collection;

  // Collection-level metadata.
  assert.equal(b.ver, a.ver);
  assert.equal(b.crt, a.crt);
  assert.deepEqual(b.decks, a.decks);
  assert.deepEqual(b.models, a.models);
  assert.deepEqual(b.dconf, a.dconf);
  assert.deepEqual(b.conf, a.conf);

  // Entities.
  assert.equal(b.notes.size, a.notes.size);
  assert.equal(b.cards.size, a.cards.size);
  assert.equal(b.revlog.length, a.revlog.length);

  for (const [id, note] of a.notes) {
    assert.ok(b.notes.has(id), `note ${id} missing after round-trip`);
    assert.deepEqual(pick(b.notes.get(id), NOTE_KEYS), pick(note, NOTE_KEYS));
  }
  for (const [id, card] of a.cards) {
    assert.ok(b.cards.has(id), `card ${id} missing after round-trip`);
    assert.deepEqual(pick(b.cards.get(id), CARD_KEYS), pick(card, CARD_KEYS));
  }

  // Media: same filenames and bytes.
  assert.equal(round.media.size, original.media.size);
  for (const [name, bytes] of original.media) {
    assert.ok(round.media.has(name), `media ${name} missing`);
    assert.deepEqual(round.media.get(name), bytes);
  }
});

test("a from-scratch collection exports and re-imports", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Capital of France?", "Paris"], tags: ["geo"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1 }));

  const out = exportPackage(col, new Map(), { SQL });
  const round = importPackage(out, { SQL }).collection;

  assert.equal(round.notes.size, 1);
  assert.equal(round.cards.size, 1);
  const back = [...round.notes.values()][0];
  assert.deepEqual(back.fields, ["Capital of France?", "Paris"]);
  assert.deepEqual(back.tags, ["geo"]);
  assert.equal(back.csum, note.csum);
  assert.equal(Object.values(round.models)[0].name, "Basic");
});

test("markdown fields export as HTML with recomputed csum/sfld", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["**Capital** of France?", "Paris"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1 }));

  const out = exportPackage(col, new Map(), { SQL });
  const back = [...importPackage(out, { SQL }).collection.notes.values()][0];

  // The package holds rendered HTML; checksums are computed on that HTML
  // (Anki-consistent), not on the markdown source.
  assert.deepEqual(back.fields, ["<strong>Capital</strong> of France?", "Paris"]);
  assert.equal(back.sfld, "Capital of France?");
  assert.equal(back.csum, fieldChecksum("<strong>Capital</strong> of France?"));
});

test("field default values round-trip through export (unknown key tolerated)", () => {
  const col = Collection.createDefault();
  const nt = col.addNoteType("With Defaults", NoteTypeKind.Standard);
  nt.flds[0].default = "**prefilled**";

  const out = exportPackage(col, new Map(), { SQL });
  const round = importPackage(out, { SQL }).collection;
  const back = Object.values(round.models).find((m) => m.name === "With Defaults");
  assert.equal(back.flds[0].default, "**prefilled**");
  assert.equal(back.flds.length, 2);
});
