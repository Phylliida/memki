// File-backed persistence: the same function surface as src/storage.js, but
// the whole collection lives in ONE JSON file (the src/backup.js format, plus
// a `history` field) instead of IndexedDB. Used by the Capacitor Android app,
// where the user picks a folder and the file sits there for external sync
// (Syncthing etc.).
//
// The "db" handle is a plain object holding an in-memory mirror of the
// collection; every mutating call just marks the store dirty and schedules a
// debounced full-file rewrite (the app mutates the Collection object first,
// then calls these puts — same contract as the IndexedDB backend).
//
// The bridge abstracts the actual file IO (native plugin on Android, the
// File System Access API on desktop Chrome/Edge, a mock in tests):
//   read()                -> Promise<string|null>  base64 file bytes, null if missing
//   write(base64)         -> Promise<{modified:number}>  atomic replace (tmp+rename)
//   stat()                -> Promise<{exists:boolean, modified:number}>
//   readMedia(name)       -> Promise<string|null>  base64 media bytes, null if missing
//   writeMedia(name, b64) -> Promise<void>
//
// Media does NOT live in the JSON: it's individual files in an
// `oss-anki.media/` sibling folder, so reviewing a card rewrites only the
// (small) text JSON and Syncthing only moves genuinely new media. Save files
// written by older versions may still embed base64 media — loadCollection
// migrates those out to files on first read.

import { collectionToBackup, collectionFromBackup } from "../src/backup.js";

const WRITE_DEBOUNCE_MS = 1000;
const HISTORY_KEEP = 20; // versions kept per note (matches src/storage.js)

// --- text <-> base64 (chunked; btoa/atob exist in browsers and Node >= 16) ---

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Open the file-backed store. The bridge must already point at a chosen file. */
export async function openCollectionDB(bridge) {
  if (!bridge) throw new Error("file storage needs a bridge (no save folder chosen?)");
  return {
    bridge,
    col: null,          // Collection mirror (the same object the app mutates)
    history: new Map(), // nid -> [{ts, fields, tags}], oldest first
    dirty: false,
    epoch: 0,           // bumped by every markDirty; guards in-flight flushes
    timer: null,
    writing: null,      // in-flight flush promise
    lastStamp: 0,       // file mtime we last read or wrote (external-change detection)
    lastSerialized: null, // last file content — flushes with no real change are skipped
  };
}

function markDirty(db) {
  db.epoch += 1;
  db.dirty = true;
  db.onDirty?.(); // app.js: edits instantly re-enable the Backup button
  if (db.timer) clearTimeout(db.timer);
  db.timer = setTimeout(() => {
    db.timer = null;
    flushStore(db)?.catch((e) => console.error("save-file write failed:", e));
  }, WRITE_DEBOUNCE_MS);
}

function serialize(db) {
  // No media in the JSON — it lives as sibling files (see header comment).
  const backup = collectionToBackup(db.col);
  backup.history = Object.fromEntries(
    [...db.history].map(([nid, arr]) => [String(nid), arr]),
  );
  return JSON.stringify(backup);
}

/** Write any pending changes to the file now (no-op when clean). */
export async function flushStore(db) {
  if (db.timer) { clearTimeout(db.timer); db.timer = null; }
  if (db.writing) return db.writing; // serialize concurrent flushes
  if (!db.dirty || !db.col) return;
  // Snapshot synchronously, then only clear `dirty` if nothing was marked
  // while the write was in flight (a newer markDirty has its own timer and
  // will flush again).
  const epoch = db.epoch;
  const text = serialize(db);
  if (text === db.lastSerialized) {
    // Nothing actually changed (e.g. init's unconditional putMeta) — don't
    // rewrite the file: the mtime is the external-change signal, and
    // bumping it would fool the watcher AND the backup-stamp check.
    if (db.epoch === epoch) db.dirty = false;
    db.onFlushed?.();
    return;
  }
  db.writing = (async () => {
    try {
      const { modified } = await db.bridge.write(textToBase64(text));
      db.lastStamp = modified;
      db.lastSerialized = text;
      db.onFileEvent?.("saved", modified); // app.js save/load history log
      if (db.epoch === epoch) db.dirty = false;
      db.onFlushed?.();
    } finally {
      db.writing = null;
    }
  })();
  return db.writing;
}

/** The file mtime this store last read/wrote; compare with bridge.stat(). */
export function storeStamp(db) {
  return db.lastStamp;
}

/**
 * Load the collection, or null if the file doesn't exist yet.
 * Pass { force: true } to re-read from disk (external change / folder switch).
 * @returns {Promise<import("../src/model.js").Collection|null>}
 */
export async function loadCollection(db, { force = false } = {}) {
  if (db.col && !force) return db.col;
  const b64 = await db.bridge.read();
  if (b64 == null) {
    db.col = null; db.history = new Map();
    return null;
  }
  const obj = JSON.parse(base64ToText(b64));
  const { collection, media } = collectionFromBackup(obj);
  db.col = collection;
  db.history = new Map(
    Object.entries(obj.history ?? {}).map(([nid, arr]) => [Number(nid), arr]),
  );
  db.lastSerialized = base64ToText(b64); // lets flushStore skip no-change rewrites
  // One-time migration: save files from before the media split still embed
  // base64 media — move it out to sibling files and rewrite the JSON
  // without it (via the dirty flag).
  if (media.size > 0) {
    await saveMedia(db, media);
    markDirty(db);
  }
  const st = await db.bridge.stat();
  db.lastStamp = st.modified;
  return db.col;
}

/** Replace the whole collection (mirrors + schedules a write). */
export async function saveCollection(db, collection) {
  db.col = collection;
  markDirty(db);
}

// The app mutates the Collection object before calling these; the file
// backend only needs to schedule a rewrite.

export async function putCard(db) { markDirty(db); }
export async function putNote(db) { markDirty(db); }
export async function putRevlog(db) { markDirty(db); }
export async function deleteRevlog(db) { markDirty(db); }
export async function putMeta(db) { markDirty(db); }
export async function deleteCards(db) { markDirty(db); }
export async function deleteNoteAndCards(db) { markDirty(db); }

/** Record a note's field/tag snapshot in its edit history (pruned to the last N). */
export async function pushNoteHistory(db, nid, fields, tags) {
  const arr = db.history.get(nid) ?? [];
  arr.push({ ts: Date.now(), fields: [...fields], tags: [...tags] });
  while (arr.length > HISTORY_KEEP) arr.shift();
  db.history.set(nid, arr);
  markDirty(db);
}

/** A note's edit history, newest first. */
export async function listNoteHistory(db, nid) {
  return (db.history.get(nid) ?? []).slice().sort((a, b) => b.ts - a.ts);
}

/** Drop a note's edit history (when the note is deleted). */
export async function deleteNoteHistory(db, nid) {
  db.history.delete(nid);
  markDirty(db);
}

/** Write media blobs as individual sibling files (filename -> Uint8Array). */
export async function saveMedia(db, media) {
  for (const [name, data] of media) await db.bridge.writeMedia(name, bytesToBase64(data));
}

/** Fetch specific media files by name; missing ones are skipped. */
export async function loadMediaNames(db, names) {
  const out = new Map();
  for (const name of names) {
    const b64 = await db.bridge.readMedia(name);
    if (b64 != null) out.set(name, base64ToBytes(b64));
  }
  return out;
}

/** The file backend never bulk-loads media — the app fetches lazily by name. */
export async function loadMedia(db) {
  return new Map();
}

/** Reset everything (used by "replace collection" on restore/import). */
export async function clearAll(db) {
  db.col = null;
  db.history = new Map();
  markDirty(db);
}
