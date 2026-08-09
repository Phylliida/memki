// Restores vendor/sqljs/sql-wasm.wasm from the pinned npm sql.js package.
// The wasm is a prebuilt binary, so it is NOT kept in git (F-Droid's source
// scanner rejects prebuilt binaries); package-lock.json pins sql.js, so every
// environment installs byte-identical files and builds stay reproducible.
// Runs as npm's postinstall — npm ci/install covers local dev, the release
// workflow, and the F-Droid buildserver alike.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlJsDist = dirname(require.resolve("sql.js")); // node_modules/sql.js/dist
copyFileSync(
  join(sqlJsDist, "sql-wasm.wasm"),
  new URL("../vendor/sqljs/sql-wasm.wasm", import.meta.url),
);
