// Template renderer tests.

import test from "node:test";
import assert from "node:assert/strict";

import { renderTemplate, renderCard, fieldMap, clozeFilter, clozeNumbers, typeDiff } from "../src/template.js";
import { basicNoteType, clozeNoteType, Note } from "../src/model.js";

test("renderCard renders a Basic note's question and answer", () => {
  const nt = basicNoteType(123, "Basic");
  const note = new Note({ mid: 123, fields: ["Hello <b>world</b>", "The answer"] });
  const { question, answer } = renderCard(nt, 0, note);
  assert.equal(question, "Hello <b>world</b>");
  assert.equal(answer, "Hello <b>world</b>\n\n<hr id=answer>\n\nThe answer");
});

test("{{text:Field}} strips HTML", () => {
  assert.equal(renderTemplate("{{text:Front}}", { fields: { Front: "a<b>b</b>c" } }), "abc");
});

test("{{#Field}} shows when non-empty, {{^Field}} when empty", () => {
  const t = "{{#Extra}}[{{Extra}}]{{/Extra}}{{^Extra}}none{{/Extra}}";
  assert.equal(renderTemplate(t, { fields: { Extra: "" } }), "none");
  assert.equal(renderTemplate(t, { fields: { Extra: "hi" } }), "[hi]");
});

test("{{FrontSide}} is available in the answer context", () => {
  assert.equal(renderTemplate("{{FrontSide}} / {{Back}}", { fields: { Back: "B" }, FrontSide: "F" }), "F / B");
});

test("nested conditionals resolve correctly", () => {
  const t = "{{#A}}A{{#B}}B{{/B}}{{/A}}";
  assert.equal(renderTemplate(t, { fields: { A: "x", B: "y" } }), "AB");
  assert.equal(renderTemplate(t, { fields: { A: "x", B: "" } }), "A");
  assert.equal(renderTemplate(t, { fields: { A: "", B: "y" } }), "");
});

test("fieldMap maps a note's fields by name", () => {
  const nt = basicNoteType(1);
  const note = new Note({ mid: 1, fields: ["Q", "A"] });
  assert.deepEqual(fieldMap(nt, note), { Front: "Q", Back: "A" });
});

test("unknown fields render as empty, media tags pass through untouched", () => {
  assert.equal(renderTemplate("{{Missing}}", { fields: {} }), "");
  assert.equal(renderTemplate('{{Front}}', { fields: { Front: '<img src="cat.jpg">' } }), '<img src="cat.jpg">');
});

test("cloze: active deletion hides on the question, reveals on the answer", () => {
  const text = "The {{c1::cat}} sat on the {{c2::mat}}";
  assert.equal(clozeFilter(text, 1, "q"),
    'The <span class="cloze" data-ordinal="1">[...]</span> sat on the <span class="cloze-inactive" data-ordinal="2">mat</span>');
  assert.equal(clozeFilter(text, 1, "a"),
    'The <span class="cloze" data-ordinal="1">cat</span> sat on the <span class="cloze-inactive" data-ordinal="2">mat</span>');
  assert.match(clozeFilter(text, 2, "q"), /sat on the <span class="cloze" data-ordinal="2">\[\.\.\.\]<\/span>/);
});

test("cloze: hint is shown in brackets on the question", () => {
  assert.equal(clozeFilter("{{c1::Paris::capital}}", 1, "q"),
    '<span class="cloze" data-ordinal="1">[capital]</span>');
});

test("cloze: nested clozes render at both levels (2.1.56+ behavior)", () => {
  const text = "{{c1::the {{c2::inner}} part}}";
  // c1 active: whole thing hidden on the question.
  assert.equal(clozeFilter(text, 1, "q"), '<span class="cloze" data-ordinal="1">[...]</span>');
  // c1 answer: content revealed, inner c2 wrapped as inactive.
  assert.equal(clozeFilter(text, 1, "a"),
    '<span class="cloze" data-ordinal="1">the <span class="cloze-inactive" data-ordinal="2">inner</span> part</span>');
  // c2 active: only the inner span hidden; outer renders as inactive.
  assert.equal(clozeFilter(text, 2, "q"),
    '<span class="cloze-inactive" data-ordinal="1">the <span class="cloze" data-ordinal="2">[...]</span> part</span>');
});

test("clozeNumbers finds distinct ordinals, including nested", () => {
  assert.deepEqual([...clozeNumbers("{{c1::a}} {{c2::b}} {{c1::c}}")].sort(), [1, 2]);
  assert.deepEqual([...clozeNumbers("{{c1::a {{c3::b}}}}")].sort(), [1, 3]);
});

test("type-in-the-answer: input on question, char diff on answer", () => {
  const nt = basicNoteType(7);
  nt.tmpls[0].qfmt = "{{type:Back}}";
  const note = new Note({ mid: 7, fields: ["Q", "Paris"] });
  const q = renderCard(nt, 0, note, {});
  assert.match(q.question, /<input[^>]*id="typeans"/);

  // Correct: one typeGood span, no arrow.
  const right = typeDiff("Paris", "Paris");
  assert.match(right, /<span class=typeGood>Paris<\/span>/);
  assert.doesNotMatch(right, /typearrow/);

  // Wrong: provided line with typeBad, arrow, expected line with typeMissed.
  const wrong = typeDiff("Paros", "Paris");
  assert.match(wrong, /typeBad/);
  assert.match(wrong, /typeMissed/);
  assert.match(wrong, /typearrow/);
  assert.match(wrong, /<span class=typeGood>Par<\/span>/); // shared prefix is good

  // Missed characters appear as dashes on the provided line.
  assert.match(typeDiff("", "abc"), /<span class=typeBad>---<\/span>/);
  assert.match(typeDiff("<b>x</b>", "y"), /&lt;b&gt;x&lt;\/b&gt;/); // typed text is escaped
});

test("{{type:cloze:Text}} expects the active cloze answers", () => {
  const nt = clozeNoteType(9);
  nt.tmpls[0].qfmt = "{{cloze:Text}}\n{{type:cloze:Text}}";
  nt.tmpls[0].afmt = "{{cloze:Text}}\n{{type:cloze:Text}}";
  const note = new Note({ mid: 9, fields: ["{{c1::alpha}} and {{c1::beta}} and {{c2::gamma}}", ""] });
  const a = renderCard(nt, 0, note, { typed: "alpha, beta" });
  assert.match(a.answer, /<span class=typeGood>alpha, beta<\/span>/); // both c1 answers expected
});

test("renderCard on a Cloze note type selects by ordinal", () => {
  const nt = clozeNoteType(5);
  const note = new Note({ mid: 5, fields: ["The {{c1::cat}} sat on the {{c2::mat}}", "extra"] });
  const c0 = renderCard(nt, 0, note); // ord 0 → cloze 1
  assert.match(c0.question, /The <span class="cloze" data-ordinal="1">\[\.\.\.\]<\/span> sat/);
  assert.match(c0.answer, /The <span class="cloze" data-ordinal="1">cat<\/span> sat/);
  assert.match(c0.answer, /extra/); // Back Extra included on the answer
  const c1 = renderCard(nt, 1, note); // ord 1 → cloze 2
  assert.match(c1.question, /sat on the <span class="cloze" data-ordinal="2">\[\.\.\.\]<\/span>/);
});

test("special fields: Deck, Subdeck, Card, Type, CardFlag, and conditionals", () => {
  const nt = basicNoteType(11);
  nt.tmpls[0].qfmt = "{{Deck}}|{{Subdeck}}|{{Card}}|{{Type}}|{{#CardFlag}}F={{CardFlag}}{{/CardFlag}}";
  const note = new Note({ mid: 11, fields: ["Q", "A"] });
  const r = renderCard(nt, 0, note, { deckName: "Lang::French", flag: 3 });
  assert.equal(r.question, "Lang::French|French|Card 1|Basic|F=flag3");
  const noFlag = renderCard(nt, 0, note, { deckName: "Solo" });
  assert.equal(noFlag.question, "Solo|Solo|Card 1|Basic|");
});

test("{{hint:Field}} renders a show-hint link; empty hints render nothing", () => {
  const out = renderTemplate("{{hint:Extra}}", { fields: { Extra: "a clue" } });
  assert.match(out, /class=hint/);
  assert.match(out, /a clue/);
  assert.match(out, /Extra<\/a>/); // link text is the field name
  assert.equal(renderTemplate("{{hint:Extra}}", { fields: { Extra: "" } }), "");
});

test("furigana / kanji / kana filters split kanji[reading] pairs", () => {
  const fields = { F: "日本語[にほんご]" };
  assert.equal(renderTemplate("{{furigana:F}}", { fields }),
    "<ruby><rb>日本語</rb><rt>にほんご</rt></ruby>");
  assert.equal(renderTemplate("{{kanji:F}}", { fields }), "日本語");
  assert.equal(renderTemplate("{{kana:F}}", { fields }), "にほんご");
});

test("filter chains apply right-to-left", () => {
  // text: strips the HTML that survives cloze rendering.
  const fields = { T: "<b>{{c1::word}}</b>" };
  const out = renderTemplate("{{text:cloze:T}}", { fields, clozeOrd: 1, side: "a" });
  assert.equal(out, "word");
});
