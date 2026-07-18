// Sync merge engine tests: two devices diverge from a common ancestor and
// must converge without losing reviews, notes, or deletions.

import test from "node:test";
import assert from "node:assert/strict";

import { syncMerge, mergeMedia } from "../src/sync.js";
import { collectionToBackup, collectionFromBackup } from "../src/backup.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { Rating } from "../src/fsrs.js";
import { nowSec } from "../src/ids.js";

/** A common-ancestor collection with two notes / two cards. */
function ancestor() {
  const col = Collection.createDefault();
  col.crt = nowSec() - 100 * 86400;
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  for (const front of ["alpha", "beta"]) {
    const n = new Note({ mid, fields: [front, "x"] }).normalize();
    col.addNote(n);
    col.addCard(new Card({ nid: n.id, did: 1, ord: 0, due: 1 }));
  }
  return col;
}

/** Deep-copy a collection (simulates a device restoring the shared state). */
const clone = (col) => collectionFromBackup(JSON.parse(JSON.stringify(collectionToBackup(col))));
const cardOf = (col, front) => {
  const note = [...col.notes.values()].find((n) => n.fields[0] === front);
  return col.cardsForNote(note.id)[0];
};

test("independent reviews on two devices both survive the merge", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  new Scheduler(devA).answerCard(cardOf(devA, "alpha"), Rating.Good);
  new Scheduler(devB).answerCard(cardOf(devB, "beta"), Rating.Good);

  const m = syncMerge(devA, devB);
  assert.equal(m.revlog.length, 2); // both reviews in history
  assert.ok(cardOf(m, "alpha").reps === 1 && cardOf(m, "beta").reps === 1);
  assert.equal(m.cards.size, 2); // no duplicates
});

test("conflicting reviews of the same card: more-studied state wins, history unions", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  const sa = new Scheduler(devA);
  sa.answerCard(cardOf(devA, "alpha"), Rating.Good, { nowMs: Date.now() });
  sa.answerCard(cardOf(devA, "alpha"), Rating.Good, { nowMs: Date.now() + 1 });
  new Scheduler(devB).answerCard(cardOf(devB, "alpha"), Rating.Again, { nowMs: Date.now() + 2 });

  const m = syncMerge(devA, devB);
  assert.equal(cardOf(m, "alpha").reps, 2); // A studied more; A's state wins
  assert.equal(m.revlog.length, 3);         // every answer kept
});

test("notes added on each device both appear; edits take the newer version", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  const mid = Object.values(devA.models).find((m) => m.name === "Basic").id;
  const na = new Note({ mid, fields: ["from-A", "x"] }).normalize();
  devA.addNote(na);
  devA.addCard(new Card({ nid: na.id, did: 1, ord: 0, due: 9 }));
  const nb = new Note({ mid, fields: ["from-B", "x"] }).normalize();
  devB.addNote(nb);
  devB.addCard(new Card({ nid: nb.id, did: 1, ord: 0, due: 9 }));
  // B edits alpha later than A's copy
  const alphaB = [...devB.notes.values()].find((n) => n.fields[0] === "alpha");
  alphaB.fields = ["alpha-edited", "x"];
  alphaB.mod = Math.floor(Date.now() / 1000) + 50;

  const m = syncMerge(devA, devB);
  const fronts = [...m.notes.values()].map((n) => n.fields[0]).sort();
  assert.deepEqual(fronts, ["alpha-edited", "beta", "from-A", "from-B"]);
  assert.equal(m.cards.size, 4);
});

test("a deletion on one device wins on the other", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  const alphaA = [...devA.notes.values()].find((n) => n.fields[0] === "alpha");
  devA.removeNote(alphaA.id);

  const m1 = syncMerge(devA, devB);
  const m2 = syncMerge(devB, devA);
  for (const m of [m1, m2]) {
    assert.ok(![...m.notes.values()].some((n) => n.fields[0] === "alpha"));
    assert.equal(m.notes.size, 1);
  }
});

test("decks created on a device arrive with their own settings; merge is idempotent", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  const { deck } = devB.cloneCardsIntoNewDeck("Cram", [...devB.cards.values()]);
  assert.ok(deck);

  let m = syncMerge(devA, devB);
  assert.ok(Object.values(m.decks).some((d) => d.name === "Cram"));
  assert.equal(m.cards.size, 4); // 2 originals + 2 cram copies
  const cram = Object.values(m.decks).find((d) => d.name === "Cram");
  assert.equal(m.dconf[String(cram.conf)]?.name, "Cram"); // its own settings came along

  const again = syncMerge(m, devB); // re-merging changes nothing
  assert.equal(again.cards.size, 4);
  assert.equal(again.revlog.length, m.revlog.length);
  assert.equal(again.notes.size, m.notes.size);
});

test("merging is order-insensitive where it matters", () => {
  const base = ancestor();
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  new Scheduler(devA).answerCard(cardOf(devA, "alpha"), Rating.Good, { nowMs: Date.now() });
  new Scheduler(devB).answerCard(cardOf(devB, "beta"), Rating.Good, { nowMs: Date.now() + 1 });

  const ab = syncMerge(devA, devB);
  const ba = syncMerge(devB, devA);
  assert.equal(ab.cards.size, ba.cards.size);
  assert.equal(ab.notes.size, ba.notes.size);
  assert.equal(ab.revlog.length, ba.revlog.length);
  assert.equal(cardOf(ab, "alpha").reps, cardOf(ba, "alpha").reps);
  assert.equal(cardOf(ab, "beta").due, cardOf(ba, "beta").due);
});

test("per-deck scheduling memory merges key-wise across devices", () => {
  const base = ancestor();
  const wow = base.addDeck("Wowwow");
  const zap = base.addDeck("Zapzap");
  const devA = clone(base).collection;
  const devB = clone(base).collection;
  const noteA = [...devA.notes.values()].find((n) => n.fields[0] === "alpha");
  const noteB = [...devB.notes.values()].find((n) => n.fields[0] === "alpha");
  // A archives Wowwow memory; B archives Zapzap memory (same note, different decks).
  const wowA = Object.values(devA.decks).find((d) => d.name === "Wowwow");
  const zapB = Object.values(devB.decks).find((d) => d.name === "Zapzap");
  devA.addNoteCardToDeck(noteA, wowA.id, 0);
  devA.removeNoteFromDeck(noteA.id, wowA.id);
  devB.addNoteCardToDeck(noteB, zapB.id, 0);
  devB.removeNoteFromDeck(noteB.id, zapB.id);
  noteB.mod = (noteA.mod ?? 0) + 10; // B's note copy is newer overall

  const m = syncMerge(devA, devB);
  const merged = [...m.notes.values()].find((n) => n.fields[0] === "alpha");
  assert.match(merged.data, /Wowwow/); // both memories survive
  assert.match(merged.data, /Zapzap/);
});

test("mergeMedia unions by filename", () => {
  const a = new Map([["x.png", new Uint8Array([1])]]);
  const b = new Map([["x.png", new Uint8Array([9])], ["y.png", new Uint8Array([2])]]);
  const m = mergeMedia(a, b);
  assert.equal(m.size, 2);
  assert.deepEqual([...m.get("x.png")], [1]); // a wins name conflicts
});
