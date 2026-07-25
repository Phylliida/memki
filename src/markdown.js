// Markdown rendering for note fields, on top of the vendored marked build.
//
// Fields are markdown-native; inline and block HTML passes through untouched,
// so legacy notes (written by the old rich-text editor) and Anki imports keep
// rendering exactly as before. The pipeline downstream (web/app.js displayHtml)
// still handles [sound:] players, media blob URLs, and MathJax — this module's
// job is only to keep those constructs intact while markdown is parsed:
//
//   - math spans are protected so `_` / `*` in LaTeX never become emphasis:
//       \(..\) \[..\] [latex]..[/latex] [$]..[/$] [$$]..[/$$]
//   - [sound:name] is protected (otherwise it parses as a reference link, and
//     underscores in two filenames on one line would pair up as emphasis)
//   - images support a sizing extension: ![alt](name){width=200} — the editor
//     writes this when you drag-resize an image; it renders as width="200"
//
// Anki-like output shaping:
//   - a field that is a single paragraph renders WITHOUT the <p> wrapper, so
//     plain fields ("Paris") render byte-identically to Anki
//   - single newlines become <br> (breaks: true), matching Anki display
//   - GFM is on (tables, strikethrough, autolinks)

import { Marked } from "../vendor/marked.esm.js";

// --- raw passthrough tokenizers (math, sound) ---

/** A protected span whose raw text is emitted verbatim into the HTML. */
function rawToken(name, rule, start) {
  return {
    name,
    level: "inline",
    start(src) { return start(src); },
    tokenizer(src) {
      const m = rule.exec(src);
      if (m) return { type: name, raw: m[0] };
    },
    renderer(token) { return token.raw; },
  };
}

const mathTokens = [
  // display math \[ .. \]
  rawToken("mathBracket", /^\\\[([\s\S]+?)\\\]/, (s) => s.indexOf("\\[")),
  // inline math \( .. \)
  rawToken("mathParen", /^\\\(([\s\S]+?)\\\)/, (s) => s.indexOf("\\(")),
  // Anki [latex]..[/latex]
  rawToken("mathLatex", /^\[latex\]([\s\S]+?)\[\/latex\]/i, (s) => s.toLowerCase().indexOf("[latex]")),
  // Anki [$$]..[/$$]
  rawToken("mathDD", /^\[\$\$\]([\s\S]+?)\[\/\$\$\]/, (s) => s.indexOf("[$$]")),
  // Anki [$]..[/$]
  rawToken("mathD", /^\[\$\]([\s\S]+?)\[\/\$\]/, (s) => s.indexOf("[$]")),
  // [sound:filename] — must reach resolveSounds byte-identical
  rawToken("soundTag", /^\[sound:[^\]\n]+\]/, (s) => s.indexOf("[sound:")),
];

// --- image sizing: ![alt](dest){width=N} ---

const escAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const imgSizeToken = {
  name: "imgSize",
  level: "inline",
  start(src) { return src.indexOf("!["); },
  tokenizer(src) {
    const m = /^!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)\)(?:\{width=(\d+)\})?/.exec(src);
    if (!m) return;
    return {
      type: "imgSize",
      raw: m[0],
      alt: m[1],
      dest: m[2].startsWith("<") ? m[2].slice(1, -1) : m[2],
      width: m[3],
    };
  },
  renderer(token) {
    const w = token.width ? ` width="${token.width}"` : "";
    return `<img src="${escAttr(token.dest)}" alt="${escAttr(token.alt)}"${w}>`;
  },
};

const md = new Marked({ breaks: true, gfm: true });
md.use({ extensions: [...mathTokens, imgSizeToken] });

/**
 * Render a field's markdown source to HTML. Inline/block HTML passes through;
 * a single-paragraph field is unwrapped (no surrounding <p>) so plain fields
 * render exactly like Anki.
 * @param {string} src markdown source
 * @returns {string} HTML
 */
export function mdToHtml(src) {
  if (!src) return "";
  const tokens = md.lexer(src);
  const significant = tokens.filter((t) => t.type !== "space");
  if (significant.length === 1 && significant[0].type === "paragraph") {
    return md.parseInline(src);
  }
  return md.parser(tokens);
}

// --- token syntax shared with the editor (web/app.js) ---

/** The editor's image token for a media name (+ optional display width). */
export function mdImageToken(name, width) {
  const dest = /[\s()]/.test(name) ? `<${name}>` : name;
  return `![](${dest})${width ? `{width=${width}}` : ""}`;
}

/** The editor's audio/video token for a media name (Anki's convention). */
export function mdSoundToken(name) {
  return `[sound:${name}]`;
}

/**
 * Scan markdown source for media tokens the editor renders as inline widgets.
 * @returns {Array<{ start: number, raw: string, kind: "img"|"sound",
 *                   name: string, width: number|null }>}
 */
export function scanMdMedia(src) {
  const re = /!\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))\)(?:\{width=(\d+)\})?|\[sound:([^\]\n]+)\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {
      out.push({ start: m.index, raw: m[0], kind: "sound", name: m[5].trim(), width: null });
    } else {
      out.push({
        start: m.index,
        raw: m[0],
        kind: "img",
        name: m[2] ?? m[3],
        width: m[4] ? Number(m[4]) : null,
      });
    }
  }
  return out;
}
