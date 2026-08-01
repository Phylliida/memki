// File-backed persistence tests (web/storage-file.js) with a mock bridge —
// the same surface as src/storage.js, but everything lives in one JSON file.

import test from "node:test";
import assert from "node:assert/strict";

import {
  openCollectionDB, saveCollection, loadCollection, putCard, putNote, putRevlog,
  saveMedia, loadMedia, clearAll, pushNoteHistory, listNoteHistory,
  deleteNoteHistory, deleteNoteAndCards, flushStore, storeStamp,
} from "../web/storage-file.js";
import { Collection, Note, Card, Revlog } from "../src/model.js";
import { collectionToBackup } from "../src/backup.js";

// In-memory bridge mirroring the native SaveFolder plugin contract.
function mockBridge() {
  let content = null; // base64 of the file bytes
  let mtime = 0;
  return {
    async read() { return content; },
    async write(b64) { content = b64; mtime += 1000; return { modified: mtime }; },
    async stat() { return { exists: content != null, modified: mtime }; },
    // Test helpers: simulate an external (e.g. Syncthing) write.
    externalWrite(b64) { content = b64; mtime += 1000; },
    raw() { return content; },
  };
}

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

test("loadCollection returns null when the file doesn't exist", async () => {
  const db = await openCollectionDB(mockBridge());
  assert.equal(await loadCollection(db), null);
});

test("save, flush, reopen: collection + media round trip", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  const col = sampleCollection();
  await saveCollection(db, col);
  await saveMedia(db, new Map([["pic.png", new Uint8Array([1, 2, 3, 250])]]));
  await flushStore(db);

  assert.ok(bridge.raw(), "file was written");
  assert.ok(storeStamp(db) > 0);

  const db2 = await openCollectionDB(bridge);
  const back = await loadCollection(db2);
  assert.ok(back);
  assert.deepEqual(back.decks, col.decks);
  assert.deepEqual(back.models, col.models);
  assert.equal(back.notes.size, 2);
  assert.equal(back.cards.size, 2);
  const note = [...back.notes.values()][0];
  assert.ok(note instanceof Note);
  assert.deepEqual(note.fields, ["2+2", "4"]);
  assert.deepEqual(note.tags, ["demo"]);
  const media = await loadMedia(db2);
  assert.deepEqual([...media.get("pic.png")], [1, 2, 3, 250]);
});

test("incremental puts after in-app mutation are persisted", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  const col = sampleCollection();
  await saveCollection(db, col);
  await flushStore(db);

  // The app mutates the Collection object first, then calls the puts.
  const card = [...col.cards.values()][0];
  card.ivl = 42;
  col.revlog.push(new Revlog({ id: 123, cid: card.id, ease: 3 }));
  await putCard(db, card);
  await putRevlog(db);
  await putNote(db, col.notes.get(card.nid));
  await flushStore(db);

  const db2 = await openCollectionDB(bridge);
  const back = await loadCollection(db2);
  assert.equal(back.cards.get(card.id).ivl, 42);
  assert.equal(back.revlog.length, 1);
  assert.equal(back.revlog[0].ease, 3);
});

test("note edit history: keep last 20, newest first, survives reload", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  await saveCollection(db, sampleCollection());
  for (let i = 0; i < 25; i++) {
    await pushNoteHistory(db, 7, [`v${i}`, "x"], ["t"]);
  }
  const hist = await listNoteHistory(db, 7);
  assert.equal(hist.length, 20); // pruned to the newest 20 (v5..v24)
  assert.deepEqual(
    new Set(hist.map((h) => h.fields[0])),
    new Set(Array.from({ length: 20 }, (_, i) => `v${i + 5}`)),
  );
  for (let i = 1; i < hist.length; i++) assert.ok(hist[i - 1].ts >= hist[i].ts);
  assert.deepEqual(await listNoteHistory(db, 999), []);
  await flushStore(db);

  const db2 = await openCollectionDB(bridge);
  await loadCollection(db2);
  assert.equal((await listNoteHistory(db2, 7)).length, 20);

  await deleteNoteHistory(db2, 7);
  assert.deepEqual(await listNoteHistory(db2, 7), []);
});

test("clearAll + saveCollection replaces the collection", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  await saveCollection(db, sampleCollection());
  await saveMedia(db, new Map([["a.png", new Uint8Array([9])]]));
  await flushStore(db);

  const fresh = Collection.createDefault();
  await clearAll(db);
  await saveCollection(db, fresh);
  await flushStore(db);

  const db2 = await openCollectionDB(bridge);
  const back = await loadCollection(db2);
  assert.equal(back.notes.size, 0);
  assert.equal((await loadMedia(db2)).size, 0);
});

test("external change is visible via stat + force reload", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  const col = sampleCollection();
  await saveCollection(db, col);
  await flushStore(db);
  const stamp = storeStamp(db);

  // Another device (via Syncthing) writes a collection with an extra note.
  const other = sampleCollection();
  const mid = Object.values(other.models)[0].id;
  const n = new Note({ mid, fields: ["from", "elsewhere"] }).normalize();
  other.addNote(n);
  other.addCard(new Card({ nid: n.id, did: 1 }));
  const b64 = btoa(unescape(encodeURIComponent(
    JSON.stringify(collectionToBackup(other, new Map())),
  )));
  bridge.externalWrite(b64);

  const st = await bridge.stat();
  assert.notEqual(st.modified, stamp); // app would detect this on resume

  const back = await loadCollection(db, { force: true });
  assert.equal(back.notes.size, 3);
  assert.equal(storeStamp(db), st.modified);
});

test("flushStore is a no-op when clean or empty", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  await flushStore(db); // nothing loaded, nothing dirty
  assert.equal(bridge.raw(), null);

  await saveCollection(db, sampleCollection());
  await flushStore(db);
  const first = bridge.raw();
  await flushStore(db); // clean now — no rewrite
  assert.equal(bridge.raw(), first);
});

test("deleteNoteAndCards marks dirty and persists the app's mutation", async () => {
  const bridge = mockBridge();
  const db = await openCollectionDB(bridge);
  const col = sampleCollection();
  await saveCollection(db, col);
  await flushStore(db);

  const note = [...col.notes.values()][0];
  const cardIds = col.cardsForNote(note.id).map((c) => c.id);
  for (const id of cardIds) col.cards.delete(id);
  col.notes.delete(note.id);
  await deleteNoteAndCards(db, note.id, cardIds);
  await flushStore(db);

  const db2 = await openCollectionDB(bridge);
  const back = await loadCollection(db2);
  assert.equal(back.notes.size, 1);
  assert.equal(back.cards.size, 1);
});
