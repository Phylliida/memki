// Browser-side counterpart to native-bridge.js, for desktop Chrome/Edge:
// uses the File System Access API so the web app can live on a user-chosen
// save folder (same storage-file.js backend as the Android app), instead
// of IndexedDB. Pick the folder your phone syncs via Syncthing and both
// devices edit the same oss-anki.json (+ oss-anki.media/) files.
//
// Permission model: the directory handle is stored in IndexedDB and
// survives restarts, so the folder is picked once, ever. Write permission
// persists for the session; a fresh browser session may need ONE click
// (the gate button doubles as the required user gesture). Installed-as-PWA
// on Chrome 122+ can get a fully persistent grant ("allow on every visit").
//
// Exports intentionally mirror the names app.js uses from native-bridge.js
// (ensureSaveFolder / getSaveFileBridge / pickSaveFolder / folderLabel /
// statSaveFile) so callers just dispatch on platform.

export const SAVE_FILE_NAME = "oss-anki.json";
const MEDIA_DIR = "oss-anki.media";

// The picked FileSystemDirectoryHandle, cached in memory + IndexedDB.
let cachedHandle;

// --- tiny IndexedDB kv store (handles aren't JSON-serializable, so not localStorage) ---

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("oss-anki-fs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(h) {
  cachedHandle = h;
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(h, "saveFile");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle() {
  if (cachedHandle) return cachedHandle;
  try {
    const db = await idb();
    cachedHandle = await new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get("saveFile");
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    cachedHandle = null;
  }
  // Legacy: pre-media-split versions stored a single FILE handle. Force a
  // one-time re-pick of the folder containing it.
  if (cachedHandle && cachedHandle.kind !== "directory") cachedHandle = null;
  return cachedHandle;
}

// --- base64 helpers (the bridge contract speaks base64) ---

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

async function fileBase64(fileHandle) {
  const f = await fileHandle.getFile();
  if (f.size === 0) return null;
  return bytesToBase64(new Uint8Array(await f.arrayBuffer()));
}

async function writeFileBase64(fileHandle, b64) {
  // Chrome stages createWritable() in a swap file and moves it over the
  // target on close — partial writes aren't observable.
  const w = await fileHandle.createWritable();
  await w.write(base64ToBytes(b64));
  await w.close();
  return { modified: (await fileHandle.getFile()).lastModified };
}

async function mediaDir(create) {
  const dir = await loadHandle();
  if (!dir) return null;
  try {
    return await dir.getDirectoryHandle(MEDIA_DIR, { create });
  } catch {
    return null; // NotFoundError when create=false and no media yet
  }
}

/** Human-readable label for the chosen folder ("" when none). */
export async function folderLabel() {
  return (await loadHandle())?.name ?? "";
}

/** Stat the save file (for external-change detection on the poll). */
export async function statSaveFile() {
  const dir = await loadHandle();
  if (!dir) return { exists: false, modified: 0, size: 0 };
  try {
    const fh = await dir.getFileHandle(SAVE_FILE_NAME);
    const f = await fh.getFile();
    return { exists: true, modified: f.lastModified, size: f.size };
  } catch {
    return { exists: false, modified: 0, size: 0 }; // file moved/deleted
  }
}

/** Ask the user to pick a (new) save folder. Returns true when one was chosen. */
export async function pickSaveFolder() {
  try {
    await saveHandle(await showDirectoryPicker({ mode: "readwrite" }));
    return true;
  } catch {
    return false; // cancelled
  }
}

/**
 * Make sure a save folder is chosen AND writable. Fast path: stored handle
 * with a still-valid grant returns silently. Otherwise shows the blocking
 * gate — its button clicks are the user gesture requestPermission and the
 * picker require.
 */
export async function ensureSaveFolder() {
  const h = await loadHandle();
  if (h && (await h.queryPermission({ mode: "readwrite" })) === "granted") return;

  const gate = document.getElementById("folder-gate");
  const msg = document.getElementById("folder-gate-msg");
  const btn = document.getElementById("btn-pick-folder");
  gate.hidden = false;
  try {
    if (h) {
      // Have a handle from a previous session — just re-grant access.
      btn.textContent = `Reconnect to ${h.name}`;
      for (;;) {
        await new Promise((resolve) => btn.addEventListener("click", resolve, { once: true }));
        if ((await h.requestPermission({ mode: "readwrite" })) === "granted") return;
        msg.textContent = "Permission not granted. Try again.";
      }
    }
    for (;;) {
      await new Promise((resolve) => btn.addEventListener("click", resolve, { once: true }));
      if (await pickSaveFolder()) return;
      msg.textContent = "No folder chosen. Try again.";
    }
  } finally {
    gate.hidden = true;
  }
}

/** Bridge for web/storage-file.js bound to the save file in the chosen folder. */
export async function getSaveFileBridge() {
  await ensureSaveFolder();
  const dir = await loadHandle();
  return {
    read: async () => {
      try {
        return await fileBase64(await dir.getFileHandle(SAVE_FILE_NAME));
      } catch {
        return null; // NotFoundError → fresh folder, default collection
      }
    },
    write: async (data) =>
      writeFileBase64(await dir.getFileHandle(SAVE_FILE_NAME, { create: true }), data),
    stat: statSaveFile,
    // Media: individual files in the oss-anki.media/ subfolder.
    readMedia: async (name) => {
      const md = await mediaDir(false);
      if (!md) return null;
      try {
        return await fileBase64(await md.getFileHandle(name));
      } catch {
        return null;
      }
    },
    writeMedia: async (name, data) => {
      const md = await mediaDir(true);
      await writeFileBase64(await md.getFileHandle(name, { create: true }), data);
    },
  };
}
