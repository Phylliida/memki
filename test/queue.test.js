// Due-queue builder tests.

import test from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { Rating } from "../src/fsrs.js";
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

test("daily new limit tapers as cards are studied today", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.perDay = 2;
  for (let i = 0; i < 5; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  const sched = new Scheduler(col);
  assert.equal(sched.counts(1).new, 2);

  const toStudy = sched.queue(1).new;
  sched.answerCard(toStudy[0], Rating.Good);
  sched.answerCard(toStudy[1], Rating.Good);
  assert.equal(sched.counts(1).new, 0); // daily cap reached
});

test("answering buries siblings; new-day unbury restores them", () => {
  const col = collectionWithDeck();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  const c0 = col.addCard(new Card({ nid: note.id, did: 1, ord: 0, type: CardType.New, queue: CardQueue.New, due: 1 }));
  const c1 = col.addCard(new Card({ nid: note.id, did: 1, ord: 1, type: CardType.New, queue: CardQueue.New, due: 2 }));

  const sched = new Scheduler(col);
  sched.answerCard(c0, Rating.Good);
  assert.equal(c1.queue, CardQueue.SchedBuried); // sibling buried

  // Same-day re-query does not surface the buried sibling.
  assert.ok(!sched.queue(1).all.some((c) => c.id === c1.id));

  // New-day unbury restores it (idempotent within a day).
  assert.equal(sched.unburyForNewDay(), 1);
  assert.equal(c1.queue, CardQueue.New);
  assert.equal(sched.unburyForNewDay(), 0);
});

test("learn-ahead surfaces near-due learning cards (after everything else)", () => {
  const col = collectionWithDeck();
  col.conf.collapseTime = 1200; // 20 min
  const ahead = addCard(col, { type: CardType.Learning, queue: CardQueue.Learning, due: nowSec() + 300 });
  const sched = new Scheduler(col);
  const q = sched.queue(1);
  assert.equal(q.learning.length, 0); // not due "now"
  assert.ok(q.all.some((c) => c.id === ahead.id)); // but reachable via learn-ahead
});

test("filtered deck: build gathers cards, study reschedules, empty returns them", () => {
  const col = collectionWithDeck();
  // two review cards not due for a long time
  const a = addCard(col, { type: CardType.Review, queue: CardQueue.Review, ivl: 30, factor: 2500, due: 9_000_000 });
  const b = addCard(col, { type: CardType.Review, queue: CardQueue.Review, ivl: 30, factor: 2500, due: 9_000_000 });
  const fd = col.createFilteredDeck("Cram");
  const sched = new Scheduler(col);

  // Build: both cards move into the filtered deck, becoming due now.
  assert.equal(sched.buildFiltered(fd.id, () => true), 2);
  assert.equal(a.did, fd.id);
  assert.equal(a.odid, 1);
  assert.equal(a.odue, 9_000_000);
  assert.equal(a.due, sched.daysElapsed);

  // They're studyable in the filtered deck (no per-day cap).
  assert.equal(sched.queue(fd.id).all.length, 2);

  // Answer one → rescheduled (odue cleared so its new schedule sticks).
  sched.answerCard(a, Rating.Good);
  assert.equal(a.odue, 0);

  // Empty: both return home; the unreviewed one restores its original due.
  sched.emptyFiltered(fd.id);
  assert.equal(a.did, 1);
  assert.equal(a.odid, 0);
  assert.equal(b.did, 1);
  assert.equal(b.due, 9_000_000); // unreviewed → restored
});

test("manual card operations: suspend/bury/flag/forget/setDueDate/move", () => {
  const col = collectionWithDeck();
  const card = addCard(col, { type: CardType.Review, queue: CardQueue.Review, ivl: 10, factor: 2500, reps: 3, lapses: 1 });
  const sched = new Scheduler(col);

  sched.suspend(card);
  assert.equal(card.queue, CardQueue.Suspended);
  sched.unsuspend(card);
  assert.equal(card.queue, CardQueue.Review); // restored from type
  sched.buryCard(card);
  assert.equal(card.queue, CardQueue.UserBuried);
  sched.setFlag(card, 3);
  assert.equal(card.flags & 7, 3);

  sched.setDueDate(card, 5);
  assert.equal(card.type, CardType.Review);
  assert.equal(card.due, sched.daysElapsed + 5);
  assert.equal(card.ivl, 5);

  sched.moveCard(card, 7);
  assert.equal(card.did, 7);

  sched.forget(card);
  assert.equal(card.type, CardType.New);
  assert.equal(card.queue, CardQueue.New);
  assert.equal(card.reps, 0);
  assert.equal(card.ivl, 0);
  assert.equal(card.memoryState, null);
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
