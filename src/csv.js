// CSV / TSV parsing for note import.
//
// RFC 4180-ish: fields may be quoted with ", embedded quotes are doubled, and
// quoted fields may contain the delimiter and newlines. Lines beginning with #
// are treated as comments (Anki uses these for metadata like #separator:tab).

/** Parse delimited text into an array of rows (each an array of string fields). */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let started = false; // whether the current row has any content yet
  let i = 0;
  const d = delimiter;
  const pushField = () => { row.push(field); field = ""; started = true; };
  const pushRow = () => { rows.push(row); row = []; started = false; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; started = true; i++; continue; }
    if (c === d) { pushField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { pushField(); pushRow(); i++; continue; }
    field += c; started = true; i++;
  }
  if (started || field !== "") { pushField(); pushRow(); }
  return rows;
}

/** Guess the delimiter from the first non-comment line. */
export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const count = (re) => (line.match(re) || []).length;
  const tabs = count(/\t/g);
  const commas = count(/,/g);
  const semis = count(/;/g);
  if (tabs > 0 && tabs >= commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/**
 * Parse CSV/TSV text into { delimiter, rows }, dropping comment (#) and empty
 * lines. If `delimiter` is omitted it's auto-detected.
 */
export function parseCsv(text, delimiter) {
  // Strip comment lines first (they may otherwise be parsed as data).
  const cleaned = text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("#"))
    .join("\n");
  const d = delimiter || detectDelimiter(text);
  const rows = parseDelimited(cleaned, d).filter((r) => !(r.length === 1 && r[0] === ""));
  return { delimiter: d, rows };
}
