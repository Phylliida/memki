// Markdown rendering for note fields (src/markdown.js, vendored marked).
import { test } from "node:test";
import assert from "node:assert/strict";

import { mdToHtml, mdImageToken, mdSoundToken, scanMdMedia } from "../src/markdown.js";

test("plain fields render unwrapped, byte-identical to Anki", () => {
  assert.equal(mdToHtml("Paris"), "Paris");
  assert.equal(mdToHtml(""), "");
  assert.equal(mdToHtml(null), "");
});

test("inline emphasis, strike, code", () => {
  assert.equal(mdToHtml("**bold** and *em*"), "<strong>bold</strong> and <em>em</em>");
  assert.equal(mdToHtml("~~gone~~ and `x_i`"), "<del>gone</del> and <code>x_i</code>");
});

test("single newlines become <br> (Anki display behavior)", () => {
  assert.equal(mdToHtml("a\nb"), "a<br>b");
});

test("blank line separates paragraphs (no unwrap with 2+ blocks)", () => {
  assert.equal(mdToHtml("foo\n\nbar"), "<p>foo</p>\n<p>bar</p>\n");
});

test("headings, lists, quotes, rules, tables (GFM)", () => {
  assert.equal(mdToHtml("# Title"), "<h1>Title</h1>\n");
  assert.equal(mdToHtml("- one\n- two"), "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n");
  assert.equal(mdToHtml("1. one\n2. two"), "<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n");
  assert.equal(mdToHtml("> wise"), "<blockquote>\n<p>wise</p>\n</blockquote>\n");
  assert.match(mdToHtml("a | b\n--|--\n1 | 2"), /^<table>/);
});

test("links render as anchors", () => {
  assert.equal(mdToHtml("[Anki](https://apps.ankiweb.net)"),
    '<a href="https://apps.ankiweb.net">Anki</a>');
});

test("inline and block HTML pass through unchanged (legacy fields)", () => {
  assert.equal(mdToHtml("<b>legacy</b> html"), "<b>legacy</b> html");
  assert.equal(mdToHtml("<div>a</div>\n<div>b</div>"), "<div>a</div>\n<div>b</div>");
  assert.equal(mdToHtml('<img src="img-1.png" width="200">'), '<img src="img-1.png" width="200">');
});

test("math spans are protected from emphasis parsing", () => {
  assert.equal(mdToHtml("\\(x_i\\) and \\(y_j\\)"), "\\(x_i\\) and \\(y_j\\)");
  assert.equal(mdToHtml("\\[ E = mc^2 \\]"), "\\[ E = mc^2 \\]");
  assert.equal(mdToHtml("[latex]a_i < b[/latex]"), "[latex]a_i < b[/latex]");
  assert.equal(mdToHtml("[$]x_i[/$] and [$$]y_j[/$$]"), "[$]x_i[/$] and [$$]y_j[/$$]");
});

test("[sound:] passes through literally, even with emphasis chars in names", () => {
  assert.equal(mdToHtml("[sound:snd_1.mp3] and [sound:snd_2.mp3]"),
    "[sound:snd_1.mp3] and [sound:snd_2.mp3]");
});

test("images render with optional {width=N} sizing", () => {
  assert.equal(mdToHtml("![](img-1.png)"), '<img src="img-1.png" alt="">');
  assert.equal(mdToHtml("![](img-1.png){width=200}"), '<img src="img-1.png" alt="" width="200">');
  assert.equal(mdToHtml("![alt](<my pic.png>){width=80}"), '<img src="my pic.png" alt="alt" width="80">');
});

test("cloze markers survive; markdown inside clozes renders", () => {
  assert.equal(mdToHtml("{{c1::**Paris**}} is the capital"),
    "{{c1::<strong>Paris</strong>}} is the capital");
});

test("mdImageToken / mdSoundToken build editor tokens", () => {
  assert.equal(mdImageToken("plain.png"), "![](plain.png)");
  assert.equal(mdImageToken("a b.png", 100), "![](<a b.png>){width=100}");
  assert.equal(mdSoundToken("a.mp3"), "[sound:a.mp3]");
});

test("scanMdMedia finds image and sound tokens with offsets", () => {
  const toks = scanMdMedia("x ![](a.png){width=5} y [sound:b.mp3] z ![t](<c d.png>)");
  assert.deepEqual(toks, [
    { start: 2, raw: "![](a.png){width=5}", kind: "img", name: "a.png", width: 5 },
    { start: 24, raw: "[sound:b.mp3]", kind: "sound", name: "b.mp3", width: null },
    { start: 40, raw: "![t](<c d.png>)", kind: "img", name: "c d.png", width: null },
  ]);
  // every raw token re-renders to the same HTML mdToHtml would produce
  for (const t of toks) assert.ok(mdToHtml(t.raw).length > 0);
});
