// Anki-style search: parse a query into a predicate over cards.
//
// Supported (a practical subset of Anki's syntax):
//   foo bar            implicit AND of substring matches (note fields + tags)
//   "a phrase"         quoted phrase (also lets key:"value with spaces")
//   -term              negation
//   a or b             OR (AND binds tighter); parentheses group: (a or b) c
//   deck:Name          card's deck (includes subdecks)
//   tag:foo  tag:none  has tag foo (wildcards * , hierarchical parent::*), or untagged
//   note:TypeName      note type
//   is:new|review|learn|due|suspended|buried
//   prop:ivl>=21  prop:due<=0  prop:reps>0  prop:lapses>1  prop:ease>2.5
//   added:7            added in the last N days
//   card:1             template ordinal (1-based)
//   flag:1             flag number (0–7)
//
// Pure module: compileSearch(query) -> (card, ctx) => bool, and searchCards()
// which builds the ctx from a collection.

import { CardType, CardQueue } from "./model.js";

const lc = (x) => (x ?? "").toLowerCase();

// --- tokenizer ---

function tokenize(query) {
  const toks = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === "(" || c === ")") { toks.push({ t: c }); i++; continue; }
    let s = "";
    while (i < query.length && !" \t\n()".includes(query[i])) {
      if (query[i] === '"') {
        i++;
        while (i < query.length && query[i] !== '"') { s += query[i]; i++; }
        i++; // skip closing quote
      } else {
        s += query[i];
        i++;
      }
    }
    const low = s.toLowerCase();
    if (low === "or") toks.push({ t: "or" });
    else if (low === "and") toks.push({ t: "and" });
    else toks.push({ t: "term", s });
  }
  return toks;
}

// --- term predicates ---

function wildcardRegExp(s) {
  const esc = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

function textPred(text) {
  const needle = lc(text);
  if (!needle) return () => true;
  return (card, ctx) => {
    const note = ctx.note(card);
    if (!note) return false;
    return lc(`${note.fields.join(" ")} ${note.tags.join(" ")}`).includes(needle);
  };
}

function deckPred(name) {
  const n = lc(name);
  return (card, ctx) => {
    const d = lc(ctx.deckName(card));
    return d === n || d.startsWith(`${n}::`);
  };
}

function tagPred(val) {
  if (lc(val) === "none") return (card, ctx) => (ctx.note(card)?.tags.length ?? 0) === 0;
  const re = wildcardRegExp(val);
  const prefix = `${lc(val)}::`;
  return (card, ctx) => (ctx.note(card)?.tags ?? []).some((t) => re.test(t) || lc(t).startsWith(prefix));
}

function isPred(state) {
  return (card, ctx) => {
    switch (state) {
      case "new": return card.type === CardType.New;
      case "review": return card.type === CardType.Review;
      case "learn": return card.type === CardType.Learning || card.type === CardType.Relearning;
      case "suspended": return card.queue === CardQueue.Suspended;
      case "buried": return card.queue === CardQueue.UserBuried || card.queue === CardQueue.SchedBuried;
      case "due":
        if (card.queue === CardQueue.Review || card.queue === CardQueue.DayLearning) return card.due <= ctx.today;
        if (card.queue === CardQueue.Learning) return card.due <= ctx.nowSec;
        return false;
      default: return () => false;
    }
  };
}

function propPred(val) {
  const m = val.match(/^(ivl|interval|due|reps|lapses|ease)\s*(>=|<=|!=|=|>|<)\s*(-?\d+(?:\.\d+)?)$/i);
  if (!m) return () => false;
  const key = m[1].toLowerCase();
  const num = Number(m[3]);
  const cmp = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, "=": (a, b) => a === b, "!=": (a, b) => a !== b }[m[2]];
  const get = (card, ctx) => {
    switch (key) {
      case "ivl": case "interval": return card.ivl;
      case "due": return card.due - ctx.today;
      case "reps": return card.reps;
      case "lapses": return card.lapses;
      case "ease": return card.factor / 1000;
      default: return NaN;
    }
  };
  return (card, ctx) => cmp(get(card, ctx), num);
}

function addedPred(val) {
  const days = Number(val);
  if (!Number.isFinite(days)) return () => false;
  return (card, ctx) => ctx.nowMs - card.id <= days * 86400000;
}

function notePred(name) {
  const n = lc(name);
  return (card, ctx) => lc(ctx.noteTypeName(ctx.note(card))) === n;
}

function termPredicate(s) {
  const ci = s.indexOf(":");
  if (ci > 0) {
    const key = s.slice(0, ci).toLowerCase();
    const val = s.slice(ci + 1);
    switch (key) {
      case "deck": return deckPred(val);
      case "tag": return tagPred(val);
      case "is": return isPred(lc(val));
      case "prop": return propPred(val);
      case "added": return addedPred(val);
      case "note": return notePred(val);
      case "card": { const n = Number(val); return Number.isFinite(n) ? (card) => card.ord === n - 1 : () => false; }
      case "flag": { const n = Number(val); return Number.isFinite(n) ? (card) => (card.flags & 7) === n : () => false; }
      default: return textPred(s); // unknown key → match the whole token as text
    }
  }
  return textPred(s);
}

// --- recursive-descent parser → composed predicate ---

function parse(toks) {
  let pos = 0;
  const peek = () => toks[pos];

  function parseUnary() {
    const tk = peek();
    if (tk && tk.t === "(") {
      pos++;
      const e = parseOr();
      if (peek() && peek().t === ")") pos++;
      return e;
    }
    if (tk && tk.t === "term") {
      pos++;
      let s = tk.s;
      let neg = false;
      if (s.startsWith("-")) { neg = true; s = s.slice(1); }
      const pred = termPredicate(s);
      return neg ? (c, ctx) => !pred(c, ctx) : pred;
    }
    pos++; // stray operator / paren — ignore
    return () => true;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek() && peek().t !== "or" && peek().t !== ")") {
      if (peek().t === "and") pos++;
      const right = parseUnary();
      const l = left;
      left = (c, ctx) => l(c, ctx) && right(c, ctx);
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === "or") {
      pos++;
      const right = parseAnd();
      const l = left;
      left = (c, ctx) => l(c, ctx) || right(c, ctx);
    }
    return left;
  }

  return toks.length ? parseOr() : () => true;
}

/** Compile a query string into a predicate `(card, ctx) => boolean`. */
export function compileSearch(query) {
  return parse(tokenize(query || ""));
}

/** Build the lookup context a compiled search needs. */
export function searchContext(col, { now } = {}) {
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  return {
    col,
    today: Math.floor((nowSec - (col.crt ?? 0)) / 86400),
    nowSec,
    nowMs: nowSec * 1000,
    note: (card) => col.notes.get(card.nid),
    deckName: (card) => col.decks[String(card.did)]?.name ?? "",
    noteTypeName: (note) => (note ? col.models[String(note.mid)]?.name ?? "" : ""),
  };
}

/** Convenience: return the cards in a collection matching `query`. */
export function searchCards(col, query, opts = {}) {
  const pred = compileSearch(query);
  const ctx = searchContext(col, opts);
  return [...col.cards.values()].filter((card) => pred(card, ctx));
}
