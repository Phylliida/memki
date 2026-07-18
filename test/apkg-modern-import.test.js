// Import test against a modern-format .apkg (Abbreviated.apkg, exported from a
// current Anki): meta version 3, Zstd-compressed collection.anki21b with schema
// ver 18 — note types / decks / conf live in separate protobuf-encoded tables
// and the legacy collection.anki2 inside is only the "please update" stub.
//
// 3 notes / 3 cards of the "Basic" note type in an "Abbreviated" deck.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { importPackage } from "../src/apkg.js";
import { initSqlJsNode } from "../src/sqljs-node.js";
import { Note, NoteTypeKind } from "../src/model.js";

const SQL = await initSqlJsNode();
const fixture = fileURLToPath(new URL("./fixtures/Abbreviated.apkg", import.meta.url));
const { collection, media } = importPackage(new Uint8Array(readFileSync(fixture)), { SQL });

test("reads the real data, not the legacy 'please update' stub", () => {
  assert.equal(collection.notes.size, 3);
  assert.equal(collection.cards.size, 3);
  for (const note of collection.notes.values()) {
    assert.doesNotMatch(note.fields[0], /update to the latest Anki/);
  }
});

test("collection metadata converts to legacy shapes", () => {
  assert.equal(collection.crt, 1767376800);
  assert.equal(collection.ver, 11); // converted in-memory representation
  assert.equal(collection.conf.schedVer, 2);
  assert.equal(collection.conf.curDeck, 1);
});

test("protobuf note type decodes: Basic, 2 fields, 1 template", () => {
  const models = Object.values(collection.models);
  assert.equal(models.length, 1);
  const m = models[0];
  assert.equal(m.name, "Basic");
  assert.equal(m.type, NoteTypeKind.Standard);
  assert.deepEqual(m.flds.map((f) => f.name), ["Front", "Back"]);
  assert.equal(m.tmpls.length, 1);
  assert.equal(m.tmpls[0].qfmt, "{{Front}}");
  assert.match(m.tmpls[0].afmt, /\{\{FrontSide\}\}/);
  assert.match(m.css, /\.card \{/);
});

test("decks decode from protobuf kind; cards land in the imported deck", () => {
  const names = Object.values(collection.decks).map((d) => d.name).sort();
  assert.deepEqual(names, ["Abbreviated", "Default"]);
  const abbreviated = Object.values(collection.decks).find((d) => d.name === "Abbreviated");
  assert.equal(abbreviated.dyn, 0);
  for (const card of collection.cards.values()) {
    assert.equal(card.did, abbreviated.id);
  }
  assert.ok(collection.dconf[String(abbreviated.conf)], "deck's options group exists");
});

test("every note's mid resolves and renormalizing reproduces Anki's csum/sfld", () => {
  for (const note of collection.notes.values()) {
    const model = collection.noteType(note.mid);
    assert.ok(model, "note type resolves");
    const fresh = new Note({ mid: note.mid, fields: note.fields }).normalize(model.sortf ?? 0);
    assert.equal(fresh.csum, note.csum);
    assert.equal(fresh.sfld, note.sfld);
  }
});

test("modern media manifest parses (this deck has none)", () => {
  assert.equal(media.size, 0);
});
