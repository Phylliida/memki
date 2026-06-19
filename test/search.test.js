// Search-syntax tests.

import test from "node:test";
import assert from "node:assert/strict";

import { searchCards } from "../src/search.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { nowSec } from "../src/ids.js";

function build() {
  const col = Collection.createDefault();
  col.crt = nowSec() - 100 * 86400;
  const basic = Object.values(col.models).find((m) => m.name === "Basic").id;
  const mk = (fields, tags, cardProps) => {
    const n = new Note({ mid: basic, fields, tags }).normalize();
    col.addNote(n);
    col.addCard(new Card({ nid: n.id, did: 1, ...cardProps }));
    return n;
  };
  mk(["Hola", "Hello"], ["spanish", "greeting"], { type: CardType.New, queue: CardQueue.New, flags: 1 });
  mk(["Adiós", "Goodbye"], ["spanish"], { type: CardType.Review, queue: CardQueue.Review, ivl: 30, due: 0, reps: 5, factor: 2500 });
  mk(["Bonjour", "Hello"], ["french", "greeting"], { type: CardType.Review, queue: CardQueue.Suspended, ivl: 3, reps: 2 });
  return col;
}

const titles = (cards, col) => cards.map((c) => col.notes.get(c.nid).fields[0]).sort();

test("bare terms are AND substring matches over fields + tags", () => {
  const col = build();
  assert.deepEqual(titles(searchCards(col, "hello"), col), ["Bonjour", "Hola"]);
  assert.deepEqual(titles(searchCards(col, "hello greeting"), col), ["Bonjour", "Hola"]);
  assert.deepEqual(titles(searchCards(col, "hello spanish"), col), ["Hola"]);
});

test("negation and OR", () => {
  const col = build();
  assert.deepEqual(titles(searchCards(col, "hello -french"), col), ["Hola"]);
  assert.deepEqual(titles(searchCards(col, "french or spanish"), col).length, 3);
});

test("tag: with hierarchy/none, and is: states", () => {
  const col = build();
  assert.deepEqual(titles(searchCards(col, "tag:french"), col), ["Bonjour"]);
  assert.equal(searchCards(col, "tag:none").length, 0);
  assert.deepEqual(titles(searchCards(col, "is:new"), col), ["Hola"]);
  assert.deepEqual(titles(searchCards(col, "is:suspended"), col), ["Bonjour"]);
  assert.deepEqual(titles(searchCards(col, "is:review"), col), ["Adiós", "Bonjour"]);
});

test("prop: numeric comparisons", () => {
  const col = build();
  assert.deepEqual(titles(searchCards(col, "prop:ivl>=21"), col), ["Adiós"]);
  assert.deepEqual(titles(searchCards(col, "prop:reps>0"), col), ["Adiós", "Bonjour"]);
  assert.deepEqual(titles(searchCards(col, "prop:ease>2"), col), ["Adiós"]);
});

test("flag: and note: and card:", () => {
  const col = build();
  assert.deepEqual(titles(searchCards(col, "flag:1"), col), ["Hola"]);
  assert.equal(searchCards(col, "note:Basic").length, 3);
  assert.equal(searchCards(col, "note:Cloze").length, 0);
  assert.equal(searchCards(col, "card:1").length, 3); // all are first template
});

test("deck: matches deck and subdecks; quoted phrases", () => {
  const col = build();
  col.decks["2"] = { ...col.decks["1"], id: 2, name: "Lang::Spanish" };
  const basic = Object.values(col.models).find((m) => m.name === "Basic").id;
  const n = new Note({ mid: basic, fields: ["gato cat", "cat"] }).normalize();
  col.addNote(n);
  col.addCard(new Card({ nid: n.id, did: 2, type: CardType.New, queue: CardQueue.New }));

  assert.deepEqual(titles(searchCards(col, "deck:Lang"), col), ["gato cat"]); // subdeck included
  assert.deepEqual(titles(searchCards(col, '"gato cat"'), col), ["gato cat"]);
  assert.equal(searchCards(col, '"gato dog"').length, 0);
});

test("empty query matches everything; parens group OR under AND", () => {
  const col = build();
  assert.equal(searchCards(col, "").length, 3);
  assert.equal(searchCards(col, "   ").length, 3);
  // (french or spanish) and greeting → Hola, Bonjour
  assert.deepEqual(titles(searchCards(col, "(french or spanish) greeting"), col), ["Bonjour", "Hola"]);
});
