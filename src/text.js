// Field encoding and the text normalization Anki uses for csum / sort field.
//
// Faithful to anki/rslib/src/text.rs + notes/mod.rs:
//   - fields in a note are stored joined by the 0x1f unit separator
//   - csum   = first 4 bytes (big-endian u32) of SHA-1 of strip_html_preserving_
//              media_filenames(field[0])
//   - sfld   = strip_html_preserving_media_filenames(field[sort_field_idx])
//
// strip_html here approximates Anki's regex stripper: it removes tags, keeps the
// src/data filename of media tags, and decodes common HTML entities. For plain
// and ordinary-HTML fields this is identical to Anki; only exotic media-tag
// markup could differ, which never affects text-only golden vectors.

import { sha1Bytes } from "./sha1.js";

/** The unit-separator byte Anki uses between a note's fields. */
export const FIELD_SEPARATOR = "\x1f";

/** Join field values into the stored `flds` string. @param {string[]} fields */
export function joinFields(fields) {
  return fields.join(FIELD_SEPARATOR);
}

/** Split a stored `flds` string back into field values. @param {string} flds */
export function splitFields(flds) {
  return flds.split(FIELD_SEPARATOR);
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Decode the common HTML entities (named + numeric).   becomes a space. */
export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return m;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    const r = NAMED_ENTITIES[body];
    return r === undefined ? m : r;
  });
}

// Media tags whose src/data filename should survive stripping (img, audio,
// object, ...). Mirrors rslib's HTML_MEDIA_TAGS.
const MEDIA_TAG = /<(?:img|audio|video|object|source)\b[^>]*?\b(?:src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^ >]+))[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;

/** Remove all HTML tags and decode entities. */
export function stripHtml(html) {
  return decodeEntities(html.replace(ANY_TAG, ""));
}

/**
 * Like stripHtml, but replaces media tags with their src/data filename
 * SURROUNDED BY SPACES, exactly as rslib's `r" ${1}${2}${3} "`. The result is
 * NOT trimmed — those spaces are part of what Anki checksums and stores as sfld.
 */
export function stripHtmlPreservingMediaFilenames(html) {
  const withMedia = html.replace(MEDIA_TAG, (_m, q, a, u) => ` ${q ?? a ?? u ?? ""} `);
  return decodeEntities(withMedia.replace(ANY_TAG, ""));
}

/**
 * Anki note checksum: first 4 bytes of SHA-1 of the NFC-normalized, stripped
 * first field, as a big-endian unsigned 32-bit integer. Anki normalizes fields
 * to NFC before checksumming, so we do too.
 * @param {string} field0 The first field's raw (HTML) value.
 * @returns {number} unsigned 32-bit checksum
 */
export function fieldChecksum(field0) {
  const d = sha1Bytes(stripHtmlPreservingMediaFilenames(field0.normalize("NFC")));
  return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
}

/**
 * The sort field value: NFC-normalized, media-preserving-stripped text of the
 * field at `sortIdx` (default 0). Matches Anki's stored sfld byte-for-byte.
 * @param {string[]} fields
 * @param {number} [sortIdx]
 */
export function sortField(fields, sortIdx = 0) {
  return stripHtmlPreservingMediaFilenames((fields[sortIdx] ?? "").normalize("NFC"));
}
