// Memki browser app: local-first study UI over the Memki core library.
// Fully offline: .apkg import/export lazily loads vendored sql.js + fflate +
// fzstd builds from ../vendor/ (see the import map in index.html).

import {
  Collection, Note, Card, NoteTypeKind, CardType, CardQueue, RevlogType, imageOcclusionNoteType,
  basicNoteType, basicReversedNoteType, basicOptionalReversedNoteType, basicTypeNoteType, clozeNoteType,
  cardFlagSet, writeCardFlags, parseNoteData,
} from "../src/model.js";
import { Scheduler } from "../src/scheduler.js";
import { renderCard, cardOrdinalsForNote } from "../src/template.js";
import { mathify } from "../src/mathify.js";
import { mdToHtml, mdImageToken, mdSoundToken, scanMdMedia } from "../src/markdown.js";
import { collectionStats } from "../src/stats.js";
import { compileSearch, searchContext } from "../src/search.js";
import { parseCsv } from "../src/csv.js";
import { Rating } from "../src/fsrs.js";
import { stripHtml, stripHtmlPreservingMediaFilenames } from "../src/text.js";
import {
  openCollectionDB, loadCollection, saveCollection,
  putCard, putNote, putRevlog, putMeta, saveMedia, loadMedia, loadMediaNames, clearAll, deleteCards, deleteNoteAndCards, deleteRevlog,
  pushNoteHistory, listNoteHistory, deleteNoteHistory,
  isNative, hasSaveFile, bridgePath, flushStore, storeStamp, storeDirty,
} from "./storage.js";

const SQL_CDN = new URL("../vendor/sqljs/", import.meta.url).href;

// Scroll is the user's alone: focusing an element (programmatically — modal
// inputs, editor caret restores, MathJax's menus, anything) must never move
// the page. Native tap-to-focus doesn't go through .focus() and still works.
// (Selection/caret moves can also scroll; the markdown editor pins those
// with keepScroll.)
const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (opts) {
  nativeFocus.call(this, { preventScroll: true, ...opts });
};

const state = {
  db: null,
  col: null,
  media: new Map(), // cache: complete on IndexedDB, lazily filled on file-backed stores
  mediaUrls: new Map(),
  deckId: null,
  card: null,
  answerShown: false,
};

const view = () => document.getElementById("view");
// Status messages are disabled — kept as a no-op so the many call sites
// stay as-is (errors still go to the console via console.error).
const setStatus = (_msg) => {};

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

/** Run fn() without letting it change any scroll position. Focusing a
 *  contenteditable and moving its caret make the browser scroll the element
 *  or caret into view — which yanks the page (or the browse pane, its own
 *  scroller) around on undo/toolbar actions. This pins the window and every
 *  ancestor scroller for the duration, re-asserting once more on the next
 *  frame in case the browser applied a scroll asynchronously. */
function keepScroll(el, fn) {
  const pinned = [];
  for (let n = el; n; n = n.parentElement) pinned.push([n, n.scrollTop, n.scrollLeft]);
  const wx = window.scrollX, wy = window.scrollY;
  const restore = () => {
    for (const [n, t, l] of pinned) { n.scrollTop = t; n.scrollLeft = l; }
    window.scrollTo(wx, wy);
  };
  fn();
  restore();
  requestAnimationFrame(restore);
}

// Highlight the header button of the current view (null clears all).
function setActiveNav(id) {
  document.querySelectorAll(".actions button").forEach((b) =>
    b.classList.toggle("active", b.id === id));
}

function debounced(fn, ms = 180) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// --- Add-card draft: small IndexedDB scratch store, deliberately NOT part of
// the collection (no note, no deck, nothing visible in Browse). It only
// remembers the in-progress Add Card form so an accidental Back (or a crash,
// or closing the tab) doesn't lose work. Cleared on Save.
let _draftDbP = null;
function draftDb() {
  return (_draftDbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("memki-ui", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
async function draftGet(key) {
  const db = await draftDb();
  return new Promise((resolve, reject) => {
    const rq = db.transaction("kv").objectStore("kv").get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function draftWrite(key, value) { // value === undefined deletes
  const db = await draftDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    if (value === undefined) tx.objectStore("kv").delete(key);
    else tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- minimal inline SVG icons (no emoji; stroke/fill follow currentColor) ---

const ICONS = {
  pencil: '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" class="fill"><path d="M13 2 3 14h7l-1 8 11-13h-7l1-7z"/></svg>',
  eject: '<svg viewBox="0 0 24 24"><path d="M5 14l7-8 7 8H5z"/><path d="M5 18h14"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  flag: '<svg viewBox="0 0 24 24" class="fill"><path d="M5 2h2v20H5z"/><path d="M7 3h13l-3 4.5L20 12H7z"/></svg>',
  funnel: '<svg viewBox="0 0 24 24"><path d="M22 3H2l8 9.5V21l4-2v-6.5z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  "align-left": '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg>',
  "align-center": '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M5.5 18h13"/></svg>',
  "align-right": '<svg viewBox="0 0 24 24"><path d="M4 6h16M10 12h10M7 18h13"/></svg>',
};

/** A minimal inline SVG icon. */
function icon(name) {
  return el("span", { class: "ic", html: ICONS[name] ?? "" });
}

/**
 * A centered modal on top of everything. Closes on backdrop click or Escape.
 * @returns {{ close: () => void, panel: HTMLElement }}
 */
function openModal(children, { onClose } = {}) {
  const overlay = el("div", { class: "modal-overlay" });
  const panel = el("div", { class: "modal-panel" }, ...children);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  overlay.append(panel);
  document.body.append(overlay);
  return { close, panel };
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

// --- markdown field editor ---
//
// Fields are markdown source. The editing surface is plain text (monospace,
// syntax visible) in a plaintext-only contenteditable, EXCEPT media tokens,
// which render inline as atomic widgets:
//   ![](name){width=N} → the image — click to select, drag the corner handle
//                        to resize (writes {width=N} into the token),
//                        double-click to restore natural size
//   [sound:name]       → an inline audio/video player (volume persists)
// Widgets are contenteditable=false spans whose dataset.token holds their
// source text; serialization swaps them back, so getText() always returns
// markdown source. Tokens whose media isn't in the store stay plain text.
//
// Undo/redo is our own snapshot stack (native contenteditable undo is
// unreliable across the programmatic widget re-renders): Ctrl+Z /
// Ctrl+Shift+Z / Ctrl+Y, or the ↶ ↷ toolbar buttons. For longer time travel
// there's the note-level Edit History modal.

function tbBtn(label, title, onClick) {
  const b = el("button", { type: "button", class: "md-tb", title, onclick: (e) => { e.preventDefault(); onClick(); } }, label);
  // Don't let the button take focus — the field selection must survive so
  // formatting actions apply to it.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
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

/** A markdown source editor over a field. Returns { el, getText, setText, focus }.
 *  opts.afterHistory: extra toolbar control(s) placed right after undo/redo. */
function mdEditor(initial = "", { afterHistory = null } = {}) {
  const area = el("div", { class: "md", contenteditable: "plaintext-only" });
  // Engines without plaintext-only support fall back to a plain contenteditable
  // plus Enter/paste interception that keeps the content text-only.
  const plainOnly = area.contentEditable === "plaintext-only";
  if (!plainOnly) area.contentEditable = "true";

  // --- source ⇄ DOM ---

  /** An atomic widget for a media token, or null to leave it as plain text. */
  const widgetFor = (tok) => {
    const url = mediaUrl(tok.name);
    if (!url) {
      // File-backed stores load media lazily — fetch it, then re-tokenize
      // so the plain text becomes a widget once the bytes arrive.
      ensureMedia([tok.name]).then(scheduleRetokenize);
      return null;
    }
    let inner;
    if (tok.kind === "img") {
      inner = el("img", { src: url, alt: tok.raw });
      if (tok.width) inner.setAttribute("width", String(tok.width));
    } else {
      const isVideo = /\.(mp4|webm|mov)$/i.test(tok.name);
      inner = el(isVideo ? "video" : "audio", { controls: "", preload: "metadata", src: url, class: "av" });
      inner.dataset.name = encodeURIComponent(tok.name);
    }
    const w = el("span", { class: `md-w md-w-${tok.kind}`, contenteditable: "false" }, inner);
    w.dataset.token = tok.raw;
    return w;
  };

  /** Rebuild the area's DOM from markdown source. */
  const render = (source) => {
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const tok of scanMdMedia(source)) {
      const w = widgetFor(tok);
      if (!w) continue;
      frag.append(document.createTextNode(source.slice(pos, tok.start)), w);
      pos = tok.start + tok.raw.length;
    }
    frag.append(document.createTextNode(source.slice(pos)));
    area.replaceChildren(frag);
    wireSoundVolumes(area);
  };

  /** Source length of a DOM node (widgets count as their token text). */
  const measure = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data.length;
    if (node.dataset?.token != null) return node.dataset.token.length;
    if (node.tagName === "BR") return 1;
    let n = 0;
    for (const ch of node.childNodes) n += measure(ch);
    return n;
  };

  /** The field's markdown source: text with widgets swapped back to tokens. */
  const serialize = () => {
    let out = "";
    const walk = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === Node.TEXT_NODE) out += ch.data;
        else if (ch.dataset?.token != null) out += ch.dataset.token;
        else if (ch.tagName === "BR") out += "\n";
        else walk(ch);
      }
    };
    walk(area);
    return out;
  };

  /** Source offset of a DOM (container, offset) position within the area. */
  const offsetAt = (container, offset) => {
    const walk = (node) => {
      if (node === container) {
        if (node.nodeType === Node.TEXT_NODE) return offset;
        let n = 0;
        for (let i = 0; i < offset && i < node.childNodes.length; i++) n += measure(node.childNodes[i]);
        return n;
      }
      let acc = 0;
      for (const ch of node.childNodes) {
        if (ch.dataset?.token != null) { acc += measure(ch); continue; } // atomic
        if (ch === container || (ch.nodeType === Node.ELEMENT_NODE && ch.contains(container))) {
          return acc + walk(ch);
        }
        acc += measure(ch);
      }
      return acc;
    };
    return walk(area);
  };

  /** Current selection as [start, end] source offsets, or null if outside. */
  const selOffsets = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!area.contains(r.startContainer) || !area.contains(r.endContainer)) return null;
    return [offsetAt(r.startContainer, r.startOffset), offsetAt(r.endContainer, r.endOffset)];
  };

  /** DOM position for a source offset (clamped; widgets are skipped over). */
  const positionAt = (off) => {
    let acc = 0, found = null;
    const walk = (node) => {
      for (const ch of node.childNodes) {
        const len = measure(ch);
        if (!found && off <= acc + len) {
          if (ch.nodeType === Node.TEXT_NODE) { found = { node: ch, off: Math.max(0, off - acc) }; return; }
          if (ch.dataset?.token == null && ch.tagName !== "BR") { walk(ch); if (found) return; }
        }
        acc += len;
      }
    };
    walk(area);
    if (found) found.off = Math.min(found.off, found.node.data.length);
    return found;
  };

  /** Select the source range [s, e] in the DOM (collapsed caret when s = e). */
  const setDomSelection = (s, e = s) => {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    const ps = positionAt(s);
    const pe = positionAt(e);
    if (ps) r.setStart(ps.node, ps.off);
    else { r.selectNodeContents(area); r.collapse(false); }
    if (pe) r.setEnd(pe.node, pe.off);
    sel.addRange(r);
  };

  /** Place the caret at a source offset. */
  const restoreCaret = (off) => setDomSelection(off, off);

  // --- undo/redo: our own history (native contenteditable undo is unreliable
  // across the programmatic widget re-renders). Snapshots are { src, caret };
  // typing is coalesced with a short debounce, while toolbar/media actions
  // commit immediately before and after, so each action is one undo step. ---

  const hist = { stack: [{ src: initial, caret: initial.length }], i: 0 };
  const HIST_MAX = 200;

  function updateUndoButtons() {
    undoBtn.disabled = hist.i <= 0;
    redoBtn.disabled = hist.i >= hist.stack.length - 1;
  }

  /** Push the current state if it differs from the top; drops the redo tail. */
  const commitHistory = () => {
    const src = serialize();
    if (src === hist.stack[hist.i].src) return;
    hist.stack.length = hist.i + 1;
    hist.stack.push({ src, caret: selOffsets()?.[0] ?? src.length });
    if (hist.stack.length > HIST_MAX) hist.stack.shift();
    hist.i = hist.stack.length - 1;
    updateUndoButtons();
  };
  const scheduleCommit = debounced(commitHistory, 400);

  const jumpHistory = (d) => {
    commitHistory(); // capture in-progress typing before leaving this state
    const j = hist.i + d;
    if (j < 0 || j >= hist.stack.length) return;
    hist.i = j;
    const { src, caret } = hist.stack[j];
    render(src);
    keepScroll(area, () => {
      area.focus();
      restoreCaret(Math.min(caret, src.length));
    });
    area.dispatchEvent(new Event("input", { bubbles: true })); // autosave/preview
    updateUndoButtons();
  };

  /** Re-render from a new source; restores the caret and notifies listeners. */
  const setSource = (src, caret = null, { record = true } = {}) => {
    if (record) commitHistory(); // flush the pre-action state (incl. pending typing)
    render(src);
    if (caret != null) {
      keepScroll(area, () => {
        area.focus();
        restoreCaret(caret);
      });
    }
    if (record) commitHistory(); // and the post-action state as its own step
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const insertAtCaret = (text) => {
    const src = serialize();
    const [s] = selOffsets() ?? [src.length];
    setSource(src.slice(0, s) + text + src.slice(s), s + text.length);
  };

  // --- retokenization: completed media tokens become widgets while typing ---

  const retokenize = () => {
    const src = serialize();
    const cur = [...area.querySelectorAll(".md-w")].map((w) => w.dataset.token);
    const want = scanMdMedia(src).filter((t) => state.media.has(t.name)).map((t) => t.raw);
    if (cur.join("\x1f") === want.join("\x1f")) return; // token set unchanged
    const sel = selOffsets();
    render(src);
    if (sel) keepScroll(area, () => restoreCaret(sel[0]));
  };
  const scheduleRetokenize = debounced(retokenize, 250);
  area.addEventListener("input", (e) => {
    if (!isMediaEvent(e)) { scheduleRetokenize(); scheduleCommit(); }
    if (sizingImg) positionHandle();
  });

  // --- formatting actions (operate on the source string) ---

  /** Wrap the selection as pre + selection + post. Stateless: with no
   * selection the buttons do nothing (no "bold mode" for future typing). */
  const surround = (pre, post = pre) => {
    const src = serialize();
    const sel = selOffsets();
    if (!sel || sel[0] === sel[1]) {
      setStatus("Select text first — formatting buttons apply to the selection.");
      return;
    }
    const [s, e] = sel;
    const inner = src.slice(s, e);
    setSource(src.slice(0, s) + pre + inner + post + src.slice(e));
    keepScroll(area, () => {
      area.focus();
      setDomSelection(s, e + pre.length + post.length); // show what was wrapped
    });
  };

  const linePrefix = (mk) => {
    const src = serialize();
    const [s, e] = selOffsets() ?? [src.length, src.length];
    const ls = src.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
    const nl = src.indexOf("\n", e);
    const le = nl === -1 ? src.length : nl;
    const out = src.slice(ls, le).split("\n").map((l, i) => mk(i) + l).join("\n");
    setSource(src.slice(0, ls) + out + src.slice(le), ls + out.length);
  };

  const wrapCloze = () => {
    const src = serialize();
    let max = 0, m;
    const re = /\{\{c(\d+)::/g;
    while ((m = re.exec(src))) max = Math.max(max, Number(m[1]));
    surround(`{{c${max + 1}::`, "}}");
  };

  const insertLink = () => {
    const src = serialize();
    const sel = selOffsets();
    if (!sel || sel[0] === sel[1]) {
      setStatus("Select the link text first (a pasted URL links on its own).");
      return;
    }
    const [s, e] = sel;
    const text = src.slice(s, e);
    const url = prompt("Link URL:", "https://");
    if (!url) return;
    const next = `[${text}](${url})`;
    setSource(src.slice(0, s) + next + src.slice(e), s + next.length);
  };

  const insertMedia = async (file) => {
    const name = await storeMediaFile(file);
    insertAtCaret(file.type.startsWith("image/") ? mdImageToken(name) : mdSoundToken(name));
  };

  // --- keyboard, drag & drop, paste ---

  area.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); jumpHistory(-1); return; }
    if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      e.preventDefault();
      jumpHistory(1);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      wrapCloze();
      return;
    }
    if (!plainOnly && e.key === "Enter") { e.preventDefault(); insertAtCaret("\n"); }
  });

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
    if (files.length) {
      e.preventDefault();
      for (const f of files) await insertMedia(f);
      return;
    }
    if (!plainOnly) {
      const t = e.clipboardData?.getData("text/plain");
      if (t) { e.preventDefault(); insertAtCaret(t); }
    }
  });

  // --- toolbar ---

  const pickMedia = () => {
    const inp = el("input", { type: "file", accept: "image/*,audio/*,video/*" });
    inp.addEventListener("change", () => { if (inp.files[0]) insertMedia(inp.files[0]); });
    inp.click();
  };
  const undoBtn = tbBtn("↶", "Undo (Ctrl+Z)", () => jumpHistory(-1));
  const redoBtn = tbBtn("↷", "Redo (Ctrl+Shift+Z)", () => jumpHistory(1));
  const toolbar = el("div", { class: "md-toolbar" },
    undoBtn, redoBtn,
    ...(afterHistory ? [].concat(afterHistory) : []),
    tbBtn("B", "Bold selection: **text**", () => surround("**")),
    tbBtn("I", "Italic selection: *text*", () => surround("*")),
    tbBtn("S̶", "Strikethrough selection: ~~text~~", () => surround("~~")),
    tbBtn("`", "Code selection: `text`", () => surround("`")),
    tbBtn("•", "Bullet list", () => linePrefix(() => "- ")),
    tbBtn("1.", "Numbered list", () => linePrefix((i) => `${i + 1}. `)),
    tbBtn("link", "Link: [text](url)", insertLink),
    tbBtn("[…]", "Cloze selection (Ctrl+Shift+C)", wrapCloze),
    tbBtn(icon("image"), "Insert image/audio/video (or drag & drop / paste)", pickMedia),
  );
  const wrap = el("div", { class: "md-wrap" }, toolbar, area);

  // --- image sizing: click an image to select it, drag the corner handle to
  // resize (the width is written back into the token as {width=N}, so it
  // persists in the note and in exports), double-click to restore natural
  // size. Same interaction model as the old rich-text editor. ---
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
    if (!sizingImg || !sizingImg.isConnected) { hideHandle(); return; }
    const wrapR = wrap.getBoundingClientRect();
    const r = sizingImg.getBoundingClientRect();
    handle.style.left = `${r.right - wrapR.left - 8}px`;
    handle.style.top = `${r.bottom - wrapR.top - 8}px`;
    handle.style.display = "";
  };
  const tokenWithWidth = (token, width) =>
    token.replace(/\{width=\d+\}$/, "") + (width ? `{width=${width}}` : "");
  /** Write the selected image's width back into its widget's source token. */
  const commitWidth = (width) => {
    const w = sizingImg?.closest(".md-w");
    if (!w) return;
    w.dataset.token = tokenWithWidth(w.dataset.token, width);
    // The resize changed the field source — let autosave / preview know.
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };

  area.addEventListener("click", (e) => {
    if (e.target.tagName === "IMG" && e.target.closest(".md-w")) {
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
    if (e.target.tagName === "IMG" && e.target.closest(".md-w")) {
      sizingImg = e.target;
      e.target.removeAttribute("width");
      commitWidth(null);
      positionHandle();
    }
  });
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
      positionHandle();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commitWidth(Math.round(img.getBoundingClientRect().width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  render(initial);
  updateUndoButtons();

  return {
    el: wrap,
    getText: () => serialize(),
    setText: (t) => {
      hideHandle();
      render(t ?? "");
      hist.stack = [{ src: t ?? "", caret: (t ?? "").length }];
      hist.i = 0;
      updateUndoButtons();
    },
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

// --- lazy media loading ---
// state.media is a CACHE on file-backed stores (Android / desktop FS
// Access): media lives as individual files in oss-anki.media/ and is
// fetched by name on first use, so multi-GB collections never sit in
// memory. On IndexedDB browsers the cache holds everything (as before).

const mediaLoading = new Set(); // in-flight fetches, to dedup concurrent loads

/** Fetch media files into the cache by name (missing names are skipped). */
async function ensureMedia(names) {
  const missing = [...new Set(names)].filter((n) => n && !state.media.has(n) && !mediaLoading.has(n));
  if (!missing.length) return;
  missing.forEach((n) => mediaLoading.add(n));
  try {
    const loaded = await loadMediaNames(state.db, missing);
    for (const [n, b] of loaded) state.media.set(n, b);
  } finally {
    missing.forEach((n) => mediaLoading.delete(n));
  }
}

/** Media names referenced by rendered field HTML (<img src> + [sound:] tags). */
function mediaNamesInHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const names = [];
  for (const node of tpl.content.querySelectorAll("img, audio, video, source")) {
    const src = node.getAttribute("src");
    if (src) names.push(safeDecode(src));
  }
  for (const m of html.matchAll(/\[sound:([^\]]+)\]/g)) names.push(m[1].trim());
  return names;
}

/** Media names referenced by an image-occlusion note (bare image filename + back extra). */
function mediaNamesInIONote(note) {
  return [note.fields[0], ...scanMdMedia(note.fields[3] || "").map((t) => t.name)];
}

function resolveMedia(html) {
  // Parse properly (the browser's parser, not a regex): quoted values with
  // spaces, entity encoding, and attribute order are all handled correctly.
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const node of tpl.content.querySelectorAll("img, audio, video, source")) {
    const src = node.getAttribute("src");
    if (!src) continue;
    const url = mediaUrl(safeDecode(src));
    if (url) node.setAttribute("src", url);
  }
  return tpl.innerHTML;
}

// Anki embeds audio/video in fields as [sound:filename]; turn each into a
// native <audio>/<video> player pointing at the media object URL. data-name
// lets the volume wiring identify the sound behind the blob URL.
function resolveSounds(html) {
  return html.replace(/\[sound:([^\]]+)\]/g, (m, name) => {
    const file = name.trim();
    const url = mediaUrl(file);
    if (!url) return ""; // referenced audio not in the media store — drop it
    const isVideo = /\.(mp4|webm|mov)$/i.test(file);
    return isVideo
      ? `<video controls src="${url}" data-name="${encodeURIComponent(file)}" class="av"></video>`
      : `<audio controls preload="none" src="${url}" data-name="${encodeURIComponent(file)}" class="av"></audio>`;
  });
}

// --- per-sound volume (persisted in conf.soundVolumes by media name) ---

function soundVolume(name) {
  return state.col.conf.soundVolumes?.[name] ?? 1;
}

const volumeSaveTimers = new Map();
function scheduleVolumeSave(name, v) {
  clearTimeout(volumeSaveTimers.get(name));
  volumeSaveTimers.set(name, setTimeout(async () => {
    volumeSaveTimers.delete(name);
    (state.col.conf.soundVolumes ??= {})[name] = Math.round(v * 100) / 100;
    await putMeta(state.db, state.col);
  }, 300));
}

/** Did this event originate inside a media player (e.g. its volume slider)? */
function isMediaEvent(e) {
  return !!(e.target && (e.target.closest?.("audio, video")));
}

/** Apply saved volumes to the players under `root` and persist adjustments. */
function wireSoundVolumes(root = view()) {
  for (const av of root.querySelectorAll("audio[data-name], video[data-name]")) {
    const name = safeDecode(av.dataset.name);
    av.volume = soundVolume(name);
    av.addEventListener("volumechange", () => {
      if (!av.muted) scheduleVolumeSave(name, av.volume);
    });
  }
}

/** Best-effort autoplay of the first media player in the current face (Anki-like). */
function autoplayFirstMedia(card) {
  wireSoundVolumes(); // saved per-sound volumes apply before anything plays
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

// Convert all math syntaxes (Anki [latex]/[$]/[$$], bare $..$/$$..$$) to the
// MathJax \( \) / \[ \] delimiters; those pass through. See src/mathify.js.
/** Full display pipeline for a field's HTML: math, sounds, media URLs. */
function displayHtml(html) {
  return resolveMedia(resolveSounds(mathify(html)));
}

/** Plain-text preview of a markdown field, for list rows (browse, history). */
const fieldText = (s) => stripHtml(mdToHtml(s ?? ""));

/** A card face: model-styled `.card` inside the `.card-face` frame. */
function cardFace(html) {
  return el("div", { class: "card-face" }, el("div", { class: "card", html: displayHtml(html) }));
}

/** Typeset any math under node (MathJax loads async via index.html).
 *  Defaults to the current view; previews render outside #view, so pass
 *  their container. */
function typesetMath(node = view()) {
  return window.MathJax?.typesetPromise
    ? window.MathJax.typesetPromise([node]).catch(() => {})
    : Promise.resolve();
}

/** Replace a preview box's content and typeset it, holding the box's current
 *  height as a min-height until MathJax settles. Long equations swing the
 *  preview between tall raw-TeX text and the typeset result on every
 *  keystroke; without this seatbelt the transient collapse makes the browser
 *  lose the scroll position of the surrounding page/pane. The final height
 *  still tracks the content — the box can grow freely and only shrinks once,
 *  after the new content is fully typeset. */
async function steadyPreview(box, fill) {
  // Note: no isConnected gate here — the Add screen's first paint fills its
  // preview before the form is attached (a detached box reads offsetHeight 0,
  // which is a harmless min-height). Callers that need the gate keep it
  // inside `fill`.
  box.style.minHeight = `${box.offsetHeight}px`;
  try {
    await fill();
  } finally {
    box.style.minHeight = "";
  }
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

  const field = (label, input, info) => {
    if (!info) return el("label", {}, label, input);
    const { btn, tip } = infoBubble(info);
    // Not a <label>: the info button is the first labelable element, so
    // clicking the label text would toggle the bubble instead of focusing
    // the input.
    return el("div", { class: "fld" }, el("span", { class: "lbl-row" }, label, btn), tip, input);
  };
  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Custom Study"),
    el("div", { class: "form" },
      field("Deck", deckSel, "Which deck (including its subdecks) to gather cards from."),
      field("What to study", presetSel,
        "Review ahead pulls in cards due within the next N days (useful before a trip). All cards ignores daily limits entirely. Search gathers cards whose fields or tags match the text below."),
      field("Days ahead (for 'review ahead')", nInput,
        "How far into the future to pull reviews from when using Review ahead."),
      field("Search (for 'matching a search')", searchInput,
        "Plain text matched against note fields and tags. For full search syntax (deck:, flag:red, prop: …), use Browse → Create Filtered Deck instead."),
      el("p", { class: "muted" }, "Builds a temporary filtered deck. Empty it from the deck list (eject) to return cards to their home decks."),
      el("div", { class: "row" }, el("button", { onclick: build }, "Build & Study")),
    ),
  );
}

function renderDecks() {
  state.deckId = null;
  state.card = null;
  setActiveNav(null);
  const sched = new Scheduler(state.col, { fuzz: true });
  const countsByDeck = sched.deckCounts();
  const countsFor = (d) => countsByDeck.get(Number(d.id)) ?? { new: 0, learning: 0, review: 0 };
  const decks = Object.values(state.col.decks).sort((a, b) => a.name.localeCompare(b.name));
  const rows = decks.map((d) => {
    const c = countsFor(d);
    const depth = d.name.split("::").length - 1;
    const leaf = d.name.split("::").pop();
    const actions = d.dyn
      ? el("span", { class: "deck-actions" },
          el("button", { class: "icon", title: "Rename", onclick: (e) => { e.stopPropagation(); renameDeckPrompt(d); } }, icon("pencil")),
          el("button", { class: "icon", title: "Empty (return cards home and remove deck)", onclick: (e) => { e.stopPropagation(); emptyFilteredDeck(d); } }, icon("eject")))
      : el("span", { class: "deck-actions" },
          el("button", { class: "icon", title: "Custom study", onclick: (e) => { e.stopPropagation(); renderCustomStudy(d.id); } }, icon("bolt")),
          el("button", { class: "icon", title: "Options", onclick: (e) => { e.stopPropagation(); renderDeckOptions(d.id); } }, icon("sliders")),
          el("button", { class: "icon", title: "Rename", onclick: (e) => { e.stopPropagation(); renameDeckPrompt(d); } }, icon("pencil")),
          Number(d.id) === 1
            // Default deck can't be deleted, but keep a grayed-out icon so
            // every row's action icons line up.
            ? el("button", { class: "icon", title: "The Default deck can't be deleted", disabled: "", onclick: (e) => e.stopPropagation() }, icon("trash"))
            : el("button", { class: "icon", title: "Delete", onclick: (e) => { e.stopPropagation(); deleteDeckPrompt(d); } }, icon("trash")),
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
  // Parent rows already include their subdecks, so only top-level decks feed
  // the totals (otherwise subdeck cards would be counted twice).
  const topLevel = decks.filter((d) => !d.name.includes("::"));
  const total = topLevel.reduce((n, d) => {
    const c = countsFor(d);
    return n + c.new + c.learning + c.review;
  }, 0);
  const studied = topLevel.reduce(
    (n, d) => n + sched._counterValue(d, "newToday") + sched._counterValue(d, "revToday"), 0);
  setStatus(`${state.col.cards.size} cards · ${total} due · ${studied} studied today`);
}

function nextDueCard() {
  const sched = new Scheduler(state.col, { fuzz: true });
  return sched.queue(state.deckId).all[0] ?? null;
}

function startStudy(deckId) {
  state.deckId = deckId;
  state.studiedCount = 0; // grades this session (drives the auto-return below)
  renderStudy();
}

function noteTypeAndNote(card) {
  const note = state.col.notes.get(card.nid);
  const noteType = state.col.noteType(note.mid);
  return { note, noteType };
}

/** The undo-last-answer button (disabled when there's nothing to undo). */
function undoButton() {
  return el("button", {
    class: "icon", title: "Undo last answer (Ctrl+Z)",
    disabled: state.lastAction ? null : "", onclick: doUndo,
  }, "Undo");
}

/**
 * When the next card in this deck becomes available, human-readable
 * ("in 20 min" / "in 3h 15m" / "tomorrow" / "in 5 days"), or null if the
 * deck has no future cards at all. Covers intraday (re)learning cards
 * (epoch-second dues), future-day reviews, and new cards that unlock with
 * tomorrow's daily budget at rollover.
 */
function nextDueText() {
  const sched = new Scheduler(state.col);
  const now = sched.now;
  const dids = sched._deckAndDescendants(state.deckId);
  let nextSec = Infinity;  // intraday (re)learning — epoch seconds
  let nextDay = Infinity;  // review / day-learning — day number
  let backlog = false;     // new cards waiting on tomorrow's budget
  for (const c of state.col.cards.values()) {
    if (!dids.has(c.did)) continue;
    if (c.queue === CardQueue.Learning) {
      if (c.due > now) nextSec = Math.min(nextSec, c.due);
    } else if (c.queue === CardQueue.DayLearning || c.queue === CardQueue.Review) {
      if (c.due > sched.daysElapsed) nextDay = Math.min(nextDay, c.due);
    } else if (c.queue === CardQueue.New) {
      backlog = true;
    }
  }
  if (backlog) nextDay = Math.min(nextDay, sched.daysElapsed + 1);
  const rolloverAt = now + sched.secsUntilRollover;
  const dayAt = nextDay === Infinity ? Infinity : rolloverAt + (nextDay - sched.daysElapsed - 1) * 86400;
  const t = Math.min(nextSec, dayAt);
  if (t === Infinity) return null;
  const secs = t - now;
  if (secs < 3600) return `in ${Math.max(1, Math.round(secs / 60))} min`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  const days = Math.round(secs / 86400);
  return days <= 1 ? "tomorrow" : `in ${days} days`;
}

function renderStudy() {
  const card = nextDueCard();
  state.card = card;
  state.answerShown = false;
  const back = el("div", { class: "crumbs", onclick: renderDecks }, "← Decks");

  if (!card) {
    // Done for the day after actually studying: straight back to the deck
    // list. (Entering a deck with nothing due still shows the caught-up
    // screen with the next-due time.)
    if (state.studiedCount) { renderDecks(); return; }
    // Undo stays reachable here too — you can grade the last due card and
    // land on this screen.
    const next = nextDueText();
    show(back, el("p", { class: "center" }, "All caught up — nothing due in this deck."),
      next ? el("p", { class: "center muted" }, `Next card ${next}.`) : "",
      el("div", { class: "more-bar" }, undoButton()));
    return;
  }
  const { note, noteType } = noteTypeAndNote(card);
  state.qShownAt = Date.now(); // for revlog answer-duration tracking
  const showAnswerBtn = el("button", { class: "show-answer", onclick: () => showAnswer() }, "Show Answer");
  if (noteType.ossIO) {
    ensureMedia(mediaNamesInIONote(note)).then(() => {
      if (state.card !== card) return; // moved on while media loaded
      show(back, occlusionFace(note, card.ord, "q"), showAnswerBtn, reviewMoreBar());
      wireSoundVolumes();
    });
    return;
  }
  applyModelCss(noteType);
  const { question } = renderCard(noteType, card.ord, note, {
    deckName: deckName(card.did), flag: card.flags & 7,
  });

  ensureMedia(mediaNamesInHtml(question)).then(() => {
    if (state.card !== card || state.answerShown) return; // stale prefetch
    show(back, cardFace(question), showAnswerBtn, reviewMoreBar());
    autoplayFirstMedia(card);
    typesetMath();
    // Focus a type-in-the-answer box if the template has one.
    view().querySelector("#typeans")?.focus();
  });
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
    ensureMedia(mediaNamesInIONote(note)).then(() => {
      if (state.card !== card) return;
      show(crumbs, occlusionFace(note, card.ord, "a"), controls, reviewMoreBar());
      wireSoundVolumes();
    });
    return;
  }
  applyModelCss(noteType);
  const typed = view().querySelector("#typeans")?.value ?? "";
  const { answer } = renderCard(noteType, card.ord, note, {
    typed, deckName: deckName(card.did), flag: card.flags & 7,
  });
  ensureMedia(mediaNamesInHtml(answer)).then(() => {
    if (state.card !== card) return;
    show(crumbs, cardFace(answer), controls, reviewMoreBar());
    autoplayFirstMedia(card);
    typesetMath();
  });
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
  // Persist the answered card AND its (possibly buried) siblings; the note too,
  // since a leech may have just been tagged.
  for (const c of state.col.cardsForNote(card.nid)) await putCard(state.db, c);
  await putNote(state.db, state.col.notes.get(card.nid));
  await putRevlog(state.db, entry);
  await putMeta(state.db, state.col); // persist deck daily counters (newToday/revToday)
  state.studiedCount = (state.studiedCount ?? 0) + 1;
  renderStudy();
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
/**
 * Per-field alignment + font-size toolbar buttons for a markdown editor,
 * shared by the note editor and Add Card. Clicking cycles alignment
 * left → center → right and font size small → medium (default) → large;
 * holding the size button opens a popout for an exact px size. Styles are
 * plain objects { falign: {ord: "left"|"right"}, fsize: {ord: px} } (absent
 * keys = the note type's defaults). read() returns the current style object;
 * write(style) persists a replacement. attach() wires the buttons to the
 * editor and mirrors the current style onto it.
 */
function fieldStyleToggles(f, read, write) {
  const ALIGN_CYCLE = ["left", "center", "right"];
  const SIZE_CYCLE = [14, null, 28]; // px; null = the note type's default
  let ed = null;
  const setKey = async (key, value) => {
    const s = { falign: { ...(read().falign ?? {}) }, fsize: { ...(read().fsize ?? {}) } };
    if (value == null) delete s[key][f.ord]; else s[key][f.ord] = value;
    if (!Object.keys(s.falign).length) delete s.falign;
    if (!Object.keys(s.fsize).length) delete s.fsize;
    await write(s);
  };
  const showAlign = (a) => {
    alignTb.replaceChildren(icon(`align-${a}`));
    alignTb.title = `Alignment: ${a} (click to change)`;
    if (ed) ed.el.style.textAlign = a;
  };
  const alignTb = tbBtn(icon("align-center"), "", async () => {
    const cur = read().falign?.[f.ord] ?? "center";
    const next = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(cur) + 1) % ALIGN_CYCLE.length];
    await setKey("falign", next === "center" ? null : next);
    showAlign(next);
  });
  const showSize = (px) => {
    sizeTb.style.fontSize = px == null ? "" : px <= 16 ? "11px" : px >= 26 ? "17px" : "13px";
    sizeTb.title = `Font size: ${px == null ? "default" : px + "px"} (click to cycle, hold to enter a size)`;
    if (ed) ed.el.style.fontSize = px == null ? "" : `${px}px`;
  };
  const setSize = async (px) => { await setKey("fsize", px); showSize(px); };
  const openSizePop = () => {
    const inp = el("input", { type: "number", min: "8", max: "96", value: String(read().fsize?.[f.ord] ?? 20) });
    const { close } = openModal([
      el("h3", {}, `Font size — ${f.name}`),
      el("div", { class: "form" }, el("label", {}, "Size in pixels", inp)),
      el("div", { class: "row" },
        el("button", { type: "button", onclick: async () => {
          const v = Math.round(Number(inp.value));
          await setSize(Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 8), 96) : null);
          close();
        } }, "Set"),
        el("button", { type: "button", onclick: async () => { await setSize(null); close(); } }, "Default"),
        el("button", { type: "button", onclick: () => close() }, "Cancel")),
    ]);
    inp.focus();
    inp.select();
  };
  let longFired = false;
  let pressTimer = null;
  const sizeTb = tbBtn("A", "", () => {
    if (longFired) return; // that click ends a hold, don't also cycle
    const cur = read().fsize?.[f.ord] ?? null;
    const next = SIZE_CYCLE[(SIZE_CYCLE.findIndex((s) => s === cur) + 1) % SIZE_CYCLE.length];
    setSize(next);
  });
  sizeTb.addEventListener("pointerdown", () => {
    longFired = false;
    pressTimer = setTimeout(() => { longFired = true; openSizePop(); }, 500);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    sizeTb.addEventListener(ev, () => clearTimeout(pressTimer));
  }
  sizeTb.addEventListener("contextmenu", (e) => e.preventDefault()); // no menu on hold
  return {
    buttons: [alignTb, sizeTb],
    attach(editor) {
      ed = editor;
      showAlign(read().falign?.[f.ord] ?? "center");
      showSize(read().fsize?.[f.ord] ?? null);
    },
  };
}

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

/**
 * Tag toggle bubbles shared by the add-card and edit-note screens: one bubble
 * per tag in the collection (or, past 10 tags, selected bubbles plus a search
 * field for finding the rest), toggled in the `selected` set; "+ New tag"
 * opens a small popout. `onChange` is awaited after every change (edit-note
 * uses it to persist; add-card passes none and applies the set on Save).
 */
function tagBubblePicker(selected, onChange) {
  const box = el("div", { class: "tag-bubbles" });
  const pop = el("div", { class: "pop-panel tag-pop" });
  pop.style.display = "none";
  const inp = el("input", { type: "text", placeholder: "tag-name (no spaces)" });
  const addIt = async () => {
    const t = inp.value.trim().replace(/\s+/g, "_");
    if (!t) return;
    selected.add(t);
    inp.value = "";
    pop.style.display = "none";
    await onChange?.();
    refresh();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addIt(); } });
  pop.append(
    el("h3", {}, "New tag"),
    inp,
    el("div", { class: "row" },
      el("button", { type: "button", onclick: addIt }, "Add"),
      el("button", { type: "button", onclick: () => { pop.style.display = "none"; } }, "Cancel")),
  );
  const allTags = () => {
    const s = new Set(selected);
    for (const n of state.col.notes.values()) for (const t of n.tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  };
  // Up to 10 tags: one bubble each. Past that, bubbles would swamp the form —
  // show the selected ones plus a search field for finding the rest.
  const MAX_BUBBLES = 10;
  const search = el("input", { type: "text", class: "tag-search", placeholder: "Search tags…" });
  const refresh = () => {
    const tags = allTags();
    const bubble = (t, on) => el("button", {
      type: "button", class: `tag-bub${on ? " on" : ""}`,
      onclick: async () => {
        if (selected.has(t)) selected.delete(t); else selected.add(t);
        await onChange?.();
        refresh();
      },
    }, t);
    const newTagBtn = el("button", { type: "button", class: "tag-bub ghost", onclick: () => {
      pop.style.display = pop.style.display === "none" ? "" : "none";
      if (pop.style.display === "") inp.focus();
    } }, "+ New tag");
    if (tags.length <= MAX_BUBBLES) {
      box.replaceChildren(...tags.map((t) => bubble(t, selected.has(t))), newTagBtn, pop);
      return;
    }
    const q = search.value.trim().toLowerCase();
    const matches = q
      ? tags.filter((t) => !selected.has(t) && t.toLowerCase().includes(q)).slice(0, MAX_BUBBLES)
      : [];
    box.replaceChildren(
      ...tags.filter((t) => selected.has(t)).map((t) => bubble(t, true)),
      search,
      ...matches.map((t) => bubble(t, false)),
      newTagBtn,
      pop,
    );
  };
  search.addEventListener("input", refresh);
  refresh();
  return box;
}

async function renderAddCard() {
  state.card = null;
  setActiveNav("btn-add");
  const DRAFT_KEY = "addCardDraft";
  const draft = await draftGet(DRAFT_KEY).catch(() => null);
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const modelSel = el("select", {}, ...models.map((m) => el("option", { value: m.id }, m.name)));
  modelSel.value = validModelId(state.col.conf.curModel);
  if (draft && models.some((m) => m.id === draft.mid)) modelSel.value = String(draft.mid);
  const deckSel = el("select", {}, ...decks.map((d) => el("option", { value: d.id }, d.name)));
  // Default deck: the one being studied right now, else the last card's
  // deck (Anki's curDeck). A saved draft wins over both.
  if (decks.some((d) => d.id === state.col.conf.curDeck)) deckSel.value = String(state.col.conf.curDeck);
  if (state.deckId && decks.some((d) => d.id === state.deckId)) deckSel.value = String(state.deckId);
  if (draft && decks.some((d) => d.id === draft.did)) deckSel.value = String(draft.did);

  // Top-right actions: tag + flag toggles for the new note, then Save.
  const newTags = new Set(draft?.tags ?? []);
  const newFlags = new Set(draft?.flags ?? []);
  const flagWrap = el("span");
  const renderNewFlags = () => {
    flagWrap.replaceChildren(flagPicker(newFlags, (n) => {
      // Exclusive (Anki-style): toggling the active flag clears it.
      if (newFlags.size === 1 && newFlags.has(n)) newFlags.clear();
      else { newFlags.clear(); newFlags.add(n); }
      renderNewFlags();
      scheduleDraftSave(); // defined below; clicks only fire after render
    }));
  };
  renderNewFlags();

  const fieldsWrap = el("div", { class: "form-fields" });
  let inputs = [];
  // Field align/size styles start from the last-used ones (conf.addFieldStyle,
  // mirrored from the note editor); editing them here updates the defaults.
  const writeNewStyle = async (s) => {
    state.col.conf.addFieldStyle = s;
    await putMeta(state.db, state.col);
    schedulePreview();
  };
  const rebuildFields = () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    inputs = [];
    if (!model) {
      fieldsWrap.replaceChildren(el("p", { class: "muted" }, "No note types — create one in Types."));
      return;
    }
    fieldsWrap.replaceChildren(...model.flds.map((f) => {
      const t = fieldStyleToggles(f, () => state.col.conf.addFieldStyle ?? {}, writeNewStyle);
      const ed = mdEditor(f.default ?? "", { afterHistory: t.buttons }); // note type may define a default value
      t.attach(ed);
      inputs.push(ed);
      return el("div", { class: "fld" }, el("span", {}, f.name), ed.el);
    }));
  };

  // Live preview: the actual card(s) this note will create, as you type.
  const previewBox = el("div", { class: "preview-box" });
  const updatePreview = () => steadyPreview(previewBox, async () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) { previewBox.replaceChildren(); return; }
    const fields = inputs.map((ed) => ed.getText());
    const tmpNote = new Note({ mid: model.id, fields, data: JSON.stringify(state.col.conf.addFieldStyle ?? {}) });
    const ords = cardOrdinalsForNote(model, tmpNote);
    if (!ords.length) {
      previewBox.replaceChildren(el("div", { class: "muted pv-count" }, "No cards yet — fill the first field."));
      return;
    }
    applyModelCss(model);
    const { question, answer } = renderCard(model, ords[0], tmpNote, {
      deckName: decks.find((d) => String(d.id) === deckSel.value)?.name ?? "",
    });
    await ensureMedia([...mediaNamesInHtml(question), ...mediaNamesInHtml(answer)]);
    previewBox.replaceChildren(
      el("div", { class: "muted pv-count" },
        `Will create ${ords.length} card${ords.length > 1 ? "s" : ""} · previewing "${model.tmpls[model.type === NoteTypeKind.Cloze ? 0 : ords[0]]?.name ?? ""}"`),
      el("div", { class: "pv-pair" },
        el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(question) })),
        el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(answer) })),
      ),
    );
    wireSoundVolumes(previewBox);
    await typesetMath(previewBox); // scoped to the preview, not the whole view
  });
  // Draft autosave: every edit persists the form to IndexedDB (debounced), so
  // an accidental Back / crash / tab close can't lose work. A fully-empty
  // draft deletes itself. Switching note type deliberately does NOT save —
  // otherwise flipping models would wipe the old model's field texts.
  const scheduleDraftSave = debounced(async () => {
    const d = {
      mid: Number(modelSel.value), did: Number(deckSel.value),
      fields: inputs.map((ed) => ed.getText()),
      tags: [...newTags], flags: [...newFlags],
    };
    const empty = d.fields.every((t) => !t.trim()) && !d.tags.length && !d.flags.length;
    await draftWrite(DRAFT_KEY, empty ? undefined : d).catch(() => {});
  });
  const schedulePreview = debounced(updatePreview);
  fieldsWrap.addEventListener("input", () => { schedulePreview(); scheduleDraftSave(); });
  deckSel.addEventListener("change", () => { schedulePreview(); scheduleDraftSave(); });
  modelSel.addEventListener("change", () => { rebuildFields(); schedulePreview(); });
  rebuildFields();
  if (draft?.fields) {
    inputs.forEach((ed, i) => { if (draft.fields[i]) ed.setText(draft.fields[i]); });
    setStatus("Draft restored — you can pick up where you left off.");
  }
  updatePreview();

  const save = async () => {
    const model = state.col.noteType(Number(modelSel.value)) ?? models[0];
    if (!model) { setStatus("No note type available."); return; }
    const fields = inputs.map((ed) => ed.getText());
    // Emptiness check Anki-style: media filenames count as content, so an
    // image-only (or [sound:]-only) first field is a valid note.
    if (!stripHtmlPreservingMediaFilenames(fields[0]).trim()) { setStatus("The first field is empty."); return; }
    const note = addNoteWithCards(model, fields, Number(deckSel.value),
      [...newTags].sort((a, b) => a.localeCompare(b)));
    state.col.conf.curDeck = Number(deckSel.value); // default deck for the next card
    state.col.conf.curModel = model.id; // default note type too (rapid multi-add)
    // The field align/size styles become the note's own data.
    const s = state.col.conf.addFieldStyle;
    if (s?.falign || s?.fsize) {
      const d = parseNoteData(note.data);
      if (s.falign) d.falign = s.falign;
      if (s.fsize) d.fsize = s.fsize;
      note.data = JSON.stringify(d);
    }
    if (newFlags.size) {
      for (const c of state.col.cardsForNote(note.id)) writeCardFlags(c, new Set(newFlags));
    }
    await putNoteAndMeta(note);
    for (const c of state.col.cardsForNote(note.id)) await putCard(state.db, c);
    await draftWrite(DRAFT_KEY, undefined).catch(() => {}); // draft consumed
    const count = state.col.cardsForNote(note.id).length;
    setStatus(`Added (${count} card${count > 1 ? "s" : ""}).`);
    renderDecks();
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "add-head" },
      el("h2", {}, "Add Card"),
      el("div", { class: "add-actions" },
        el("button", { onclick: save }, "Save"))),
    el("div", { class: "form" },
      el("div", { class: "row" }, el("label", {}, "Note type", modelSel), el("label", {}, "Deck", deckSel)),
      fieldsWrap,
      el("h2", { class: "pv-head" }, "Preview"),
      previewBox,
      el("div", { class: "form-tags" }, el("span", { class: "muted tag-lbl" }, "Tags"), tagBubblePicker(newTags, scheduleDraftSave)),
      el("div", { class: "form-tags" }, el("span", { class: "muted tag-lbl" }, "Flags"), flagWrap),
    ),
  );
}

async function putNoteAndMeta(note) {
  await putNote(state.db, note);
  await putMeta(state.db, state.col);
}

function renderImportCsv(file = null) {
  state.card = null;
  const models = Object.values(state.col.models);
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.txt" });
  // A file preselected from the header Import button (the input can override).
  let pickedFile = file;
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
    if (!pickedFile) return;
    parsed = parseCsv(await pickedFile.text(), delimSel.value || undefined);
    buildMapping();
  };
  fileInput.addEventListener("change", () => { pickedFile = fileInput.files[0] ?? null; reparse(); });
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
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("h2", {}, "Import CSV / TSV"),
    el("div", { class: "form" },
      el("label", {}, pickedFile ? `File (${pickedFile.name})` : "File", fileInput),
      el("div", { class: "row" }, el("label", {}, "Note type", modelSel), el("label", {}, "Deck", deckSel)),
      el("div", { class: "row" },
        el("label", {},
          el("span", { class: "lbl-row" }, "Delimiter",
            infoBubbleInline("The character separating columns in the file. Auto detects comma, tab, or semicolon from the first rows.")),
          delimSel),
        el("label", { class: "inline" }, headerChk, "First row is a header",
          infoBubbleInline("When on, the first row is treated as column names and not imported as a note.")),
      ),
      el("h3", {}, "Column → field mapping"),
      mappingBox,
      preview,
      el("div", { class: "row" }, el("button", { onclick: doImport }, "Import")),
    ),
  );
  if (pickedFile) reparse();
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

/**
 * Create a new, fully independent deck from a browse query: fresh copies of
 * the matching cards (same notes, new scheduling) and its own options group.
 * Originals stay in their decks untouched; nothing is inherited or returned.
 * @returns {Promise<{ ok: boolean, msg: string }>}
 */
async function createFilteredDeck(query, name) {
  let pred;
  try { pred = compileSearch(query); } catch { return { ok: false, msg: "Invalid search." }; }
  if (Object.values(state.col.decks).some((d) => d.name === name)) {
    return { ok: false, msg: `A deck named "${name}" already exists.` };
  }
  const ctx = searchContext(state.col);
  const matches = [...state.col.cards.values()].filter((c) => pred(c, ctx));
  if (!matches.length) return { ok: false, msg: "No cards match this filter." };
  const { count } = state.col.cloneCardsIntoNewDeck(name, matches);
  await persistAll();
  return { ok: true, msg: `Created "${name}" — ${count} fresh cards.` };
}

/** Does `term` appear as a whole token (or phrase) inside a query string? */
function termInQuery(q, term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${esc}(?=\\s|$)`).test(q);
}

function renderBrowse() {
  state.card = null;
  setActiveNav("btn-browse");
  // Multiple filters: each filter is an AND of its terms (the text in the
  // search bar is that filter's query, chips just edit the text); "All
  // filters" shows the union (OR) of every non-empty filter.
  state.browseTabs ??= [{ q: "" }];
  state.browseActive ??= 0;
  state.browseViewAll ??= false;
  const tabs = state.browseTabs;
  if (state.browseActive >= tabs.length) state.browseActive = 0;
  const activeTab = () => tabs[state.browseActive];

  const unionQuery = () => {
    const parts = tabs.map((t) => t.q.trim());
    // An empty filter matches every card, so the union is every card.
    if (parts.some((p) => !p)) return "";
    return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(" or ");
  };
  const currentQuery = () => (state.browseViewAll ? unionQuery() : activeTab().q);

  const search = el("input", {
    class: "search", type: "search", value: "",
    placeholder: 'Filter query — e.g. deck:Spanish tag:verb is:due prop:ivl>21 -flag:red',
    oninput: (e) => {
      if (state.browseViewAll) return;
      activeTab().q = e.target.value;
      syncChips();
      renderRows(currentQuery());
    },
  });
  const list = el("div", { class: "browse-list" });

  // Right-hand edit pane (desktop): clicking a row edits in place.
  const editPane = el("aside", { class: "browse-edit" });
  const panePlaceholder = () =>
    el("div", { class: "center muted" }, "Select a card to edit it here. Sibling cards share one note — editing updates them all.");
  editPane.append(panePlaceholder());
  let selectedNoteId = null;
  const isDesktop = () => window.matchMedia("(min-width: 641px)").matches;

  const openInPane = (noteId) => {
    selectedNoteId = noteId;
    editPane.replaceChildren(noteEditorForm(noteId, {
      onAutoSaved: () => renderRows(currentQuery()),
      onDeleted: () => {
        selectedNoteId = null;
        editPane.replaceChildren(panePlaceholder());
        renderRows(currentQuery());
      },
      onCardsChanged: () => { renderRows(currentQuery()); openInPane(noteId); },
      onTagsChanged: () => { refreshSidebarTags(); renderRows(currentQuery()); },
    }));
    renderRows(currentQuery()); // refresh row highlight
  };

  // Toggling a chip edits the ACTIVE filter's text (and shows that filter,
  // so you always see what you're changing).
  const toggleTerm = (term) => {
    const t = activeTab();
    if (termInQuery(t.q, term)) {
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t.q = t.q.replace(new RegExp(`(^|\\s)${esc}(?=\\s|$)`), " ").replace(/\s+/g, " ").trim();
    } else {
      t.q = `${t.q.trim()} ${term}`.trim();
    }
    state.browseViewAll = false;
    sync();
  };

  const sideItem = (label, term, extra = null, cls = "") =>
    el("div", {
      class: `side-item ${cls}`, "data-term": term, title: term,
      onclick: () => toggleTerm(term),
    }, extra, label);
  const section = (title, ...items) =>
    el("div", { class: "side-sec" }, el("h4", {}, title), ...items);

  const decks = Object.values(state.col.decks).sort((a, b) => a.name.localeCompare(b.name));

  // Tag chips rebuild whenever a note's tags change (e.g. a tag added in the
  // edit pane appears as a filter immediately).
  const tagItems = el("div");
  const refreshSidebarTags = () => {
    const tagSet = new Set();
    for (const n of state.col.notes.values()) for (const t of n.tags) tagSet.add(t);
    tagItems.replaceChildren(
      sideItem("Untagged", "tag:none"),
      ...[...tagSet].sort((a, b) => a.localeCompare(b)).map((t) => sideItem(t, quoteTerm(`tag:${t}`))),
    );
    syncChips();
  };

  const sidebar = el("aside", { class: "browse-side" },
    el("div", { class: "side-item side-clear muted", onclick: () => {
      activeTab().q = "";
      state.browseViewAll = false;
      sync();
    } }, icon("x"), " Clear this filter"),
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
        sideItem(name, `flag:${i ? name.toLowerCase() : "none"}`,
          i ? el("span", { class: `flag-dot f${i}` }, icon("flag")) : null, `f${i} `)),
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
    section("Tags", tagItems),
  );

  const syncChips = () => {
    const q = activeTab().q;
    sidebar.querySelectorAll(".side-item[data-term]").forEach((n) => {
      n.classList.toggle("on", termInQuery(q, n.dataset.term));
    });
  };

  // --- filter tabs: Filter 1 · Filter 2 · New filter · All filters ---
  const tabsBar = el("div", { class: "filter-tabs" });
  const renderTabs = () => {
    tabsBar.replaceChildren(
      el("button", {
        class: `ftab all${state.browseViewAll ? " active" : ""}`,
        title: "Show the union of all filters (a card matching any filter)",
        onclick: () => { state.browseViewAll = true; sync(); },
      }, "All filters"),
      ...tabs.map((t, i) =>
        el("button", {
          class: `ftab${!state.browseViewAll && i === state.browseActive ? " active" : ""}`,
          title: t.q.trim() || "(empty filter)",
          onclick: () => { state.browseActive = i; state.browseViewAll = false; sync(); },
        },
          `Filter ${i + 1}`,
          tabs.length > 1
            ? el("span", { class: "ftab-x", title: "Remove this filter", onclick: (e) => {
                e.stopPropagation();
                tabs.splice(i, 1);
                if (state.browseActive >= tabs.length) state.browseActive = tabs.length - 1;
                sync();
              } }, icon("x"))
            : null,
        )),
      el("button", { class: "ftab ghost", onclick: () => {
        tabs.push({ q: "" });
        state.browseActive = tabs.length - 1;
        state.browseViewAll = false;
        sync();
      } }, "New filter"),
    );
  };

  const sync = () => {
    renderTabs();
    if (state.browseViewAll) {
      search.value = unionQuery();
      search.readOnly = true;
      search.classList.add("ro");
    } else {
      search.value = activeTab().q;
      search.readOnly = false;
      search.classList.remove("ro");
    }
    syncChips();
    createPanel.style.display = "none"; // filters changed → stale panel closes
    renderRows(currentQuery());
  };

  // --- Create Filtered Deck popout: shows exactly which filters feed the
  // deck and how many cards match, then asks for a name. ---
  const createPanel = el("div", { class: "pop-panel" });
  createPanel.style.display = "none";
  const buildCreatePanel = () => {
    const q = currentQuery();
    let count = 0;
    try {
      const pred = compileSearch(q);
      const ctx = searchContext(state.col);
      count = [...state.col.cards.values()].filter((c) => pred(c, ctx)).length;
    } catch { /* count stays 0 */ }
    const sources = state.browseViewAll
      ? tabs.map((t, i) => ({ label: `Filter ${i + 1}`, q: t.q.trim() }))
      : [{ label: `Filter ${state.browseActive + 1}`, q: activeTab().q.trim() }];
    const nameInput = el("input", { type: "text", placeholder: "Deck name" });
    const err = el("div", { class: "pop-err" });
    const create = async () => {
      const name = nameInput.value.trim();
      if (!name) { err.textContent = "Give the deck a name."; return; }
      const r = await createFilteredDeck(q, name);
      if (!r.ok) { err.textContent = r.msg; return; }
      setStatus(r.msg);
      renderDecks();
    };
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
    createPanel.replaceChildren(
      el("h3", {}, state.browseViewAll
        ? "Create Filtered Deck — from All filters"
        : `Create Filtered Deck — from Filter ${state.browseActive + 1}`),
      el("div", { class: "muted pop-src" },
        state.browseViewAll ? "The union (OR) of all filters — a card in any of:" : "Cards matching the selected filter:"),
      ...sources.map((s) => el("div", { class: "pop-filter" },
        el("b", {}, s.label), " ", el("code", {}, s.q || "(empty — matches every card)"))),
      el("div", { class: "muted" },
        `${count} matching card${count === 1 ? "" : "s"} — copied in as fresh cards with their own deck settings; the originals stay where they are.`),
      nameInput,
      err,
      el("div", { class: "row" },
        el("button", { onclick: create }, "Create"),
        el("button", { onclick: () => { createPanel.style.display = "none"; } }, "Cancel"),
      ),
    );
  };
  const toggleCreatePanel = () => {
    if (createPanel.style.display === "none") {
      buildCreatePanel();
      createPanel.style.display = "";
      createPanel.querySelector("input")?.focus();
    } else {
      createPanel.style.display = "none";
    }
  };

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
        const title = fieldText(note.fields[0]).slice(0, 80) || "(empty)";
        const flags = [...cardFlagSet(card)].sort();
        return el("div", {
          class: `browse-row${note.id === selectedNoteId ? " selected" : ""}`,
          onclick: () => (isDesktop() ? openInPane(note.id) : renderEditNote(note.id)),
        },
          ...flags.map((n) => el("span", { class: `flag-dot f${n}`, title: FLAG_NAMES[n] }, icon("flag"))),
          el("span", { class: "br-title" }, title),
          el("span", { class: "br-deck" }, deckName(card.did)),
          el("span", { class: `br-state ${cardStateLabel(card)}` }, cardStateLabel(card)),
        );
      }),
      all.length > shown.length ? el("div", { class: "center" }, `…and ${all.length - shown.length} more (refine search)`) : "",
      all.length ? "" : el("div", { class: "center" }, "No matching cards."),
    );
    const label = state.browseViewAll ? "All filters" : `Filter ${state.browseActive + 1}`;
    setStatus(`${label} · ${all.length} card${all.length === 1 ? "" : "s"}`);
  };

  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "decks-head" },
      el("h2", {}, "Browse"),
      el("div", { class: "row pop-anchor" },
        el("button", { class: "side-toggle", onclick: () => sidebar.classList.toggle("open") }, icon("funnel"), " Filters"),
        el("button", { title: "Create a persistent deck from the current view (the selected filter, or the union when All filters is selected)",
          onclick: toggleCreatePanel }, "Create Filtered Deck"),
        createPanel,
      ),
    ),
    search,
    tabsBar,
    el("div", { class: "browse-layout" }, sidebar, list, editPane),
  );
  refreshSidebarTags();
  sync();
}

/**
 * The note editor form, shared by the full-page editor (mobile) and the
 * browse side pane (desktop). Editing a note edits every card of that note.
 * @param {number} noteId
 * @param {{ onAutoSaved?: () => void, onDeleted?: () => void, onCardsChanged?: () => void, onTagsChanged?: () => void }} cb
 */
function noteEditorForm(noteId, cb = {}) {
  const note = state.col.notes.get(noteId);
  if (!note) return el("div", { class: "center muted" }, "Note not found.");
  const model = state.col.noteType(note.mid);

  // Per-field text alignment and font size for rendered cards (stored in
  // notes.data falign/fsize, keyed by field ord; absent = the note type's
  // defaults). The last-used styles become the defaults for new notes
  // (conf.addFieldStyle), so Add Card starts with them.
  const writeStyle = async (s) => {
    const d = parseNoteData(note.data);
    if (s.falign) d.falign = s.falign; else delete d.falign;
    if (s.fsize) d.fsize = s.fsize; else delete d.fsize;
    note.data = JSON.stringify(d);
    note.mod = Math.floor(Date.now() / 1000);
    await putNote(state.db, note);
    state.col.conf.addFieldStyle = s;
    await putMeta(state.db, state.col);
    schedulePvPop(); // the preview reflects the change
  };
  const inputs = model.flds.map((f) => {
    const t = fieldStyleToggles(f, () => parseNoteData(note.data), writeStyle);
    const ed = mdEditor(note.fields[f.ord] ?? "", { afterHistory: t.buttons });
    t.attach(ed);
    return { f, ed };
  });

  // Tags are bubbles: one per tag in the collection, toggled on/off for this
  // note and persisted immediately; "+ New tag" opens a small popout.
  const noteTags = new Set(note.tags ?? []);
  const applyTags = async () => {
    await ensureHistory();
    note.tags = [...noteTags].sort((a, b) => a.localeCompare(b));
    note.mod = Math.floor(Date.now() / 1000);
    await putNote(state.db, note);
    cb.onTagsChanged?.();
  };
  const tagBox = tagBubblePicker(noteTags, applyTags);

  // Edit history: the pre-edit state is snapshotted once per editing session
  // (before the first change lands), restorable from the History modal.
  const original = { fields: [...note.fields], tags: [...note.tags] };
  let historySaved = false;
  const ensureHistory = async () => {
    if (historySaved) return;
    historySaved = true;
    await pushNoteHistory(state.db, note.id, original.fields, original.tags);
  };

  // Auto-save: field edits persist as you type (debounced), and immediately
  // when focus leaves the editor. There is no Save button.
  let saveTimer = null;
  const doSave = async () => {
    saveTimer = null;
    if (!state.col.notes.has(note.id)) return; // deleted meanwhile
    await ensureHistory();
    note.fields = inputs.map(({ ed }) => ed.getText());
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
    cb.onAutoSaved?.();
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 400);
  };

  const del = async () => {
    if (!confirm("Delete this note and its cards?")) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const cardIds = state.col.removeNote(noteId);
    await deleteNoteAndCards(state.db, noteId, cardIds);
    await deleteNoteHistory(state.db, noteId);
    setStatus("Deleted.");
    cb.onDeleted?.();
  };

  // Change-type modal: pick the target type, map each of its fields from an
  // old field (prefilled by matching name, then position).
  const openChangeTypeModal = () => {
    const others = Object.values(state.col.models).filter((m) => m.id !== model.id);
    if (!others.length) { setStatus("There is no other note type to change to."); return; }
    const typeSel = el("select", {}, ...others.map((m) => el("option", { value: m.id }, m.name)));
    const mapBox = el("div", { class: "form" });
    const selects = [];
    const buildMap = () => {
      const target = state.col.noteType(Number(typeSel.value));
      selects.length = 0;
      mapBox.replaceChildren(...target.flds.map((f, i) => {
        const sel = el("select", {},
          el("option", { value: -1 }, "(blank)"),
          ...model.flds.map((of, oi) => el("option", { value: oi }, of.name)));
        const byName = model.flds.findIndex((of) => of.name === f.name);
        sel.value = String(byName !== -1 ? byName : (i < model.flds.length ? i : -1));
        selects.push(sel);
        return el("label", {}, `${f.name} ← old field`, sel);
      }));
    };
    typeSel.addEventListener("change", buildMap);
    buildMap();
    const doChange = async () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      await ensureHistory(); // old field values stay restorable
      const ok = await applyChangeNoteType(note, Number(typeSel.value), selects.map((s) => Number(s.value)));
      close();
      if (ok) setStatus("Note type changed — cards recreated fresh.");
      refresh();
    };
    const { close } = openModal([
      el("h3", {}, "Change note type"),
      el("div", { class: "muted pop-src" },
        "Map each field of the new type from a field of this note. Cards are deleted and recreated fresh (scheduling resets); tags, flags, and deck membership are kept."),
      el("div", { class: "form" }, el("label", {}, "New type", typeSel), mapBox),
      el("div", { class: "row" },
        el("button", { type: "button", onclick: doChange }, "Change"),
        el("button", { type: "button", onclick: () => close() }, "Cancel")),
    ]);
  };

  // History modal: past versions of this note, restorable (restoring first
  // snapshots the current state, so restores are themselves undoable).
  const openHistoryModal = async () => {
    const entries = await listNoteHistory(state.db, note.id);
    const rows = entries.length
      ? entries.map((e) => el("div", { class: "hist-row" },
          el("div", { class: "hist-meta" },
            el("b", {}, new Date(e.ts).toLocaleString()),
            el("span", { class: "muted" }, ` · ${fieldText(e.fields[0]).slice(0, 60) || "(empty)"}`)),
          el("button", { type: "button", onclick: async () => {
            await pushNoteHistory(state.db, note.id, inputs.map(({ ed }) => ed.getText()), [...note.tags]);
            note.fields = [...e.fields];
            note.tags = [...e.tags];
            note.mod = Math.floor(Date.now() / 1000);
            note.normalize(model.sortf ?? 0);
            await putNote(state.db, note);
            close();
            setStatus("Restored.");
            refresh();
          } }, "Restore")))
      : [el("div", { class: "center muted" }, "No earlier versions yet — history is recorded when you edit.")];
    const { close } = openModal([
      el("h3", {}, "Note history"),
      ...rows,
      el("div", { class: "row" }, el("button", { type: "button", onclick: () => close() }, "Close")),
    ]);
  };

  // Study history modal: the review log (rating + date) for each card of
  // this note, with bubble tabs to switch between every deck that has
  // scheduling metadata for it — live cards plus state archived on the note
  // for decks it was removed from. Above the log: the next study date and
  // how long until then.
  const openStudyHistoryModal = () => {
    const sched = new Scheduler(state.col);
    const easeLabel = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
    const easeClass = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
    const untilText = (t) => { // t: epoch seconds
      const secs = t - sched.now;
      if (secs <= 0) return "due now";
      if (secs < 3600) return `in ${Math.max(1, Math.round(secs / 60))} min`;
      if (secs < 86400) {
        const h = Math.floor(secs / 3600);
        const m = Math.round((secs % 3600) / 60);
        return m ? `in ${h}h ${m}m` : `in ${h}h`;
      }
      const days = Math.round(secs / 86400);
      return days <= 1 ? "tomorrow" : `in ${days} days`;
    };
    // Next-study line for a card (or an archived snapshot — same fields).
    const nextStudy = (c) => {
      if (c.queue === CardQueue.Suspended) return "Suspended — not scheduled.";
      if (c.queue === CardQueue.New) return "New card — not scheduled yet.";
      if (c.queue === CardQueue.Learning) { // intraday: due is epoch seconds
        return `Next study: ${new Date(c.due * 1000).toLocaleString()} (${untilText(c.due)})`;
      }
      // Review / day-learning / buried: due is a day number whose day starts
      // at rollover (same math as nextDueText).
      const t = sched.now + sched.secsUntilRollover + (c.due - sched.daysElapsed - 1) * 86400;
      return `Next study: ${new Date(t * 1000).toLocaleDateString()} (${untilText(t)})`;
    };

    // One tab per (deck, ord) with metadata: live cards first, then
    // archived snapshots (note.data sched map, keyed `deckName \x1f ord`)
    // that have no live card.
    const tabs = state.col.cardsForNote(note.id).map((c) => ({
      deck: deckName(c.did), ord: c.ord, card: c, live: true,
    }));
    const liveKeys = new Set(tabs.map((t) => `${t.deck}\x1f${t.ord}`));
    let archived = {};
    try { archived = JSON.parse(note.data || "{}").sched ?? {}; } catch { /* no metadata */ }
    for (const [key, snap] of Object.entries(archived)) {
      if (liveKeys.has(key)) continue;
      const [deck, ord] = key.split("\x1f");
      tabs.push({ deck, ord: Number(ord), card: snap, live: false });
    }
    // Disambiguate tabs sharing a deck name by the card's template.
    const deckCounts = {};
    for (const t of tabs) deckCounts[t.deck] = (deckCounts[t.deck] ?? 0) + 1;
    for (const t of tabs) {
      t.label = t.deck;
      if (deckCounts[t.deck] > 1) {
        t.label += " · " + (model.type === NoteTypeKind.Cloze
          ? `Cloze ${t.ord + 1}`
          : model.tmpls[t.ord]?.name ?? `Card ${t.ord + 1}`);
      }
      if (!t.live) t.label += " (removed)";
    }

    if (!tabs.length) {
      const { close } = openModal([
        el("h3", {}, "Study history"),
        el("div", { class: "center muted" }, "No scheduling info for this note yet."),
        el("div", { class: "row" }, el("button", { type: "button", onclick: () => close() }, "Close")),
      ]);
      return;
    }

    const content = el("div");
    const showTab = (idx) => {
      const t = tabs[idx];
      tabBar.querySelectorAll(".ftab").forEach((b, i) => b.classList.toggle("active", i === idx));
      const entries = state.col.revlog
        .filter((e) => e.cid === t.card.id)
        .sort((a, b) => b.id - a.id);
      const rows = entries.length
        ? entries.map((e) => el("div", { class: "hist-row" },
            el("div", { class: "hist-meta" },
              el("b", { class: easeClass[e.ease] ? `sh-${easeClass[e.ease]}` : "" },
                easeLabel[e.ease] ?? (e.type === RevlogType.Rescheduled ? "Rescheduled" : "Manual")),
              el("span", { class: "muted" }, ` · ${new Date(e.id).toLocaleString()}`))))
        : [el("div", { class: "center muted" }, "No reviews recorded yet.")];
      content.replaceChildren(el("div", { class: "muted sh-next" }, nextStudy(t.card)), ...rows);
    };
    const tabBar = el("div", { class: "filter-tabs sh-tabs" },
      ...tabs.map((t, i) => el("button", { type: "button", class: "ftab", onclick: () => showTab(i) }, t.label)));
    const { close } = openModal([
      el("h3", {}, "Study history"),
      tabBar,
      content,
      el("div", { class: "row" }, el("button", { type: "button", onclick: () => close() }, "Close")),
    ]);
    showTab(0);
  };

  const cardCount = state.col.cardsForNote(noteId).length;
  const fieldsBox = el("div", { class: "form ne-fields" },
    ...inputs.map(({ f, ed }) => el("div", { class: "fld" }, el("span", {}, f.name), ed.el)));
  fieldsBox.addEventListener("input", (e) => {
    if (!isMediaEvent(e)) scheduleSave();
    schedulePvPop();
  });
  fieldsBox.addEventListener("focusout", () => {
    if (saveTimer) { clearTimeout(saveTimer); doSave(); }
  });

  // Live preview: the note's first card rendered front + back through the
  // real pipeline, below the fields (beside them on wide screens in the
  // browse pane), updated as you type.
  const pvBox = el("div", { class: "ne-pv" });
  const updatePvPop = () => steadyPreview(pvBox, async () => {
    if (!pvBox.isConnected) return; // editor closed/replaced meanwhile
    if (model.ossIO) {
      // Image occlusion notes render their own face (fields are image + mask
      // JSON, edited by the occlusion tool — preview the saved note).
      await ensureMedia(mediaNamesInIONote(note));
      if (!pvBox.isConnected) return;
      pvBox.replaceChildren(occlusionFace(note, 0, "q"));
      wireSoundVolumes(pvBox);
      return;
    }
    const fields = inputs.map(({ ed }) => ed.getText());
    const tmpNote = new Note({ mid: model.id, fields, tags: [...noteTags], data: note.data });
    const ords = cardOrdinalsForNote(model, tmpNote);
    if (!ords.length) {
      pvBox.replaceChildren(el("div", { class: "muted pv-count" }, "No cards — fill the first field."));
      return;
    }
    applyModelCss(model);
    const deckName = state.col.decks[String(state.col.cardsForNote(note.id)[0]?.did ?? 1)]?.name ?? "";
    const { question, answer } = renderCard(model, ords[0], tmpNote, { deckName });
    await ensureMedia([...mediaNamesInHtml(question), ...mediaNamesInHtml(answer)]);
    if (!pvBox.isConnected) return;
    pvBox.replaceChildren(
      el("div", { class: "muted pv-count" },
        `Previewing "${model.tmpls[model.type === NoteTypeKind.Cloze ? 0 : ords[0]]?.name ?? ""}"`),
      el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(question) })),
      el("div", { class: "card-face pv" }, el("div", { class: "card", html: displayHtml(answer) })),
    );
    wireSoundVolumes(pvBox);
    await typesetMath(pvBox);
  });
  const schedulePvPop = debounced(updatePvPop);
  // First paint: run after the caller has attached the form (MathJax and
  // media sizing need layout).
  queueMicrotask(updatePvPop);

  const refresh = () => (cb.onCardsChanged ?? cb.onAutoSaved ?? (() => {}))();
  const noteCards = state.col.cardsForNote(noteId);
  return el("div", { class: "form note-editor" },
    el("div", { class: "muted ne-head" },
      `${model.name} · ${cardCount} card${cardCount === 1 ? "" : "s"} share this note · edits save automatically`),
    el("div", { class: "ne-main" }, fieldsBox, pvBox),
    el("div", { class: "form-tags" }, el("span", { class: "muted tag-lbl" }, "Tags"), tagBox),
    el("div", { class: "form-tags" }, el("span", { class: "muted tag-lbl" }, "Flags"),
      flagPicker(cardFlagSet(noteCards[0] ?? { flags: 0 }),
        async (n) => { await applyToNoteCards(note, (s, c) => s.toggleFlag(c, n)); refresh(); })),
    el("div", { class: "row ne-bottom" },
      el("button", { onclick: () => openDeckModalForNote(note, refresh) }, "Decks"),
      el("button", { onclick: openHistoryModal }, "Edit History"),
      el("button", { onclick: openStudyHistoryModal }, "Study History"),
      el("button", { onclick: openChangeTypeModal }, "Change Type"),
      el("button", { class: "danger", onclick: del }, "Delete"),
    ),
  );
}

function renderEditNote(noteId) {
  const back = () => renderBrowse();
  if (!state.col.notes.get(noteId)) return back();
  show(
    el("div", { class: "crumbs", onclick: back }, "← Browse"),
    el("h2", {}, "Edit"),
    noteEditorForm(noteId, {
      onDeleted: back,
      onCardsChanged: () => renderEditNote(noteId),
    }),
  );
}

// --- deck options ---

/**
 * A little info icon next to a setting that toggles an inline explanation.
 * Tap-friendly (tooltips don't exist on touch); the text also lives in
 * `title` for desktop hover.
 */
function infoBubble(text) {
  const tip = el("div", { class: "info-tip" }, text);
  tip.style.display = "none";
  const btn = el("button", {
    type: "button", class: "info-btn", title: text, "aria-label": "What does this do?",
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      tip.style.display = tip.style.display === "none" ? "" : "none";
    },
  }, icon("info"));
  return { btn, tip };
}

/** An info icon whose explanation reveals right where it sits (for inline labels). */
function infoBubbleInline(text) {
  const { btn, tip } = infoBubble(text);
  return el("span", { class: "lbl-inline-info" }, btn, tip);
}

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
  const newBury = check(nu.bury ?? false);

  const revPerDay = num(rev.perDay ?? 200);
  // Anki stores this as a collection-wide flag (shown here like Anki's deck
  // options does); the legacy per-preset key is only a fallback for old saves.
  const newIgnoreRev = check(state.col.conf.newCardsIgnoreReviewLimit ?? nu.ignoreReviewLimit ?? false);
  const autoplayChk = check(dc.autoplay ?? true);
  const maxIvl = num(rev.maxIvl ?? 36500);
  const easyBonus = num(rev.ease4 ?? 1.3, "0.05");
  const ivlMod = num(rev.ivlFct ?? 1.0, "0.05");
  const hardFactor = num(rev.hardFactor ?? 1.2, "0.05");
  const revBury = check(rev.bury ?? false);

  const lapseSteps = txt((lapse.delays ?? [10]).join(" "));
  const leechFails = num(lapse.leechFails ?? 8);
  const minInt = num(lapse.minInt ?? 1);
  const newIvlPct = num(Math.round((lapse.mult ?? 0) * 100));
  const leechAction = el("select", {}, el("option", { value: 0 }, "Suspend"), el("option", { value: 1 }, "Tag only"));
  leechAction.value = String(lapse.leechAction ?? 1);

  const fsrsOn = check(state.col.conf.fsrs === true);
  const retention = num(dc.desiredRetention ?? state.col.conf.desiredRetention ?? 0.9, "0.01");
  const fsrsParams = txt((dc.fsrsParams6 ?? []).join(", "));

  // Easy days (load balancer): tap a weekday to cycle normal → reduced → minimum.
  const easyDays = [...(dc.easyDays ?? [1, 1, 1, 1, 1, 1, 1])];
  const easyRow = el("div", { class: "easy-days" },
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, i) => {
      const b = el("button", { type: "button", class: "easy-day" }, label);
      const paint = () => {
        const v = easyDays[i];
        b.classList.toggle("ed-reduced", v > 0 && v < 1);
        b.classList.toggle("ed-minimum", v === 0);
        b.title = `${label}: ${v === 1 ? "normal load" : v === 0 ? "minimum — almost nothing scheduled" : "reduced load (~half)"}`;
      };
      b.addEventListener("click", () => {
        easyDays[i] = easyDays[i] === 1 ? 0.5 : easyDays[i] === 0.5 ? 0 : 1;
        paint();
      });
      paint();
      return b;
    }));

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
    state.col.conf.newCardsIgnoreReviewLimit = newIgnoreRev.checked;
    delete nu.ignoreReviewLimit; // legacy per-preset key; now collection-wide
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
    if (easyDays.some((v) => v !== 1)) dc.easyDays = [...easyDays];
    else delete dc.easyDays; // all-normal is the default — keep the config clean
    await putMeta(state.db, state.col);
    setStatus("Deck options saved.");
    renderDecks();
  };

  const field = (label, input, info) => {
    if (!info) return el("label", {}, label, input);
    const { btn, tip } = infoBubble(info);
    // Not a <label>: the info button is the first labelable element, so
    // clicking the label text would toggle the bubble instead of focusing
    // the input.
    return el("div", { class: "fld" }, el("span", { class: "lbl-row" }, label, btn), tip, input);
  };
  const inline = (chk, text, info) => {
    const lab = el("label", { class: "inline" }, chk, text);
    if (!info) return lab;
    const { btn, tip } = infoBubble(info);
    lab.append(btn);
    return el("div", { class: "inline-wrap" }, lab, tip);
  };
  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "add-head" },
      el("h2", {}, `Options — ${deck.name}`),
      el("div", { class: "add-actions" },
        el("button", { onclick: () => exportDeck(deck) }, "Export .apkg"),
      ),
    ),
    el("div", { class: "form" },
      consequences,
      el("h3", {}, "New cards"),
      field("Learning steps (minutes)", newSteps,
        "Delays between repetitions while a card is being learned. \"1 10\" means: see it again after 1 minute, then after 10 minutes; passing the last step turns it into a review card."),
      field("New cards/day", newPerDay,
        "How many new cards may be introduced per day from this deck. Parent and subdeck limits stack — the smallest one along the chain wins."),
      el("div", { class: "row" },
        field("Graduating interval (days)", gradGood,
          "Days until the first review after passing the final learning step with Good."),
        field("Easy interval (days)", gradEasy,
          "Days until the first review when you press Easy on a learning card — it skips the remaining steps and graduates immediately.")),
      field("Starting ease", startEase,
        "The starting interval multiplier for reviews (SM-2). At 2.5, pressing Good multiplies the interval by about 2.5×. Not used while FSRS is enabled."),
      field("Insertion order", newOrder,
        "Sequential shows newly added cards in the order you created them; Random shuffles them into the backlog."),
      inline(newBury, "Bury new siblings",
        "After studying one card of a note, its other NEW cards are hidden until tomorrow, so \"front→back\" and \"back→front\" of the same note don't appear the same day."),
      el("h3", {}, "Reviews"),
      field("Maximum reviews/day", revPerDay,
        "Cap on reviews shown per day. Learning cards that cross a day boundary count against it, and by default it also gates new-card introduction."),
      inline(newIgnoreRev, "New cards ignore review limit",
        "Keep introducing new cards even on days the review limit is already used up. Like in Anki, this is a collection-wide switch, not per preset."),
      inline(autoplayChk, "Automatically play audio",
        "Play a card's first audio/video as soon as the card is shown."),
      field("Maximum interval (days)", maxIvl,
        "Reviews are never scheduled further out than this. 36500 (100 years) effectively means no limit."),
      el("div", { class: "row" },
        field("Easy bonus", easyBonus,
          "Extra multiplier applied on top of the ease when you press Easy on a review. 1.3 = 30% longer than Good."),
        field("Hard interval", hardFactor,
          "Multiplier for Hard: the interval grows by this factor (1.2 = 20% longer) instead of the full ease."),
        field("Interval modifier", ivlMod,
          "A global dial on all SM-2 review intervals. 1.0 = unchanged, 0.9 = 10% shorter (more retention, more work).")),
      inline(revBury, "Bury review siblings",
        "After studying one card of a note, its other REVIEW cards are hidden until tomorrow."),
      el("h3", {}, "Lapses"),
      field("Relearning steps (minutes)", lapseSteps,
        "The learning steps a review card goes through after you press Again on it."),
      field("Leech threshold (lapses)", leechFails,
        "After this many lapses (and every half-threshold after), the note is tagged \"leech\" and the leech action runs. Leeches eat your study time — usually the card needs rewriting."),
      field("Minimum interval (days)", minInt,
        "A lapsed card's next review interval never drops below this many days."),
      field("New interval (% of old)", newIvlPct,
        "After relearning, the new interval is this percentage of the old one. 0% starts the card's interval over from scratch."),
      field("Leech action", leechAction,
        "What happens when a card becomes a leech: Suspend hides it until you unsuspend; Tag only just marks the note so you can find and fix it."),
      el("h3", {}, "FSRS"),
      inline(fsrsOn, "Enable FSRS (whole collection)",
        "Schedule reviews with the FSRS memory model instead of SM-2 multipliers. It predicts recall per card and picks intervals to hit your desired retention."),
      field("Desired retention (0.70–0.99)", retention,
        "The fraction of reviews you want to answer correctly. Higher means more frequent reviews: 0.90 is the default; 0.95 roughly doubles your workload."),
      field("Parameters (17/19/21 numbers, comma-separated; blank = default)", fsrsParams,
        "FSRS weights fitted to your review history (from Anki's optimizer). Leave blank to use the stock FSRS-6 defaults."),
      field("Easy days (tap to cycle)", easyRow,
        "How much review load the load balancer may place on each weekday: normal, reduced (about half), or minimum (almost nothing — for days off). Applies to this options group when the load balancer is on."),
      el("h3", {}, "Collection preferences"),
      field("Next day starts at (hour, 0–23)", rolloverHour,
        "The hour when the scheduling day rolls over. At 4, studying at 2 AM still counts as yesterday — so late-night sessions don't split across two days."),
      field("New/review order", newSpreadSel,
        "When new cards appear relative to reviews in a session: mixed evenly through them, after all reviews are done, or before them."),
      field("Learn ahead limit (minutes)", learnAhead,
        "When nothing is due right now, learning cards due within this many minutes are shown early instead of making you wait."),
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

/**
 * Seven independent flag bubbles (flags are not exclusive — a card can carry
 * red and green at once). Clicking toggles that flag immediately.
 */
function flagPicker(flagSet, onToggle) {
  return el("span", { class: "flag-picker" },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
      el("button", {
        type: "button",
        class: `flag-bub f${n}${flagSet.has(n) ? " on" : ""}`,
        title: flagSet.has(n) ? `${FLAG_NAMES[n]} (on)` : FLAG_NAMES[n],
        onclick: () => onToggle(n),
      }, icon("flag"))));
}

/**
 * Toggle a note's membership in a deck: on adds fresh cards for the note
 * there (one per template/cloze), off deletes the note's cards from it.
 * A note always stays in at least one deck.
 * @returns {Promise<boolean>} false if the toggle was refused
 */
async function toggleNoteDeck(note, did, on) {
  const noteCards = state.col.cardsForNote(note.id);
  if (on) {
    const model = state.col.noteType(note.mid);
    const existing = new Set(noteCards.filter((c) => c.did === did).map((c) => c.ord));
    for (const ord of cardOrdinalsForNote(model, note)) {
      if (existing.has(ord)) continue;
      // Restores the scheduling this note remembers for the deck, if any.
      await putCard(state.db, state.col.addNoteCardToDeck(note, did, ord));
    }
    await putMeta(state.db, state.col);
    return true;
  }
  const inDeck = noteCards.filter((c) => c.did === did);
  if (inDeck.length === noteCards.length) return false; // must stay somewhere
  const ids = state.col.removeNoteFromDeck(note.id, did);
  await deleteCards(state.db, ids);
  await putNote(state.db, note); // the archived scheduling lives on the note
  await putMeta(state.db, state.col);
  return true;
}

/**
 * Change a note's type with a field mapping: old cards are deleted, fresh
 * cards are created in the same decks, and tags/flags/deck membership carry.
 */
async function applyChangeNoteType(note, newMid, fieldMap) {
  const res = state.col.changeNoteType(note.id, newMid, fieldMap);
  if (!res) return false;
  const newModel = state.col.noteType(newMid);
  for (const did of res.decks) {
    for (const ord of cardOrdinalsForNote(newModel, note)) {
      const card = state.col.addNoteCardToDeck(note, did, ord);
      if (res.flags.size) writeCardFlags(card, res.flags);
      await putCard(state.db, card);
    }
  }
  await deleteCards(state.db, res.deletedIds);
  await putNote(state.db, note);
  await putMeta(state.db, state.col);
  return true;
}

/** Centered modal toggling which decks a note's cards live in. */
function openDeckModalForNote(note, onDone) {
  const decks = Object.values(state.col.decks).filter((d) => !d.dyn);
  const bubbles = el("div", { class: "tag-bubbles" });
  const rebuild = () => {
    const inDecks = new Set(state.col.cardsForNote(note.id).map((c) => c.did));
    bubbles.replaceChildren(...decks.map((d) =>
      el("button", {
        type: "button", class: `tag-bub${inDecks.has(d.id) ? " on" : ""}`,
        onclick: async () => {
          const ok = await toggleNoteDeck(note, d.id, !inDecks.has(d.id));
          if (!ok) setStatus("A note must stay in at least one deck.");
          rebuild();
        },
      }, d.name)));
  };
  rebuild();
  const { close } = openModal([
    el("h3", {}, "Decks"),
    el("div", { class: "muted pop-src" },
      "This note lives in the toggled decks. Each deck schedules its copies independently, and the note remembers its scheduling per deck — toggling off and back on restores it."),
    bubbles,
    el("div", { class: "row" }, el("button", { type: "button", onclick: () => close() }, "Close")),
  ], { onClose: onDone });
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
  return el("div", { class: "more-bar" },
    undoButton(),
    el("button", { class: "icon", onclick: () => renderEditNote(note.id) }, icon("pencil"), " Edit"),
    el("button", { class: "icon", onclick: () => act((s, c) => s.buryCard(c)) }, "Bury"),
    el("button", { class: "icon", onclick: () => act((s, c) => s.suspend(c)) }, "Suspend"),
    el("button", { class: "icon", onclick: () => { if (confirm("Reset to new?")) act((s, c) => s.forget(c), true); } }, "Forget"),
    el("button", { class: "icon", onclick: () => { const d = Number(prompt("Due in days?", "1")); if (Number.isFinite(d)) act((s, c) => s.setDueDate(c, d)); } }, "Set Due"),
    flagPicker(cardFlagSet(card), (n) => act((s, c) => s.toggleFlag(c, n))),
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
      el("button", { class: "io-maskchip", onclick: () => { masks.splice(i, 1); refresh(); } }, `Mask ${i + 1} ×`)));
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
  if (side === "a" && back) parts.push(el("div", { class: "io-back", html: displayHtml(mdToHtml(back)) }));
  return el("div", { class: "card-face" }, ...parts);
}

// --- note-type / template editor ---

function renderNoteTypes() {
  state.card = null;
  setActiveNav("btn-types");
  const models = Object.values(state.col.models);

  // "+ New" opens a popout panel (no native prompt/confirm popups).
  const pop = el("div", { class: "pop-panel nt-pop" });
  pop.style.display = "none";
  const nameInp = el("input", { type: "text", placeholder: "Note type name" });
  let isCloze = false;
  const yesBtn = el("button", { type: "button", class: "tag-bub" }, "Yes");
  const noBtn = el("button", { type: "button", class: "tag-bub on" }, "No");
  yesBtn.addEventListener("click", () => {
    isCloze = true;
    yesBtn.className = "tag-bub on";
    noBtn.className = "tag-bub";
  });
  noBtn.addEventListener("click", () => {
    isCloze = false;
    yesBtn.className = "tag-bub";
    noBtn.className = "tag-bub on";
  });
  const closePop = () => { pop.style.display = "none"; };
  const create = async () => {
    const name = nameInp.value.trim();
    if (!name) { nameInp.focus(); return; }
    const nt = state.col.addNoteType(name, isCloze ? NoteTypeKind.Cloze : NoteTypeKind.Standard);
    await persistAll();
    renderEditNoteType(nt.id);
  };
  nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } });
  pop.append(
    el("h3", {}, "New note type"),
    nameInp,
    el("div", { class: "row nt-cloze-row" }, el("span", { class: "muted" }, "Cloze?"), yesBtn, noBtn),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: create }, "Create"),
      el("button", { type: "button", onclick: closePop }, "Cancel")),
  );
  const add = el("button", {
    onclick: () => {
      pop.style.display = pop.style.display === "none" ? "" : "none";
      if (pop.style.display === "") nameInp.focus();
    },
  }, "+ New");
  const addWrap = el("span", { class: "pop-anchor" }, add, pop);

  const STOCK = [basicNoteType, basicReversedNoteType, basicOptionalReversedNoteType, basicTypeNoteType, clozeNoteType];
  const missing = STOCK.filter((f) => !models.some((m) => m.name === f(0).name));
  show(
    el("div", { class: "crumbs", onclick: renderDecks }, "← Decks"),
    el("div", { class: "decks-head" }, el("h2", {}, "Note Types"), addWrap),
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
      const def = el("input", {
        type: "text", class: "nt-def", value: f.default ?? "",
        placeholder: "default value (blank = none)",
        title: "Default value: prefills this field's editor when adding a card of this type",
      });
      fieldNameInputs.push({ ord: i, inp, def });
      const rm = el("button", { class: "icon", title: "Remove field",
        onclick: async () => { state.col.removeField(mid, i); await persistAll(); renderEditNoteType(mid); } }, icon("trash"));
      return el("div", { class: "nt-row" }, inp, def, nt.flds.length > 1 ? rm : "");
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
        onclick: async () => { state.col.removeTemplate(mid, i); await persistAll(); renderEditNoteType(mid); } }, icon("trash"));
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
    for (const { ord, inp, def } of fieldNameInputs) {
      state.col.renameField(mid, ord, inp.value);
      const f = state.col.noteType(mid).flds[ord];
      if (f && def.value) f.default = def.value;
      else if (f) delete f.default; // keep the JSON clean when blank
    }
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
  const updatePreview = async () => {
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
        await ensureMedia([...mediaNamesInHtml(question), ...mediaNamesInHtml(answer)]);
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
    wireSoundVolumes(previewBox);
    typesetMath();
  };
  const schedulePreview = debounced(updatePreview);
  tmplBox.addEventListener("input", schedulePreview);
  cssArea.addEventListener("input", schedulePreview);

  show(
    el("div", { class: "crumbs", onclick: renderNoteTypes }, "← Note types"),
    el("div", { class: "add-head" },
      el("h2", {}, `Edit note type${isCloze ? " (Cloze)" : ""}`),
      el("div", { class: "add-actions" }, el("button", { onclick: save }, "Save"))),
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
  setActiveNav("btn-stats");
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
  await flushStore(state.db); // land pending edits first, so the recorded stamp covers them
  const { collectionToBackup } = await import("../src/backup.js");
  // File-backed stores keep media as sibling files next to the save file
  // (synced along by Syncthing & co.), so the backup JSON is text-only.
  // IndexedDB browsers embed media in the backup as before.
  const data = JSON.stringify(collectionToBackup(state.col, hasSaveFile ? undefined : state.media));
  if (hasSaveFile) {
    // Write into the save folder — same fixed name as the automatic
    // backup: always overwritten.
    const { writeToFolder, textToBase64, folderLabel, BACKUP_FILE_NAME } =
      await import(bridgePath);
    await writeToFolder(BACKUP_FILE_NAME, textToBase64(data));
    setStatus(`Backup written to ${BACKUP_FILE_NAME} in ${await folderLabel()}.`);
    recordBackupStamp();
    updateBackupButton();
    return;
  }
  // IndexedDB browsers: no folder to write to — download instead.
  const name = `oss-anki-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Backup downloaded.");
  recordBackupStamp();
  updateBackupButton();
}

// --- automatic backup (native app only) ---

// Overwrite the same fixed-name backup file in the save folder on a timer
// and when the app is backgrounded. Skips empty/unloaded collections so a
// wiped or half-loaded state can never clobber a good backup.
const AUTO_BACKUP_INTERVAL_MS = 15 * 60 * 1000;
let autoBackupRunning = false;

// Keep the backup trailing the save file: a few seconds after edits stop
// auto-saving, snapshot to the backup file so the Backup button settles
// back to grey on its own. Cheap now that backups are text-only.
const AUTO_BACKUP_AFTER_SAVE_MS = 4 * 1000;
let autoBackupTimer = null;
function scheduleAutoBackup() {
  if (!hasSaveFile) return;
  clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => autoBackup(), AUTO_BACKUP_AFTER_SAVE_MS);
}

async function autoBackup() {
  if (!hasSaveFile || !state.db || !state.col || autoBackupRunning) return;
  if (state.col.notes.size === 0) return;
  autoBackupRunning = true;
  try {
    await flushStore(state.db); // land pending edits so the stamp covers them
    const { collectionToBackup } = await import("../src/backup.js");
    const { writeToFolder, textToBase64, BACKUP_FILE_NAME } =
      await import(bridgePath);
    // Text-only: media lives as sibling files in the same synced folder.
    const data = JSON.stringify(collectionToBackup(state.col));
    await writeToFolder(BACKUP_FILE_NAME, textToBase64(data));
    console.log(`auto-backup wrote ${BACKUP_FILE_NAME}`);
    recordBackupStamp();
    updateBackupButton();
  } catch (e) {
    console.error("auto-backup failed:", e);
  } finally {
    autoBackupRunning = false;
  }
}

async function doRestore(file) {
  try {
    const { collectionFromBackup } = await import("../src/backup.js");
    const { collection, media } = collectionFromBackup(JSON.parse(await file.text()));
    if (!confirm(`Restore this backup (${collection.cards.size} cards, ${media.size} media files)?\n\nThis REPLACES your current collection.`)) return;
    // Backups from before fields went markdown-native may hold HTML fields.
    const { migrateCollectionToMarkdown } = await import("../src/html-to-md.js");
    migrateCollectionToMarkdown(collection);
    sanitizeCurModel(collection);
    state.col = collection;
    // File-backed: media was written to sibling files by saveMedia below;
    // keep the cache empty and let it refill lazily.
    state.media = hasSaveFile ? new Map() : media;
    state.mediaUrls.clear();
    await clearAll(state.db);
    await saveCollection(state.db, collection);
    await saveMedia(state.db, media);
    setStatus(`Restored ${collection.cards.size} cards.`);
    renderDecks();
  } catch (e) {
    console.error("restore failed:", e);
    alert(`Restore failed: ${e?.message ?? e}`);
  }
}

async function doImport(file) {
  if (file.name.toLowerCase().endsWith(".json")) return doRestore(file);
  // CSV/TSV goes to the dedicated mapping screen (column → field, header,
  // delimiter) rather than being imported blindly.
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return renderImportCsv(file);
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
    // File-backed: saveMedia below writes sibling files; the cache refills
    // lazily. IndexedDB: keep the cache complete (it IS the media store view).
    if (!hasSaveFile) for (const [name, bytes] of media) state.media.set(name, bytes);
    state.mediaUrls.clear();
    sanitizeCurModel(state.col);
    await saveCollection(state.db, state.col);
    // Show the imported deck(s) NOW — media writes below can take many
    // seconds on Android (one SAF provider call per file), and with status
    // messages disabled there'd be no sign anything happened.
    renderDecks();
    await saveMedia(state.db, media);
    setStatus(`Imported: ${r.added} notes added, ${r.updated} updated.`);
  } catch (e) {
    console.error("import failed:", e);
    alert(`Import failed: ${e?.message ?? e}`);
  }
}

// --- export (.apkg, one deck at a time — from the deck's options view) ---

async function exportDeck(deck) {
  try {
    const { exportPackage, collectionForDeck } = await import("../src/apkg.js");
    const SQL = await loadSql();
    const sub = collectionForDeck(state.col, deck.id);
    // Only ship the media actually referenced by this deck's notes — fetch
    // it into the cache first (file-backed stores load media lazily).
    const names = [];
    for (const n of sub.notes.values()) {
      if (state.col.noteType(n.mid)?.ossIO) names.push(n.fields[0]); // IO image: bare filename
      for (const f of n.fields) for (const m of scanMdMedia(f)) names.push(m.name);
    }
    await ensureMedia(names);
    const media = new Map();
    for (const name of names) {
      const blob = state.media.get(name);
      if (blob) media.set(name, blob);
    }
    const bytes = exportPackage(sub, media, { SQL });
    const name = `${deck.name.replaceAll("::", "-").replace(/[\/\\:*?"<>|]/g, "_")}.apkg`;
    if (isNative) {
      // "Save as" picker — user chooses location + file name.
      const { exportFile, bytesToBase64 } = await import("./native-bridge.js");
      await exportFile(name, bytesToBase64(bytes), "application/zip"); // .apkg is a zip
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    if (/cancelled/i.test(e?.message ?? "")) return; // save-as picker dismissed
    console.error("export failed:", e);
    alert(`Export failed: ${e?.message ?? e}`);
  }
}

// --- init ---

// --- native (Capacitor Android): save folder + file-change watching ---

async function updateFolderButton() {
  const { folderLabel } = await import(bridgePath);
  const label = await folderLabel();
  const btn = document.getElementById("btn-folder");
  btn.textContent = label ? `Folder: ${label}` : "Folder";
  btn.title = label ? `Saving oss-anki.json in ${label}` : "Choose save folder";
}

/** Reload the collection from the save file (external change / folder switch). */
async function reloadFromSaveFile(statusMsg) {
  const col = await loadCollection(state.db, { force: true });
  state.col = col ?? Collection.createDefault();
  if (!col) await saveCollection(state.db, state.col);
  state.media = await loadMedia(state.db);
  state.mediaUrls.clear();
  state.card = null;
  state.lastAction = null;
  recordFileEvent("loaded");
  setStatus(statusMsg);
  renderDecks();
}

/** Pick a new save folder/file, then load whatever oss-anki.json lives there. */
async function onChangeFolder() {
  try {
    await flushStore(state.db); // don't lose pending edits to the old file
    const { pickSaveFolder, folderLabel } = await import(bridgePath);
    if (!(await pickSaveFolder())) return;
    await reloadFromSaveFile(`Save location: ${await folderLabel()}.`);
    await flushStore(state.db); // a fresh default collection lands immediately
    updateFolderButton();
  } catch (e) {
    setStatus(`Save-location switch failed: ${e.message}`);
    console.error(e);
  }
}

/** On resume: flush our edits, then reload if the file changed underneath us. */
async function onNativeResume() {
  if (!state.db) return;
  try {
    await flushStore(state.db); // last-writer-wins: pending edits land first
    const { statSaveFile } = await import(bridgePath);
    const st = await statSaveFile();
    if (st.exists && st.modified !== storeStamp(state.db)) {
      await reloadFromSaveFile("Reloaded — save file changed on disk.");
    }
  } catch (e) {
    console.error("resume reload failed:", e);
  }
}

// The save-file stamp (mtime) the last successful backup covered, persisted
// so Backup's greyed-out state survives app restarts. Absent/0 = no backup
// yet → button enabled (fails open).
const BACKUP_STAMP_KEY = "backupStamp";

function recordBackupStamp() {
  try { localStorage.setItem(BACKUP_STAMP_KEY, String(storeStamp(state.db))); } catch { /* quota */ }
}

/**
 * Grey out Backup once a backup already covers the current state: the
 * persisted backup stamp matches the save file's current stamp and there
 * are no unflushed edits. Any content change — a local edit, or a synced-in
 * external edit bumping the file mtime — re-enables it.
 */function updateBackupButton() {
  const btn = document.getElementById("btn-backup");
  const stamp = Number(localStorage.getItem(BACKUP_STAMP_KEY));
  btn.disabled = !!state.db && !storeDirty(state.db)
    && stamp > 0 && stamp === storeStamp(state.db);
}

/**
 * Companion-server mode only: if the server goes down or restarts, re-open
 * the connect gate instead of silently not-saving (it auto-reconnects with
 * the stored token once the server is back). Blocks until reconnected, then
 * reloads from the file.
 */
let serverGateOpen = false;
async function checkServerConnection() {
  if (bridgePath !== "./http-bridge.js" || serverGateOpen || !state.db) return;
  const { connectionHealth } = await import("./http-bridge.js");
  if ((await connectionHealth()) === "ok") return;
  serverGateOpen = true;
  try {
    const { ensureSaveFolder } = await import(bridgePath);
    await ensureSaveFolder(); // blocks until reconnected
    await reloadFromSaveFile("Reconnected to file server.");
    updateFolderButton();
  } catch (e) {
    console.error("server reconnect failed:", e);
  } finally {
    serverGateOpen = false;
  }
}

// --- save/load history (native) ---

// Ring buffer of the last 20 file events ({ t, kind: "saved"|"loaded" }),
// persisted so the History popup covers previous app launches too.
const FILE_HISTORY_KEY = "fileHistory";
const FILE_HISTORY_MAX = 20;

function fileHistory() {
  try { return JSON.parse(localStorage.getItem(FILE_HISTORY_KEY)) ?? []; } catch { return []; }
}

function recordFileEvent(kind, t = Date.now()) {
  const log = fileHistory();
  log.push({ t, kind });
  while (log.length > FILE_HISTORY_MAX) log.shift();
  try { localStorage.setItem(FILE_HISTORY_KEY, JSON.stringify(log)); } catch { /* quota — drop it */ }
}

/** "14:03:22" today, "Aug 1, 14:03:22" on other days. */
function fmtEventTime(t) {
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${hm}`;
}

function showHistory() {
  const log = fileHistory();
  const last = (kind) => log.findLast((e) => e.kind === kind);
  const saved = last("saved");
  const loaded = last("loaded");
  openModal([
    el("h3", {}, "Save / load history"),
    el("div", {}, `Last saved: ${saved ? fmtEventTime(saved.t) : "never"}`),
    el("div", {}, `Last loaded: ${loaded ? fmtEventTime(loaded.t) : "never"}`),
    ...(log.length ? [el("hr")] : []),
    ...log.slice().reverse().map((e) =>
      el("div", { class: "muted" }, `${fmtEventTime(e.t)} — ${e.kind}`)),
  ]);
}

async function wireNative() {
  document.getElementById("btn-folder").hidden = false;
  document.getElementById("btn-history").hidden = false;
  updateFolderButton();
  if (isNative) {
    const { watchAppState } = await import("./native-bridge.js");
    watchAppState({
      onPause: () => {
        flushStore(state.db)?.catch?.((e) => console.error("pause flush failed:", e));
        autoBackup();
      },
      onResume: () => { onNativeResume(); updateBackupButton(); },
    });
  }
  setInterval(autoBackup, AUTO_BACKUP_INTERVAL_MS);
  window.addEventListener("beforeunload", () => { flushStore(state.db); });
  updateBackupButton();
  // Poor-man's file watcher: pick up external edits (Syncthing delivering
  // changes made on another device, etc.) so the app stays up to date while
  // it sits open, keep the Backup button's greyed-out state in step, and
  // (companion-server mode) re-open the connect gate if the server drops.
  // Same last-writer-wins rule as onNativeResume — pending local edits
  // flush first.
  setInterval(() => { onNativeResume(); updateBackupButton(); checkServerConnection(); }, 3 * 1000);
}

// Light/dark theme. Each theme sets [data-theme] on <html> (the palettes are
// CSS var blocks in styles.css) plus the mobile chrome color and the toggle's
// icon (the icon shows what you'll switch TO). A new theme = one CSS block +
// one entry here; the toggle becomes a cycle through THEMES in order.
const THEMES = {
  dark: { next: "light", icon: "sun", chrome: "#191817" },
  light: { next: "dark", icon: "moon", chrome: "#f6f1e8" },
};

function applyTheme(name) {
  if (!THEMES[name]) name = "dark";
  document.documentElement.dataset.theme = name;
  localStorage.setItem("theme", name);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES[name].chrome);
  const b = document.getElementById("btn-theme");
  if (b) {
    b.replaceChildren(icon(THEMES[name].icon));
    b.title = `Switch to ${THEMES[name].next} mode`;
  }
}

function wireHeader() {
  // ☰ menu: collapse the header actions behind a toggle. State persists
  // across launches; collapsed by default.
  const header = document.querySelector("header");
  const menuBtn = document.getElementById("btn-menu");
  const actions = header.querySelector(".actions");
  const setMenuOpen = (open) => {
    actions.hidden = !open;
    header.classList.toggle("menu-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    localStorage.setItem("menuOpen", open ? "1" : "0");
  };
  menuBtn.addEventListener("click", () => {
    setMenuOpen(actions.hidden);
    menuBtn.blur(); // don't leave the ☰ looking focused/highlighted after a tap
  });
  setMenuOpen(localStorage.getItem("menuOpen") === "1");

  document.getElementById("btn-add").addEventListener("click", renderAddCard);
  document.getElementById("btn-browse").addEventListener("click", () => renderBrowse());
  document.getElementById("btn-stats").addEventListener("click", renderStats);
  document.getElementById("btn-types").addEventListener("click", renderNoteTypes);
  const fileInput = document.getElementById("file-import");
  document.getElementById("btn-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) doImport(fileInput.files[0]);
    fileInput.value = "";
  });
  document.getElementById("btn-backup").addEventListener("click", doBackup);
  document.getElementById("btn-history").addEventListener("click", showHistory);
  document.getElementById("btn-folder").addEventListener("click", onChangeFolder);

  const themeBtn = document.getElementById("btn-theme");
  themeBtn.addEventListener("click", () => {
    applyTheme(THEMES[document.documentElement.dataset.theme]?.next ?? "dark");
    themeBtn.blur(); // don't keep it looking focused after a tap
  });
  applyTheme(localStorage.getItem("theme") ?? "dark"); // icon + chrome color
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
    // Fields include contenteditable (mdEditor) — mid-study note edits must not
    // trigger flip/grade shortcuts.
    const inField = e.target?.isContentEditable || e.target?.matches?.("input, textarea, select");
    if (inField) return;
    if (!state.answerShown) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showAnswer(); }
    } else if (GRADE[e.key]) {
      e.preventDefault();
      gradeCard(GRADE[e.key]);
    }
  });
}

async function init() {
  state.db = await openCollectionDB();
  state.db.onFileEvent = (kind, t) => {
    recordFileEvent(kind, t);
    if (kind === "saved") scheduleAutoBackup();
  };
  state.db.onDirty = () => updateBackupButton();   // any edit → Backup no longer up to date
  state.db.onFlushed = () => updateBackupButton(); // auto-save settled → re-evaluate
  state.col = await loadCollection(state.db);
  if (!state.col) {
    state.col = Collection.createDefault();
    await saveCollection(state.db, state.col);
  }
  state.media = await loadMedia(state.db);
  if (hasSaveFile) recordFileEvent("loaded");
  sanitizeCurModel(state.col); // a stale curModel (e.g. from an import) would break Add Card
  // One-time migration: convert any legacy HTML fields to markdown.
  const { migrateCollectionToMarkdown } = await import("../src/html-to-md.js");
  const migrated = migrateCollectionToMarkdown(state.col);
  if (migrated > 0) {
    await saveCollection(state.db, state.col);
    setStatus(`Converted ${migrated} note${migrated > 1 ? "s" : ""} to markdown.`);
  }
  // New-day maintenance: un-bury yesterday's buried siblings, then persist.
  if (new Scheduler(state.col).unburyForNewDay() > 0) {
    await saveCollection(state.db, state.col);
  } else {
    await putMeta(state.db, state.col);
  }
  wireHeader();
  wireKeyboard();
  if (hasSaveFile) await wireNative();
  renderDecks();
}

init().catch((e) => {
  setStatus(`Error: ${e.message}`);
  console.error(e);
});
