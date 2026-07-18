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

test("decks merge by name; new decks are added, not duplicated", () => {
  const src = source();
  src.addDeck("Spanish");
  const spanishId = Object.values(src.decks).find((d) => d.name === "Spanish").id;
  for (const c of src.cards.values()) c.did = spanishId;

  const target = Collection.createDefault();
  mergeCollection(target, src);

  // "Default" matched by name (no duplicate); "Spanish" added.
  const names = Object.values(target.decks).map((d) => d.name).sort();
  assert.deepEqual(names, ["Default", "Spanish"]);
  const tSpanish = Object.values(target.decks).find((d) => d.name === "Spanish");
  for (const c of target.cards.values()) assert.equal(c.did, tSpanish.id);
});

test("a same-name deck with a clashing id maps cards into the existing deck", () => {
  const target = Collection.createDefault();
  target.addDeck("Spanish");
  const tid = Object.values(target.decks).find((d) => d.name === "Spanish").id;

  const src = source();
  const sDeck = src.addDeck("Spanish");
  for (const c of src.cards.values()) c.did = sDeck.id;

  mergeCollection(target, src);
  assert.equal(Object.values(target.decks).filter((d) => d.name === "Spanish").length, 1);
  for (const c of target.cards.values()) assert.equal(c.did, tid);
});

test("review due dates shift by the collections' creation-day offset", () => {
  const src = source();
  const target = Collection.createDefault();
  src.crt = target.crt - 100 * 86400; // source collection created 100 days earlier

  // A review card due on source-day 130 (i.e. 30 days from source-day 100 = today).
  const [note] = [...src.notes.values()];
  const rev = [...src.cards.values()].find((c) => c.nid === note.id);
  rev.type = 2;
  rev.queue = 2;
  rev.due = 130;

  mergeCollection(target, src);
  const merged = [...target.cards.values()].find((c) => c.queue === 2);
  assert.equal(merged.due, 30); // still due 30 days from target-day 0 = today
});

test("new cards' position-based due is not shifted", () => {
  const src = source();
  const target = Collection.createDefault();
  src.crt = target.crt - 100 * 86400;
  mergeCollection(target, src);
  for (const c of [...target.cards.values()].filter((c) => c.type === 0)) {
    assert.ok(c.due < 1000, `new-card position preserved (got ${c.due})`);
  }
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
