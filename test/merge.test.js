// .apkg merge-on-import tests.

import test from "node:test";
import assert from "node:assert/strict";

import { mergeCollection } from "../src/merge.js";
import { Collection, Note, Card } from "../src/model.js";

function source() {
  const col = Collection.createDefault();
  const mid = Object.values(col.models).find((m) => m.name === "Basic").id;
  for (const [q, a] of [["2+2", "4"], ["capital", "Paris"]]) {
    const n = new Note({ mid, fields: [q, a], mod: 1000 }).normalize();
    col.addNote(n);
    col.addCard(new Card({ nid: n.id, did: 1 }));
  }
  return col;
}

test("merge adds new notes + cards; re-merge updates, no duplicates", () => {
  const src = source();
  const target = Collection.createDefault();

  let r = mergeCollection(target, src);
  assert.deepEqual(r, { added: 2, updated: 0 });
  assert.equal(target.notes.size, 2);
  assert.equal(target.cards.size, 2);

  // Merge the same source again → all matched by guid, updated, no new cards.
  r = mergeCollection(target, src);
  assert.equal(r.added, 0);
  assert.equal(r.updated, 2);
  assert.equal(target.notes.size, 2);
  assert.equal(target.cards.size, 2);
});

test("merge updates an existing note's fields when the import is newer", () => {
  const src = source();
  const target = Collection.createDefault();
  mergeCollection(target, src);

  // Edit a source note and bump its mod, then re-merge.
  const sn = [...src.notes.values()][0];
  sn.fields = ["2+2", "four"];
  sn.mod = 2000;
  mergeCollection(target, src);

  const tn = [...target.notes.values()].find((n) => n.guid === sn.guid);
  assert.deepEqual(tn.fields, ["2+2", "four"]);
});

test("older imports do not overwrite newer existing notes", () => {
  const src = source();
  const target = Collection.createDefault();
  mergeCollection(target, src);

  const tn = [...target.notes.values()][0];
  tn.fields = ["2+2", "newer answer"];
  tn.mod = 5000; // target is newer than source (mod 1000)
  mergeCollection(target, src);

  // The newer target note is not overwritten by the older import.
  assert.deepEqual([...target.notes.values()].find((n) => n.guid === tn.guid).fields, ["2+2", "newer answer"]);
});

test("id collisions get fresh ids without dropping data", () => {
  const target = Collection.createDefault();
  const mid = Object.values(target.models).find((m) => m.name === "Basic").id;
  const existing = new Note({ mid, fields: ["x", "y"], guid: "AAA" });
  target.addNote(existing);

  const src = new Collection();
  src.crt = target.crt;
  src.models = target.models;
  const clash = new Note({ id: existing.id, guid: "BBB", mid, fields: ["p", "q"], mod: 1 }).normalize();
  src.notes.set(clash.id, clash);
  src.cards.set(clash.id, new Card({ id: clash.id, nid: clash.id, did: 1 }));

  const r = mergeCollection(target, src);
  assert.equal(r.added, 1);
  assert.equal(target.notes.size, 2); // both kept
});
