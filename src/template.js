// Anki card-template renderer.
//
// Mustache-style syntax, faithful to rslib template.rs / cloze.rs / typeanswer.rs:
//   {{Field}}                 field value (raw HTML)
//   {{filter:Field}}          filtered; chains apply right-to-left ({{a:b:F}})
//     text:      HTML stripped
//     cloze:     cloze deletion for the active card ordinal (nesting supported)
//     hint:      collapsed behind a "show hint" link
//     furigana:  kanji[reading] → <ruby> markup;  kanji: / kana: keep one part
//     type:      type-in-the-answer (input on the question, char diff on answer);
//                {{type:cloze:Field}} expects the active cloze answer(s)
//   {{FrontSide}}             the rendered question (answer templates)
//   {{Tags}} {{Deck}} {{Subdeck}} {{Card}} {{Type}} {{CardFlag}}  special fields
//   {{#Field}}...{{/Field}}   shown only if the field is non-empty
//   {{^Field}}...{{/Field}}   shown only if the field is empty
//
// The renderer emits HTML; media (`<img src="file">`, `[sound:...]`) is left
// untouched for the caller to rewrite to object URLs / players.

import { stripHtml } from "./text.js";
import { NoteTypeKind } from "./model.js";

const TOKEN = /\{\{\s*([#^/])?\s*([^}]+?)\s*\}\}/g;

function tokenize(template) {
  const toks = [];
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(template))) {
    if (m.index > last) toks.push({ text: template.slice(last, m.index) });
    toks.push({ sigil: m[1] || "", key: m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < template.length) toks.push({ text: template.slice(last) });
  return toks;
}

// --- cloze parsing (nesting-aware, per rslib cloze.rs) ---

const CLOZE_OPEN = /^\{\{c(\d+)::/;

/**
 * Parse cloze markup into a node tree. Returns children of an implicit root:
 * strings and { ord, children } nodes. Unclosed clozes keep their children.
 */
function parseClozeNodes(text) {
  const root = { ord: null, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (s) => { if (s) top().children.push(s); };
  let i = 0;
  while (i < text.length) {
    // Next genuine "{{cN::" opening at or after i.
    let open = -1;
    let m = null;
    for (let j = text.indexOf("{{c", i); j !== -1; j = text.indexOf("{{c", j + 1)) {
      const mm = CLOZE_OPEN.exec(text.slice(j, j + 16));
      if (mm) { open = j; m = mm; break; }
    }
    const close = stack.length > 1 ? text.indexOf("}}", i) : -1;
    if (open === -1 && close === -1) {
      pushText(text.slice(i));
      break;
    }
    if (close !== -1 && (open === -1 || close < open)) {
      pushText(text.slice(i, close));
      stack.pop();
      i = close + 2;
    } else {
      pushText(text.slice(i, open));
      const node = { ord: Number(m[1]), children: [] };
      top().children.push(node);
      stack.push(node);
      i = open + m[0].length;
    }
  }
  return root.children;
}

/** Split a cloze node's children into content and hint at the first top-level "::". */
function splitHint(children) {
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (typeof c === "string") {
      const at = c.indexOf("::");
      if (at !== -1) {
        return {
          content: [...children.slice(0, i), c.slice(0, at)],
          hint: [c.slice(at + 2), ...children.slice(i + 1)],
        };
      }
    }
  }
  return { content: children, hint: [] };
}

function renderClozeChildren(children, ord, side) {
  let out = "";
  for (const c of children) {
    if (typeof c === "string") { out += c; continue; }
    const { content, hint } = splitHint(c.children);
    const inner = renderClozeChildren(content, ord, side);
    if (c.ord === ord) {
      out += side === "q"
        ? `<span class="cloze" data-ordinal="${c.ord}">[${renderClozeChildren(hint, ord, side) || "..."}]</span>`
        : `<span class="cloze" data-ordinal="${c.ord}">${inner}</span>`;
    } else {
      out += `<span class="cloze-inactive" data-ordinal="${c.ord}">${inner}</span>`;
    }
  }
  return out;
}

/**
 * Render Anki cloze markup for a given active ordinal and side. Active clozes
 * become `[...]`/`[hint]` on the question and highlighted content on the back;
 * inactive clozes render their content in `cloze-inactive` spans. Nested
 * clozes are supported.
 */
export function clozeFilter(text, ord, side) {
  return renderClozeChildren(parseClozeNodes(text), ord, side);
}

/** Distinct cloze ordinals present in a field's text (e.g. {1,2}), nesting included. */
export function clozeNumbers(text) {
  const nums = new Set();
  const walk = (children) => {
    for (const c of children) {
      if (typeof c === "string") continue;
      if (c.ord > 0) nums.add(c.ord);
      walk(c.children);
    }
  };
  walk(parseClozeNodes(text));
  return nums;
}

/** The active cloze answers of a field, joined like Anki's type:cloze ("a, b"). */
export function clozeExpected(text, ord) {
  const parts = [];
  const walk = (children) => {
    for (const c of children) {
      if (typeof c === "string") continue;
      if (c.ord === ord) {
        const { content } = splitHint(c.children);
        parts.push(stripHtml(renderClozeChildren(content, -1, "a")));
      } else {
        walk(c.children);
      }
    }
  };
  walk(parseClozeNodes(text));
  return parts.join(", ");
}

// --- filters ---

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// kanji[reading] segments (rslib japanese.rs); sound tags pass through.
const JP_RE = / ?([^ >]+?)\[(.+?)\]/g;
const furi = (val, repl) =>
  val.replace(JP_RE, (m, kanji, reading) => (reading.startsWith("sound:") ? m : repl(kanji, reading)));

function applyFilter(filter, val, fieldName, ctx) {
  switch (filter.toLowerCase()) {
    case "text": return stripHtml(val);
    case "cloze": return clozeFilter(val, ctx.clozeOrd ?? 0, ctx.side ?? "q");
    case "hint": {
      if (!val) return "";
      const id = `hint${(ctx.hintCount = (ctx.hintCount ?? 0) + 1)}`;
      return (
        `<a class=hint href="#" onclick="this.style.display='none';` +
        `document.getElementById('${id}').style.display='block';return false;">` +
        `${escapeHtml(fieldName)}</a>` +
        `<div id="${id}" class=hint style="display: none">${val}</div>`
      );
    }
    case "furigana": return furi(val, (k, r) => `<ruby><rb>${k}</rb><rt>${r}</rt></ruby>`);
    case "kanji": return furi(val, (k) => k);
    case "kana": return furi(val, (_k, r) => r);
    default: return val; // unknown filters pass the value through
  }
}

// --- field resolution (special fields + filter chains) ---

function specialValue(ctx, name) {
  switch (name) {
    case "FrontSide": return ctx.FrontSide ?? "";
    case "Tags": return ctx.Tags ?? "";
    case "Deck": return ctx.Deck ?? "";
    case "Subdeck": return (ctx.Deck ?? "").split("::").pop();
    case "Card": return ctx.Card ?? "";
    case "Type": return ctx.Type ?? "";
    case "CardFlag": return ctx.flag ? `flag${ctx.flag}` : "";
    default: return null;
  }
}

function fieldValue(ctx, key) {
  const parts = key.split(":").map((p) => p.trim());
  const name = parts.pop();
  const filters = parts;

  // {{type:Field}} / {{type:cloze:Field}} — handled as a unit.
  if (filters[0]?.toLowerCase() === "type") {
    const raw = ctx.fields?.[name] ?? "";
    const expected = filters[1]?.toLowerCase() === "cloze"
      ? clozeExpected(raw, ctx.clozeOrd ?? 0)
      : stripHtml(raw);
    return (ctx.side ?? "q") === "q"
      ? `<input id="typeans" class="typeans" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`
      : typeDiff(ctx.typed ?? "", expected);
  }

  const special = specialValue(ctx, name);
  let val = special ?? ctx.fields?.[name] ?? "";
  for (let i = filters.length - 1; i >= 0; i--) {
    val = applyFilter(filters[i], val, name, ctx);
  }
  return val;
}

/** A type-the-answer character diff, Anki-style (rslib typeanswer.rs). */
export function typeDiff(typed, correct) {
  const t = typed.trim().normalize("NFC");
  const c = correct.trim().normalize("NFC");
  if (t === c) return `<code id=typeans><span class=typeGood>${escapeHtml(c)}</span></code>`;
  const [provided, expected] = diffLines(t, c);
  return `<code id=typeans>${provided}<br><span id=typearrow>⇩</span><br>${expected}</code>`;
}

function diffLines(t, c) {
  const a = [...t];
  const b = [...c];
  if (a.length * b.length > 250000) {
    // Pathologically long input: skip the char diff.
    return [
      `<span class=typeBad>${escapeHtml(t)}</span>`,
      `<span class=typeMissed>${escapeHtml(c)}</span>`,
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const provided = [];
  const expected = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      provided.push(["typeGood", a[i]]);
      expected.push(["typeGood", b[j]]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      provided.push(["typeBad", a[i]]); // typed a char that isn't in the answer
      i++;
    } else {
      provided.push(["typeBad", "-"]); // missed a char: dash placeholder
      expected.push(["typeMissed", b[j]]);
      j++;
    }
  }
  while (i < m) provided.push(["typeBad", a[i++]]);
  while (j < n) { provided.push(["typeBad", "-"]); expected.push(["typeMissed", b[j++]]); }
  return [runSpans(provided), runSpans(expected)];
}

function runSpans(pairs) {
  let out = "";
  let cls = null;
  let buf = "";
  const flush = () => { if (cls !== null) out += `<span class=${cls}>${escapeHtml(buf)}</span>`; };
  for (const [c, ch] of pairs) {
    if (c !== cls) { flush(); cls = c; buf = ""; }
    buf += ch;
  }
  flush();
  return out;
}

// --- conditionals + rendering ---

function nonEmpty(ctx, key) {
  const parts = key.split(":");
  const name = parts[parts.length - 1].trim();
  const special = specialValue(ctx, name);
  return (special ?? ctx.fields?.[name] ?? "") !== "";
}

function renderTokens(toks, ctx) {
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.text !== undefined) {
      out += tk.text;
      continue;
    }
    if (tk.sigil === "#" || tk.sigil === "^") {
      // Find the matching close for this key (handles same-key nesting).
      let depth = 1;
      let j = i + 1;
      for (; j < toks.length; j++) {
        const t2 = toks[j];
        if ((t2.sigil === "#" || t2.sigil === "^") && t2.key === tk.key) depth++;
        else if (t2.sigil === "/" && t2.key === tk.key && --depth === 0) break;
      }
      const inner = toks.slice(i + 1, j);
      const show = tk.sigil === "#" ? nonEmpty(ctx, tk.key) : !nonEmpty(ctx, tk.key);
      if (show) out += renderTokens(inner, ctx);
      i = j; // skip past the close
    } else if (tk.sigil === "/") {
      // stray close — ignore
    } else {
      out += fieldValue(ctx, tk.key);
    }
  }
  return out;
}

/** Render one template string against a context { fields, FrontSide?, Tags?, ... }. */
export function renderTemplate(template, ctx) {
  return renderTokens(tokenize(template), ctx);
}

/** Map a note's field array to a { name: value } object for its note type. */
export function fieldMap(noteType, note) {
  const map = {};
  for (const f of noteType.flds) map[f.name] = note.fields[f.ord] ?? "";
  return map;
}

/**
 * The card ordinals a note should have (Anki's card-generation rule).
 * Cloze: one card per cloze ordinal. Standard: a template generates a card
 * iff the note's fields affect its rendered question — rendering with the
 * real fields must differ from rendering with every field blank (so pure
 * static text, or an unfilled {{#Optional}} section, generates nothing).
 */
export function cardOrdinalsForNote(noteType, note) {
  if (noteType.type === NoteTypeKind.Cloze) {
    const nums = [...clozeNumbers(note.fields[0] ?? "")].sort((a, b) => a - b);
    return (nums.length ? nums : [1]).map((n) => n - 1);
  }
  const fields = fieldMap(noteType, note);
  const blank = Object.fromEntries(Object.keys(fields).map((k) => [k, ""]));
  const ords = [];
  for (const t of noteType.tmpls) {
    if (renderTemplate(t.qfmt, { fields, side: "q" }) !== renderTemplate(t.qfmt, { fields: blank, side: "q" })) {
      ords.push(t.ord);
    }
  }
  return ords;
}

/**
 * Render a card's question and answer HTML.
 * @param {object} noteType  a model from collection.models
 * @param {number} ord       template ordinal (card.ord)
 * @param {import("./model.js").Note} note
 * @param {{ typed?: string, deckName?: string, flag?: number }} [opts]
 * @returns {{ question: string, answer: string }}
 */
export function renderCard(noteType, ord, note, opts = {}) {
  const isCloze = noteType.type === NoteTypeKind.Cloze;
  // Cloze note types have a single template; the ordinal selects the cloze number.
  const tmpl = noteType.tmpls[isCloze ? 0 : ord];
  if (!tmpl) throw new Error(`note type has no template ord ${ord}`);
  const fields = fieldMap(noteType, note);
  const base = {
    fields,
    Tags: (note.tags ?? []).join(" "),
    Deck: opts.deckName ?? "",
    Card: tmpl.name ?? "",
    Type: noteType.name ?? "",
    flag: (opts.flag ?? 0) & 7,
    clozeOrd: isCloze ? ord + 1 : undefined,
  };
  const question = renderTemplate(tmpl.qfmt, { ...base, side: "q" });
  const answer = renderTemplate(tmpl.afmt, {
    ...base, side: "a", FrontSide: question, typed: opts.typed ?? "",
  });
  return { question, answer };
}
