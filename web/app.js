// oss-anki browser app: local-first study UI over the oss-anki core library.
// Core study/persistence runs fully offline; .apkg import/export lazily loads
// sql.js + fflate + fzstd from the CDN (see the import map in index.html).

import { Collection, Note, Card, NoteTypeKind } from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard, clozeNumbers } from "../src/template.js";
import { collectionStats } from "../src/stats.js";
import { Rating } from "../src/fsrs.js";
import { stripHtml } from "../src/text.js";
import {
  openCollectionDB, loadCollection, saveCollection,
  putCard, putNote, putRevlog, putMeta, saveMedia, loadMedia, clearAll, deleteNoteAndCards, deleteRevlog,
} from "../src/storage.js";

const SQL_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/";

const state = {
  db: null,
  col: null,
  media: new Map(),
  mediaUrls: new Map(),
  deckId: null,
  card: null,
  answerShown: false,
};

const view = () => document.getElementById("view");
const setStatus = (msg) => { document.getElementById("status").textContent = msg ?? ""; };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function show(...nodes) {
  const v = view();
  v.replaceChildren(...nodes);
}

// --- media ---

// Blob URLs need the right MIME type, especially SVG: browsers won't render an
// <img> pointing at an SVG blob unless its type is exactly image/svg+xml.
const MIME = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
  m4a: "audio/mp4", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
function mimeFor(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function mediaUrl(name) {
  if (!state.mediaUrls.has(name)) {
    const bytes = state.media.get(name);
    if (!bytes) return null;
    state.mediaUrls.set(name, URL.createObjectURL(new Blob([bytes], { type: mimeFor(name) })));
  }
  return state.mediaUrls.get(name);
}

function resolveMedia(html) {
  return html.replace(/(src\s*=\s*)(["']?)([^"'>\s]+)\2/gi, (m, pre, _q, name) => {
    const url = mediaUrl(decodeURIComponent(name));
    return url ? `${pre}"${url}"` : m;
  });
}

// Anki embeds audio/video in fields as [sound:filename]; turn each into a
// native <audio>/<video> player pointing at the media object URL.
function resolveSounds(html) {
  return html.replace(/\[sound:([^\]]+)\]/g, (m, name) => {
    const file = name.trim();
    const url = mediaUrl(file);
    if (!url) return ""; // referenced audio not in the media store — drop it
    const isVideo = /\.(mp4|webm|mov)$/i.test(file);
    return isVideo
      ? `<video controls src="${url}" class="av"></video>`
      : `<audio controls preload="none" src="${url}" class="av"></audio>`;
  });
}

/** Best-effort autoplay of the first media player in the current face (Anki-like). */
function autoplayFirstMedia() {
  const av = view().querySelector("audio, video");
  if (av) av.play().catch(() => {});
}

// --- card rendering (note-type CSS + math) ---

// Naively scope a note type's CSS to the card area so deck styling can't bleed
// into the app chrome. Prefixes each rule's selectors with `scope `; @-rules
// (media/font-face/keyframes) are left unprefixed.
function scopeCss(css, scope) {
  return css.replace(/(^|\})\s*([^{}@]+?)\s*\{/g, (_m, brace, sel) => {
    const scoped = sel.split(",").map((s) => `${scope} ${s.trim()}`).join(", ");
    return `${brace} ${scoped} {`;
  });
}

function applyModelCss(model) {
  let style = document.getElementById("model-css");
  if (!style) {
    style = document.createElement("style");
    style.id = "model-css";
    document.head.appendChild(style);
  }
  style.textContent = model?.css ? scopeCss(model.css, ".card-face") : "";
}

// Convert Anki LaTeX tags to MathJax delimiters; `\(...\)` / `\[...\]` pass through.
function mathify(html) {
  return html
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, x) => `\\[${x}\\]`)
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, x) => `\\[${x}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, x) => `\\(${x}\\)`);
}

/** Full display pipeline for a field's HTML: math, sounds, media URLs. */
function displayHtml(html) {
  return resolveMedia(resolveSounds(mathify(html)));
}

/** A card face: model-styled `.card` inside the `.card-face` frame. */
function cardFace(html) {
  return el("div", { class: "card-face" }, el("div", { class: "card", html: displayHtml(html) }));
}

/** Typeset any math in the current view (MathJax loads async via index.html). */
function typesetMath() {
  if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([view()]).catch(() => {});
}

// --- formatting ---

function formatInterval(k) {
  if (k.days !== undefined) {
    const d = k.days;
    if (d < 1) return "<1d";
    if (d < 30) return `${d}d`;
    if (d < 365) return `${Math.round(d / 30)}mo`;
    return `${(d / 365).toFixed(1)}y`;
  }
  const s = k.secs;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// --- views ---

async function persistAll() {
  await saveCollection(state.db, state.col);
}

function addDeckPrompt() {
  const name = prompt("New deck name (use :: for subdecks):");
  if (!name || !name.trim()) return;
  state.col.addDeck(name.trim());
  persistAll().then(renderDecks);
}

function renameDeckPrompt(deck) {
  const name = prompt("Rename deck:", deck.name);
  if (!name || !name.trim() || name === deck.name) return;
  state.col.renameDeck(deck.id, name.trim());
  persistAll().then(renderDecks);
}

function deleteDeckPrompt(deck) {
  if (!confirm(`Delete "${deck.name}" and all its cards (including subdecks)?`)) return;
  state.col.removeDeck(deck.id);
  persistAll().then(renderDecks);
}

function renderDecks() {
  state.deckId = null;
  state.card = null;
  const sched = new Scheduler(state.col, { fuzz: true });
  const decks = Object.values(state.col.decks).sort((a, b) => a.name.localeCompare(b.name));
  const rows = decks.map((d) => {
    const c = sched.counts(d.id);
    const depth = d.name.split("::").length - 1;
    const leaf = d.name.split("::").pop();
    const actions = el("span", { class: "deck-actions" },
      el("button", { class: "icon", title: "Rename", onclick: (e) => { e.stopPropagation(); renameDeckPrompt(d); } }, "✎"),
      Number(d.id) === 1 ? "" :
        el("button", { class: "icon", title: "Delete", onclick: (e) => { e.stopPropagation(); deleteDeckPrompt(d); } }, "🗑"),
    );
    const row = el("div", { class: "deck", onclick: () => startStudy(d.id) },
      el("span", { class: "name", style: `padding-left:${depth * 18}px` }, leaf),
      el("span", { class: "count new", title: "new" }, c.new),
      el("span", { class: "count learning", title: "learning" }, c.learning),
      el("span", { class: "count review", title: "review" }, c.review),
      actions,
    );
    return row;
  });
  show(
    el("div", { class: "decks-head" }, el("h2", {}, "Decks"), el("button", { onclick: addDeckPrompt }, "+ Deck")),
    ...rows,
    rows.length ? "" : el("p", { class: "center" }, "No decks yet. Add a card or import an .apkg."),
  );
  const total = decks.reduce((n, d) => {
    const c = sched.counts(d.id);
    return n + c.new + c.learning + c.review;
  }, 0);
  setStatus(`${state.col.cards.size} cards · ${total} due`);
}

function nextDueCard() {
  const sched = new Scheduler(state.col, { fuzz: true });
  return sched.queue(state.deckId).all[0] ?? null;
}

function startStudy(deckId) {
  state.deckId = deckId;
  renderStudy();
}

function noteTypeAndNote(card) {
  const note = state.col.notes.get(card.nid);
  const noteType = state.col.noteType(note.mid);
  return { note, noteType };
}

function renderStudy() {
  const card = nextDueCard();
  state.card = card;
  state.answerShown = false;
  const back = el("div", { class: "crumbs", onclick: renderDecks }, "← Decks");

  if (!card) {
    show(back, el("p", { class: "center" }, "🎉 All caught up — nothing due in this deck."));
    return;
  }
  const { note, noteType } = noteTypeAndNote(card);
  applyModelCss(noteType);
  const { question } = renderCard(noteType, card.ord, note);

  show(
    back,
    cardFace(question),
    el("button", { class: "show-answer", onclick: () => showAnswer() }, "Show Answer"),
  );
  autoplayFirstMedia();
  typesetMath();
  // Focus a type-in-the-answer box if the template has one.
  view().querySelector("#typeans")?.focus();
}

function showAnswer() {
  const card = state.card;
  state.answerShown = true;
  const { note, noteType } = noteTypeAndNote(card);
  applyModelCss(noteType);
  const typed = view().querySelector("#typeans")?.value ?? "";
  const { answer } = renderCard(noteType, card.ord, note, { typed });
  const sched = new Scheduler(state.col, { fuzz: true });
  const outcomes = sched.nextStates(card);

  const ratingBtn = (label, cls, rating) =>
    el("button", { class: `rate ${cls}`, onclick: () => gradeCard(rating) },
      el("span", {}, label),
      el("small", {}, formatInterval(outcomes[cls].interval)),
    );

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    cardFace(answer),
    el("div", { class: "study-controls" },
      ratingBtn("Again", "again", Rating.Again),
      ratingBtn("Hard", "hard", Rating.Hard),
      ratingBtn("Good", "good", Rating.Good),
      ratingBtn("Easy", "easy", Rating.Easy),
    ),
  );
  autoplayFirstMedia();
  typesetMath();
}

async function gradeCard(rating) {
  const card = state.card;
  // Snapshot for single-level undo: the card before mutation + all deck counters.
  const snapshot = {
    deckId: state.deckId,
    cardId: card.id,
    card: { ...card },
    siblings: state.col.cardsForNote(card.nid)
      .filter((c) => c.id !== card.id)
      .map((c) => ({ id: c.id, queue: c.queue })),
    deckCounters: Object.fromEntries(
      Object.entries(state.col.decks).map(([id, d]) => [id, { newToday: d.newToday, revToday: d.revToday }]),
    ),
  };
  const sched = new Scheduler(state.col, { fuzz: true });
  const entry = sched.answerCard(card, rating);
  snapshot.entryId = entry.id;
  state.lastAction = snapshot;
  updateUndoButton();
  // Persist the answered card AND its (possibly buried) siblings.
  for (const c of state.col.cardsForNote(card.nid)) await putCard(state.db, c);
  await putRevlog(state.db, entry);
  await putMeta(state.db, state.col); // persist deck daily counters (newToday/revToday)
  renderStudy();
}

function updateUndoButton() {
  const btn = document.getElementById("btn-undo");
  if (btn) btn.disabled = !state.lastAction;
}

async function doUndo() {
  const a = state.lastAction;
  if (!a) return;
  const card = state.col.cards.get(a.cardId);
  if (card) Object.assign(card, a.card); // restore pre-answer card fields
  for (const s of a.siblings ?? []) {     // un-bury siblings buried by the answer
    const sib = state.col.cards.get(s.id);
    if (sib) sib.queue = s.queue;
  }
  state.col.revlog = state.col.revlog.filter((r) => r.id !== a.entryId);
  for (const [id, counters] of Object.entries(a.deckCounters)) {
    if (state.col.decks[id]) Object.assign(state.col.decks[id], counters);
  }
  state.lastAction = null;
  updateUndoButton();
  if (card) for (const c of state.col.cardsForNote(card.nid)) await putCard(state.db, c);
  await deleteRevlog(state.db, a.entryId);
  await putMeta(state.db, state.col);
  setStatus("Undone.");
  state.deckId = a.deckId;
  renderStudy();
}

function renderAddCard() {
  state.card = null;
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks);
  const modelSel = el("select", {}, ...models.map((m) => el("option", { value: m.id }, m.name)));
  if (state.col.conf.curModel) modelSel.value = state.col.conf.curModel;
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));

  const fieldsWrap = el("div", { class: "form-fields" });
  let inputs = [];
  const rebuildFields = () => {
    const model = state.col.noteType(Number(modelSel.value));
    inputs = [];
    fieldsWrap.replaceChildren(...model.flds.map((f) => {
      const ta = el("textarea", { placeholder: f.name });
      inputs.push(ta);
      return el("label", {}, f.name, ta);
    }));
  };
  modelSel.addEventListener("change", rebuildFields);
  rebuildFields();

  const save = async () => {
    const model = state.col.noteType(Number(modelSel.value));
    const fields = inputs.map((ta) => ta.value);
    if (!fields[0].trim()) { setStatus("The first field is empty."); return; }
    const note = new Note({ mid: model.id, fields }).normalize(model.sortf ?? 0);
    state.col.addNote(note);

    // Cloze notes generate one card per distinct cloze number; otherwise one per template.
    let ords;
    if (model.type === NoteTypeKind.Cloze) {
      const nums = [...clozeNumbers(fields[0])].sort((a, b) => a - b);
      ords = (nums.length ? nums : [1]).map((n) => n - 1);
    } else {
      ords = model.tmpls.map((t) => t.ord);
    }
    for (const ord of ords) {
      const due = state.col.conf.nextPos ?? 1;
      state.col.conf.nextPos = due + 1;
      const card = state.col.addCard(new Card({ nid: note.id, did: Number(deckSel.value), ord, due }));
      await putCard(state.db, card);
    }
    await putNoteAndMeta(note);
    setStatus(`Added (${ords.length} card${ords.length > 1 ? "s" : ""}).`);
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Add Card"),
    el("div", { class: "form" },
      el("label", {}, "Note type", modelSel),
      el("label", {}, "Deck", deckSel),
      fieldsWrap,
      el("div", { class: "row" }, el("button", { onclick: save }, "Save")),
    ),
  );
}

async function putNoteAndMeta(note) {
  await putNote(state.db, note);
  await putMeta(state.db, state.col);
}

// --- browse / edit ---

const cardStateLabel = (card) => {
  if (card.queue < 0) return "suspended";
  return ["new", "learning", "review", "relearning"][card.type] ?? "?";
};

function deckName(did) {
  return state.col.decks[String(did)]?.name ?? "?";
}

function renderBrowse(query = "") {
  state.card = null;
  const search = el("input", {
    class: "search", type: "search", placeholder: "Search fields, tags, deck…", value: query,
    oninput: (e) => { state.browseQuery = e.target.value; renderRows(e.target.value); },
  });
  const list = el("div", { class: "browse-list" });

  const renderRows = (qstr) => {
    const ql = qstr.trim().toLowerCase();
    const all = [...state.col.cards.values()].filter((c) => {
      if (!ql) return true;
      const note = state.col.notes.get(c.nid);
      const hay = `${note.fields.join(" ")} ${note.tags.join(" ")} ${deckName(c.did)}`.toLowerCase();
      return hay.includes(ql);
    });
    const shown = all.slice(0, 500);
    list.replaceChildren(
      ...shown.map((card) => {
        const note = state.col.notes.get(card.nid);
        const title = stripHtml(note.fields[0] ?? "").slice(0, 80) || "(empty)";
        return el("div", { class: "browse-row", onclick: () => renderEditNote(note.id) },
          el("span", { class: "br-title" }, title),
          el("span", { class: "br-deck" }, deckName(card.did)),
          el("span", { class: `br-state ${cardStateLabel(card)}` }, cardStateLabel(card)),
        );
      }),
      all.length > shown.length ? el("div", { class: "center" }, `…and ${all.length - shown.length} more (refine search)`) : "",
      all.length ? "" : el("div", { class: "center" }, "No matching cards."),
    );
    setStatus(`${all.length} card${all.length === 1 ? "" : "s"}`);
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Browse"),
    search,
    list,
  );
  renderRows(query);
}

function renderEditNote(noteId) {
  const note = state.col.notes.get(noteId);
  if (!note) return renderBrowse(state.browseQuery ?? "");
  const model = state.col.noteType(note.mid);

  const inputs = model.flds.map((f) => {
    const ta = el("textarea", {});
    ta.value = note.fields[f.ord] ?? "";
    return { f, ta };
  });
  const tagsInput = el("input", { type: "text", value: (note.tags ?? []).join(" ") });

  const save = async () => {
    note.fields = inputs.map(({ ta }) => ta.value);
    note.tags = tagsInput.value.split(/\s+/).filter(Boolean);
    note.mod = Math.floor(Date.now() / 1000);
    note.normalize(model.sortf ?? 0);
    await putNote(state.db, note);
    setStatus("Saved.");
    renderBrowse(state.browseQuery ?? "");
  };

  const del = async () => {
    if (!confirm("Delete this note and its cards?")) return;
    const cardIds = state.col.removeNote(noteId);
    await deleteNoteAndCards(state.db, noteId, cardIds);
    setStatus("Deleted.");
    renderBrowse(state.browseQuery ?? "");
  };

  show(
    el("div", { class: "crumbs", onclick: () => renderBrowse(state.browseQuery ?? "") }, "← Browse"),
    el("h2", {}, `Edit (${model.name})`),
    el("div", { class: "form" },
      ...inputs.map(({ f, ta }) => el("label", {}, f.name, ta)),
      el("label", {}, "Tags", tagsInput),
      el("div", { class: "row" },
        el("button", { onclick: save }, "Save"),
        el("button", { class: "danger", onclick: del }, "Delete"),
      ),
    ),
  );
}

// --- note-type / template editor ---

function renderNoteTypes() {
  state.card = null;
  const models = Object.values(state.col.models);
  const add = el("button", {
    onclick: () => {
      const name = prompt("New note type name:");
      if (!name || !name.trim()) return;
      const cloze = confirm("Cloze type? (OK = Cloze, Cancel = Standard)");
      const nt = state.col.addNoteType(name.trim(), cloze ? NoteTypeKind.Cloze : NoteTypeKind.Standard);
      persistAll().then(() => renderEditNoteType(nt.id));
    },
  }, "+ New");

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "decks-head" }, el("h2", {}, "Note Types"), add),
    ...models.map((m) => el("div", { class: "browse-row", onclick: () => renderEditNoteType(m.id) },
      el("span", { class: "br-title" }, m.name),
      el("span", { class: "br-deck" },
        `${m.flds.length} fields · ${m.tmpls.length} template${m.tmpls.length > 1 ? "s" : ""}` +
        (m.type === NoteTypeKind.Cloze ? " · cloze" : "")),
    )),
  );
}

function renderEditNoteType(mid) {
  state.card = null;
  const nt = state.col.noteType(mid);
  if (!nt) return renderNoteTypes();
  const isCloze = nt.type === NoteTypeKind.Cloze;

  const nameInput = el("input", { type: "text", value: nt.name });
  const cssArea = el("textarea", { class: "mono" });
  cssArea.value = nt.css ?? "";

  const fieldNameInputs = [];
  const fieldsBox = el("div", { class: "nt-list" });
  const renderFields = () => {
    fieldNameInputs.length = 0;
    fieldsBox.replaceChildren(...nt.flds.map((f, i) => {
      const inp = el("input", { type: "text", value: f.name });
      fieldNameInputs.push({ ord: i, inp });
      const rm = el("button", { class: "icon", title: "Remove field",
        onclick: async () => { state.col.removeField(mid, i); await persistAll(); renderEditNoteType(mid); } }, "🗑");
      return el("div", { class: "nt-row" }, inp, nt.flds.length > 1 ? rm : "");
    }));
  };
  renderFields();

  const tmplInputs = [];
  const tmplBox = el("div", { class: "nt-list" });
  const renderTemplates = () => {
    tmplInputs.length = 0;
    tmplBox.replaceChildren(...nt.tmpls.map((t, i) => {
      const name = el("input", { type: "text", value: t.name });
      const qfmt = el("textarea", { class: "mono" }); qfmt.value = t.qfmt;
      const afmt = el("textarea", { class: "mono" }); afmt.value = t.afmt;
      tmplInputs.push({ ord: i, name, qfmt, afmt });
      const rm = el("button", { class: "icon", title: "Remove template",
        onclick: async () => { state.col.removeTemplate(mid, i); await persistAll(); renderEditNoteType(mid); } }, "🗑");
      return el("div", { class: "nt-tmpl" },
        el("div", { class: "nt-tmpl-head" }, name, (!isCloze && nt.tmpls.length > 1) ? rm : ""),
        el("label", {}, "Front template", qfmt),
        el("label", {}, "Back template", afmt),
      );
    }));
  };
  renderTemplates();

  const save = async () => {
    nt.name = nameInput.value.trim() || nt.name;
    for (const { ord, inp } of fieldNameInputs) state.col.renameField(mid, ord, inp.value);
    for (const { ord, name, qfmt, afmt } of tmplInputs) {
      state.col.setTemplate(mid, ord, { name: name.value, qfmt: qfmt.value, afmt: afmt.value });
    }
    state.col.setCss(mid, cssArea.value);
    await persistAll();
    setStatus("Note type saved.");
    renderNoteTypes();
  };

  show(
    el("div", { class: "crumbs", onclick: renderNoteTypes }, "← Note types"),
    el("h2", {}, `Edit note type${isCloze ? " (Cloze)" : ""}`),
    el("div", { class: "form" },
      el("label", {}, "Name", nameInput),
      el("h3", {}, "Fields"), fieldsBox,
      el("button", { onclick: async () => {
        const name = prompt("Field name:");
        if (!name || !name.trim()) return;
        state.col.addField(mid, name.trim()); await persistAll(); renderEditNoteType(mid);
      } }, "+ Field"),
      el("h3", {}, "Templates"), tmplBox,
      isCloze ? "" : el("button", { onclick: async () => {
        const back = nt.flds[1]?.name ?? nt.flds[0].name;
        state.col.addTemplate(mid, `Card ${nt.tmpls.length + 1}`, `{{${nt.flds[0].name}}}`, `{{FrontSide}}<hr id=answer>{{${back}}}`);
        await persistAll(); renderEditNoteType(mid);
      } }, "+ Template"),
      el("h3", {}, "Styling (CSS)"), cssArea,
      el("div", { class: "row" }, el("button", { onclick: save }, "Save")),
    ),
  );
}

// --- stats ---

function barChart(values, color, height = 90) {
  const max = Math.max(1, ...values);
  return el("div", { class: "chart", style: `height:${height}px` },
    ...values.map((v) => el("div", {
      class: "bar", title: String(v), style: `height:${(v / max) * 100}%; background:${color}`,
    })),
  );
}

function renderStats() {
  state.card = null;
  const today = Math.floor((Math.floor(Date.now() / 1000) - (state.col.crt ?? 0)) / 86400);
  const s = collectionStats(state.col, today, 30);
  const c = s.counts;
  const stat = (label, value, cls = "") => el("div", { class: `stat ${cls}` },
    el("div", { class: "stat-n" }, value), el("div", { class: "stat-l" }, label));

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Statistics"),
    el("div", { class: "stat-grid" },
      stat("New", c.new, "new"),
      stat("Learning", c.learning, "learning"),
      stat("Young", c.young, "review"),
      stat("Mature", c.mature, "review"),
      stat("Suspended", c.suspended, "suspended"),
      stat("Total", c.total),
    ),
    el("p", { class: "muted" },
      `${s.totalReviews} reviews logged · true retention ` +
      (s.retention == null ? "—" : `${(s.retention * 100).toFixed(0)}%`)),
    el("h3", {}, "Reviews — last 30 days"),
    barChart([...s.reviewsPerDay].reverse(), "var(--good)"), // oldest → today (right)
    el("h3", {}, "Due — next 30 days"),
    barChart(s.dueForecast, "var(--accent)"),
  );
  setStatus("");
}

// --- import / export (.apkg) ---

async function loadSql() {
  const initSqlJs = (await import("sql.js")).default;
  return initSqlJs({ locateFile: (f) => SQL_CDN + f });
}

async function doImport(file) {
  setStatus("Importing…");
  try {
    const { importPackage } = await import("../src/apkg.js");
    const SQL = await loadSql();
    const buf = new Uint8Array(await file.arrayBuffer());
    const { collection, media } = importPackage(buf, { SQL });
    state.col = collection;
    state.media = media;
    state.mediaUrls.clear();
    await clearAll(state.db);
    await saveCollection(state.db, collection);
    await saveMedia(state.db, media);
    setStatus(`Imported ${collection.cards.size} cards.`);
    renderDecks();
  } catch (e) {
    setStatus(`Import failed: ${e.message}`);
    console.error(e);
  }
}

async function doExport() {
  setStatus("Exporting…");
  try {
    const { exportPackage } = await import("../src/apkg.js");
    const SQL = await loadSql();
    const bytes = exportPackage(state.col, state.media, { SQL });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = "oss-anki-export.apkg";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Exported.");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`);
    console.error(e);
  }
}

// --- init ---

function wireHeader() {
  document.getElementById("btn-add").addEventListener("click", renderAddCard);
  document.getElementById("btn-browse").addEventListener("click", () => renderBrowse(state.browseQuery ?? ""));
  document.getElementById("btn-stats").addEventListener("click", renderStats);
  document.getElementById("btn-types").addEventListener("click", renderNoteTypes);
  document.getElementById("btn-undo").addEventListener("click", doUndo);
  const fileInput = document.getElementById("file-import");
  document.getElementById("btn-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) doImport(fileInput.files[0]);
    fileInput.value = "";
  });
  document.getElementById("btn-export").addEventListener("click", doExport);
}

// Anki-style shortcuts: space/Enter flips; 1–4 (and space/Enter) grade.
function wireKeyboard() {
  const GRADE = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy, " ": Rating.Good, Enter: Rating.Good };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); return; }
    if (!state.card) return; // grading shortcuts only while a card is being studied
    const inField = e.target?.matches?.("input, textarea, select");
    if (!state.answerShown) {
      if (e.key === "Enter") { e.preventDefault(); showAnswer(); }
      else if (e.key === " " && !inField) { e.preventDefault(); showAnswer(); }
    } else if (!inField && GRADE[e.key]) {
      e.preventDefault();
      gradeCard(GRADE[e.key]);
    }
  });
}

async function init() {
  state.db = await openCollectionDB();
  state.col = await loadCollection(state.db);
  if (!state.col) {
    state.col = Collection.createDefault();
    await saveCollection(state.db, state.col);
  }
  state.media = await loadMedia(state.db);
  // New-day maintenance: un-bury yesterday's buried siblings, then persist.
  if (new Scheduler(state.col).unburyForNewDay() > 0) {
    await saveCollection(state.db, state.col);
  }
  wireHeader();
  wireKeyboard();
  renderDecks();
}

init().catch((e) => {
  setStatus(`Error: ${e.message}`);
  console.error(e);
});
