// Storage backend selector: inside the Capacitor Android app the whole
// collection lives in a user-chosen JSON save file (web/storage-file.js),
// and desktop Chrome/Edge can do the same via the File System Access API
// (web/fs-access-bridge.js) — so the file can be synced externally
// (Syncthing etc.). Other browsers keep using IndexedDB (src/storage.js).
// All backends expose the same function surface — every call takes the db
// handle first — so callers (web/app.js) don't branch on platform anywhere
// else.

import * as idbStore from "../src/storage.js";
import * as fileStore from "./storage-file.js";

export const isNative = !!globalThis.Capacitor?.isNativePlatform?.();
// True when the whole collection lives in one user-chosen JSON file:
// Android (SAF folder) or desktop Chrome/Edge (File System Access API).
export const hasSaveFile = isNative || !!globalThis.showOpenFilePicker;
const impl = hasSaveFile ? fileStore : idbStore;

export async function openCollectionDB(...args) {
  if (hasSaveFile) {
    // The bridge needs the user's chosen save file; the bridge modules
    // handle the first-run picker gate. Imported lazily so IndexedDB-only
    // browsers never load them.
    const { getSaveFileBridge } = await import(isNative ? "./native-bridge.js" : "./fs-access-bridge.js");
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
export const clearAll = (...a) => impl.clearAll(...a);
export const deleteCards = (...a) => impl.deleteCards(...a);
export const deleteNoteAndCards = (...a) => impl.deleteNoteAndCards(...a);
export const deleteRevlog = (...a) => impl.deleteRevlog(...a);
export const pushNoteHistory = (...a) => impl.pushNoteHistory(...a);
export const listNoteHistory = (...a) => impl.listNoteHistory(...a);
export const deleteNoteHistory = (...a) => impl.deleteNoteHistory(...a);

// File-backend extras: no-ops under IndexedDB (which writes through already).
export const flushStore = hasSaveFile ? (...a) => fileStore.flushStore(...a) : async () => {};
export const storeStamp = hasSaveFile ? (...a) => fileStore.storeStamp(...a) : () => 0;
export const storeDirty = hasSaveFile ? (db) => !!db?.dirty : () => false;
