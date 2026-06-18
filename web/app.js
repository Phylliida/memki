// oss-anki browser app: local-first study UI over the oss-anki core library.
// Core study/persistence runs fully offline; .apkg import/export lazily loads
// sql.js + fflate + fzstd from the CDN (see the import map in index.html).

import { Collection, Note, Card } from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard } from "../src/template.js";
import { Rating } from "../src/fsrs.js";
import {
  openCollectionDB, loadCollection, saveCollection,
  putCard, putRevlog, putMeta, saveMedia, loadMedia, clearAll,
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

function renderDecks() {
  state.deckId = null;
  const sched = new Scheduler(state.col);
  const decks = Object.values(state.col.decks).sort((a, b) => a.name.localeCompare(b.name));
  const rows = decks.map((d) => {
    const c = sched.counts(d.id);
    return el("div", { class: "deck", onclick: () => startStudy(d.id) },
      el("span", { class: "name" }, d.name),
      el("span", { class: "count new", title: "new" }, c.new),
      el("span", { class: "count learning", title: "learning" }, c.learning),
      el("span", { class: "count review", title: "review" }, c.review),
    );
  });
  show(
    el("h2", {}, "Decks"),
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
  const sched = new Scheduler(state.col);
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
  const { question } = renderCard(noteType, card.ord, note);

  show(
    back,
    el("div", { class: "card-face", html: resolveMedia(question) }),
    el("button", { class: "show-answer", onclick: () => showAnswer() }, "Show Answer"),
  );
}

function showAnswer() {
  const card = state.card;
  const { note, noteType } = noteTypeAndNote(card);
  const { answer } = renderCard(noteType, card.ord, note);
  const sched = new Scheduler(state.col);
  const outcomes = sched.nextStates(card);

  const ratingBtn = (label, cls, rating) =>
    el("button", { class: `rate ${cls}`, onclick: () => gradeCard(rating) },
      el("span", {}, label),
      el("small", {}, formatInterval(outcomes[cls].interval)),
    );

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "card-face", html: resolveMedia(answer) }),
    el("div", { class: "study-controls" },
      ratingBtn("Again", "again", Rating.Again),
      ratingBtn("Hard", "hard", Rating.Hard),
      ratingBtn("Good", "good", Rating.Good),
      ratingBtn("Easy", "easy", Rating.Easy),
    ),
  );
}

async function gradeCard(rating) {
  const card = state.card;
  const sched = new Scheduler(state.col);
  const entry = sched.answerCard(card, rating);
  await putCard(state.db, card);
  await putRevlog(state.db, entry);
  renderStudy();
}

function renderAddCard() {
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks);
  const modelSel = el("select", {}, ...models.map((m) => el("option", { value: m.id }, m.name)));
  if (state.col.conf.curModel) modelSel.value = state.col.conf.curModel;
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  const front = el("textarea", { placeholder: "Front" });
  const back = el("textarea", { placeholder: "Back" });

  const save = async () => {
    const model = state.col.noteType(Number(modelSel.value));
    const note = new Note({
      mid: model.id,
      fields: model.flds.map((_, i) => (i === 0 ? front.value : i === 1 ? back.value : "")),
    }).normalize(model.sortf ?? 0);
    state.col.addNote(note);
    // one card per template
    for (const tmpl of model.tmpls) {
      const due = state.col.conf.nextPos ?? 1;
      state.col.conf.nextPos = due + 1;
      const card = state.col.addCard(new Card({ nid: note.id, did: Number(deckSel.value), ord: tmpl.ord, due }));
      await putCard(state.db, card);
    }
    await putNoteAndMeta(note);
    setStatus("Card added.");
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Add Card"),
    el("div", { class: "form" },
      el("label", {}, "Note type", modelSel),
      el("label", {}, "Deck", deckSel),
      el("label", {}, "Front", front),
      el("label", {}, "Back", back),
      el("div", { class: "row" }, el("button", { onclick: save }, "Save")),
    ),
  );
}

async function putNoteAndMeta(note) {
  const { putNote } = await import("../src/storage.js");
  await putNote(state.db, note);
  await putMeta(state.db, state.col);
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
  const fileInput = document.getElementById("file-import");
  document.getElementById("btn-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) doImport(fileInput.files[0]);
    fileInput.value = "";
  });
  document.getElementById("btn-export").addEventListener("click", doExport);
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
  renderDecks();
}

init().catch((e) => {
  setStatus(`Error: ${e.message}`);
  console.error(e);
});
