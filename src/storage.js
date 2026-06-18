// Local-first persistence in IndexedDB.
//
// Object stores:
//   meta   - one record (key "collection") with col-level fields (crt/mod/scm/
//            ver/dty/usn/ls/conf/models/decks/dconf/tags)
//   notes  - keyPath "id"
//   cards  - keyPath "id", index "did"
//   revlog - keyPath "id"
//   media  - keyPath "name" ({ name, data: Uint8Array })
//
// The module uses the global `indexedDB`, so it runs in browsers as-is and in
// Node tests via the `fake-indexeddb` polyfill. No runtime dependencies.

import { Collection, Note, Card, Revlog } from "./model.js";

const STORES = ["meta", "notes", "cards", "revlog", "media"];
const DB_VERSION = 1;
const META_KEY = "collection";

const promisify = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** Open (and migrate) the collection database. @returns {Promise<IDBDatabase>} */
export function openCollectionDB(name = "oss-anki", idb = globalThis.indexedDB) {
  if (!idb) throw new Error("no IndexedDB available (pass one, or run in a browser)");
  return new Promise((resolve, reject) => {
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("cards")) {
        const cards = db.createObjectStore("cards", { keyPath: "id" });
        cards.createIndex("did", "did", { unique: false });
      }
      if (!db.objectStoreNames.contains("revlog")) db.createObjectStore("revlog", { keyPath: "id" });
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const metaFromCol = (c) => ({
  crt: c.crt, mod: c.mod, scm: c.scm, ver: c.ver, dty: c.dty, usn: c.usn, ls: c.ls,
  conf: c.conf, models: c.models, decks: c.decks, dconf: c.dconf, tags: c.tags,
});

/** Write an entire collection (replacing existing notes/cards/revlog/meta). */
export async function saveCollection(db, collection) {
  const tx = db.transaction(["meta", "notes", "cards", "revlog"], "readwrite");
  const meta = tx.objectStore("meta");
  const notes = tx.objectStore("notes");
  const cards = tx.objectStore("cards");
  const revlog = tx.objectStore("revlog");
  meta.clear();
  notes.clear();
  cards.clear();
  revlog.clear();
  meta.put(metaFromCol(collection), META_KEY);
  for (const n of collection.notes.values()) notes.put({ ...n });
  for (const c of collection.cards.values()) cards.put({ ...c });
  for (const r of collection.revlog) revlog.put({ ...r });
  await txDone(tx);
}

/** Load a collection, or null if none has been saved yet. @returns {Promise<Collection|null>} */
export async function loadCollection(db) {
  const tx = db.transaction(["meta", "notes", "cards", "revlog"], "readonly");
  const meta = await promisify(tx.objectStore("meta").get(META_KEY));
  if (!meta) return null;

  const col = new Collection();
  Object.assign(col, meta);
  for (const o of await promisify(tx.objectStore("notes").getAll())) col.notes.set(o.id, new Note(o));
  for (const o of await promisify(tx.objectStore("cards").getAll())) col.cards.set(o.id, new Card(o));
  col.revlog = (await promisify(tx.objectStore("revlog").getAll())).map((o) => new Revlog(o));
  return col;
}

/** Persist a single card (e.g. after answering). */
export async function putCard(db, card) {
  const tx = db.transaction("cards", "readwrite");
  tx.objectStore("cards").put({ ...card });
  await txDone(tx);
}

/** Persist a single note. */
export async function putNote(db, note) {
  const tx = db.transaction("notes", "readwrite");
  tx.objectStore("notes").put({ ...note });
  await txDone(tx);
}

/** Append a revlog entry. */
export async function putRevlog(db, entry) {
  const tx = db.transaction("revlog", "readwrite");
  tx.objectStore("revlog").put({ ...entry });
  await txDone(tx);
}

/** Persist the collection-level metadata (conf/models/decks/dconf/...). */
export async function putMeta(db, collection) {
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(metaFromCol(collection), META_KEY);
  await txDone(tx);
}

/** Save media blobs (filename -> Uint8Array). */
export async function saveMedia(db, media) {
  const tx = db.transaction("media", "readwrite");
  const store = tx.objectStore("media");
  for (const [name, data] of media) store.put({ name, data });
  await txDone(tx);
}

/** Load all media as a Map<filename, Uint8Array>. */
export async function loadMedia(db) {
  const tx = db.transaction("media", "readonly");
  const all = await promisify(tx.objectStore("media").getAll());
  return new Map(all.map((o) => [o.name, o.data]));
}

/** Delete everything (all stores). Useful for "replace collection" on import. */
export async function clearAll(db) {
  const tx = db.transaction(STORES, "readwrite");
  for (const s of STORES) tx.objectStore(s).clear();
  await txDone(tx);
}
