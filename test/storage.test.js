// IndexedDB persistence tests, using the fake-indexeddb polyfill in Node.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  openCollectionDB, saveCollection, loadCollection, putCard, saveMedia, loadMedia, clearAll,
  pushNoteHistory, listNoteHistory, deleteNoteHistory,
} from "../src/storage.js";
import { Collection, Note, Card, CardType } from "../src/model.js";

function sampleCollection() {
  const col = Collection.createDefault();
  const mid = Object.values(col.models)[0].id;
  for (const [q, a] of [["2+2", "4"], ["Capital of France", "Paris"]]) {
    const n = new Note({ mid, fields: [q, a], tags: ["demo"] }).normalize();
    col.addNote(n);
    col.addCard(new Card({ nid: n.id, did: 1 }));
  }
  return col;
}

let dbCounter = 0;
const freshDb = () => openCollectionDB(`test-${dbCounter++}`);

test("save then load reconstructs the collection", async () => {
  const db = await freshDb();
  const col = sampleCollection();
  await saveCollection(db, col);

  const back = await loadCollection(db);
  assert.ok(back);
  assert.equal(back.ver, col.ver);
  assert.equal(back.crt, col.crt);
  assert.deepEqual(back.decks, col.decks);
  assert.deepEqual(back.models, col.models);
  assert.equal(back.notes.size, 2);
  assert.equal(back.cards.size, 2);

  // Notes/cards rehydrate as real instances (getters work).
  const note = [...back.notes.values()][0];
  assert.ok(note instanceof Note);
  assert.deepEqual(note.fields, ["2+2", "4"]);
  const card = [...back.cards.values()][0];
  assert.ok(card instanceof Card);
  assert.equal(card.memoryState, null);
  db.close();
});

test("loadCollection returns null when nothing saved", async () => {
  const db = await freshDb();
  assert.equal(await loadCollection(db), null);
  db.close();
});

test("putCard persists a single card with FSRS memory state", async () => {
  const db = await freshDb();
  const col = sampleCollection();
  await saveCollection(db, col);

  const card = [...col.cards.values()][0];
  card.type = CardType.Review;
  card.ivl = 15;
  card.memoryState = { stability: 12.5, difficulty: 6.0 };
  await putCard(db, card);

  const back = await loadCollection(db);
  const reloaded = back.cards.get(card.id);
  assert.equal(reloaded.type, CardType.Review);
  assert.equal(reloaded.ivl, 15);
  assert.deepEqual(reloaded.memoryState, { stability: 12.5, difficulty: 6.0 });
  db.close();
});

test("media round-trips", async () => {
  const db = await freshDb();
  const media = new Map([["a.svg", new Uint8Array([1, 2, 3])], ["b.png", new Uint8Array([4, 5])]]);
  await saveMedia(db, media);
  const back = await loadMedia(db);
  assert.equal(back.size, 2);
  assert.deepEqual(back.get("a.svg"), new Uint8Array([1, 2, 3]));
  db.close();
});

test("clearAll empties the database", async () => {
  const db = await freshDb();
  await saveCollection(db, sampleCollection());
  await clearAll(db);
  assert.equal(await loadCollection(db), null);
  db.close();
});

test("note edit history: push, list (newest first), prune, delete", async () => {
  const db = await openCollectionDB(`hist-${Date.now()}`, indexedDB);
  await pushNoteHistory(db, 42, ["v1", "a"], []);
  await pushNoteHistory(db, 42, ["v2", "b"], ["t"]);
  await pushNoteHistory(db, 99, ["other"], []);
  const hist = await listNoteHistory(db, 42);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((h) => h.fields[0]).includes("v2"), true);
  assert.deepEqual((await listNoteHistory(db, 99)).length, 1);

  // prune: cap is 20 per note
  for (let i = 0; i < 30; i++) await pushNoteHistory(db, 42, [`v${i + 3}`], []);
  assert.equal((await listNoteHistory(db, 42)).length, 20);

  await deleteNoteHistory(db, 42);
  assert.equal((await listNoteHistory(db, 42)).length, 0);
  assert.equal((await listNoteHistory(db, 99)).length, 1); // untouched
});
