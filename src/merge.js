// Merge an imported collection into an existing one (Anki .apkg "add" semantics).
//
// Notes are matched by GUID: a matching note has its fields/tags updated (when
// the imported copy is at least as new); a new note is added along with its
// cards. Existing notes' cards/scheduling are left untouched. Decks are matched
// by name (so an imported "Default" merges into the existing "Default" instead
// of duplicating it); unmatched decks are added as new decks. Missing note
// types / option groups are added by id.
//
// Pure and testable. ID collisions (a different note/card/deck already using an
// imported id) are resolved by assigning a fresh id from the target.

import { Note, Card, CardType, CardQueue } from "./model.js";

/** Day-based due (days since collection creation), vs. seconds or a position. */
function hasDayBasedDue(card) {
  return card.queue === CardQueue.Review || card.queue === CardQueue.DayLearning ||
    (card.queue < 0 && card.type === CardType.Review);
}

/**
 * @returns {{ added: number, updated: number }}
 */
export function mergeCollection(target, source) {
  let added = 0;
  let updated = 0;

  for (const [id, m] of Object.entries(source.models)) if (!target.models[id]) target.models[id] = m;
  for (const [id, c] of Object.entries(source.dconf)) if (!target.dconf[id]) target.dconf[id] = c;

  // Decks: match by name, add the rest (fresh id if the imported one is taken).
  const deckIds = new Map();
  const byName = new Map(Object.values(target.decks).map((d) => [d.name, d]));
  for (const d of Object.values(source.decks)) {
    const existing = byName.get(d.name);
    if (existing) {
      deckIds.set(d.id, existing.id);
      continue;
    }
    let did = d.id;
    if (did == null || target.decks[String(did)]) did = target.nextId();
    const deck = { ...d, id: did };
    target.decks[String(did)] = deck;
    byName.set(deck.name, deck);
    deckIds.set(d.id, did);
  }

  // Review-type due dates are day numbers relative to the collection's creation
  // day, which differs between collections: shift them so "due N days from now"
  // still means N days from now after the merge.
  const dayShift = Math.round(((source.crt ?? 0) - (target.crt ?? 0)) / 86400);
  const shiftDue = (card) => {
    if (!dayShift) return;
    if (card.odid) {
      // In a filtered deck `due` is an ordering; the home due date is odue.
      if (card.type === CardType.Review) card.odue += dayShift;
    } else if (hasDayBasedDue(card)) {
      card.due += dayShift;
    }
  };

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
      const card = new Card({ ...c, id: cid, nid, usn: -1, did: deckIds.get(c.did) ?? c.did });
      shiftDue(card);
      target.cards.set(cid, card);
    }
    added++;
  }
  return { added, updated };
}
