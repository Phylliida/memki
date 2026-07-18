// One-file JSON backups: the whole collection plus media, self-contained and
// human-inspectable (media is base64). Restoring replaces the collection.

import { Collection, Note, Card, Revlog } from "./model.js";

export const BACKUP_FORMAT = "oss-anki-backup";

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Serialize a collection + media into a plain JSON-able object. */
export function collectionToBackup(col, media = new Map()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    crt: col.crt, mod: col.mod, scm: col.scm, ver: col.ver, dty: col.dty,
    usn: col.usn, ls: col.ls,
    conf: col.conf, models: col.models, decks: col.decks, dconf: col.dconf, tags: col.tags,
    notes: [...col.notes.values()].map((n) => n.toRow()),
    cards: [...col.cards.values()].map((c) => c.toRow()),
    revlog: col.revlog.map((r) => r.toRow()),
    graves: col.graves,
    media: Object.fromEntries([...media].map(([name, bytes]) => [name, bytesToBase64(bytes)])),
  };
}

/**
 * Rebuild a collection + media from a backup object.
 * @returns {{ collection: Collection, media: Map<string, Uint8Array> }}
 */
export function collectionFromBackup(obj) {
  if (obj?.format !== BACKUP_FORMAT) throw new Error("not an oss-anki backup file");
  const col = new Collection();
  for (const k of ["crt", "mod", "scm", "ver", "dty", "usn", "ls"]) {
    if (obj[k] != null) col[k] = obj[k];
  }
  col.conf = obj.conf ?? col.conf;
  col.models = obj.models ?? {};
  col.decks = obj.decks ?? {};
  col.dconf = obj.dconf ?? {};
  col.tags = obj.tags ?? {};
  col.graves = obj.graves ?? [];
  for (const r of obj.notes ?? []) col.addNote(Note.fromRow(r));
  for (const r of obj.cards ?? []) col.addCard(Card.fromRow(r));
  for (const r of obj.revlog ?? []) col.addRevlog(Revlog.fromRow(r));
  const media = new Map(
    Object.entries(obj.media ?? {}).map(([name, b64]) => [name, base64ToBytes(b64)]),
  );
  return { collection: col, media };
}
