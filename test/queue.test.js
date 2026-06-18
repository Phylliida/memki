// Due-queue builder tests.

import test from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { nowSec } from "../src/ids.js";

function collectionWithDeck() {
  const col = Collection.createDefault();
  col.crt = nowSec() - 100 * 86400; // ~100 days ago, so daysElapsed is large and stable
  return col;
}

function addCard(col, props) {
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  return col.addCard(new Card({ nid: note.id, did: 1, ...props }));
}

test("queue gathers due new, learning, and review cards", () => {
  const col = collectionWithDeck();
  addCard(col, { type: CardType.New, queue: CardQueue.New, due: 1 });
  addCard(col, { type: CardType.New, queue: CardQueue.New, due: 2 });
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 }); // due (day 0 <= today)
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 9999999, ivl: 5 }); // not due
  addCard(col, { type: CardType.Learning, queue: CardQueue.Learning, due: nowSec() - 10 }); // due now
  addCard(col, { type: CardType.Suspended ?? -1, queue: CardQueue.Suspended, due: 0 }); // skipped

  const sched = new Scheduler(col);
  const c = sched.counts(1);
  assert.equal(c.new, 2);
  assert.equal(c.learning, 1);
  assert.equal(c.review, 1);

  // Study order: learning first, then review, then new.
  const all = sched.queue(1).all;
  assert.equal(all[0].queue, CardQueue.Learning);
  assert.equal(all.length, 4);
});

test("per-day new limit caps the new queue", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.perDay = 2;
  for (let i = 0; i < 5; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  const sched = new Scheduler(col);
  assert.equal(sched.counts(1).new, 2);
});

test("subdeck cards are included when studying the parent", () => {
  const col = collectionWithDeck();
  // Add a child deck "Default::Child".
  col.decks["2"] = { ...col.decks["1"], id: 2, name: "Default::Child", conf: 1 };
  const mid = Object.values(col.models)[0].id;
  const n = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(n);
  col.addCard(new Card({ nid: n.id, did: 2, type: CardType.New, queue: CardQueue.New, due: 1 }));

  const sched = new Scheduler(col);
  assert.equal(sched.counts(1).new, 1); // child card counted under parent
  assert.equal(sched.counts(2).new, 1); // and under the child itself
});
