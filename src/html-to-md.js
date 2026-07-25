// HTML → markdown conversion (turndown), the mirror of src/markdown.js.
//
// Fields are markdown-native; this module converts HTML fields to markdown:
//   - on .apkg import (Anki fields are HTML), and
//   - as a one-time migration of existing collections on app load.
//
// Turndown escapes markdown-special characters in text, which would break
// our protected spans ([sound:], math in all its delimiter forms). Those are
// stashed behind private-use placeholders before conversion and restored
// after, byte-identical. Everything else goes through turndown + its GFM
// plugin (tables, strikethrough).
//
// Conversion is LOSSY for styled markup (colors, font tags, custom classes
// flatten away) — accepted deliberately: all cards are markdown-mode, and
// .apkg export renders back to clean HTML via mdToHtml.
//
// domino is vendored for node (tests); the browser uses its native DOMParser.

import domino from "../vendor/domino.esm.js";
import TurndownService from "../vendor/turndown.esm.js";
import { gfm } from "../vendor/turndown-gfm.esm.js";

const td = new TurndownService({
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  br: "", // plain newline; our renderer shows single newlines as <br>
});
td.use(gfm);
// Images keep their display width as our {width=N} token (turndown's default
// image rule would drop it).
td.addRule("imgWidth", {
  filter: "img",
  replacement: (_content, node) => {
    const src = node.getAttribute("src") ?? "";
    const alt = node.getAttribute("alt") ?? "";
    const w = node.getAttribute("width");
    const dest = /[\s()]/.test(src) ? `<${src}>` : src;
    return `![${alt}](${dest})${w ? `{width=${w}}` : ""}`;
  },
});

// Spans turndown must not escape, in the same forms src/markdown.js protects.
const PROTECT = [
  /\\\[([\s\S]+?)\\\]/g, // \[ .. \]
  /\\\(([\s\S]+?)\\\)/g, // \( .. \)
  /\[latex\][\s\S]+?\[\/latex\]/gi,
  /\[\$\$\][\s\S]+?\[\/\$\$\]/g,
  /\[\$\][\s\S]+?\[\/\$\]/g,
  /\$\$[\s\S]+?\$\$/g,
  /\$[^\s$](?:[^$]*[^\s$])?\$(?!\d)/g, // $..$ (pandoc currency rules)
  /\[sound:[^\]\n]+\]/g,
];

function stashSpans(html) {
  const stash = [];
  const out = PROTECT.reduce(
    (s, re) => s.replace(re, (m) => `\uE000${stash.push(m) - 1}\uE001`),
    html,
  );
  return { out, stash };
}
const unstashSpans = (md, stash) =>
  md.replace(/\uE000(\d+)\uE001/g, (_m, i) => stash[Number(i)]);

function parseBody(html) {
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(html, "text/html").body;
  }
  return domino.createDocument(`<html><body>${html}</body></html>`).body;
}

/**
 * Convert an HTML field to markdown. Protected spans (math, [sound:]) pass
 * through untouched; image width becomes {width=N}.
 */
export function htmlToMd(html) {
  const { out, stash } = stashSpans(html);
  return unstashSpans(td.turndown(parseBody(out)).trim(), stash);
}

// Does this field contain HTML we'd convert? A whitelist of real tag names,
// so math ("a < b"), autolinks ("<https://…>"), and code mentioning tags in
// prose don't false-positive.
const HTML_TAG =
  /<\/?(?:b|i|em|strong|u|s|strike|del|div|span|p|br|hr|ul|ol|li|img|font|table|thead|tbody|tr|td|th|h[1-6]|blockquote|pre|a|sub|sup|dl|dt|dd|center)\b[^>]*>/i;
export const looksLikeHtml = (s) => HTML_TAG.test(s);

/** Convert a field to markdown if it looks like HTML; else return it as-is. */
export function htmlFieldToMd(field) {
  return looksLikeHtml(field) ? htmlToMd(field) : field;
}

/**
 * One-time migration: convert every HTML field in the collection to markdown,
 * recomputing sfld/csum and bumping mod on changed notes (so sync carries the
 * conversion). @returns {number} how many notes changed
 */
export function migrateCollectionToMarkdown(col) {
  let changed = 0;
  for (const note of col.notes.values()) {
    const converted = note.fields.map(htmlFieldToMd);
    if (converted.every((f, i) => f === note.fields[i])) continue;
    note.fields = converted;
    note.normalize(col.noteType(note.mid)?.sortf ?? 0);
    note.mod = Math.floor(Date.now() / 1000);
    changed++;
  }
  return changed;
}
