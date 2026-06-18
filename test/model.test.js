// Tests for the data model: golden vectors from anki/rslib (field_checksum,
// anki_base91) plus encoding round-trips and the cards.data FSRS schema.

import test from "node:test";
import assert from "node:assert/strict";

import { sha1Hex } from "../src/sha1.js";
import { fieldChecksum, joinFields, splitFields, stripHtml, stripHtmlPreservingMediaFilenames } from "../src/text.js";
import { base91 } from "../src/ids.js";
import {
  Note, Card, Revlog, Collection, CardType, CardQueue,
  parseCardData, serializeCardData, joinTags, splitTags,
} from "../src/model.js";

test("sha1 matches the standard 'test' vector", () => {
  assert.equal(sha1Hex("test"), "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
});

test("field checksum matches rslib golden values", () => {
  // rslib notes/mod.rs test_field_checksum
  assert.equal(fieldChecksum("test"), 2840236005);
  assert.equal(fieldChecksum("今日"), 1464653051);
});

test("base91 matches rslib anki_base91 golden values", () => {
  // rslib notes/mod.rs test_base91
  assert.equal(base91(0), "");
  assert.equal(base91(1), "b");
  assert.equal(base91(1234567890), "saAKk");
  assert.equal(base91(18446744073709551615n), "Rj&Z5m[>Zp"); // u64::MAX
});

test("fields round-trip through the 0x1f separator", () => {
  const fields = ["Front side", "Back <b>side</b>", "third"];
  assert.equal(joinFields(fields), "Front side\x1fBack <b>side</b>\x1fthird");
  assert.deepEqual(splitFields(joinFields(fields)), fields);
});

test("strip_html and media-preserving variant", () => {
  assert.equal(stripHtml("t<b>e</b>st"), "test");
  assert.equal(stripHtml("a&amp;b&nbsp;c"), "a&b c");
  // rslib surrounds the preserved filename with spaces (untrimmed).
  assert.equal(stripHtmlPreservingMediaFilenames('<img src="cat.jpg">'), " cat.jpg ");
  assert.equal(stripHtmlPreservingMediaFilenames("plain text"), "plain text");
});

test("csum uses the media-preserving strip (filename survives, space-padded)", () => {
  // <img src="test"> strips to " test " (with spaces), per Anki.
  assert.equal(fieldChecksum('<img src="test">'), fieldChecksum(" test "));
});

test("tags join/split match Anki's space-padded format", () => {
  assert.equal(joinTags(["a", "b"]), " a b ");
  assert.equal(joinTags([]), "");
  assert.deepEqual(splitTags(" a b "), ["a", "b"]);
  assert.deepEqual(splitTags(""), []);
});

test("cards.data FSRS state round-trips", () => {
  assert.deepEqual(parseCardData(""), {});
  assert.deepEqual(parseCardData("not json"), {});
  const s = serializeCardData({ pos: 3, s: 12.5, d: 6.25 });
  assert.deepEqual(JSON.parse(s), { pos: 3, s: 12.5, d: 6.25 });
  // unset keys are omitted
  assert.equal(serializeCardData({}), "");
});

test("Note normalize computes sfld and csum; row round-trips", () => {
  const note = new Note({ mid: 1234, fields: ["<b>Hello</b>", "World"], tags: ["greeting", "demo"] });
  note.normalize();
  assert.equal(note.sfld, "Hello");
  assert.equal(note.csum, fieldChecksum("<b>Hello</b>"));

  const row = note.toRow();
  const back = Note.fromRow(row);
  assert.equal(back.mid, 1234);
  assert.deepEqual(back.fields, ["<b>Hello</b>", "World"]);
  assert.deepEqual(back.tags, ["greeting", "demo"]);
});

test("Card memoryState getter/setter writes through data; row round-trips", () => {
  const card = new Card({ nid: 99, did: 1, type: CardType.Review, queue: CardQueue.Review, ivl: 10, factor: 2500 });
  assert.equal(card.memoryState, null);
  card.memoryState = { stability: 20.5, difficulty: 5.5 };
  assert.deepEqual(card.memoryState, { stability: 20.5, difficulty: 5.5 });
  assert.deepEqual(JSON.parse(card.data), { s: 20.5, d: 5.5 });

  const back = Card.fromRow(card.toRow());
  assert.deepEqual(back.memoryState, { stability: 20.5, difficulty: 5.5 });
  assert.equal(back.ivl, 10);
  assert.equal(back.factor, 2500);
  assert.equal(back.queue, CardQueue.Review);
});

test("removeNote deletes the note + its cards and records graves", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1, ord: 0 }));
  col.addCard(new Card({ nid: note.id, did: 1, ord: 1 }));

  const deleted = col.removeNote(note.id);
  assert.equal(deleted.length, 2);
  assert.equal(col.notes.size, 0);
  assert.equal(col.cards.size, 0);
  // one card grave per card + one note grave
  assert.equal(col.graves.filter((g) => g.type === 0).length, 2);
  assert.equal(col.graves.filter((g) => g.type === 1).length, 1);
});

test("Revlog row round-trips in column order", () => {
  const r = new Revlog({ id: 1700000000000, cid: 42, ease: 3, ivl: 4, lastIvl: 1, factor: 2500, time: 1234, type: 0 });
  assert.deepEqual(Revlog.fromRow(r.toRow()), r);
});

test("Collection.createDefault has Default deck, options, and Basic note type", () => {
  const col = Collection.createDefault();
  assert.equal(col.ver, 11);
  assert.ok(col.decks["1"] && col.decks["1"].name === "Default");
  assert.ok(col.dconf["1"] && col.dconf["1"].new.initialFactor === 2500);
  const models = Object.values(col.models);
  assert.deepEqual(models.map((m) => m.name).sort(), ["Basic", "Cloze"]);
  const basic = models.find((m) => m.name === "Basic");
  assert.deepEqual(basic.flds.map((f) => f.name), ["Front", "Back"]);
  assert.equal(col.conf.curModel, String(basic.id)); // default is Basic

  // Build a real note + card against it.
  const mid = basic.id;
  const note = new Note({ mid, fields: ["2 + 2 = ?", "4"] }).normalize(col.sortFieldIndex(mid));
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1 }));
  assert.equal(col.notes.size, 1);
  assert.equal(col.cards.size, 1);
});
