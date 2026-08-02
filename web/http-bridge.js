// Companion-server bridge: talks to web/file-server.py on 127.0.0.1, for
// browsers without the File System Access API (Firefox, Safari). Same
// save-folder semantics as native-bridge.js / fs-access-bridge.js — the
// server process owns the folder, this module is just HTTP plumbing.
//
// Exports mirror the names app.js uses from the other bridges
// (ensureSaveFolder / getSaveFileBridge / pickSaveFolder / folderLabel /
// statSaveFile / writeToFolder / textToBase64) so callers just dispatch on
// storage.js's bridgePath.

export const SAVE_FILE_NAME = "oss-anki.json";
export const BACKUP_FILE_NAME = "oss-anki-backup.json";

const LS_KEY = "fileServer"; // { url, token, label }
let server = null;           // { url, token, label } | null

function store(s) {
  server = s;
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

// Adopt ?token= from the page URL (the connect URL file-server.py prints
// opens the app it serves with the token already in the query string).
(function adoptFromUrl() {
  try {
    const q = new URLSearchParams(location.search);
    const token = q.get("token");
    if (!token) return;
    store({ url: location.origin, token, label: "" });
    q.delete("token");
    const qs = q.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  } catch { /* no location (tests) */ }
})();

function loadStored() {
  if (server) return server;
  try { server = JSON.parse(localStorage.getItem(LS_KEY)); } catch { server = null; }
  return server;
}

/** Parse a pasted connect URL ("http://127.0.0.1:8787/web/?token=…"). */
function parseConnectUrl(text) {
  const u = new URL(text.trim());
  const token = u.searchParams.get("token");
  if (!token) throw new Error("no ?token= in that URL");
  return { url: u.origin, token, label: "" };
}

async function api(path, opts = {}, timeoutMs = 0) {
  const s = loadStored();
  if (!s) throw new Error("no file server configured");
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(s.url + path, {
      ...opts,
      signal: ctrl?.signal,
      headers: { "Content-Type": "application/json", "X-Auth": s.token, ...opts.headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is a companion server reachable with the stored credentials? */
export async function probe() {
  if (!loadStored()) return false;
  try {
    const st = await api("/api/stat", {}, 1500);
    if ((st.label && !server.label) || (st.path && !server.path)) {
      store({ ...server, label: st.label ?? server.label, path: st.path ?? server.path });
    }
    return true;
  } catch {
    return false;
  }
}

/** Human-readable label for the save folder ("" when unknown). */
export async function folderLabel() {
  const s = loadStored();
  return s?.path ?? s?.label ?? "";
}

/** Stat the save file (for external-change detection on the poll). */
export async function statSaveFile() {
  try {
    return await api("/api/stat");
  } catch {
    return { exists: false, modified: 0, size: 0 };
  }
}

export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Write an arbitrary file (backup .json) into the save folder. */
export async function writeToFolder(name, base64) {
  return api("/api/write", { method: "POST", body: JSON.stringify({ name, data: base64 }) });
}

/**
 * Make sure a companion server is connected. Fast path: stored credentials
 * probe OK. Otherwise show the blocking gate with a paste box for the
 * connect URL file-server.py prints.
 */
export async function ensureSaveFolder() {
  if (await probe()) return;
  const gate = document.getElementById("folder-gate");
  const msg = document.getElementById("folder-gate-msg");
  const btn = document.getElementById("btn-pick-folder");
  gate.querySelector("h2").textContent = "Connect to a save folder";
  gate.querySelector("p").textContent =
    "This browser can't write local files directly. Run " +
    "`python3 web/file-server.py /path/to/save-folder` on this computer " +
    "and paste the connect URL it prints.";
  const input = el("input", { type: "text", placeholder: "http://127.0.0.1:8787/web/?token=…" });
  btn.before(input);
  btn.textContent = "Connect";
  gate.hidden = false;
  try {
    for (;;) {
      await new Promise((resolve) => btn.addEventListener("click", resolve, { once: true }));
      try {
        store(parseConnectUrl(input.value));
        if (await probe()) return;
        msg.textContent = "Can't reach that server — is file-server.py running?";
      } catch (e) {
        msg.textContent = `Bad connect URL (${e?.message ?? e}).`;
      }
    }
  } finally {
    gate.hidden = true;
    input.remove();
  }
}

// el() helper duplicated from app.js would be circular; minimal local one.
function el(tag, attrs = {}) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

/** Point the server at a (different) save folder path. Returns true on success. */
export async function pickSaveFolder() {
  if (!loadStored()) {
    // Not connected yet — connect first (paste the server's connect URL).
    const text = prompt("Connect URL printed by file-server.py:", "http://127.0.0.1:8787/web/?token=");
    if (!text) return false;
    try {
      store(parseConnectUrl(text));
      return await probe();
    } catch {
      return false;
    }
  }
  const path = prompt(
    "Save folder path on the machine running file-server.py:",
    loadStored()?.path ?? "~/oss-anki",
  );
  if (!path) return false;
  try {
    const r = await api("/api/root", { method: "POST", body: JSON.stringify({ path }) });
    store({ ...server, label: r.label, path: r.path });
    return true;
  } catch (e) {
    console.error("set save folder failed:", e);
    return false;
  }
}

/** Bridge for web/storage-file.js, over the companion server. */
export async function getSaveFileBridge() {
  await ensureSaveFolder();
  return {
    read: async () => (await api("/api/read")).data ?? null,
    write: async (data) => api("/api/write", { method: "POST", body: JSON.stringify({ data }) }),
    stat: statSaveFile,
    readMedia: async (name) => (await api(`/api/media/${encodeURIComponent(name)}`)).data ?? null,
    writeMedia: async (name, data) =>
      api(`/api/media/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ data }) }),
  };
}
