// Minimal Anki card-template renderer.
//
// Supports the common Mustache-style subset Anki uses:
//   {{Field}}            field value (raw HTML)
//   {{text:Field}}       field value with HTML stripped
//   {{cloze:Field}}      cloze deletion for the active card ordinal
//   {{type:Field}}       type-in-the-answer (the UI renders the input/diff)
//   {{FrontSide}}        the rendered question (available in the answer template)
//   {{#Field}}...{{/}}   shown only if the field is non-empty
//   {{^Field}}...{{/}}   shown only if the field is empty
//   {{Tags}}             space-joined tags (if provided in the context)
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

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)\}\}/g;

/**
 * Render Anki cloze markup for a given active ordinal and side.
 * Active cloze(s) become `[...]`/`[hint]` on the question and a highlighted
 * answer on the back; inactive clozes show their plain content on both sides.
 */
export function clozeFilter(text, ord, side) {
  return text.replace(CLOZE_RE, (_m, num, body) => {
    const sep = body.indexOf("::");
    const content = sep === -1 ? body : body.slice(0, sep);
    const hint = sep === -1 ? "" : body.slice(sep + 2);
    if (Number(num) === ord) {
      return side === "q"
        ? `<span class="cloze">[${hint || "..."}]</span>`
        : `<span class="cloze">${content}</span>`;
    }
    return content;
  });
}

/** Distinct cloze ordinals present in a field's text (e.g. {1,2}). */
export function clozeNumbers(text) {
  const nums = new Set();
  CLOZE_RE.lastIndex = 0;
  let m;
  while ((m = CLOZE_RE.exec(text))) nums.add(Number(m[1]));
  return nums;
}

function fieldValue(ctx, key) {
  if (key === "FrontSide") return ctx.FrontSide ?? "";
  if (key === "Tags") return ctx.Tags ?? "";
  let name = key;
  let filter = "";
  const colon = key.indexOf(":");
  if (colon !== -1) {
    filter = key.slice(0, colon);
    name = key.slice(colon + 1);
  }
  const raw = ctx.fields?.[name] ?? "";
  if (filter === "text") return stripHtml(raw);
  if (filter === "cloze") return clozeFilter(raw, ctx.clozeOrd ?? 0, ctx.side ?? "q");
  // {{type:Field}} marker for the UI; other unknown filters fall through to raw.
  return raw;
}

function nonEmpty(ctx, key) {
  if (key === "FrontSide") return (ctx.FrontSide ?? "") !== "";
  if (key === "Tags") return (ctx.Tags ?? "") !== "";
  const name = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return (ctx.fields?.[name] ?? "") !== "";
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

/** Render one template string against a context { fields, FrontSide?, Tags? }. */
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
 * Render a card's question and answer HTML.
 * @param {object} noteType  a model from collection.models
 * @param {number} ord       template ordinal (card.ord)
 * @param {import("./model.js").Note} note
 * @returns {{ question: string, answer: string }}
 */
export function renderCard(noteType, ord, note) {
  const isCloze = noteType.type === NoteTypeKind.Cloze;
  // Cloze note types have a single template; the ordinal selects the cloze number.
  const tmpl = noteType.tmpls[isCloze ? 0 : ord];
  if (!tmpl) throw new Error(`note type has no template ord ${ord}`);
  const fields = fieldMap(noteType, note);
  const Tags = (note.tags ?? []).join(" ");
  const clozeOrd = isCloze ? ord + 1 : undefined;
  const question = renderTemplate(tmpl.qfmt, { fields, Tags, clozeOrd, side: "q" });
  const answer = renderTemplate(tmpl.afmt, { fields, Tags, FrontSide: question, clozeOrd, side: "a" });
  return { question, answer };
}
