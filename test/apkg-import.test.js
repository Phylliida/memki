// Import test against a real .apkg exported from Anki (Ukulele_Chords.apkg):
// 35 notes, 70 cards (Basic-and-reversed -> 2 templates), a Chords::Ukulele
// Chords subdeck, 35 SVG media files, schema v11, no FSRS state.
//
// The strongest check here: for every real note, re-normalizing our model from
// its stored fields must reproduce the csum (and sort field) that *Anki itself*
// wrote — validating our SHA-1 / strip-html / checksum against ground truth.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { importPackage } from "../src/apkg.js";
import { initSqlJsNode } from "../src/sqljs-node.js";
import { Note } from "../src/model.js";

const SQL = await initSqlJsNode();
const fixture = fileURLToPath(new URL("./fixtures/Ukulele_Chords.apkg", import.meta.url));
const { collection, media } = importPackage(new Uint8Array(readFileSync(fixture)), { SQL });

test("collection metadata parses", () => {
  assert.equal(collection.ver, 11);
  assert.equal(collection.crt, 1587358750);
  assert.equal(typeof collection.conf, "object");
});

test("notes, cards, revlog counts match the real deck", () => {
  assert.equal(collection.notes.size, 35);
  assert.equal(collection.cards.size, 70); // 35 notes x 2 templates
  assert.equal(collection.revlog.length, 0);
});

test("decks include the Chords subdeck; one note type with 2 fields/2 templates", () => {
  const deckNames = Object.values(collection.decks).map((d) => d.name).sort();
  assert.deepEqual(deckNames, ["Chords::Ukulele Chords", "Default"]);

  const models = Object.values(collection.models);
  assert.equal(models.length, 1);
  assert.match(models[0].name, /^Basic \(and reversed card\)/);
  assert.equal(models[0].flds.length, 2);
  assert.equal(models[0].tmpls.length, 2);
});

test("media map resolves numbered blobs to original filenames", () => {
  assert.equal(media.size, 35);
  assert.ok(media.has("Uke_A.svg"));
  const svg = new TextDecoder().decode(media.get("Uke_A.svg"));
  assert.match(svg, /<svg|<\?xml/i); // it's really an SVG
});

test("a card carries no FSRS state (pre-FSRS export)", () => {
  const card = collection.cards.values().next().value;
  assert.equal(card.memoryState, null);
});

test("re-normalizing every note reproduces Anki's stored csum and sfld", () => {
  const sortIdx = Object.values(collection.models)[0].sortf ?? 0;
  let checked = 0;
  for (const note of collection.notes.values()) {
    const fresh = new Note({ mid: note.mid, fields: note.fields }).normalize(sortIdx);
    assert.equal(fresh.csum, note.csum, `csum mismatch for fields=${JSON.stringify(note.fields)}`);
    assert.equal(fresh.sfld, note.sfld, `sfld mismatch for fields=${JSON.stringify(note.fields)}`);
    checked++;
  }
  assert.equal(checked, 35);
});
