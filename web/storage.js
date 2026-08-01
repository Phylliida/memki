// Storage backend selector: the browser app keeps using IndexedDB
// (src/storage.js); inside the Capacitor Android app the whole collection
// lives in a user-chosen JSON save file instead (web/storage-file.js), so it
// can be synced externally (Syncthing etc.). Both backends expose the same
// function surface — every call takes the db handle first — so callers
// (web/app.js) don't branch on platform anywhere else.

import * as idbStore from "../src/storage.js";
import * as fileStore from "./storage-file.js";

export const isNative = !!globalThis.Capacitor?.isNativePlatform?.();
const impl = isNative ? fileStore : idbStore;

export async function openCollectionDB(...args) {
  if (isNative) {
    // The bridge needs the user's chosen save folder; native-bridge handles
    // the first-run picker gate. Imported lazily so the browser never loads it.
    const { getSaveFileBridge } = await import("./native-bridge.js");
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
export const flushStore = isNative ? (...a) => fileStore.flushStore(...a) : async () => {};
export const storeStamp = isNative ? (...a) => fileStore.storeStamp(...a) : () => 0;
