// Scratch: full render pipeline (mdToHtml → mathify) on every field of an
// .apkg, classifying math breakage.
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { initSqlJsNode } from "./src/sqljs-node.js";
import { htmlToMd } from "./src/html-to-md.js";
import { mdToHtml } from "./src/markdown.js";

// mirror of app.js mathify
function mathify(html) {
  return html
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, x) => `\\[${x}\\]`)
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, x) => `\\[${x}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, x) => `\\(${x}\\)`);
}

// Extract \[..\] and \(..\) spans and report what's inside them.
function auditMath(html) {
  const problems = [];
  const spans = [
    ...html.matchAll(/\\\[([\s\S]*?)\\\]/g).map((m) => ["display", m[1]]),
    ...html.matchAll(/\\\(([\s\S]*?)\\\)/g).map((m) => ["inline", m[1]]),
  ];
  for (const [kind, inner] of spans) {
    if (/<[a-zA-Z]/.test(inner)) problems.push(`${kind} math contains HTML tag: ${inner.slice(0, 80)}`);
    if (/\$/.test(inner)) problems.push(`${kind} math contains $: ${inner.slice(0, 80)}`);
    if (/\\begin\{(?:enumerate|itemize|description|document|center|tabular)\}/.test(inner)) {
      problems.push(`${kind} math contains text-mode env: ${inner.slice(0, 80)}`);
    }
  }
  const opens = (html.match(/\\\[/g) ?? []).length, closes = (html.match(/\\\]/g) ?? []).length;
  if (opens !== closes) problems.push(`unbalanced \\[ \\]: ${opens}/${closes}`);
  return problems;
}

const file = process.argv[2] ?? "Real_Analysis_For_Writing.apkg";
const SQL = await initSqlJsNode();
const files = unzipSync(new Uint8Array(readFileSync(file)));
const dbName = Object.keys(files).find((k) => k.startsWith("collection."));
const db = new SQL.Database(files[dbName]);
const rows = db.exec("select flds from notes")[0].values;

let bad = 0, total = 0;
const examples = [];
for (const [flds] of rows) {
  for (const f of flds.split("\x1f")) {
    if (!/\$|\[latex|\[\$/.test(f)) continue;
    total++;
    const rendered = mathify(mdToHtml(htmlToMd(f)));
    const problems = auditMath(rendered);
    if (problems.length) {
      bad++;
      if (examples.length < 6) examples.push({ f, rendered, problems });
    }
  }
}
console.log(`fields with math: ${total}, broken: ${bad}`);
for (const e of examples) {
  console.log("===");
  console.log("PROBLEMS:", e.problems.join(" | "));
  console.log("RENDERED:", e.rendered.slice(0, 280));
}
