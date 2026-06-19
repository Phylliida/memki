// CSV/TSV parser tests.

import test from "node:test";
import assert from "node:assert/strict";

import { parseDelimited, detectDelimiter, parseCsv } from "../src/csv.js";

test("simple comma rows", () => {
  assert.deepEqual(parseDelimited("a,b,c\n1,2,3", ","), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("quoted fields: embedded delimiter, newline, and doubled quotes", () => {
  const text = '"a,b","line1\nline2","say ""hi"""\nx,y,z';
  assert.deepEqual(parseDelimited(text, ","), [
    ["a,b", "line1\nline2", 'say "hi"'],
    ["x", "y", "z"],
  ]);
});

test("tab delimiter", () => {
  assert.deepEqual(parseDelimited("a\tb\tc", "\t"), [["a", "b", "c"]]);
});

test("detectDelimiter prefers tabs, then semicolons, else comma", () => {
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  assert.equal(detectDelimiter("a;b;c"), ";");
  assert.equal(detectDelimiter("a,b,c"), ",");
});

test("parseCsv drops comment and blank lines, auto-detects delimiter", () => {
  const text = "#separator:comma\n#html:true\nFront,Back\n\nHola,Hello\n";
  const { delimiter, rows } = parseCsv(text);
  assert.equal(delimiter, ",");
  assert.deepEqual(rows, [["Front", "Back"], ["Hola", "Hello"]]);
});

test("trailing empty field preserved; final row without newline", () => {
  assert.deepEqual(parseDelimited("a,b,", ","), [["a", "b", ""]]);
  assert.deepEqual(parseDelimited("a,b\nc,d", ","), [["a", "b"], ["c", "d"]]);
});
