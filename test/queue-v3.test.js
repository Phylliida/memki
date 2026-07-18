// v3 gather rules: ancestor deck limits, new/review mixing, interday learning
// against the review budget, and the leech tag.

import test from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { Rating } from "../src/fsrs.js";
import { nowSec } from "../src/ids.js";

function collectionWithDeck() {
  const col = Collection.createDefault();
  col.crt = nowSec() - 100 * 86400;
  return col;
}

function addCard(col, props) {
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  return col.addCard(new Card({ nid: note.id, did: 1, ...props }));
}

test("a parent deck's limit caps its subdecks' new cards (v3)", () => {
  const col = collectionWithDeck();
  const parent = col.addDeck("Lang");
  const sub = col.addDeck("Lang::French");
  col.dconf["1"].new.perDay = 3; // shared config: parent and children all limited to 3
  for (let i = 0; i < 5; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i, did: sub.id });
  const sched = new Scheduler(col);
  // Studying the parent: the parent's own budget (3) caps the subtree.
  assert.equal(sched.counts(parent.id).new, 3);
  // Studying the subdeck directly: the subdeck budget applies the same way.
  assert.equal(sched.counts(sub.id).new, 3);
});

test("sibling subdecks each spend the shared parent budget", () => {
  const col = collectionWithDeck();
  const parent = col.addDeck("P");
  const a = col.addDeck("P::A");
  const b = col.addDeck("P::B");
  col.dconf["1"].new.perDay = 4;
  for (let i = 0; i < 4; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i, did: a.id });
  for (let i = 0; i < 4; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: 10 + i, did: b.id });
  const sched = new Scheduler(col);
  const q = sched.queue(parent.id);
  assert.equal(q.new.length, 4); // parent budget, not 8
});

test("interday learning cards consume the review budget", () => {
  const col = collectionWithDeck();
  col.dconf["1"].rev.perDay = 2;
  const sched0 = new Scheduler(col);
  addCard(col, { type: CardType.Learning, queue: CardQueue.DayLearning, due: sched0.daysElapsed });
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  const q = new Scheduler(col).queue(1);
  // 2 review budget: the day-learner takes one slot, leaving one review.
  assert.equal(q.learning.length, 1);
  assert.equal(q.review.length, 1);
});

test("newSpread orders new cards first / last / mixed", () => {
  const col = collectionWithDeck();
  for (let i = 0; i < 3; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  for (let i = 0; i < 3; i++) addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });

  col.conf.newSpread = 2; // new first
  let all = new Scheduler(col).queue(1).all;
  assert.deepEqual(all.map((c) => c.queue), [0, 0, 0, 2, 2, 2]);

  col.conf.newSpread = 1; // new last
  all = new Scheduler(col).queue(1).all;
  assert.deepEqual(all.map((c) => c.queue), [2, 2, 2, 0, 0, 0]);

  col.conf.newSpread = 0; // distribute
  all = new Scheduler(col).queue(1).all;
  const queues = all.map((c) => c.queue);
  assert.notDeepEqual(queues, [2, 2, 2, 0, 0, 0]);
  assert.notDeepEqual(queues, [0, 0, 0, 2, 2, 2]);
  assert.equal(queues.filter((q) => q === 0).length, 3); // all cards still present
});

test("reaching the leech threshold tags the note and suspends", () => {
  const col = collectionWithDeck();
  col.dconf["1"].lapse.leechFails = 2;
  const card = addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 10, factor: 2500, lapses: 1 });
  const sched = new Scheduler(col);
  sched.answerCard(card, Rating.Again); // second lapse → leech
  const note = col.notes.get(card.nid);
  assert.ok(note.tags.includes("leech"));
  assert.equal(card.queue, CardQueue.Suspended);
});

test("leech action 'tag only' tags but does not suspend", () => {
  const col = collectionWithDeck();
  col.dconf["1"].lapse.leechFails = 2;
  col.dconf["1"].lapse.leechAction = 1;
  const card = addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 10, factor: 2500, lapses: 1 });
  new Scheduler(col).answerCard(card, Rating.Again);
  assert.ok(col.notes.get(card.nid).tags.includes("leech"));
  assert.notEqual(card.queue, CardQueue.Suspended);
});

test("answer duration is recorded in the revlog (capped at 60s)", () => {
  const col = collectionWithDeck();
  const card = addCard(col, { type: CardType.New, queue: CardQueue.New, due: 1 });
  const sched = new Scheduler(col);
  const e1 = sched.answerCard(card, Rating.Good, { takenMs: 4321 });
  assert.equal(e1.time, 4321);
  const card2 = addCard(col, { type: CardType.New, queue: CardQueue.New, due: 2 });
  const e2 = sched.answerCard(card2, Rating.Good, { takenMs: 999999 });
  assert.equal(e2.time, 60000);
});
