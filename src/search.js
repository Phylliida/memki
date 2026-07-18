// Anki-style search: parse a query into a predicate over cards.
//
// Supported (a practical subset of Anki's syntax):
//   foo bar            implicit AND of substring matches (note fields + tags)
//   "a phrase"         quoted phrase (also lets key:"value with spaces")
//   -term              negation
//   a or b             OR (AND binds tighter); parentheses group: (a or b) c
//   deck:Name          card's deck (includes subdecks; * and _ wildcards)
//   tag:foo  tag:none  has tag foo (wildcards, hierarchical parent::*), or untagged
//   note:TypeName      note type
//   Field:value        a specific field matches value (whole-field, wildcards)
//   re:pattern         regex over the note's fields (case-insensitive)
//   is:new|review|learn|due|suspended|buried|buried-manually|buried-sibling
//   prop:ivl>=21  prop:due<=0  prop:reps>0  prop:ease>2.5  prop:s>30  prop:d<6
//   added:7  edited:7  introduced:7   (last N scheduling days)
//   rated:7  rated:7:1  answered in the last N days (optionally with button)
//   card:1             template ordinal (1-based)
//   flag:red           flag by color name (red orange green blue pink
//                      turquoise purple, none) or number (0–7)
//
// Pure module: compileSearch(query) -> (card, ctx) => bool, and searchCards()
// which builds the ctx from a collection.

import { CardType, CardQueue, parseCardData, cardHasFlag } from "./model.js";
import { collectionTiming } from "./timing.js";

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
  // Anki wildcards: * = any run, _ = any single character.
  const esc = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/_/g, ".");
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
  if (/[*_]/.test(name)) {
    const re = wildcardRegExp(name);
    const reSub = wildcardRegExp(`${name}::*`);
    return (card, ctx) => { const d = ctx.deckName(card); return re.test(d) || reSub.test(d); };
  }
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
      // is:learn is queue-based in Anki: cards currently in (re)learning steps.
      case "learn": return card.queue === CardQueue.Learning || card.queue === CardQueue.DayLearning;
      case "suspended": return card.queue === CardQueue.Suspended;
      case "buried": return card.queue === CardQueue.UserBuried || card.queue === CardQueue.SchedBuried;
      case "buried-manually": return card.queue === CardQueue.UserBuried;
      case "buried-sibling": return card.queue === CardQueue.SchedBuried;
      case "due":
        if (card.queue === CardQueue.Review || card.queue === CardQueue.DayLearning) return card.due <= ctx.today;
        if (card.queue === CardQueue.Learning) return card.due <= ctx.nowSec + ctx.learnAhead;
        return false;
      default: return false;
    }
  };
}

function propPred(val) {
  const m = val.match(/^(ivl|interval|due|reps|lapses|ease|s|stability|d|difficulty)\s*(>=|<=|!=|=|>|<)\s*(-?\d+(?:\.\d+)?)$/i);
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
      case "s": case "stability": return parseCardData(card.data).s ?? NaN;
      case "d": case "difficulty": return parseCardData(card.data).d ?? NaN;
      default: return NaN;
    }
  };
  return (card, ctx) => cmp(get(card, ctx), num);
}

/** Epoch-seconds cutoff for "within the last N scheduling days". */
const daysBackCutoff = (ctx, days) => ctx.dayCutoff - Math.max(days, 1) * 86400;

function addedPred(val) {
  const days = Number(val);
  if (!Number.isFinite(days)) return () => false;
  return (card, ctx) => card.id / 1000 >= daysBackCutoff(ctx, days);
}

function editedPred(val) {
  const days = Number(val);
  if (!Number.isFinite(days)) return () => false;
  return (card, ctx) => (ctx.note(card)?.mod ?? 0) >= daysBackCutoff(ctx, days);
}

function ratedPred(val) {
  const m = val.match(/^(\d+)(?::([0-4]))?$/);
  if (!m) return () => false;
  const days = Number(m[1]);
  const ease = m[2] ? Number(m[2]) : null;
  return (card, ctx) => {
    const cutoffMs = daysBackCutoff(ctx, days) * 1000;
    return (ctx.revlogFor(card.id) ?? []).some((r) => {
      if (r.id < cutoffMs) return false;
      // rated:N:0 = manual reschedules; plain rated:N = real answers only.
      if (ease === 0) return r.ease === 0;
      return r.ease > 0 && (ease == null || r.ease === ease);
    });
  };
}

function introducedPred(val) {
  const days = Number(val);
  if (!Number.isFinite(days)) return () => false;
  return (card, ctx) => {
    const first = ctx.revlogFor(card.id)?.[0];
    return first != null && first.id >= daysBackCutoff(ctx, days) * 1000;
  };
}

function rePred(pattern) {
  let re;
  try {
    re = new RegExp(pattern, "is");
  } catch {
    return () => false;
  }
  return (card, ctx) => {
    const note = ctx.note(card);
    return !!note && re.test(note.fields.join("\x1f"));
  };
}

/** `Front:dog` — the named field matches the pattern (whole field, wildcards). */
function fieldPred(key, val) {
  const re = wildcardRegExp(val);
  return (card, ctx) => {
    const note = ctx.note(card);
    if (!note) return false;
    const model = ctx.col.models[String(note.mid)];
    const fld = model?.flds.find((f) => lc(f.name) === key);
    if (!fld) return false;
    return re.test(note.fields[fld.ord] ?? "");
  };
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
      case "edited": return editedPred(val);
      case "rated": return ratedPred(val);
      case "introduced": return introducedPred(val);
      case "re": return rePred(val);
      case "note": return notePred(val);
      case "card": { const n = Number(val); return Number.isFinite(n) ? (card) => card.ord === n - 1 : () => false; }
      case "flag": {
        const FLAG_COLORS = { none: 0, red: 1, orange: 2, green: 3, blue: 4, pink: 5, turquoise: 6, turquise: 6, purple: 7 };
        const n = lc(val) in FLAG_COLORS ? FLAG_COLORS[lc(val)] : Number(val);
        // Flags are non-exclusive: flag:red matches any card carrying red.
        return Number.isFinite(n) ? (card) => cardHasFlag(card, n) : () => false;
      }
      default: return fieldPred(key, val); // unknown key → treat as a field name (Anki)
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
  const timing = collectionTiming(col, nowSec);
  let revlogIdx = null; // built lazily: cid -> entries sorted by id
  return {
    col,
    today: timing.daysElapsed,
    dayCutoff: timing.nextDayAt,
    learnAhead: col.conf?.collapseTime ?? 1200,
    nowSec,
    nowMs: nowSec * 1000,
    note: (card) => col.notes.get(card.nid),
    deckName: (card) => col.decks[String(card.did)]?.name ?? "",
    noteTypeName: (note) => (note ? col.models[String(note.mid)]?.name ?? "" : ""),
    revlogFor: (cid) => {
      if (!revlogIdx) {
        revlogIdx = new Map();
        for (const r of col.revlog) {
          if (!revlogIdx.has(r.cid)) revlogIdx.set(r.cid, []);
          revlogIdx.get(r.cid).push(r);
        }
        for (const list of revlogIdx.values()) list.sort((a, b) => a.id - b.id);
      }
      return revlogIdx.get(cid);
    },
  };
}

/** Convenience: return the cards in a collection matching `query`. */
export function searchCards(col, query, opts = {}) {
  const pred = compileSearch(query);
  const ctx = searchContext(col, opts);
  return [...col.cards.values()].filter((card) => pred(card, ctx));
}
