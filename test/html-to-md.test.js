// HTML → markdown conversion (src/html-to-md.js, vendored turndown).
import { test } from "node:test";
import assert from "node:assert/strict";

import { htmlToMd, looksLikeHtml, htmlFieldToMd, migrateCollectionToMarkdown } from "../src/html-to-md.js";
import { Collection, Note } from "../src/model.js";

test("inline formatting converts", () => {
  assert.equal(htmlToMd("<b>bold</b> and <i>em</i>"), "**bold** and *em*");
  assert.equal(htmlToMd("<div>line1</div><div>line2</div>"), "line1\n\nline2");
  assert.equal(htmlToMd("a<br>b"), "a\nb");
});

test("lists and tables (GFM) convert", () => {
  assert.equal(htmlToMd("<ul><li>one</li><li>two</li></ul>"), "-   one\n-   two");
  assert.equal(
    htmlToMd("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"),
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
  );
});

test("images keep their width as {width=N}", () => {
  assert.equal(htmlToMd('<img src="img-1.png">'), "![](img-1.png)");
  assert.equal(htmlToMd('<img src="img-1.png" width="200">'), "![](img-1.png){width=200}");
});

test("protected spans survive untouched (no escaping)", () => {
  assert.equal(htmlToMd("[sound:snd-1.mp3]"), "[sound:snd-1.mp3]");
  assert.equal(htmlToMd("\\(x_i\\) and \\[y_j\\]"), "\\(x_i\\) and \\[y_j\\]");
  assert.equal(htmlToMd("[latex]a_i[/latex]"), "[latex]a_i[/latex]");
  assert.equal(htmlToMd("[$]x[/$] and [$$]y[/$$]"), "[$]x[/$] and [$$]y[/$$]");
  assert.equal(htmlToMd("$x_i$ and $$y_j$$"), "$x_i$ and $$y_j$$");
  assert.equal(htmlToMd("<b>[sound:a.mp3] \\(x\\)</b>"), "**[sound:a.mp3] \\(x\\)**");
});

test("cloze markers survive, HTML inside them converts", () => {
  assert.equal(htmlToMd("<b>{{c1::<i>Paris</i>}}</b>"), "**{{c1::*Paris*}}**");
});

test("looksLikeHtml only fires on real tags", () => {
  assert.ok(looksLikeHtml("<b>x</b>"));
  assert.ok(looksLikeHtml('<img src="a.png">'));
  assert.ok(!looksLikeHtml("a < b and c > d"));
  assert.ok(!looksLikeHtml("see <https://example.com>"));
  assert.ok(!looksLikeHtml("**bold** [sound:a.mp3] \\(x\\)"));
  assert.equal(htmlFieldToMd("plain markdown **bold**"), "plain markdown **bold**");
});

test("migrateCollectionToMarkdown converts HTML notes only, recomputing sfld/csum", () => {
  const col = Collection.createDefault();
  const mid = Object.values(col.models)[0].id;
  const html = new Note({ mid, fields: ["<b>Berlin</b>", "capital"] }).normalize();
  const md = new Note({ mid, fields: ["**Paris**", "capital"] }).normalize();
  col.addNote(html);
  col.addNote(md);
  const mdCsumBefore = md.csum;

  const changed = migrateCollectionToMarkdown(col);
  assert.equal(changed, 1);
  assert.deepEqual(html.fields, ["**Berlin**", "capital"]);
  assert.equal(html.sfld, "**Berlin**"); // recomputed on the markdown source
  assert.deepEqual(md.fields, ["**Paris**", "capital"]); // untouched
  assert.equal(md.csum, mdCsumBefore);
});
