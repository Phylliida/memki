// IDs, GUIDs, and timestamps, matching Anki's conventions.
//
// - Note/card/revlog IDs are millisecond epoch timestamps, made unique by
//   bumping forward when they collide (anki/rslib uses the same scheme).
// - A note's `guid` is a random 64-bit integer encoded in Anki's base-91 table
//   (anki/rslib/src/notes/mod.rs `base91_u64` / `anki_base91`).

// Exact table from rslib `anki_base91`. Length 91.
const BASE91 =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

/**
 * Encode a non-negative integer in Anki's base-91 (rslib `to_base_n`).
 * Accepts a number or BigInt. Returns "" for 0 (matches rslib).
 * @param {number | bigint} n
 */
export function base91(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error("base91 expects a non-negative integer");
  const len = BigInt(BASE91.length);
  let out = "";
  while (v > 0n) {
    out = BASE91[Number(v % len)] + out;
    v /= len;
  }
  return out;
}

/** A fresh random note GUID: base-91 of a random unsigned 64-bit integer. */
export function newGuid() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return base91(n);
}

/** Current time in whole seconds (Anki uses seconds for many `mod` columns). */
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** Current time in milliseconds (Anki uses ms for IDs and the collection `mod`). */
export function nowMs() {
  return Date.now();
}

/**
 * A generator of strictly-increasing millisecond IDs. Anki derives IDs from the
 * current time but guarantees uniqueness within a collection by incrementing.
 * @param {number} [start] initial floor (defaults to now)
 * @returns {() => number}
 */
export function makeIdGenerator(start) {
  let last = (start ?? Date.now()) - 1;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}
