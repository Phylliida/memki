// Template renderer tests.

import test from "node:test";
import assert from "node:assert/strict";

import { renderTemplate, renderCard, fieldMap } from "../src/template.js";
import { basicNoteType, Note } from "../src/model.js";

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
