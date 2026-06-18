// Minimal Anki card-template renderer.
//
// Supports the common Mustache-style subset Anki uses:
//   {{Field}}            field value (raw HTML)
//   {{text:Field}}       field value with HTML stripped
//   {{FrontSide}}        the rendered question (available in the answer template)
//   {{#Field}}...{{/}}   shown only if the field is non-empty
//   {{^Field}}...{{/}}   shown only if the field is empty
//   {{Tags}}             space-joined tags (if provided in the context)
//
// Cloze deletion ({{cloze:...}}), {{type:...}} input, and {{hint:...}} are not
// yet implemented; their tags render as their bare field value for now.
//
// The renderer emits HTML; media (`<img src="file">`) is left untouched for the
// caller to rewrite to object URLs from its media store.

import { stripHtml } from "./text.js";

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

function fieldValue(ctx, key) {
  if (key === "FrontSide") return ctx.FrontSide ?? "";
  if (key === "Tags") return ctx.Tags ?? "";
  let name = key;
  let strip = false;
  const colon = key.indexOf(":");
  if (colon !== -1) {
    const filter = key.slice(0, colon);
    name = key.slice(colon + 1);
    if (filter === "text") strip = true;
    // other filters (cloze/type/hint) fall through to the bare field for now
  }
  const raw = ctx.fields?.[name] ?? "";
  return strip ? stripHtml(raw) : raw;
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
  const tmpl = noteType.tmpls[ord];
  if (!tmpl) throw new Error(`note type has no template ord ${ord}`);
  const fields = fieldMap(noteType, note);
  const Tags = (note.tags ?? []).join(" ");
  const question = renderTemplate(tmpl.qfmt, { fields, Tags });
  const answer = renderTemplate(tmpl.afmt, { fields, Tags, FrontSide: question });
  return { question, answer };
}
