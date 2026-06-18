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
  assert.equal(clozeFilter(text, 1, "q"), 'The <span class="cloze">[...]</span> sat on the mat');
  assert.equal(clozeFilter(text, 1, "a"), 'The <span class="cloze">cat</span> sat on the mat');
  assert.equal(clozeFilter(text, 2, "q"), 'The cat sat on the <span class="cloze">[...]</span>');
});

test("cloze: hint is shown in brackets on the question", () => {
  assert.equal(clozeFilter("{{c1::Paris::capital}}", 1, "q"), '<span class="cloze">[capital]</span>');
});

test("clozeNumbers finds distinct ordinals", () => {
  assert.deepEqual([...clozeNumbers("{{c1::a}} {{c2::b}} {{c1::c}}")].sort(), [1, 2]);
});

test("type-in-the-answer: input on question, diff on answer", () => {
  const nt = basicNoteType(7);
  nt.tmpls[0].qfmt = "{{type:Back}}";
  const note = new Note({ mid: 7, fields: ["Q", "Paris"] });
  const q = renderCard(nt, 0, note, {});
  assert.match(q.question, /<input[^>]*id="typeans"/);

  assert.match(typeDiff("Paris", "Paris"), /class="typeans-result correct"/);
  const wrong = typeDiff("Parris", "Paris");
  assert.match(wrong, /typed-bad/);
  assert.match(wrong, /typed-good/);
  assert.match(typeDiff("<b>x</b>", "y"), /&lt;b&gt;x&lt;\/b&gt;/); // typed text is escaped
});

test("renderCard on a Cloze note type selects by ordinal", () => {
  const nt = clozeNoteType(5);
  const note = new Note({ mid: 5, fields: ["The {{c1::cat}} sat on the {{c2::mat}}", "extra"] });
  const c0 = renderCard(nt, 0, note); // ord 0 → cloze 1
  assert.match(c0.question, /The <span class="cloze">\[\.\.\.\]<\/span> sat on the mat/);
  assert.match(c0.answer, /The <span class="cloze">cat<\/span> sat/);
  assert.match(c0.answer, /extra/); // Back Extra included on the answer
  const c1 = renderCard(nt, 1, note); // ord 1 → cloze 2
  assert.match(c1.question, /sat on the <span class="cloze">\[\.\.\.\]<\/span>/);
});
