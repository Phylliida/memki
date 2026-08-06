// Deck-list due counts (Scheduler.deckCounts / counts) — parity with Anki's
// deck tree: rslib decks/tree.rs (sum_counts_and_apply_limits_v3),
// decks/limits.rs (RemainingLimits) and storage/deck/due_counts.sql.

import test from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { Collection, Note, Card, CardType, CardQueue, defaultDeckConfig } from "../src/model.js";
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

test("learn-ahead learning cards count in the deck list, not in the study queue", () => {
  const col = collectionWithDeck();
  col.conf.collapseTime = 1200; // 20 min
  addCard(col, { type: CardType.Learning, queue: CardQueue.Learning, due: nowSec() + 300 });
  addCard(col, { type: CardType.Learning, queue: CardQueue.Learning, due: nowSec() + 7200 });
  const sched = new Scheduler(col);
  assert.equal(sched.counts(1).learning, 1); // due within the learn-ahead window
  assert.equal(sched.queue(1).learning.length, 0); // but not studyable yet
});

test("deck list counts don't simulate sibling burying", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.bury = true;
  const mid = Object.values(col.models)[0].id;
  const note = new Note({ mid, fields: ["Q", "A"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1, ord: 0, type: CardType.New, queue: CardQueue.New, due: 1 }));
  col.addCard(new Card({ nid: note.id, did: 1, ord: 1, type: CardType.New, queue: CardQueue.New, due: 2 }));
  const sched = new Scheduler(col);
  assert.equal(sched.counts(1).new, 2); // tree counts both (rslib due_counts.sql)
  assert.equal(sched.queue(1).new.length, 1); // gather buries the second
});

test("new cards studied today also eat the review budget (Anki default)", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.perDay = 20;
  col.dconf["1"].rev.perDay = 5;
  for (let i = 0; i < 10; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  for (let i = 0; i < 10; i++) addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  const sched = new Scheduler(col);
  col.decks["1"].newToday = [sched.daysElapsed, 3]; // 3 new already studied today

  let c = new Scheduler(col).counts(1);
  assert.equal(c.review, 2); // 5 - 3 (rslib limits.rs: review_limit -= new_today)
  assert.equal(c.new, 0); // the 2 remaining review slots go to due reviews first

  col.conf.newCardsIgnoreReviewLimit = true; // collection-wide in Anki
  c = new Scheduler(col).counts(1);
  assert.equal(c.review, 5);
  assert.equal(c.new, 10);
});

test("legacy per-preset ignoreReviewLimit still wins when no global flag is stored", () => {
  const col = collectionWithDeck();
  col.dconf["1"].rev.perDay = 1;
  col.dconf["1"].new.ignoreReviewLimit = true; // written by older app versions
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  for (let i = 0; i < 3; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  const c = new Scheduler(col).counts(1);
  assert.equal(c.review, 1);
  assert.equal(c.new, 3);
});

test("per-deck limit overrides beat the preset; 'today' overrides beat them", () => {
  const col = collectionWithDeck();
  for (let i = 0; i < 5; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i });
  const sched = new Scheduler(col);
  const deck = col.decks["1"];

  deck.newLimit = 1; // per-deck override (proto Deck.Normal.new_limit)
  assert.equal(new Scheduler(col).counts(1).new, 1);

  deck.newLimitToday = { today: sched.daysElapsed, limit: 2 }; // custom-study style
  assert.equal(new Scheduler(col).counts(1).new, 2);

  deck.newLimitToday = { today: sched.daysElapsed - 1, limit: 3 }; // stale: ignored
  assert.equal(new Scheduler(col).counts(1).new, 1);
});

test("children ignore parent limits unless applyAllParentLimits is set", () => {
  const col = collectionWithDeck();
  col.dconf["2"] = defaultDeckConfig(2, "Custom");
  col.dconf["2"].new.perDay = 1;
  const parent = col.addDeck("P");
  parent.conf = 2; // parent limited to 1 new/day
  const child = col.addDeck("P::C"); // preset 1: 20 new/day
  for (let i = 0; i < 5; i++) {
    addCard(col, { type: CardType.New, queue: CardQueue.New, due: i, did: child.id });
  }

  // Anki default (applyAllParentLimits = false): the child shows its own
  // limit; the parent caps the summed counts with its own limit.
  let sched = new Scheduler(col);
  assert.equal(sched.counts(child.id).new, 5);
  assert.equal(sched.counts(parent.id).new, 1);

  col.conf.applyAllParentLimits = true;
  sched = new Scheduler(col);
  assert.equal(sched.counts(child.id).new, 1); // now capped by the parent
  assert.equal(sched.counts(parent.id).new, 1);
});

test("interday learning spends the review budget first; intraday is uncapped", () => {
  const col = collectionWithDeck();
  col.dconf["1"].rev.perDay = 1;
  const sched = new Scheduler(col);
  addCard(col, { type: CardType.Learning, queue: CardQueue.DayLearning, due: sched.daysElapsed });
  addCard(col, { type: CardType.Learning, queue: CardQueue.Learning, due: nowSec() - 10 });
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  addCard(col, { type: CardType.Review, queue: CardQueue.Review, due: 0, ivl: 5 });
  const c = new Scheduler(col).counts(1);
  assert.equal(c.learning, 2); // 1 capped interday + 1 uncapped intraday
  assert.equal(c.review, 0); // the interday learner took the single review slot
});

test("filtered decks have no daily limits in the deck list", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.perDay = 2;
  const fd = col.createFilteredDeck("Cram");
  for (let i = 0; i < 5; i++) {
    addCard(col, { type: CardType.New, queue: CardQueue.New, due: i, did: fd.id });
  }
  assert.equal(new Scheduler(col).counts(fd.id).new, 5);
});

// Anki's own unit test (rslib decks/tree.rs nested_counts_v3): nested limits
// 8/4/2/1 over decks holding 2 new cards each.
test("nested deck limits match Anki's tree test", () => {
  const col = collectionWithDeck();
  col.dconf["1"].new.perDay = 8; // Default
  const mk = (name, perDay) => {
    const deck = col.addDeck(name);
    const id = Object.keys(col.dconf).length + 100;
    col.dconf[String(id)] = defaultDeckConfig(id, name);
    col.dconf[String(id)].new.perDay = perDay;
    deck.conf = id;
    return deck;
  };
  const child = mk("Default::child", 4);
  const gc1 = mk("Default::child::grandchild_1", 2);
  const gc2 = mk("Default::child::grandchild_2", 1);
  for (const did of [1, child.id, gc1.id, gc2.id]) {
    for (let i = 0; i < 2; i++) addCard(col, { type: CardType.New, queue: CardQueue.New, due: i, did });
  }
  const sched = new Scheduler(col);
  assert.equal(sched.counts(gc1.id).new, 2);
  assert.equal(sched.counts(gc2.id).new, 1);
  assert.equal(sched.counts(child.id).new, 4);
  assert.equal(sched.counts(1).new, 6);
});
