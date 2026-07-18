// JSON backup round-trip tests.

import test from "node:test";
import assert from "node:assert/strict";

import { collectionToBackup, collectionFromBackup } from "../src/backup.js";
import { Collection, Note, Card, CardType, CardQueue } from "../src/model.js";

function sample() {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  const note = new Note({ mid, fields: ["Q", "A"], tags: ["t1"] }).normalize();
  col.addNote(note);
  col.addCard(new Card({ nid: note.id, did: 1, type: CardType.Review, queue: CardQueue.Review, ivl: 12, due: 30, factor: 2500 }));
  const media = new Map([["a.png", new Uint8Array([137, 80, 78, 71, 0, 255, 3])]]);
  return { col, media };
}

test("backup round-trips collection and media byte-for-byte", () => {
  const { col, media } = sample();
  const json = JSON.parse(JSON.stringify(collectionToBackup(col, media))); // through real JSON
  const { collection: back, media: mediaBack } = collectionFromBackup(json);

  assert.equal(back.crt, col.crt);
  assert.equal(back.notes.size, 1);
  assert.equal(back.cards.size, 1);
  const [n0] = [...back.notes.values()];
  assert.deepEqual(n0.fields, ["Q", "A"]);
  assert.deepEqual(n0.tags, ["t1"]);
  const [c0] = [...back.cards.values()];
  assert.equal(c0.ivl, 12);
  assert.equal(c0.queue, CardQueue.Review);
  assert.deepEqual(Object.keys(back.models).sort(), Object.keys(col.models).sort());
  assert.deepEqual([...mediaBack.get("a.png")], [137, 80, 78, 71, 0, 255, 3]);
});

test("restoring rejects non-backup JSON", () => {
  assert.throws(() => collectionFromBackup({ some: "json" }), /not an oss-anki backup/);
});
