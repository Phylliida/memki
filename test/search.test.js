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

// --- extended syntax (audit additions) ---

import { Revlog } from "../src/model.js";

function build2() {
  const col = Collection.createDefault();
  col.crt = nowSec() - 100 * 86400;
  const basic = Object.values(col.models).find((m) => m.name === "Basic").id;
  const mk = (fields = ["Q", "A"], cardProps = {}) => {
    const n = new Note({ mid: basic, fields }).normalize();
    col.addNote(n);
    return col.addCard(new Card({ nid: n.id, did: 1, ...cardProps }));
  };
  return { col, mk };
}

test("field search: Front:pattern matches the whole field with wildcards", () => {
  const { col, mk } = build2();
  mk(["dog", "chien"]);
  mk(["dogma", "x"]);
  assert.equal(searchCards(col, "front:dog").length, 1);
  assert.equal(searchCards(col, "front:dog*").length, 2);
  assert.equal(searchCards(col, "front:d_g").length, 1);
  assert.equal(searchCards(col, "nosuchfield:dog").length, 0);
});

test("re: regex search over fields", () => {
  const { col, mk } = build2();
  mk(["colour", "x"]);
  mk(["color", "x"]);
  assert.equal(searchCards(col, "re:colou?r").length, 2);
  assert.equal(searchCards(col, "re:colou+r").length, 1);
  assert.equal(searchCards(col, "re:[").length, 0); // invalid regex matches nothing
});

test("is:learn is queue-based; buried split into manually/sibling", () => {
  const { col, mk } = build2();
  mk(undefined, { type: CardType.Relearning, queue: CardQueue.Learning });
  mk(undefined, { type: CardType.Learning, queue: CardQueue.Suspended }); // not in a learning queue
  mk(undefined, { queue: CardQueue.UserBuried });
  mk(undefined, { queue: CardQueue.SchedBuried });
  assert.equal(searchCards(col, "is:learn").length, 1);
  assert.equal(searchCards(col, "is:buried").length, 2);
  assert.equal(searchCards(col, "is:buried-manually").length, 1);
  assert.equal(searchCards(col, "is:buried-sibling").length, 1);
});

test("rated: matches recent answers, optionally by button", () => {
  const { col, mk } = build2();
  const c1 = mk();
  const c2 = mk();
  const now = Date.now();
  col.addRevlog(new Revlog({ id: now - 3600 * 1000, cid: c1.id, ease: 1 }));
  col.addRevlog(new Revlog({ id: now - 40 * 86400 * 1000, cid: c2.id, ease: 3 }));
  assert.equal(searchCards(col, "rated:2").length, 1);
  assert.equal(searchCards(col, "rated:2:1").length, 1); // again-button
  assert.equal(searchCards(col, "rated:2:3").length, 0);
  assert.equal(searchCards(col, "rated:60").length, 2);
});

test("introduced: and edited: use scheduling-day windows", () => {
  const { col, mk } = build2();
  const c1 = mk();
  col.addRevlog(new Revlog({ id: Date.now() - 3600 * 1000, cid: c1.id, ease: 3 }));
  assert.equal(searchCards(col, "introduced:2").length, 1);
  assert.ok(searchCards(col, "edited:2").length >= 1); // notes freshly created
});

test("prop:s / prop:d read FSRS memory state", () => {
  const { col, mk } = build2();
  const card = mk();
  card.memoryState = { stability: 42.5, difficulty: 3.3 };
  mk();
  assert.equal(searchCards(col, "prop:s>30").length, 1);
  assert.equal(searchCards(col, "prop:d<4").length, 1);
  assert.equal(searchCards(col, "prop:stability<30").length, 0); // NaN never matches
});

test("deck: supports wildcards", () => {
  const { col, mk } = build2();
  const fr = col.addDeck("Lang::French");
  const de = col.addDeck("Lang::German");
  mk(undefined, { did: fr.id });
  mk(undefined, { did: de.id });
  assert.equal(searchCards(col, '"deck:Lang::*"').length, 2);
  assert.equal(searchCards(col, '"deck:*French"').length, 1);
});

test("rated:N:0 finds manual reschedules; plain rated:N excludes them", () => {
  const { col, mk } = build2();
  const c1 = mk();
  col.addRevlog(new Revlog({ id: Date.now() - 1000, cid: c1.id, ease: 0 })); // manual
  assert.equal(searchCards(col, "rated:1:0").length, 1);
  assert.equal(searchCards(col, "rated:1").length, 0);
});
