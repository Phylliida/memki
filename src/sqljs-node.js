// Node-only convenience: initialize sql.js, locating its bundled .wasm regardless
// of the current working directory. Browser consumers should initialize sql.js
// themselves (e.g. with a wasm URL via `locateFile`) and pass the resulting
// module to importPackage({ SQL }). Keeping this separate keeps src/apkg.js
// environment-agnostic.

import { createRequire } from "node:module";
import path from "node:path";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

/** @returns {Promise<any>} an initialized sql.js module to pass as { SQL }. */
export function initSqlJsNode() {
  const distDir = path.dirname(require.resolve("sql.js"));
  return initSqlJs({ locateFile: (f) => path.join(distDir, f) });
}
