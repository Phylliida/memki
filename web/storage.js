// Storage backend selector, probed in this order:
//   1. Android app (Capacitor)      → file-backed, SAF folder (native-bridge)
//   2. localhost companion server   → file-backed (http-bridge) whenever it's
//      (web/file-server.py)            clearly in play: page served BY it, or
//                                       paired credentials stored. Missing or
//                                       stale token = loud connect gate, NOT
//                                       a silent IndexedDB fallback.
//   3. File System Access API       → file-backed, picked folder (fs-access-bridge)
//      (desktop Chrome/Edge)
//   4. fallback                     → IndexedDB (src/storage.js)
// File-backed means the whole collection lives in a user-chosen folder as
// oss-anki.json (+ oss-anki.media/), syncable externally (Syncthing etc.).
// All backends expose the same function surface — every call takes the db
// handle first — so callers (web/app.js) don't branch on platform; they
// dispatch bridge imports via `bridgePath`.

import * as idbStore from "../src/storage.js";
import * as fileStore from "./storage-file.js";

export const isNative = !!globalThis.Capacitor?.isNativePlatform?.();
// Live bindings: hasSaveFile/bridgePath/impl may be upgraded from IndexedDB
// to the companion server when openCollectionDB's probe succeeds.
export let hasSaveFile = isNative || !!globalThis.showOpenFilePicker;
export let bridgePath = isNative ? "./native-bridge.js" : "./fs-access-bridge.js";
let impl = hasSaveFile ? fileStore : idbStore;

export async function openCollectionDB(...args) {
  // The companion server wins whenever it's clearly in play: this page is
  // served BY it, or credentials are already paired. Crucially, if the
  // token is missing/stale we do NOT silently fall back to IndexedDB —
  // getSaveFileBridge's gate demands the connect URL (loud failure).
  if (!isNative) {
    const http = await import("./http-bridge.js");
    if ((await http.probe()) || (await http.originIsServer()) || http.hasStoredCreds()) {
      hasSaveFile = true;
      bridgePath = "./http-bridge.js";
      impl = fileStore;
      return fileStore.openCollectionDB(await http.getSaveFileBridge());
    }
  }
  if (hasSaveFile) {
    // The bridge needs the user's chosen save folder; the bridge modules
    // handle the first-run picker gate. Imported lazily so IndexedDB-only
    // browsers never load them.
    const { getSaveFileBridge } = await import(bridgePath);
    return fileStore.openCollectionDB(await getSaveFileBridge());
  }
  return idbStore.openCollectionDB(...args);
}

export const loadCollection = (...a) => impl.loadCollection(...a);
export const saveCollection = (...a) => impl.saveCollection(...a);
export const putCard = (...a) => impl.putCard(...a);
export const putNote = (...a) => impl.putNote(...a);
export const putRevlog = (...a) => impl.putRevlog(...a);
export const putMeta = (...a) => impl.putMeta(...a);
export const saveMedia = (...a) => impl.saveMedia(...a);
export const loadMedia = (...a) => impl.loadMedia(...a);
/** Fetch specific media files by name (lazy cache fill; skipped when missing). */
export const loadMediaNames = (...a) =>
  hasSaveFile
    ? fileStore.loadMediaNames(...a)
    : (async (db, names) => {
        const all = await idbStore.loadMedia(db);
        return new Map(names.filter((n) => all.has(n)).map((n) => [n, all.get(n)]));
      })(...a);
export const clearAll = (...a) => impl.clearAll(...a);
export const deleteCards = (...a) => impl.deleteCards(...a);
export const deleteNoteAndCards = (...a) => impl.deleteNoteAndCards(...a);
export const deleteRevlog = (...a) => impl.deleteRevlog(...a);
export const pushNoteHistory = (...a) => impl.pushNoteHistory(...a);
export const listNoteHistory = (...a) => impl.listNoteHistory(...a);
export const deleteNoteHistory = (...a) => impl.deleteNoteHistory(...a);

// File-backend extras: no-ops under IndexedDB (which writes through already).
export const flushStore = (...a) => (hasSaveFile ? fileStore.flushStore(...a) : undefined);
export const storeStamp = (...a) => (hasSaveFile ? fileStore.storeStamp(...a) : 0);
export const storeDirty = (db) => (hasSaveFile ? !!db?.dirty : false);
