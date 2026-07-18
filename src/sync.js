// Sync merge engine for static-file sync (no server, no locks).
//
// The model: each device writes its own JSON state file; syncing reads every
// device's file, merges them all with local state, and writes only its own
// file back. No write ever races another device's write, and because merging
// is idempotent and order-insensitive, devices converge after exchanging
// files in any order.
//
// Merge rules (identity → conflict resolution):
//   revlog   by id          → union (append-only history; nothing ever lost)
//   notes    by GUID        → newer mod wins fields/tags; per-deck scheduling
//                             memory (data.sched) merges key-wise
//   cards    by (note GUID, → the state with more reps wins; ties fall to
//             deck name, ord)  newer mod, then a deterministic comparator
//   decks    by name        → union; newer mod wins settings
//   models   by id          → union; newer mod wins
//   graves   union          → deletions win (restores clear their tombstone
//                             at restore time, see addNoteCardToDeck)
//   media    by filename    → union (a's bytes win exact-name conflicts)
//
// Day-based due dates are shifted by the collections' creation-day offset
// when the two sides' crt differ (same rule as .apkg import).

import { Collection, Note, Card, Revlog, CardType, CardQueue, defaultDeckConfig } from "./model.js";
import { collectionToBackup, collectionFromBackup } from "./backup.js";

const DAY = 86400;

const deckNameOf = (col, did) => col.decks[String(did)]?.name ?? null;

const hasDayBasedDue = (c) =>
  c.queue === CardQueue.Review || c.queue === CardQueue.DayLearning ||
  (c.queue < 0 && c.type === CardType.Review);

/** Deterministic winner for equal-reps, equal-mod card conflicts. */
function cardTieBreak(x, y) {
  return JSON.stringify(x.toRow()) >= JSON.stringify(y.toRow()) ? x : y;
}

/** Pick the winning scheduling state for the same logical card. */
function pickCard(x, y) {
  if (x.reps !== y.reps) return x.reps > y.reps ? x : y;
  if ((x.mod ?? 0) !== (y.mod ?? 0)) return (x.mod ?? 0) > (y.mod ?? 0) ? x : y;
  return cardTieBreak(x, y);
}

/** Merge two per-deck scheduling maps key-wise; `prefer` wins shared keys. */
function mergeSchedData(prefer, other) {
  const parse = (s) => { try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
  const a = parse(prefer);
  const b = parse(other);
  const merged = { ...b, ...a };
  const sched = { ...(b.sched ?? {}), ...(a.sched ?? {}) };
  if (Object.keys(sched).length) merged.sched = sched;
  else delete merged.sched;
  return Object.keys(merged).length ? JSON.stringify(merged) : "";
}

/**
 * Merge collection `b` into a deep copy of `a` and return it. Deterministic
 * and symmetric up to tie-breaks, so repeated merging converges.
 * @returns {Collection}
 */
export function syncMerge(a, b) {
  const m = collectionFromBackup(JSON.parse(JSON.stringify(collectionToBackup(a)))).collection; // deep copy of a
  m.graves = [...a.graves.map((g) => ({ ...g }))];

  // Day-number offset for b's day-based due values.
  const dayShift = Math.round(((b.crt ?? 0) - (m.crt ?? 0)) / DAY);
  m.crt = Math.min(m.crt ?? 0, b.crt ?? m.crt ?? 0) || m.crt;

  // --- graves: union, then delete-wins ---
  const graveKey = (g) => `${g.type}:${g.oid}`;
  const graves = new Map(m.graves.map((g) => [graveKey(g), g]));
  for (const g of b.graves ?? []) if (!graves.has(graveKey(g))) graves.set(graveKey(g), { ...g });
  m.graves = [...graves.values()];
  const deadCards = new Set(m.graves.filter((g) => g.type === 0).map((g) => g.oid));
  const deadNotes = new Set(m.graves.filter((g) => g.type === 1).map((g) => g.oid));
  const deadDecks = new Set(m.graves.filter((g) => g.type === 2).map((g) => g.oid));

  // --- models by id: newer mod wins ---
  for (const [id, bm] of Object.entries(b.models)) {
    const am = m.models[id];
    if (!am || (bm.mod ?? 0) > (am.mod ?? 0)) m.models[id] = JSON.parse(JSON.stringify(bm));
  }

  // --- decks by name (with settings groups) ---
  const bDeckToMerged = new Map(); // b deck id -> merged deck id
  const byName = new Map(Object.values(m.decks).map((d) => [d.name, d]));
  for (const bd of Object.values(b.decks)) {
    if (deadDecks.has(bd.id) && !byName.has(bd.name)) continue;
    const existing = byName.get(bd.name);
    if (existing) {
      bDeckToMerged.set(bd.id, existing.id);
      if ((bd.mod ?? 0) > (existing.mod ?? 0)) {
        const keep = { id: existing.id, conf: existing.conf };
        Object.assign(existing, JSON.parse(JSON.stringify(bd)), keep);
      }
      continue;
    }
    const nd = JSON.parse(JSON.stringify(bd));
    if (m.decks[String(nd.id)]) nd.id = m.nextId();
    m.decks[String(nd.id)] = nd;
    byName.set(nd.name, nd);
    bDeckToMerged.set(bd.id, nd.id);
    // bring its options group along
    const bdc = b.dconf[String(bd.conf)];
    if (bdc && !m.dconf[String(bd.conf)]) m.dconf[String(bd.conf)] = JSON.parse(JSON.stringify(bdc));
    else if (bdc && m.dconf[String(bd.conf)]?.name !== bdc.name) {
      const id = m.nextId();
      m.dconf[String(id)] = { ...JSON.parse(JSON.stringify(bdc)), id };
      nd.conf = id;
    }
  }
  for (const [id, dc] of Object.entries(b.dconf ?? {})) {
    if (!m.dconf[id]) m.dconf[id] = JSON.parse(JSON.stringify(dc));
    else if ((dc.mod ?? 0) > (m.dconf[id].mod ?? 0) && m.dconf[id].name === dc.name) {
      m.dconf[id] = JSON.parse(JSON.stringify(dc));
    }
  }

  // --- notes by GUID ---
  const byGuid = new Map();
  for (const n of m.notes.values()) byGuid.set(n.guid, n);
  const bNoteToMerged = new Map(); // b note id -> merged note id
  for (const bn of b.notes.values()) {
    if (deadNotes.has(bn.id) && !byGuid.has(bn.guid)) continue;
    const existing = byGuid.get(bn.guid);
    if (existing) {
      bNoteToMerged.set(bn.id, existing.id);
      const bNewer = (bn.mod ?? 0) > (existing.mod ?? 0) ||
        ((bn.mod ?? 0) === (existing.mod ?? 0) && bn.fields.join("\x1f") > existing.fields.join("\x1f"));
      if (bNewer) {
        existing.fields = bn.fields.slice();
        existing.tags = bn.tags.slice();
        existing.mod = bn.mod;
        existing.sfld = bn.sfld;
        existing.csum = bn.csum;
        existing.data = mergeSchedData(bn.data, existing.data);
      } else {
        existing.data = mergeSchedData(existing.data, bn.data);
      }
      continue;
    }
    let nid = bn.id;
    if (m.notes.has(nid)) nid = m.nextId();
    const note = new Note({ ...bn, id: nid, fields: bn.fields.slice(), tags: bn.tags.slice() });
    m.notes.set(nid, note);
    byGuid.set(note.guid, note);
    bNoteToMerged.set(bn.id, nid);
  }

  // --- cards by (note GUID, deck name, ord) ---
  const cardKeyIn = (col, c) => {
    const guid = col.notes.get(c.nid)?.guid;
    const deck = deckNameOf(col, c.did);
    return guid && deck ? `${guid}\x1f${deck}\x1f${c.ord}` : null;
  };
  const mergedByKey = new Map();
  for (const c of m.cards.values()) {
    const k = cardKeyIn(m, c);
    if (k) mergedByKey.set(k, c);
  }
  for (const bc of b.cards.values()) {
    if (deadCards.has(bc.id)) continue;
    const k = cardKeyIn(b, bc);
    const existing = k ? mergedByKey.get(k) : null;
    const shifted = { ...bc };
    if (dayShift && hasDayBasedDue(bc)) shifted.due = bc.due + dayShift;
    if (existing) {
      const winner = pickCard(new Card(shifted), existing);
      if (winner !== existing) {
        const keep = { id: existing.id, nid: existing.nid, did: existing.did, ord: existing.ord };
        Object.assign(existing, winner, keep);
      }
      continue;
    }
    const nid = bNoteToMerged.get(bc.nid) ?? bc.nid;
    const did = bDeckToMerged.get(bc.did) ?? bc.did;
    if (!m.notes.has(nid) || !m.decks[String(did)]) continue; // parent gone
    const props = { ...shifted, nid, did };
    if (m.cards.has(props.id)) props.id = m.nextId();
    const added = m.addCard(new Card(props));
    const key = cardKeyIn(m, added);
    if (key) mergedByKey.set(key, added);
  }
  // delete-wins for a-side cards tombstoned by b
  for (const c of [...m.cards.values()]) {
    if (deadCards.has(c.id)) m.cards.delete(c.id);
  }
  for (const n of [...m.notes.values()]) {
    if (deadNotes.has(n.id)) {
      for (const c of m.cardsForNote(n.id)) m.cards.delete(c.id);
      m.notes.delete(n.id);
    }
  }

  // --- revlog: union by id; distinct entries that collided on a millisecond
  // id (two devices reviewing at the same instant) get bumped, never dropped ---
  const seen = new Set(m.revlog.map((r) => r.id));
  for (const r of b.revlog) {
    let id = r.id;
    if (seen.has(id)) {
      const mine = m.revlog.find((x) => x.id === id);
      if (mine && mine.cid === r.cid && mine.ease === r.ease && mine.type === r.type) continue;
      while (seen.has(id)) id += 1;
    }
    seen.add(id);
    m.revlog.push(new Revlog({ ...r, id }));
  }
  m.revlog.sort((x, y) => x.id - y.id);

  // --- conf: newer collection mod wins; ensure a default options group ---
  if ((b.mod ?? 0) > (a.mod ?? 0)) m.conf = JSON.parse(JSON.stringify(b.conf));
  if (!m.dconf["1"]) m.dconf["1"] = defaultDeckConfig(1, "Default");
  m.mod = Math.max(a.mod ?? 0, b.mod ?? 0);
  return m;
}

/** Merge two media maps (a's bytes win name conflicts). */
export function mergeMedia(a, b) {
  const out = new Map(b);
  for (const [name, bytes] of a) out.set(name, bytes);
  return out;
}
