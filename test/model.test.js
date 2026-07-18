// Tests for the data model: golden vectors from anki/rslib (field_checksum,
// anki_base91) plus encoding round-trips and the cards.data FSRS schema.

import test from "node:test";
import assert from "node:assert/strict";

import { sha1Hex } from "../src/sha1.js";
import { fieldChecksum, joinFields, splitFields, stripHtml, stripHtmlPreservingMediaFilenames } from "../src/text.js";
import { base91 } from "../src/ids.js";
import {
  Note, Card, Revlog, Collection, CardType, CardQueue,
  parseCardData, serializeCardData, joinTags, splitTags, imageOcclusionNoteType,
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

test("deck management: add, rename (with subdecks), delete (with cards)", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;

  const parent = col.addDeck("Spanish");
  const child = col.addDeck("Spanish::Verbs");
  assert.equal(col.addDeck("Spanish").id, parent.id); // idempotent by name

  // Rename carries the subdeck.
  col.renameDeck(parent.id, "Español");
  assert.equal(col.decks[String(parent.id)].name, "Español");
  assert.equal(col.decks[String(child.id)].name, "Español::Verbs");

  // A card in the subdeck.
  const note = new Note({ mid, fields: ["hablar", "to speak"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: child.id }));

  // Delete the parent → subdeck + its card + the orphaned note all go.
  col.removeDeck(parent.id);
  assert.equal(col.decks[String(parent.id)], undefined);
  assert.equal(col.decks[String(child.id)], undefined);
  assert.equal(col.cards.size, 0);
  assert.equal(col.notes.size, 0);

  // Default is protected.
  col.removeDeck(1);
  assert.ok(col.decks["1"]);
});

test("note-type editing migrates notes and cards", () => {
  const col = Collection.createDefault();
  const nt = col.addNoteType("Vocab", 0);
  const note = new Note({ mid: nt.id, fields: ["a", "b"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1, ord: 0 }));

  // Add a field → notes gain a trailing empty field.
  col.addField(nt.id, "Notes");
  assert.equal(nt.flds.length, 3);
  assert.deepEqual(col.notes.get(note.id).fields, ["a", "b", ""]);

  // Remove the middle field → values splice out, ords reindex.
  col.removeField(nt.id, 1);
  assert.deepEqual(nt.flds.map((f) => f.name), ["Front", "Notes"]);
  assert.deepEqual(col.notes.get(note.id).fields, ["a", ""]);

  // Add a template → a card is generated per note.
  col.addTemplate(nt.id, "Card 2", "{{Front}}", "{{Notes}}");
  assert.equal(col.cardsForNote(note.id).length, 2);
  assert.deepEqual(col.cardsForNote(note.id).map((c) => c.ord).sort(), [0, 1]);

  // Remove template 0 → its card goes, the other shifts to ord 0.
  col.removeTemplate(nt.id, 0);
  const cards = col.cardsForNote(note.id);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].ord, 0);
  assert.equal(nt.tmpls.length, 1);
});

test("image-occlusion note type: one card per mask", () => {
  const col = Collection.createDefault();
  const nt = imageOcclusionNoteType(col.nextId());
  col.models[String(nt.id)] = nt;
  assert.equal(nt.ossIO, true);

  const masks = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.3, h: 0.2 }];
  const note = new Note({ mid: nt.id, fields: ["cat.png", JSON.stringify(masks), "Anatomy", ""] }).normalize(nt.sortf);
  col.addNote(note);
  masks.forEach((_, i) => col.addCard(new Card({ nid: note.id, did: 1, ord: i })));

  assert.equal(col.cardsForNote(note.id).length, 2);
  assert.deepEqual(JSON.parse(note.fields[1]), masks);
  assert.equal(note.sfld, "Anatomy"); // sort field = Header
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
  assert.ok(models.some((m) => m.name === "Basic") && models.some((m) => m.name === "Cloze"));
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

// --- stock note types + card generation (audit additions) ---

import { basicOptionalReversedNoteType, basicReversedNoteType } from "../src/model.js";
import { cardOrdinalsForNote } from "../src/template.js";

test("createDefault ships the five stock note types", () => {
  const col = Collection.createDefault();
  const names = Object.values(col.models).map((m) => m.name).sort();
  assert.deepEqual(names, [
    "Basic", "Basic (and reversed card)", "Basic (optional reversed card)",
    "Basic (type in the answer)", "Cloze",
  ]);
});

test("optional reverse generates the second card only when Add Reverse is set", () => {
  const nt = basicOptionalReversedNoteType(1);
  const plain = new Note({ mid: 1, fields: ["Q", "A", ""] });
  assert.deepEqual(cardOrdinalsForNote(nt, plain), [0]);
  const reversed = new Note({ mid: 1, fields: ["Q", "A", "y"] });
  assert.deepEqual(cardOrdinalsForNote(nt, reversed), [0, 1]);
});

test("reversed note type generates both cards; empty note generates none", () => {
  const nt = basicReversedNoteType(2);
  assert.deepEqual(cardOrdinalsForNote(nt, new Note({ mid: 2, fields: ["Q", "A"] })), [0, 1]);
  assert.deepEqual(cardOrdinalsForNote(nt, new Note({ mid: 2, fields: ["Q", ""] })), [0]);
  assert.deepEqual(cardOrdinalsForNote(nt, new Note({ mid: 2, fields: ["", ""] })), []);
});

test("cloneCardsIntoNewDeck: independent deck, fresh cards, own options", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const note = new Note({ mid, fields: ["Q", "A"], tags: ["bees"] }).normalize();
  col.addNote(note);
  const orig = col.addCard(new Card({ nid: note.id, did: 1, ord: 0, type: 2, queue: 2, ivl: 30, due: 500, reps: 9 }));

  const { deck, count } = col.cloneCardsIntoNewDeck("Bees Redux", [orig, orig]); // dup input deduped
  assert.equal(count, 1);
  assert.equal(deck.dyn, 0); // a normal deck, not a dynamic one

  const copy = [...col.cards.values()].find((c) => c.did === deck.id);
  assert.equal(copy.nid, note.id);      // same global note
  assert.equal(copy.type, 0);           // fresh new card
  assert.equal(copy.reps, 0);
  assert.notEqual(copy.id, orig.id);
  // original untouched
  assert.equal(orig.did, 1);
  assert.equal(orig.ivl, 30);
  assert.equal(orig.odid, 0);           // no filtered-deck bookkeeping
  // its own options group, not shared with group 1
  assert.notEqual(String(deck.conf), "1");
  assert.equal(col.dconf[String(deck.conf)].name, "Bees Redux");
});

// --- non-exclusive flags ---

import { cardFlagSet, writeCardFlags, cardHasFlag } from "../src/model.js";

test("multiple flags coexist; low bits mirror the lowest for Anki compat", () => {
  const card = new Card({ nid: 1, did: 1 });
  writeCardFlags(card, new Set([1, 3])); // red + green
  assert.deepEqual([...cardFlagSet(card)].sort(), [1, 3]);
  assert.equal(card.flags & 7, 1); // Anki sees red
  assert.ok(cardHasFlag(card, 1) && cardHasFlag(card, 3));
  assert.ok(!cardHasFlag(card, 2) && !cardHasFlag(card, 0));

  writeCardFlags(card, new Set()); // clear all
  assert.equal(cardFlagSet(card).size, 0);
  assert.ok(cardHasFlag(card, 0));
  assert.equal(card.flags & 0x3ff, 0);
});

test("legacy single-flag encoding still reads correctly", () => {
  const card = new Card({ nid: 1, did: 1, flags: 6 }); // old-style turquoise
  assert.deepEqual([...cardFlagSet(card)], [6]);
  assert.ok(cardHasFlag(card, 6));
});

// --- per-deck scheduling memory on the note ---

test("removing a note from a deck archives scheduling; re-adding restores it", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const wow = col.addDeck("Wowwow");
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const card = col.addCard(new Card({
    nid: note.id, did: wow.id, ord: 0,
    type: CardType.Review, queue: CardQueue.Review, due: 321, ivl: 17, factor: 2350, reps: 8, lapses: 2,
  }));
  const originalId = card.id;

  col.removeNoteFromDeck(note.id, wow.id);
  assert.equal(col.cardsForNote(note.id).length, 0);
  assert.match(note.data, /Wowwow/); // the note itself carries the metadata

  const restored = col.addNoteCardToDeck(note, wow.id, 0);
  assert.equal(restored.id, originalId); // revlog history re-links
  assert.equal(restored.ivl, 17);
  assert.equal(restored.due, 321);
  assert.equal(restored.factor, 2350);
  assert.equal(restored.reps, 8);
  assert.equal(restored.type, CardType.Review);
});

test("deck memory survives deleting and recreating a same-named deck", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const wow = col.addDeck("Wowwow");
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  // keep the note alive in Default too, so deck deletion doesn't remove it
  col.addCard(new Card({ nid: note.id, did: 1, ord: 0 }));
  col.addCard(new Card({ nid: note.id, did: wow.id, ord: 0, type: CardType.Review, queue: CardQueue.Review, due: 99, ivl: 42, factor: 2500 }));

  col.removeDeck(wow.id); // archives on the note
  assert.equal(col.cardsForNote(note.id).length, 1);

  const wow2 = col.addDeck("Wowwow"); // brand-new deck, same name
  const back = col.addNoteCardToDeck(note, wow2.id, 0);
  assert.equal(back.ivl, 42);
  assert.equal(back.due, 99);
});

test("renaming a deck carries the notes' archived scheduling keys", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const wow = col.addDeck("Wowwow");
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1, ord: 0 }));
  col.addCard(new Card({ nid: note.id, did: wow.id, ord: 0, ivl: 7, type: CardType.Review, queue: CardQueue.Review, due: 5, factor: 2500 }));
  col.removeNoteFromDeck(note.id, wow.id);

  col.renameDeck(wow.id, "Zowzow");
  const back = col.addNoteCardToDeck(note, wow.id, 0); // deck now named Zowzow
  assert.equal(back.ivl, 7); // memory followed the rename
});

test("without memory, adding to a deck creates a fresh card", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const fresh = col.addNoteCardToDeck(note, 1, 0);
  assert.equal(fresh.type, CardType.New);
  assert.equal(fresh.reps, 0);
});
