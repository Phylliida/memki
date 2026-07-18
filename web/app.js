// oss-anki browser app: local-first study UI over the oss-anki core library.
// Core study/persistence runs fully offline; .apkg import/export lazily loads
// sql.js + fflate + fzstd from the CDN (see the import map in index.html).

import {
  Collection, Note, Card, NoteTypeKind, CardType, CardQueue, imageOcclusionNoteType,
  basicNoteType, basicReversedNoteType, basicOptionalReversedNoteType, basicTypeNoteType, clozeNoteType,
} from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard, cardOrdinalsForNote } from "../src/template.js";
import { collectionStats } from "../src/stats.js";
import { compileSearch, searchContext } from "../src/search.js";
import { parseCsv } from "../src/csv.js";
import { Rating } from "../src/fsrs.js";
import { stripHtml, stripHtmlPreservingMediaFilenames } from "../src/text.js";
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

function debounced(fn, ms = 180) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** A valid model id: the preferred one if it exists, else the first model. */
function validModelId(preferred) {
  if (preferred != null && state.col.models[String(preferred)]) return String(preferred);
  const first = Object.values(state.col.models)[0];
  return first ? String(first.id) : "";
}

/** Ensure conf.curModel points at a real note type (imports can leave it stale). */
function sanitizeCurModel(col) {
  if (!col.models[String(col.conf.curModel)]) {
    const first = Object.values(col.models)[0];
    col.conf.curModel = first ? String(first.id) : null;
  }
}

// --- rich-text field editor (contenteditable + native formatting, like Anki) ---

function tbBtn(label, title, onClick) {
  return el("button", { type: "button", class: "rich-tb", title, onclick: (e) => { e.preventDefault(); onClick(); } }, label);
}

/** Store a dropped/pasted file in the media store; returns its media name. */
async function storeMediaFile(file) {
  const kind = file.type.startsWith("image/") ? "img" : "snd";
  const extRaw = (file.name?.includes(".") ? file.name.split(".").pop() : file.type.split("/")[1]) || "png";
  const ext = extRaw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png";
  const name = `${kind}-${state.col.nextId()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.media.set(name, bytes);
  state.mediaUrls.delete(name);
  await saveMedia(state.db, new Map([[name, bytes]]));
  return name;
}

const isDroppableMedia = (f) =>
  f.type.startsWith("image/") || f.type.startsWith("audio/") || f.type.startsWith("video/");

// Fields store media as <img src="filename">. In the editor the image must
// actually display, so srcs referencing stored media are rewritten to blob URLs
// tagged with data-name, and swapped back to bare filenames on read.
function editorDisplayHtml(html) {
  return html.replace(/(<img\b[^>]*?src\s*=\s*)(["']?)([^"'>\s]+)\2/gi, (m, pre, _q, src) => {
    const name = safeDecode(src);
    if (!state.media.has(name)) return m;
    return `${pre}"${mediaUrl(name)}" data-name="${encodeURIComponent(name)}"`;
  });
}

/** Move the caret to the point (x, y), clamped to stay inside `container`. */
function placeCaretAt(container, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) {
      range = document.createRange();
      range.setStart(p.offsetNode, p.offset);
    }
  }
  if (!range || !container.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(container);
    range.collapse(false);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const mediaFilesOf = (dt) => [...(dt?.files ?? [])].filter(isDroppableMedia);

/** A rich-text editor over a field's HTML. Returns { el, getHTML, setHTML, focus }. */
function richEditor(initialHtml = "") {
  const area = el("div", { class: "rich", contenteditable: "true" });
  area.innerHTML = editorDisplayHtml(initialHtml);
  const raw = el("textarea", { class: "rich-raw mono" });
  raw.style.display = "none";
  let rawMode = false;

  /** The field HTML to store: the editor DOM with media srcs back to filenames. */
  const storageHtml = () => {
    const clone = area.cloneNode(true);
    for (const img of clone.querySelectorAll("img[data-name]")) {
      img.setAttribute("src", safeDecode(img.getAttribute("data-name")));
      img.removeAttribute("data-name");
    }
    for (const img of clone.querySelectorAll("img.img-selected")) {
      img.classList.remove("img-selected"); // editor-only selection marker
      if (!img.className) img.removeAttribute("class");
    }
    return clone.innerHTML;
  };

  const insertMedia = async (file) => {
    if (rawMode) return;
    const name = await storeMediaFile(file);
    area.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount || !area.contains(sel.getRangeAt(0).startContainer)) {
      const r = document.createRange();
      r.selectNodeContents(area);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (file.type.startsWith("image/")) {
      document.execCommand("insertHTML", false,
        `<img src="${mediaUrl(name)}" data-name="${encodeURIComponent(name)}">`);
    } else {
      // Audio/video go in as Anki's [sound:...] tag (players render at review).
      document.execCommand("insertText", false, `[sound:${name}]`);
    }
  };

  const cmd = (c, val = null) => { area.focus(); document.execCommand(c, false, val); };
  const wrapCloze = () => {
    if (rawMode) return;
    area.focus();
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "";
    let max = 0; let m;
    const re = /\{\{c(\d+)::/g;
    while ((m = re.exec(area.innerHTML))) max = Math.max(max, Number(m[1]));
    document.execCommand("insertText", false, `{{c${max + 1}::${text}}}`);
  };
  const toggleRaw = () => {
    rawMode = !rawMode;
    hideHandle();
    if (rawMode) { raw.value = storageHtml(); raw.style.display = ""; area.style.display = "none"; }
    else { area.innerHTML = editorDisplayHtml(raw.value); raw.style.display = "none"; area.style.display = ""; }
  };

  area.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); wrapCloze(); }
  });

  // Drag-and-drop and paste images straight into the field.
  area.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) {
      e.preventDefault();
      area.classList.add("dropping");
    }
  });
  area.addEventListener("dragleave", () => area.classList.remove("dropping"));
  area.addEventListener("drop", async (e) => {
    area.classList.remove("dropping");
    const files = mediaFilesOf(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    placeCaretAt(area, e.clientX, e.clientY);
    for (const f of files) await insertMedia(f);
  });
  area.addEventListener("paste", async (e) => {
    const files = mediaFilesOf(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await insertMedia(f);
  });

  const toolbar = el("div", { class: "rich-toolbar" },
    tbBtn("B", "Bold", () => cmd("bold")),
    tbBtn("I", "Italic", () => cmd("italic")),
    tbBtn("U", "Underline", () => cmd("underline")),
    tbBtn("•", "Bullet list", () => cmd("insertUnorderedList")),
    tbBtn("1.", "Numbered list", () => cmd("insertOrderedList")),
    tbBtn("T̶", "Clear formatting", () => cmd("removeFormat")),
    tbBtn("[…]", "Cloze (Ctrl+Shift+C)", wrapCloze),
    tbBtn("🖼", "Insert image/audio/video (or drag & drop / paste)", () => {
      const inp = el("input", { type: "file", accept: "image/*,audio/*,video/*" });
      inp.addEventListener("change", () => { if (inp.files[0]) insertMedia(inp.files[0]); });
      inp.click();
    }),
    tbBtn("</>", "Edit HTML", toggleRaw),
  );
  const wrap = el("div", { class: "rich-wrap" }, toolbar, area, raw);

  // --- image sizing (Anki-style): click an image to select it, drag the
  // corner handle to resize (stored as a width attribute, so it persists in
  // the note and in exports), double-click to restore natural size. ---
  const handle = el("span", { class: "img-handle", title: "Drag to resize · double-click image to reset" });
  handle.style.display = "none";
  wrap.append(handle);
  let sizingImg = null;

  const hideHandle = () => {
    sizingImg?.classList.remove("img-selected");
    sizingImg = null;
    handle.style.display = "none";
  };
  const positionHandle = () => {
    if (!sizingImg || !sizingImg.isConnected || rawMode) { hideHandle(); return; }
    const wrapR = wrap.getBoundingClientRect();
    const r = sizingImg.getBoundingClientRect();
    handle.style.left = `${r.right - wrapR.left - 8}px`;
    handle.style.top = `${r.bottom - wrapR.top - 8}px`;
    handle.style.display = "";
  };

  area.addEventListener("click", (e) => {
    if (e.target.tagName === "IMG") {
      if (sizingImg !== e.target) {
        sizingImg?.classList.remove("img-selected");
        sizingImg = e.target;
        sizingImg.classList.add("img-selected");
      }
      positionHandle();
    } else {
      hideHandle();
    }
  });
  area.addEventListener("dblclick", (e) => {
    if (e.target.tagName === "IMG") {
      e.target.removeAttribute("width");
      e.target.removeAttribute("height");
      positionHandle();
    }
  });
  area.addEventListener("input", () => { if (sizingImg) positionHandle(); });
  handle.addEventListener("pointerdown", (e) => {
    if (!sizingImg) return;
    e.preventDefault();
    const img = sizingImg;
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const maxW = Math.max(48, area.clientWidth - 24);
    const move = (ev) => {
      const w = Math.min(Math.max(Math.round(startW + (ev.clientX - startX)), 16), maxW);
      img.setAttribute("width", String(w));
      img.removeAttribute("height"); // keep aspect ratio
      positionHandle();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  return {
    el: wrap,
    getHTML: () => (rawMode ? raw.value : storageHtml()),
    setHTML: (h) => { hideHandle(); area.innerHTML = editorDisplayHtml(h); raw.value = h; },
    focus: () => area.focus(),
  };
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

/** decodeURIComponent that tolerates stray '%' in real-world filenames. */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
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
    const url = mediaUrl(safeDecode(name));
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
function autoplayFirstMedia(card) {
  if (card && new Scheduler(state.col).deckConfigFor(card).autoplay === false) return;
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

function emptyFilteredDeck(deck) {
  const sched = new Scheduler(state.col);
  sched.emptyFiltered(deck.id);
  delete state.col.decks[String(deck.id)];
  state.col.graves.push({ usn: -1, oid: deck.id, type: 2 });
  persistAll().then(renderDecks);
}

function renderCustomStudy(sourceDeckId) {
  state.card = null;
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  deckSel.value = String(sourceDeckId ?? decks[0]?.id ?? 1);
  const presetSel = el("select", {},
    el("option", { value: "ahead" }, "Review ahead — cards due in the next N days"),
    el("option", { value: "all" }, "All cards in deck (ignore limits)"),
    el("option", { value: "search" }, "Cards matching a search"),
  );
  const nInput = el("input", { type: "number", value: "7", min: "1" });
  const searchInput = el("input", { type: "text", placeholder: "search text (fields/tags)" });

  const build = async () => {
    const sched = new Scheduler(state.col, { fuzz: true });
    const srcIds = sched._deckAndDescendants(Number(deckSel.value));
    const today = sched.daysElapsed;
    const preset = presetSel.value;
    const n = Math.max(1, Number(nInput.value) || 7);
    const q = searchInput.value.trim().toLowerCase();
    const match = (card) => {
      if (!srcIds.has(card.did)) return false;
      if (preset === "ahead") return card.type === CardType.Review && card.due > today && card.due <= today + n;
      if (preset === "search") {
        const note = state.col.notes.get(card.nid);
        return `${note.fields.join(" ")} ${note.tags.join(" ")}`.toLowerCase().includes(q);
      }
      return true; // all
    };
    const fd = state.col.createFilteredDeck("Custom Study");
    const count = sched.buildFiltered(fd.id, match);
    if (count === 0) {
      delete state.col.decks[String(fd.id)];
      setStatus("No matching cards found.");
      return;
    }
    await persistAll();
    setStatus(`Custom study: ${count} cards gathered.`);
    startStudy(fd.id);
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Custom Study"),
    el("div", { class: "form" },
      el("label", {}, "Deck", deckSel),
      el("label", {}, "What to study", presetSel),
      el("label", {}, "Days ahead (for 'review ahead')", nInput),
      el("label", {}, "Search (for 'matching a search')", searchInput),
      el("p", { class: "muted" }, "Builds a temporary filtered deck. Empty it from the deck list (⏏) to return cards to their home decks."),
      el("div", { class: "row" }, el("button", { onclick: build }, "Build & Study")),
    ),
  );
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
    const actions = d.dyn
      ? el("span", { class: "deck-actions" },
          el("button", { class: "icon", title: "Empty (return cards home)", onclick: (e) => { e.stopPropagation(); emptyFilteredDeck(d); } }, "⏏"))
      : el("span", { class: "deck-actions" },
          el("button", { class: "icon", title: "Custom study", onclick: (e) => { e.stopPropagation(); renderCustomStudy(d.id); } }, "⚡"),
          el("button", { class: "icon", title: "Options", onclick: (e) => { e.stopPropagation(); renderDeckOptions(d.id); } }, "⚙"),
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
  const studied = decks.reduce(
    (n, d) => n + sched._counterValue(d, "newToday") + sched._counterValue(d, "revToday"), 0);
  setStatus(`${state.col.cards.size} cards · ${total} due · ${studied} studied today`);
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
  state.qShownAt = Date.now(); // for revlog answer-duration tracking
  const showAnswerBtn = el("button", { class: "show-answer", onclick: () => showAnswer() }, "Show Answer");
  if (noteType.ossIO) {
    show(back, occlusionFace(note, card.ord, "q"), showAnswerBtn, reviewMoreBar());
    return;
  }
  applyModelCss(noteType);
  const { question } = renderCard(noteType, card.ord, note, {
    deckName: deckName(card.did), flag: card.flags & 7,
  });

  show(back, cardFace(question), showAnswerBtn, reviewMoreBar());
  autoplayFirstMedia(card);
  typesetMath();
  // Focus a type-in-the-answer box if the template has one.
  view().querySelector("#typeans")?.focus();
}

function showAnswer() {
  const card = state.card;
  state.answerShown = true;
  const { note, noteType } = noteTypeAndNote(card);
  const sched = new Scheduler(state.col, { fuzz: true });
  const outcomes = sched.nextStates(card);
  const ratingBtn = (label, cls, rating) =>
    el("button", { class: `rate ${cls}`, onclick: () => gradeCard(rating) },
      el("span", {}, label),
      el("small", {}, formatInterval(outcomes[cls].interval)),
    );
  const controls = el("div", { class: "study-controls" },
    ratingBtn("Again", "again", Rating.Again),
    ratingBtn("Hard", "hard", Rating.Hard),
    ratingBtn("Good", "good", Rating.Good),
    ratingBtn("Easy", "easy", Rating.Easy),
  );
  const crumbs = el("div", { class: "crumbs", onclick: renderDecks }, "← Decks");

  if (noteType.ossIO) {
    show(crumbs, occlusionFace(note, card.ord, "a"), controls, reviewMoreBar());
    return;
  }
  applyModelCss(noteType);
  const typed = view().querySelector("#typeans")?.value ?? "";
  const { answer } = renderCard(noteType, card.ord, note, {
    typed, deckName: deckName(card.did), flag: card.flags & 7,
  });
  show(crumbs, cardFace(answer), controls, reviewMoreBar());
  autoplayFirstMedia(card);
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
  const entry = sched.answerCard(card, rating, {
    takenMs: state.qShownAt ? Date.now() - state.qShownAt : 0,
  });
  snapshot.entryId = entry.id;
  state.lastAction = snapshot;
  updateUndoButton();
  // Persist the answered card AND its (possibly buried) siblings; the note too,
  // since a leech may have just been tagged.
  for (const c of state.col.cardsForNote(card.nid)) await putCard(state.db, c);
  await putNote(state.db, state.col.notes.get(card.nid));
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

/**
 * Create a note + its cards (cloze → one per cloze number; else one per
 * template) in the collection, returning the note. Does not persist.
 */
function addNoteWithCards(model, fields, did, tags = []) {
  const note = new Note({ mid: model.id, fields, tags }).normalize(model.sortf ?? 0);
  state.col.addNote(note);
  const ords = cardOrdinalsForNote(model, note);
  const deck = state.col.decks[String(did)];
  const dc = state.col.dconf[String(deck?.conf ?? 1)];
  const randomOrder = (dc?.new?.order ?? 1) === 0; // 0 = random, 1 = sequential
  for (const ord of ords) {
    const due = state.col.conf.nextPos ?? 1;
    state.col.conf.nextPos = due + 1;
    state.col.addCard(new Card({ nid: note.id, did, ord, due: randomOrder ? 1 + Math.floor(Math.random() * due) : due }));
  }
  return note;
}

function renderAddCard() {
  state.card = null;
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const modelSel = el("select", {}, ...models.map((m) => el("option", { value: m.id }, m.name)));
  modelSel.value = validModelId(state.col.conf.curModel);
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));

  const fieldsWrap = el("div", { class: "form-fields" });
  let inputs = [];
  const rebuildFields = () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    inputs = [];
    if (!model) {
      fieldsWrap.replaceChildren(el("p", { class: "muted" }, "No note types — create one in Types."));
      return;
    }
    fieldsWrap.replaceChildren(...model.flds.map((f) => {
      const ed = richEditor("");
      inputs.push(ed);
      return el("label", {}, f.name, ed.el);
    }));
  };

  // Live preview: the actual card(s) this note will create, as you type.
  const previewBox = el("div", { class: "preview-box" });
  const updatePreview = () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) { previewBox.replaceChildren(); return; }
    const fields = inputs.map((ed) => ed.getHTML());
    const tmpNote = new Note({ mid: model.id, fields });
    const ords = cardOrdinalsForNote(model, tmpNote);
    if (!ords.length) {
      previewBox.replaceChildren(el("div", { class: "muted pv-count" }, "No cards yet — fill the first field."));
      return;
    }
    applyModelCss(model);
    const { question, answer } = renderCard(model, ords[0], tmpNote, {
      deckName: decks.find((d) => String(d.id) === deckSel.value)?.name ?? "",
    });
    previewBox.replaceChildren(
      el("div", { class: "muted pv-count" },
        `Will create ${ords.length} card${ords.length > 1 ? "s" : ""} · previewing "${model.tmpls[model.type === NoteTypeKind.Cloze ? 0 : ords[0]]?.name ?? ""}"`),
      el("div", { class: "pv-pair" },
        el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(question) })),
        el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(answer) })),
      ),
    );
    typesetMath();
  };
  const schedulePreview = debounced(updatePreview);
  fieldsWrap.addEventListener("input", schedulePreview);
  deckSel.addEventListener("change", schedulePreview);
  modelSel.addEventListener("change", () => { rebuildFields(); schedulePreview(); });
  rebuildFields();
  updatePreview();

  const save = async () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) { setStatus("No note type available."); return; }
    const fields = inputs.map((ed) => ed.getHTML());
    // Emptiness check Anki-style: media filenames count as content, so an
    // image-only (or [sound:]-only) first field is a valid note.
    if (!stripHtmlPreservingMediaFilenames(fields[0]).trim()) { setStatus("The first field is empty."); return; }
    const note = addNoteWithCards(model, fields, Number(deckSel.value));
    await putNoteAndMeta(note);
    for (const c of state.col.cardsForNote(note.id)) await putCard(state.db, c);
    const count = state.col.cardsForNote(note.id).length;
    setStatus(`Added (${count} card${count > 1 ? "s" : ""}).`);
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Add Card"),
    el("div", { class: "form" },
      el("div", { class: "row" }, el("label", {}, "Note type", modelSel), el("label", {}, "Deck", deckSel)),
      fieldsWrap,
      el("div", { class: "row" },
        el("button", { onclick: save }, "Save"),
        el("button", { onclick: renderImportCsv }, "Import CSV/TSV"),
        el("button", { onclick: renderImageOcclusion }, "🖼 Image Occlusion"),
      ),
      previewBox,
    ),
  );
}

async function putNoteAndMeta(note) {
  await putNote(state.db, note);
  await putMeta(state.db, state.col);
}

function renderImportCsv() {
  state.card = null;
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.txt" });
  const modelSel = el("select", {}, ...models.map((m) => el("option", { value: m.id }, m.name)));
  modelSel.value = validModelId(state.col.conf.curModel);
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  const delimSel = el("select", {},
    el("option", { value: "" }, "Auto"), el("option", { value: "," }, "Comma"),
    el("option", { value: "\t" }, "Tab"), el("option", { value: ";" }, "Semicolon"));
  const headerChk = el("input", { type: "checkbox" });
  headerChk.checked = true;
  const mappingBox = el("div", { class: "form" });
  const preview = el("div", { class: "muted io-preview" });
  let parsed = null;
  const mapSelects = [];

  const buildMapping = () => {
    mapSelects.length = 0;
    mappingBox.replaceChildren();
    if (!parsed || !parsed.rows.length) return;
    const cols = Math.max(...parsed.rows.map((r) => r.length));
    const header = headerChk.checked ? parsed.rows[0] : null;
    const colLabel = (i) => (header && header[i] ? `Col ${i + 1} — ${header[i]}` : `Col ${i + 1}`);
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) return;
    mappingBox.replaceChildren(...model.flds.map((f, fi) => {
      const sel = el("select", {},
        el("option", { value: -1 }, "(empty)"),
        ...Array.from({ length: cols }, (_, i) => el("option", { value: i }, colLabel(i))));
      sel.value = String(fi < cols ? fi : -1);
      mapSelects.push(sel);
      return el("label", {}, f.name, sel);
    }));
    const dataCount = parsed.rows.length - (headerChk.checked ? 1 : 0);
    const sample = (headerChk.checked ? parsed.rows.slice(1, 4) : parsed.rows.slice(0, 3))
      .map((r) => r.join(" | ")).join("    /    ");
    preview.textContent = `${dataCount} rows · ${cols} columns · sample: ${sample}`;
  };

  const reparse = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    parsed = parseCsv(await f.text(), delimSel.value || undefined);
    buildMapping();
  };
  fileInput.addEventListener("change", reparse);
  delimSel.addEventListener("change", reparse);
  headerChk.addEventListener("change", buildMapping);
  modelSel.addEventListener("change", buildMapping);

  const doImport = async () => {
    if (!parsed || !parsed.rows.length) { setStatus("Choose a file first."); return; }
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) { setStatus("No note type available."); return; }
    const did = Number(deckSel.value);
    const map = mapSelects.map((s) => Number(s.value));
    const dataRows = headerChk.checked ? parsed.rows.slice(1) : parsed.rows;
    let n = 0;
    for (const row of dataRows) {
      const fields = model.flds.map((_, fi) => (map[fi] >= 0 ? row[map[fi]] ?? "" : ""));
      if (!stripHtmlPreservingMediaFilenames(fields[0]).trim()) continue;
      addNoteWithCards(model, fields, did);
      n++;
    }
    await saveCollection(state.db, state.col);
    setStatus(`Imported ${n} notes.`);
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderAddCard }, "← Add"),
    el("h2", {}, "Import CSV / TSV"),
    el("div", { class: "form" },
      el("label", {}, "File", fileInput),
      el("div", { class: "row" }, el("label", {}, "Note type", modelSel), el("label", {}, "Deck", deckSel)),
      el("div", { class: "row" },
        el("label", {}, "Delimiter", delimSel),
        el("label", { class: "inline" }, headerChk, "First row is a header"),
      ),
      el("h3", {}, "Column → field mapping"),
      mappingBox,
      preview,
      el("div", { class: "row" }, el("button", { onclick: doImport }, "Import")),
    ),
  );
}

// --- browse / edit ---

const cardStateLabel = (card) => {
  if (card.queue < 0) return "suspended";
  return ["new", "learning", "review", "relearning"][card.type] ?? "?";
};

function deckName(did) {
  return state.col.decks[String(did)]?.name ?? "?";
}

/** Wrap a search term in quotes when its value needs them. */
function quoteTerm(term) {
  return /\s/.test(term) ? `"${term}"` : term;
}

/** Build a filtered deck from a browse query and start studying it. */
async function buildDeckFromSearch(query) {
  let pred;
  try { pred = compileSearch(query); } catch { setStatus("Invalid search."); return; }
  const ctx = searchContext(state.col);
  const sched = new Scheduler(state.col, { fuzz: true });
  const fd = state.col.createFilteredDeck("Custom Study");
  const count = sched.buildFiltered(fd.id, (c) => pred(c, ctx));
  if (!count) {
    delete state.col.decks[String(fd.id)];
    setStatus("No cards match this filter.");
    return;
  }
  await persistAll();
  setStatus(`Custom deck: ${count} cards gathered.`);
  startStudy(fd.id);
}

function renderBrowse(query = "") {
  state.card = null;
  const search = el("input", {
    class: "search", type: "search", value: query,
    placeholder: 'Search — e.g. deck:Spanish tag:verb is:due prop:ivl>21 -flag:1',
    oninput: (e) => { state.browseQuery = e.target.value; renderRows(e.target.value); },
  });
  const list = el("div", { class: "browse-list" });

  // --- sidebar: click sets the search; Ctrl/⌘-click ANDs it on ---
  const setQuery = (q, additive) => {
    const next = additive && search.value.trim() ? `${search.value.trim()} ${q}` : q;
    search.value = next;
    state.browseQuery = next;
    renderRows(next);
  };
  const sideItem = (label, q, extra = null) =>
    el("div", { class: "side-item", title: q, onclick: (e) => setQuery(q, e.ctrlKey || e.metaKey) }, extra, label);
  const section = (title, ...items) =>
    el("div", { class: "side-sec" }, el("h4", {}, title), ...items);

  const decks = Object.values(state.col.decks).sort((a, b) => a.name.localeCompare(b.name));
  const tagSet = new Set();
  for (const n of state.col.notes.values()) for (const t of n.tags) tagSet.add(t);
  const tags = [...tagSet].sort((a, b) => a.localeCompare(b));

  const sidebar = el("aside", { class: "browse-side" },
    section("Today",
      sideItem("Due today", "is:due"),
      sideItem("Overdue", "is:due prop:due<0"),
      sideItem("Added", "added:1"),
      sideItem("Edited", "edited:1"),
      sideItem("Studied", "rated:1"),
      sideItem("First review", "introduced:1"),
      sideItem("Rescheduled", "rated:1:0"),
      sideItem("Again", "rated:1:1"),
    ),
    section("Card state",
      sideItem("New", "is:new"),
      sideItem("Learning", "is:learn"),
      sideItem("Review", "is:review"),
      sideItem("Suspended", "is:suspended"),
      sideItem("Buried", "is:buried"),
    ),
    section("Flags",
      ...FLAG_NAMES.map((name, i) =>
        sideItem(name, `flag:${i}`, i ? el("span", { class: `flag-dot f${i}` }, "⚑") : null)),
    ),
    section("Decks",
      ...decks.map((d) => {
        const depth = d.name.split("::").length - 1;
        return sideItem(d.name.split("::").pop(), quoteTerm(`deck:${d.name}`),
          depth ? el("span", { class: "side-indent", style: `width:${depth * 12}px` }) : null);
      }),
    ),
    section("Note types",
      ...Object.values(state.col.models).map((m) => sideItem(m.name, quoteTerm(`note:${m.name}`))),
    ),
    section("Tags",
      sideItem("Untagged", "tag:none"),
      ...tags.map((t) => sideItem(t, quoteTerm(`tag:${t}`))),
    ),
  );

  const renderRows = (qstr) => {
    let all;
    try {
      const pred = compileSearch(qstr);
      const ctx = searchContext(state.col);
      all = [...state.col.cards.values()].filter((c) => pred(c, ctx));
    } catch {
      all = [];
    }
    const shown = all.slice(0, 500);
    list.replaceChildren(
      ...shown.map((card) => {
        const note = state.col.notes.get(card.nid);
        const title = stripHtml(note.fields[0] ?? "").slice(0, 80) || "(empty)";
        const flag = card.flags & 7;
        return el("div", { class: "browse-row", onclick: () => renderEditNote(note.id) },
          flag ? el("span", { class: `flag-dot f${flag}`, title: FLAG_NAMES[flag] }, "⚑") : "",
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
    el("div", { class: "decks-head" },
      el("h2", {}, "Browse"),
      el("div", { class: "row" },
        el("button", { class: "side-toggle", onclick: () => sidebar.classList.toggle("open") }, "☰ Filters"),
        el("button", { title: "Build a filtered deck from the current search and study it",
          onclick: () => buildDeckFromSearch(search.value) }, "⚡ Study these"),
      ),
    ),
    search,
    el("div", { class: "browse-layout" }, sidebar, list),
  );
  renderRows(query);
}

function renderEditNote(noteId) {
  const note = state.col.notes.get(noteId);
  if (!note) return renderBrowse(state.browseQuery ?? "");
  const model = state.col.noteType(note.mid);

  const inputs = model.flds.map((f) => ({ f, ed: richEditor(note.fields[f.ord] ?? "") }));
  const tagsInput = el("input", { type: "text", value: (note.tags ?? []).join(" ") });

  const save = async () => {
    note.fields = inputs.map(({ ed }) => ed.getHTML());
    note.tags = tagsInput.value.split(/\s+/).filter(Boolean);
    note.mod = Math.floor(Date.now() / 1000);
    note.normalize(model.sortf ?? 0);
    await putNote(state.db, note);
    // Card generation on edit (Anki): create any cards the new field values
    // now require (e.g. filling "Add Reverse", or a new cloze number).
    const have = new Set(state.col.cardsForNote(note.id).map((c) => c.ord));
    const homeDid = state.col.cardsForNote(note.id)[0]?.did ?? 1;
    let made = 0;
    for (const ord of cardOrdinalsForNote(model, note)) {
      if (have.has(ord)) continue;
      const due = state.col.conf.nextPos ?? 1;
      state.col.conf.nextPos = due + 1;
      await putCard(state.db, state.col.addCard(new Card({ nid: note.id, did: homeDid, ord, due })));
      made++;
    }
    if (made) await putMeta(state.db, state.col);
    setStatus(made ? `Saved (+${made} card${made > 1 ? "s" : ""}).` : "Saved.");
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
      ...inputs.map(({ f, ed }) => el("label", {}, f.name, ed.el)),
      el("label", {}, "Tags", tagsInput),
      el("div", { class: "row" },
        el("button", { onclick: save }, "Save"),
        el("button", { class: "danger", onclick: del }, "Delete"),
      ),
      el("h3", {}, "Card actions"),
      noteActions(note, () => renderEditNote(noteId)),
    ),
  );
}

// --- deck options ---

function renderDeckOptions(deckId) {
  state.card = null;
  const deck = state.col.decks[String(deckId)];
  const dcId = deck && deck.conf != null ? String(deck.conf) : "1";
  const dc = state.col.dconf[dcId] ?? state.col.dconf["1"];
  if (!dc) return renderDecks();
  const nu = dc.new ?? (dc.new = {});
  const rev = dc.rev ?? (dc.rev = {});
  const lapse = dc.lapse ?? (dc.lapse = {});

  const num = (v, step) => { const i = el("input", { type: "number", value: String(v ?? "") }); if (step) i.step = step; return i; };
  const txt = (v) => el("input", { type: "text", value: v });
  const check = (v) => { const c = el("input", { type: "checkbox" }); c.checked = !!v; return c; };
  const parseSteps = (s) => s.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);

  const ints = nu.ints ?? [1, 4, 7];
  const newSteps = txt((nu.delays ?? [1, 10]).join(" "));
  const newPerDay = num(nu.perDay ?? 20);
  const gradGood = num(ints[0] ?? 1);
  const gradEasy = num(ints[1] ?? 4);
  const startEase = num((nu.initialFactor ?? 2500) / 1000, "0.01");
  const newBury = check(nu.bury ?? true);

  const revPerDay = num(rev.perDay ?? 200);
  const newIgnoreRev = check(nu.ignoreReviewLimit ?? false);
  const autoplayChk = check(dc.autoplay ?? true);
  const maxIvl = num(rev.maxIvl ?? 36500);
  const easyBonus = num(rev.ease4 ?? 1.3, "0.05");
  const ivlMod = num(rev.ivlFct ?? 1.0, "0.05");
  const hardFactor = num(rev.hardFactor ?? 1.2, "0.05");
  const revBury = check(rev.bury ?? true);

  const lapseSteps = txt((lapse.delays ?? [10]).join(" "));
  const leechFails = num(lapse.leechFails ?? 8);
  const minInt = num(lapse.minInt ?? 1);
  const newIvlPct = num(Math.round((lapse.mult ?? 0) * 100));
  const leechAction = el("select", {}, el("option", { value: 0 }, "Suspend"), el("option", { value: 1 }, "Tag only"));
  leechAction.value = String(lapse.leechAction ?? 0);

  const fsrsOn = check(state.col.conf.fsrs === true);
  const retention = num(dc.desiredRetention ?? state.col.conf.desiredRetention ?? 0.9, "0.01");
  const fsrsParams = txt((dc.fsrsParams6 ?? []).join(", "));

  const newOrder = el("select", {}, el("option", { value: 1 }, "Sequential (oldest first)"), el("option", { value: 0 }, "Random"));
  newOrder.value = String(nu.order ?? 1);
  const rolloverHour = num(state.col.conf.rollover ?? 4);
  const newSpreadSel = el("select", {},
    el("option", { value: 0 }, "Mix with reviews"),
    el("option", { value: 1 }, "After reviews"),
    el("option", { value: 2 }, "Before reviews"));
  newSpreadSel.value = String(state.col.conf.newSpread ?? 0);
  const learnAhead = num(Math.round((state.col.conf.collapseTime ?? 1200) / 60));

  // What these settings actually do, shown live (no imagining required).
  const consequences = el("div", { class: "consequences muted" });
  const updateConsequences = () => {
    const fmtM = (mins) => (mins < 60 ? `${Math.round(mins)}m` : mins < 1440 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h` : `${Math.round(mins / 1440)}d`);
    const steps = parseSteps(newSteps.value);
    const ease = Number(startEase.value) || 2.5;
    const mod = Number(ivlMod.value) || 1;
    const ivl = 10; // a sample 10-day review card
    const hard = Math.max(1, Math.round(ivl * (Number(hardFactor.value) || 1.2) * mod));
    const good = Math.max(hard + 1, Math.round(ivl * ease * mod));
    const easy = Math.max(good + 1, Math.round(ivl * ease * (Number(easyBonus.value) || 1.3) * mod));
    const relearn = parseSteps(lapseSteps.value);
    const lapseIvl = Math.max(Number(minInt.value) || 1, Math.round(ivl * ((Number(newIvlPct.value) || 0) / 100)));
    consequences.replaceChildren(
      el("div", {}, `New card: ${steps.length ? steps.map(fmtM).join(" → ") : "no steps"} → graduates at ${Number(gradGood.value) || 1}d (Easy: ${Number(gradEasy.value) || 4}d).`),
      el("div", {}, `A 10-day review: Hard ${hard}d · Good ${good}d · Easy ${easy}d · Again → ${relearn.length ? relearn.map(fmtM).join(" → ") + " then" : ""} ${lapseIvl}d.`),
      state.col.conf.fsrs ? el("div", {}, "FSRS is on: review intervals above are replaced by the memory model; steps and limits still apply.") : "",
    );
  };
  const scheduleConsequences = debounced(updateConsequences, 120);
  for (const inp of [newSteps, gradGood, gradEasy, startEase, hardFactor, easyBonus, ivlMod, lapseSteps, newIvlPct, minInt]) {
    inp.addEventListener("input", scheduleConsequences);
  }
  updateConsequences();

  const save = async () => {
    nu.delays = parseSteps(newSteps.value);
    nu.perDay = Number(newPerDay.value) || 0;
    nu.ints = [Number(gradGood.value) || 1, Number(gradEasy.value) || 4, ints[2] ?? 7];
    nu.initialFactor = Math.round((Number(startEase.value) || 2.5) * 1000);
    nu.bury = newBury.checked;
    rev.perDay = Number(revPerDay.value) || 0;
    nu.ignoreReviewLimit = newIgnoreRev.checked;
    dc.autoplay = autoplayChk.checked;
    rev.maxIvl = Number(maxIvl.value) || 36500;
    rev.ease4 = Number(easyBonus.value) || 1.3;
    rev.ivlFct = Number(ivlMod.value) || 1;
    rev.hardFactor = Number(hardFactor.value) || 1.2;
    rev.bury = revBury.checked;
    lapse.delays = parseSteps(lapseSteps.value);
    lapse.leechFails = Number(leechFails.value) || 8;
    lapse.minInt = Number(minInt.value) || 1;
    lapse.mult = (Number(newIvlPct.value) || 0) / 100;
    lapse.leechAction = Number(leechAction.value) || 0;
    nu.order = Number(newOrder.value) === 0 ? 0 : 1;
    state.col.conf.rollover = Math.min(Math.max(Math.trunc(Number(rolloverHour.value) || 0), 0), 23);
    state.col.conf.newSpread = Number(newSpreadSel.value) || 0;
    state.col.conf.collapseTime = Math.max(0, Math.trunc((Number(learnAhead.value) || 0) * 60));
    state.col.conf.fsrs = fsrsOn.checked;
    const r = Number(retention.value);
    if (Number.isFinite(r)) dc.desiredRetention = Math.min(Math.max(r, 0.7), 0.99);
    const ps = fsrsParams.value.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    if ([17, 19, 21].includes(ps.length)) dc.fsrsParams6 = ps;
    else if (ps.length === 0) delete dc.fsrsParams6;
    await putMeta(state.db, state.col);
    setStatus("Deck options saved.");
    renderDecks();
  };

  const field = (label, input) => el("label", {}, label, input);
  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, `Options — ${deck.name}`),
    el("div", { class: "form" },
      consequences,
      el("h3", {}, "New cards"),
      field("Learning steps (minutes)", newSteps),
      field("New cards/day", newPerDay),
      el("div", { class: "row" }, field("Graduating interval (days)", gradGood), field("Easy interval (days)", gradEasy)),
      field("Starting ease", startEase),
      field("Insertion order", newOrder),
      el("label", { class: "inline" }, newBury, "Bury new siblings"),
      el("h3", {}, "Reviews"),
      field("Maximum reviews/day", revPerDay),
      el("label", { class: "inline" }, newIgnoreRev, "New cards ignore review limit"),
      el("label", { class: "inline" }, autoplayChk, "Automatically play audio"),
      field("Maximum interval (days)", maxIvl),
      el("div", { class: "row" }, field("Easy bonus", easyBonus), field("Hard interval", hardFactor), field("Interval modifier", ivlMod)),
      el("label", { class: "inline" }, revBury, "Bury review siblings"),
      el("h3", {}, "Lapses"),
      field("Relearning steps (minutes)", lapseSteps),
      field("Leech threshold (lapses)", leechFails),
      field("Minimum interval (days)", minInt),
      field("New interval (% of old)", newIvlPct),
      field("Leech action", leechAction),
      el("h3", {}, "FSRS"),
      el("label", { class: "inline" }, fsrsOn, "Enable FSRS (whole collection)"),
      field("Desired retention (0.70–0.99)", retention),
      field("Parameters (17/19/21 numbers, comma-separated; blank = default)", fsrsParams),
      el("h3", {}, "Collection preferences"),
      field("Next day starts at (hour, 0–23)", rolloverHour),
      field("New/review order", newSpreadSel),
      field("Learn ahead limit (minutes)", learnAhead),
      el("p", { class: "muted" }, "Scheduling options apply to every deck sharing this options group; collection preferences apply everywhere."),
      el("div", { class: "row" }, el("button", { onclick: save }, "Save")),
    ),
  );
}

// --- card operations (shared) ---

async function applyToNoteCards(note, fn, { meta = false } = {}) {
  const sched = new Scheduler(state.col);
  const cards = state.col.cardsForNote(note.id);
  for (const c of cards) fn(sched, c);
  for (const c of cards) await putCard(state.db, c);
  if (meta) await putMeta(state.db, state.col);
}

/** Anki's seven card flags (index = flag number; 0 = none). */
const FLAG_NAMES = ["No flag", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];
const flagOptions = () => FLAG_NAMES.map((l, i) => el("option", { value: i }, i ? `⚑ ${l}` : l));

/** A row of note-level operations (applied to all the note's cards). */
function noteActions(note, onDone) {
  const cards = state.col.cardsForNote(note.id);
  const anySusp = cards.some((c) => c.queue === CardQueue.Suspended);
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const flagSel = el("select", {}, ...flagOptions());
  flagSel.value = String((cards[0]?.flags ?? 0) & 7);
  const moveSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  moveSel.value = String(cards[0]?.did ?? 1);
  const act = async (fn, meta) => { await applyToNoteCards(note, fn, { meta }); onDone(); };

  return el("div", { class: "note-actions" },
    el("button", { onclick: () => act((s, c) => (anySusp ? s.unsuspend(c) : s.suspend(c))) }, anySusp ? "Unsuspend" : "Suspend"),
    el("button", { onclick: () => act((s, c) => s.buryCard(c)) }, "Bury"),
    el("button", { onclick: () => { if (confirm("Reset these cards to new?")) act((s, c) => s.forget(c), true); } }, "Forget"),
    el("button", { onclick: () => { const d = Number(prompt("Due in how many days?", "1")); if (Number.isFinite(d)) act((s, c) => s.setDueDate(c, d)); } }, "Set Due"),
    el("span", { class: "na-group" }, "Flag", flagSel, el("button", { onclick: () => act((s, c) => s.setFlag(c, Number(flagSel.value))) }, "Set")),
    el("span", { class: "na-group" }, "Move", moveSel, el("button", { onclick: () => act((s, c) => s.moveCard(c, Number(moveSel.value))) }, "Go")),
  );
}

/** A compact operations bar for the current card during review. */
function reviewMoreBar() {
  const card = state.card;
  const note = state.col.notes.get(card.nid);
  const act = async (fn, meta = false) => {
    const sched = new Scheduler(state.col);
    fn(sched, card);
    await putCard(state.db, card);
    if (meta) await putMeta(state.db, state.col);
    renderStudy();
  };
  const flagSel = el("select", { class: "flag-sel", title: "Flag" }, ...flagOptions());
  flagSel.value = String(card.flags & 7);
  flagSel.addEventListener("change", () => act((s, c) => s.setFlag(c, Number(flagSel.value))));
  return el("div", { class: "more-bar" },
    el("button", { class: "icon", onclick: () => renderEditNote(note.id) }, "✎ Edit"),
    el("button", { class: "icon", onclick: () => act((s, c) => s.buryCard(c)) }, "Bury"),
    el("button", { class: "icon", onclick: () => act((s, c) => s.suspend(c)) }, "Suspend"),
    el("button", { class: "icon", onclick: () => { if (confirm("Reset to new?")) act((s, c) => s.forget(c), true); } }, "Forget"),
    el("button", { class: "icon", onclick: () => { const d = Number(prompt("Due in days?", "1")); if (Number.isFinite(d)) act((s, c) => s.setDueDate(c, d)); } }, "Set Due"),
    flagSel,
  );
}

// --- image occlusion ---

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const normRect = (a, b) => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
});
const setRect = (rect, m) => {
  rect.setAttribute("x", m.x * 100); rect.setAttribute("y", m.y * 100);
  rect.setAttribute("width", m.w * 100); rect.setAttribute("height", m.h * 100);
};

// mode: "edit" (all masks shown), "q" (cover only the active), "a" (outline active).
function svgOverlay(masks, activeIdx, mode) {
  const svg = svgEl("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none", class: "io-svg" });
  masks.forEach((m, i) => {
    if (mode === "q" && i !== activeIdx) return;
    if (mode === "a" && i !== activeIdx) return;
    const rect = svgEl("rect", {
      class: mode === "a" ? "io-mask-active" : mode === "q" ? "io-mask-q" : "io-mask-edit",
    });
    setRect(rect, m);
    svg.append(rect);
  });
  return svg;
}

function attachDrawing(svg, onCommit) {
  let start = null;
  let preview = null;
  const toFrac = (e) => {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  svg.addEventListener("pointerdown", (e) => {
    start = toFrac(e);
    preview = svgEl("rect", { class: "io-mask-edit" });
    svg.append(preview);
    try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  svg.addEventListener("pointermove", (e) => { if (start) setRect(preview, normRect(start, toFrac(e))); });
  svg.addEventListener("pointerup", (e) => {
    if (!start) return;
    const r = normRect(start, toFrac(e));
    if (preview) preview.remove();
    if (r.w > 0.01 && r.h > 0.01) onCommit(r);
    start = null;
    preview = null;
  });
}

async function renderImageOcclusion() {
  state.card = null;
  let nt = Object.values(state.col.models).find((m) => m.ossIO);
  if (!nt) {
    nt = imageOcclusionNoteType(state.col.nextId());
    state.col.models[String(nt.id)] = nt;
    await persistAll();
  }
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  const headerInput = el("input", { type: "text", placeholder: "Header (optional)" });
  const backInput = el("textarea", { placeholder: "Back extra (optional)" });
  const fileInput = el("input", { type: "file", accept: "image/*" });
  const stage = el("div", { class: "io-stage" });
  const maskList = el("div", { class: "io-masklist" });

  let imageName = null;
  const masks = [];

  const refresh = () => {
    maskList.replaceChildren(...masks.map((m, i) =>
      el("button", { class: "io-maskchip", onclick: () => { masks.splice(i, 1); refresh(); } }, `Mask ${i + 1} ✕`)));
    stage.replaceChildren();
    if (!imageName) {
      stage.append(el("p", { class: "muted" }, "Choose an image, then drag on it to draw masks."));
      return;
    }
    stage.append(el("img", { src: mediaUrl(imageName) }));
    const svg = svgOverlay(masks, -1, "edit");
    stage.append(svg);
    attachDrawing(svg, (r) => { masks.push(r); refresh(); });
  };

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const ext = (f.name.split(".").pop() || "png").toLowerCase();
    imageName = `io-${state.col.nextId()}.${ext}`;
    const bytes = new Uint8Array(await f.arrayBuffer());
    state.media.set(imageName, bytes);
    state.mediaUrls.delete(imageName);
    await saveMedia(state.db, new Map([[imageName, bytes]]));
    masks.length = 0;
    refresh();
  });

  const create = async () => {
    if (!imageName) { setStatus("Choose an image first."); return; }
    if (!masks.length) { setStatus("Draw at least one mask."); return; }
    const note = new Note({
      mid: nt.id, fields: [imageName, JSON.stringify(masks), headerInput.value, backInput.value],
    }).normalize(nt.sortf ?? 2);
    state.col.addNote(note);
    masks.forEach((_, i) => {
      const due = state.col.conf.nextPos ?? 1;
      state.col.conf.nextPos = due + 1;
      state.col.addCard(new Card({ nid: note.id, did: Number(deckSel.value), ord: i, due }));
    });
    await putNoteAndMeta(note);
    for (const c of state.col.cardsForNote(note.id)) await putCard(state.db, c);
    setStatus(`Created ${masks.length} occlusion cards.`);
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderAddCard }, "← Add"),
    el("h2", {}, "Image Occlusion"),
    el("div", { class: "form" },
      el("label", {}, "Deck", deckSel),
      el("label", {}, "Image", fileInput),
      stage,
      maskList,
      el("label", {}, "Header", headerInput),
      el("label", {}, "Back extra", backInput),
      el("div", { class: "row" }, el("button", { onclick: create }, "Create cards")),
    ),
  );
  refresh();
}

/** Render an image-occlusion card face (hide-one-guess-one). */
function occlusionFace(note, ord, side) {
  const image = note.fields[0];
  let masks = [];
  try { masks = JSON.parse(note.fields[1] || "[]"); } catch { /* ignore */ }
  const header = note.fields[2] || "";
  const back = note.fields[3] || "";
  const stage = el("div", { class: "io-stage" },
    el("img", { src: mediaUrl(image) }),
    svgOverlay(masks, ord, side === "q" ? "q" : "a"));
  const parts = [];
  if (header) parts.push(el("div", { class: "io-header" }, header));
  parts.push(stage);
  if (side === "a" && back) parts.push(el("div", { class: "io-back", html: displayHtml(back) }));
  return el("div", { class: "card-face" }, ...parts);
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

  const STOCK = [basicNoteType, basicReversedNoteType, basicOptionalReversedNoteType, basicTypeNoteType, clozeNoteType];
  const missing = STOCK.filter((f) => !models.some((m) => m.name === f(0).name));
  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "decks-head" }, el("h2", {}, "Note Types"), add),
    missing.length
      ? el("div", { class: "row stock-row" }, "Add stock type:", ...missing.map((f) =>
          el("button", { onclick: async () => { state.col.addStockNoteType(f); await persistAll(); renderNoteTypes(); } }, f(0).name)))
      : "",
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

  // Live preview: render a real note of this type (or field-name placeholders)
  // through the templates as they are edited — including the CSS box.
  const previewBox = el("div", { class: "preview-box" });
  const updatePreview = () => {
    const tmpNt = {
      ...nt,
      css: cssArea.value,
      tmpls: tmplInputs.map(({ ord, name, qfmt, afmt }) =>
        ({ ...nt.tmpls[ord], name: name.value, qfmt: qfmt.value, afmt: afmt.value })),
    };
    const sample = state.col.notesOfType(mid)[0]
      ?? new Note({ mid, fields: nt.flds.map((f) => f.name === "Text" && isCloze ? "A {{c1::sample}} cloze" : `(${f.name})`) });
    applyModelCss(tmpNt);
    const parts = [el("h3", {}, "Live preview")];
    for (const t of (isCloze ? [tmpNt.tmpls[0]] : tmpNt.tmpls)) {
      if (!t) continue;
      try {
        const { question, answer } = renderCard(tmpNt, isCloze ? 0 : t.ord, sample, { deckName: "Deck" });
        parts.push(
          el("div", { class: "muted pv-count" }, t.name),
          el("div", { class: "pv-pair" },
            el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(question) })),
            el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(answer) })),
          ),
        );
      } catch { /* a template can be transiently invalid mid-edit */ }
    }
    previewBox.replaceChildren(...parts);
    typesetMath();
  };
  const schedulePreview = debounced(updatePreview);
  tmplBox.addEventListener("input", schedulePreview);
  cssArea.addEventListener("input", schedulePreview);

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
      previewBox,
    ),
  );
  updatePreview();
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
  const today = new Scheduler(state.col).daysElapsed;
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
    el("h3", {}, "Answer buttons"),
    el("div", { class: "ab-row" },
      ...Object.entries(s.answerButtons).map(([k, v]) => {
        const total = Object.values(s.answerButtons).reduce((a, b) => a + b, 0) || 1;
        return el("div", { class: `stat ${k === "again" ? "suspended" : ""}` },
          el("div", { class: "stat-n" }, v),
          el("div", { class: "stat-l" }, `${k} · ${Math.round((v / total) * 100)}%`));
      })),
    el("h3", {}, "Review intervals (weeks)"),
    barChart(s.intervalHistogram, "var(--good)"),
  );
  setStatus("");
}

// --- import / export (.apkg) ---

async function loadSql() {
  const initSqlJs = (await import("sql.js")).default;
  return initSqlJs({ locateFile: (f) => SQL_CDN + f });
}

async function doBackup() {
  const { collectionToBackup } = await import("../src/backup.js");
  const data = JSON.stringify(collectionToBackup(state.col, state.media));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = `oss-anki-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Backup downloaded.");
}

async function doRestore(file) {
  try {
    const { collectionFromBackup } = await import("../src/backup.js");
    const { collection, media } = collectionFromBackup(JSON.parse(await file.text()));
    if (!confirm(`Restore this backup (${collection.cards.size} cards, ${media.size} media files)?\n\nThis REPLACES your current collection.`)) return;
    sanitizeCurModel(collection);
    state.col = collection;
    state.media = media;
    state.mediaUrls.clear();
    await clearAll(state.db);
    await saveCollection(state.db, collection);
    await saveMedia(state.db, media);
    setStatus(`Restored ${collection.cards.size} cards.`);
    renderDecks();
  } catch (e) {
    setStatus(`Restore failed: ${e.message}`);
    console.error(e);
  }
}

async function doImport(file) {
  if (file.name.toLowerCase().endsWith(".json")) return doRestore(file);
  // Always merge into the current collection: imported decks are added as new
  // decks (matched by name), notes dedup/update by GUID. Existing cards'
  // scheduling is never touched.
  setStatus("Importing…");
  try {
    const { importPackage } = await import("../src/apkg.js");
    const { mergeCollection } = await import("../src/merge.js");
    const SQL = await loadSql();
    const buf = new Uint8Array(await file.arrayBuffer());
    const { collection, media } = importPackage(buf, { SQL });

    const r = mergeCollection(state.col, collection);
    for (const [name, bytes] of media) state.media.set(name, bytes);
    state.mediaUrls.clear();
    sanitizeCurModel(state.col);
    await saveCollection(state.db, state.col);
    await saveMedia(state.db, media);
    setStatus(`Imported: ${r.added} notes added, ${r.updated} updated.`);
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
  document.getElementById("btn-backup").addEventListener("click", doBackup);
}

// Anki-style shortcuts: space/Enter flips; 1–4 (and space/Enter) grade.
function wireKeyboard() {
  const GRADE = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy, " ": Rating.Good, Enter: Rating.Good };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      const t = e.target;
      if (t && (t.isContentEditable || t.matches?.("input, textarea, select"))) return; // let the field undo
      e.preventDefault(); doUndo(); return;
    }
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
  sanitizeCurModel(state.col); // a stale curModel (e.g. from an import) would break Add Card
  // New-day maintenance: un-bury yesterday's buried siblings, then persist.
  if (new Scheduler(state.col).unburyForNewDay() > 0) {
    await saveCollection(state.db, state.col);
  } else {
    await putMeta(state.db, state.col);
  }
  wireHeader();
  wireKeyboard();
  renderDecks();
}

init().catch((e) => {
  setStatus(`Error: ${e.message}`);
  console.error(e);
});
