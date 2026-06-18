// Integration test for the data-flow the browser UI drives (without the DOM):
// create default collection → persist → reload → add a card → study queue →
// render question/answer → answer → persist. Uses fake-indexeddb.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

import { openCollectionDB, loadCollection, saveCollection, putCard, putRevlog, putNote, putMeta } from "../src/storage.js";
import { Collection, Note, Card, CardType } from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard } from "../src/template.js";
import { Rating } from "../src/fsrs.js";

test("end-to-end UI data-flow: create, add, persist, study, answer", async () => {
  const db = await openCollectionDB("app-int");

  // Fresh collection (init()).
  let col = await loadCollection(db);
  if (!col) {
    col = Collection.createDefault();
    await saveCollection(db, col);
  }

  // Add a card (renderAddCard save path).
  const model = col.noteType(Number(col.conf.curModel));
  const note = new Note({
    mid: model.id,
    fields: model.flds.map((_, i) => (i === 0 ? "2 + 2 = ?" : i === 1 ? "4" : "")),
  }).normalize(model.sortf ?? 0);
  col.addNote(note);
  for (const tmpl of model.tmpls) {
    const due = col.conf.nextPos ?? 1;
    col.conf.nextPos = due + 1;
    const card = col.addCard(new Card({ nid: note.id, did: 1, ord: tmpl.ord, due }));
    await putCard(db, card);
  }
  await putNote(db, note);
  await putMeta(db, col);

  // Reload from storage (simulating a page refresh).
  col = await loadCollection(db);
  assert.equal(col.cards.size, 1); // Basic = 1 template

  // Study queue.
  const sched = new Scheduler(col);
  const queue = sched.queue(1).all;
  assert.equal(queue.length, 1);
  const card = queue[0];
  assert.equal(card.type, CardType.New);

  // Render question + answer.
  const rendered = renderCard(col.noteType(note.mid), card.ord, col.notes.get(card.nid));
  assert.equal(rendered.question, "2 + 2 = ?");
  assert.match(rendered.answer, /4/);

  // Preview intervals are positive and ordered.
  const outcomes = sched.nextStates(card);
  assert.ok(outcomes.again.interval && outcomes.good.interval);

  // Answer Good → enters learning, persist.
  const entry = sched.answerCard(card, Rating.Good);
  await putCard(db, card);
  await putRevlog(db, entry);
  assert.notEqual(card.type, CardType.New);
  assert.equal(card.reps, 1);

  // Reload and confirm persistence.
  const reloaded = await loadCollection(db);
  assert.equal(reloaded.cards.get(card.id).reps, 1);
  assert.equal(reloaded.revlog.length, 1);
  db.close();
});
