// oss-anki browser app: local-first study UI over the oss-anki core library.
// Core study/persistence runs fully offline; .apkg import/export lazily loads
// sql.js + fflate + fzstd from the CDN (see the import map in index.html).

import { Collection, Note, Card, NoteTypeKind } from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard, clozeNumbers } from "../src/template.js";
import { Rating } from "../src/fsrs.js";
import { stripHtml } from "../src/text.js";
import {
  openCollectionDB, loadCollection, saveCollection,
  putCard, putNote, putRevlog, putMeta, saveMedia, loadMedia, clearAll, deleteNoteAndCards,
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
  const sched = new Scheduler(state.col, { fuzz: true });
  const entry = sched.answerCard(card, rating);
  await putCard(state.db, card);
  await putRevlog(state.db, entry);
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
    if (!state.card) return; // only while a card is being studied
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
  wireHeader();
  wireKeyboard();
  renderDecks();
}

init().catch((e) => {
  setStatus(`Error: ${e.message}`);
  console.error(e);
});
