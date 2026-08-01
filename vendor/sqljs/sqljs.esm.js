// ESM facade over the UMD sql-wasm.js build so the app's bare
// `import initSqlJs from "sql.js"` resolves offline (see the import map in
// web/index.html). The UMD file only knows how to publish itself as a
// browser global, so load it with a classic <script> tag and hand the
// global back as the default export. Top-level await keeps the module
// graph simple for the one lazy importer (the .apkg import/export path).
const initSqlJs = await new Promise((resolve, reject) => {
  if (window.initSqlJs) { resolve(window.initSqlJs); return; }
  const s = document.createElement("script");
  s.src = new URL("./sql-wasm.js", import.meta.url);
  s.onload = () => window.initSqlJs
    ? resolve(window.initSqlJs)
    : reject(new Error("sql-wasm.js loaded but window.initSqlJs is missing"));
  s.onerror = () => reject(new Error("failed to load vendored sql-wasm.js"));
  document.head.appendChild(s);
});
export default initSqlJs;
