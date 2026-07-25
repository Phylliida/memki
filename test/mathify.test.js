// MathJax delimiter normalization (src/mathify.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import { mathify } from "../src/mathify.js";

test("pure [latex] blocks become display math", () => {
  assert.equal(mathify("[latex]\\frac{1}{2}[/latex]"), "\\[\\frac{1}{2}\\]");
});

test("[$] and [$$] become inline/display math", () => {
  assert.equal(mathify("[$]x^2[/$]"), "\\(x^2\\)");
  assert.equal(mathify("[$$]x^2[/$$]"), "\\[x^2\\]");
});

test("bare $ and $$ become math; currency stays text", () => {
  assert.equal(mathify("$x_i$ and $$y_j$$"), "\\(x_i\\) and \\[y_j\\]");
  assert.equal(mathify("costs $5 and $10"), "costs $5 and $10");
});

test("mixed-content [latex] unwraps: prose stays, $..$ becomes math", () => {
  const out = mathify("[latex]A real number $s$ is the \\textit{sup} of $A$.[/latex]");
  assert.equal(out, "A real number \\(s\\) is the \\textit{sup} of \\(A\\).");
});

test("mixed [latex] with HTML unwraps without swallowing the tags", () => {
  const out = mathify("[latex]criteria:<div>$x \\leq b.$</div>[/latex]");
  assert.equal(out, "criteria:<div>\\(x \\leq b.\\)</div>");
});

test("text-mode list environments in mixed [latex] become HTML lists", () => {
  const out = mathify("[latex]\\begin{enumerate}<div>\\item[(i)] $a$</div><div>\\item[(ii)] $b$\\end{enumerate}[/latex]");
  assert.equal(out, "<ol><div><li> \\(a\\)</div><div><li> \\(b\\)</ol>");
  const ul = mathify("[latex]\\begin{itemize}\\item $x$\\end{itemize}[/latex]");
  assert.equal(ul, "<ul><li> \\(x\\)</ul>");
});

test("HTML tags are stripped inside math (author's <div> line breaks)", () => {
  const out = mathify("$$g(x) = \\begin{cases}<div>1& \\text{if } x \\in \\mathbb{Q} \\\\</div><div>0& \\text{else}</div>\\end{cases}$$");
  assert.equal(out, "\\[g(x) = \\begin{cases}1& \\text{if } x \\in \\mathbb{Q} \\\\0& \\text{else}\\end{cases}\\]");
});

test("\\( \\) and \\[ \\] pass through untouched", () => {
  assert.equal(mathify("\\(x\\) and \\[y\\]"), "\\(x\\) and \\[y\\]");
});
