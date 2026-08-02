// Browser-side counterpart to native-bridge.js, for desktop Chrome/Edge:
// uses the File System Access API so the web app can live on a user-chosen
// JSON save file (same storage-file.js backend as the Android app), instead
// of IndexedDB. Pick the same oss-anki.json your phone syncs via Syncthing
// and both devices edit one file.
//
// Permission model: the file handle is stored in IndexedDB and survives
// restarts, so the file is picked once, ever. Write permission persists
// for the session; a fresh browser session may need ONE click (the gate
// button doubles as the required user gesture). Installed-as-PWA on
// Chrome 122+ can get a fully persistent grant ("allow on every visit").
//
// Exports intentionally mirror the names app.js uses from native-bridge.js
// (ensureSaveFolder / getSaveFileBridge / pickSaveFolder / folderLabel /
// statSaveFile) so callers just dispatch on platform.

export const SAVE_FILE_NAME = "oss-anki.json";

const JSON_TYPE = { description: "JSON", accept: { "application/json": [".json"] } };

// The picked FileSystemFileHandle, cached in memory + persisted in IndexedDB.
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
  return cachedHandle;
}

// --- base64 helpers (the bridge contract speaks base64) ---

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
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

/** Open-existing or create-new picker. Throws AbortError when cancelled. */
async function pickFile(create) {
  const h = create
    ? await showSaveFilePicker({ suggestedName: SAVE_FILE_NAME, types: [JSON_TYPE] })
    : (await showOpenFilePicker({ types: [JSON_TYPE], multiple: false }))[0];
  await saveHandle(h);
}

/** Human-readable label for the chosen file ("" when none). */
export async function folderLabel() {
  return (await loadHandle())?.name ?? "";
}

/** Stat the save file (for external-change detection on the poll). */
export async function statSaveFile() {
  const h = await loadHandle();
  if (!h) return { exists: false, modified: 0, size: 0 };
  try {
    const f = await h.getFile();
    return { exists: true, modified: f.lastModified, size: f.size };
  } catch {
    return { exists: false, modified: 0, size: 0 }; // file moved/deleted
  }
}

/**
 * Make sure a save file is chosen AND writable. Fast path: stored handle
 * with a still-valid grant returns silently. Otherwise shows the blocking
 * gate — its button clicks are the user gesture requestPermission and the
 * pickers require.
 */
export async function ensureSaveFolder() {
  const h = await loadHandle();
  if (h && (await h.queryPermission({ mode: "readwrite" })) === "granted") return;

  const gate = document.getElementById("folder-gate");
  const msg = document.getElementById("folder-gate-msg");
  const btn = document.getElementById("btn-pick-folder");
  const newBtn = document.getElementById("btn-new-file");
  gate.querySelector("h2").textContent = "Choose a save file";
  gate.querySelector("p").textContent =
    "oss-anki stores your whole collection as one JSON file you choose, and " +
    "rewrites it as you study and edit. Pick a file your sync tool " +
    "(Syncthing, …) watches to keep devices in sync.";
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
    btn.textContent = "Open existing file…";
    newBtn.hidden = false;
    for (;;) {
      const which = await new Promise((resolve) => {
        btn.addEventListener("click", () => resolve("open"), { once: true });
        newBtn.addEventListener("click", () => resolve("new"), { once: true });
      });
      try {
        await pickFile(which === "new");
        return;
      } catch (e) {
        if (e?.name !== "AbortError") {
          msg.textContent = `No file chosen (${e?.message ?? e}). Try again.`;
        }
      }
    }
  } finally {
    gate.hidden = true;
    newBtn.hidden = true;
  }
}

/** Ask the user to pick a (new) save file. Returns true when one was chosen. */
export async function pickSaveFolder() {
  try {
    await pickFile(false);
    return true;
  } catch {
    return false; // cancelled
  }
}

/** Bridge for web/storage-file.js bound to the chosen save file. */
export async function getSaveFileBridge() {
  await ensureSaveFolder();
  const h = await loadHandle();
  return {
    read: async () => {
      const f = await h.getFile();
      if (f.size === 0) return null; // freshly created file → default collection
      return textToBase64(await f.text());
    },
    write: async (data) => {
      // Chrome stages createWritable() in a swap file and moves it over the
      // target on close — partial writes aren't observable.
      const w = await h.createWritable();
      await w.write(base64ToBytes(data));
      await w.close();
      return { modified: (await h.getFile()).lastModified };
    },
    stat: statSaveFile,
  };
}
