// Merge an imported collection into an existing one (Anki .apkg "add" semantics).
//
// Notes are matched by GUID: a matching note has its fields/tags updated (when
// the imported copy is at least as new); a new note is added along with its
// cards. Existing notes' cards/scheduling are left untouched. Missing note
// types / decks / option groups are added by id.
//
// Pure and testable. ID collisions (a different note/card already using an
// imported id) are resolved by assigning a fresh id from the target.

import { Note, Card } from "./model.js";

/**
 * @returns {{ added: number, updated: number }}
 */
export function mergeCollection(target, source) {
  let added = 0;
  let updated = 0;

  for (const [id, m] of Object.entries(source.models)) if (!target.models[id]) target.models[id] = m;
  for (const [id, d] of Object.entries(source.decks)) if (!target.decks[id]) target.decks[id] = d;
  for (const [id, c] of Object.entries(source.dconf)) if (!target.dconf[id]) target.dconf[id] = c;

  const byGuid = new Map();
  for (const n of target.notes.values()) byGuid.set(n.guid, n);

  for (const sn of source.notes.values()) {
    const existing = byGuid.get(sn.guid);
    if (existing) {
      // Update content only if the imported note isn't older.
      if ((sn.mod ?? 0) >= (existing.mod ?? 0)) {
        existing.fields = sn.fields.slice();
        existing.tags = sn.tags.slice();
        existing.mod = sn.mod;
        existing.normalize(target.noteType(existing.mid)?.sortf ?? 0);
        updated++;
      }
      continue; // leave existing cards/scheduling alone
    }
    // New note: preserve its id unless taken.
    let nid = sn.id;
    if (nid == null || target.notes.has(nid)) nid = target.nextId();
    const note = new Note({
      id: nid, guid: sn.guid, mid: sn.mid, mod: sn.mod, usn: -1,
      tags: sn.tags.slice(), fields: sn.fields.slice(),
      sfld: sn.sfld, csum: sn.csum, flags: sn.flags, data: sn.data,
    });
    target.notes.set(nid, note);
    byGuid.set(note.guid, note);
    for (const c of source.cardsForNote(sn.id)) {
      let cid = c.id;
      if (cid == null || target.cards.has(cid)) cid = target.nextId();
      target.cards.set(cid, new Card({ ...c, id: cid, nid, usn: -1 }));
    }
    added++;
  }
  return { added, updated };
}
