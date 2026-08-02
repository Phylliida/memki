// Capacitor-side glue for the Android save folder. Only ever imported on
// native (see web/storage.js / web/app.js) — uses the globally injected
// `window.Capacitor` bridge, no bundler/import-map needed.
//
// Talks to the SaveFolder plugin (android/.../SaveFolderPlugin.java), which
// wraps a SAF document tree the user picked: the collection lives there as
// `oss-anki.json`, readable/writable by Syncthing & co.

export const SAVE_FILE_NAME = "oss-anki.json";
// Automatic backup lives next to the save file under this fixed name —
// always overwritten, never timestamped, so Syncthing & co. just see one
// current copy.
export const BACKUP_FILE_NAME = "oss-anki-backup.json";

const plugin = () => {
  const p = globalThis.Capacitor?.Plugins?.SaveFolder;
  if (!p) throw new Error("SaveFolder native plugin is not available");
  return p;
};

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Currently chosen folder, or null. @returns {Promise<{uri:string,label:string}|null>} */
export async function currentFolder() {
  const res = await plugin().getFolder();
  return res?.uri ? res : null;
}

/** Human-readable label for the chosen folder ("" when none). */
export async function folderLabel() {
  return (await currentFolder())?.label ?? "";
}

/**
 * Make sure a save folder is chosen. On first run (or after the system
 * revoked the URI permission) shows a blocking gate with a picker button
 * until the user picks one.
 */
export async function ensureSaveFolder() {
  if (await currentFolder()) return;
  const gate = document.getElementById("folder-gate");
  const msg = document.getElementById("folder-gate-msg");
  const btn = document.getElementById("btn-pick-folder");
  gate.hidden = false;
  try {
    for (;;) {
      await new Promise((resolve) => btn.addEventListener("click", resolve, { once: true }));
      try {
        await plugin().pickFolder();
        return;
      } catch (e) {
        msg.textContent = `No folder chosen (${e?.message ?? e}). Try again.`;
      }
    }
  } finally {
    gate.hidden = true;
  }
}

/** Ask the user to pick a (new) save folder. Returns true when one was chosen. */
export async function pickSaveFolder() {
  try {
    await plugin().pickFolder();
    return true;
  } catch {
    return false; // cancelled
  }
}

/** Bridge for web/storage-file.js bound to the save file in the chosen folder. */
export async function getSaveFileBridge() {
  await ensureSaveFolder();
  const p = plugin();
  const name = SAVE_FILE_NAME;
  return {
    read: async () => (await p.readFile({ name })).data ?? null,
    write: async (data) => p.writeFile({ name, data }),
    stat: async () => p.statFile({ name }),
  };
}

/** Stat the save file (for external-change detection on resume). */
export async function statSaveFile() {
  return plugin().statFile({ name: SAVE_FILE_NAME });
}

/** Stat an arbitrary file in the save folder (e.g. BACKUP_FILE_NAME). */
export async function statInFolder(name) {
  return plugin().statFile({ name });
}

/** Write an arbitrary file (backup .json) into the save folder. */
export async function writeToFolder(name, base64) {
  return plugin().writeFile({ name, data: base64 });
}

/** "Save as" picker: user chooses where and under what name to write a
 *  file (export .apkg). Rejects with code CANCELLED if dismissed. */
export async function exportFile(name, base64, mimeType = "application/octet-stream") {
  return plugin().exportFile({ name, data: base64, mimeType });
}

/** appStateChange wiring: onPause when backgrounded, onResume when back. */
export function watchAppState({ onPause, onResume }) {
  globalThis.Capacitor?.Plugins?.App?.addListener("appStateChange", ({ isActive }) => {
    if (isActive) onResume?.();
    else onPause?.();
  });
}
