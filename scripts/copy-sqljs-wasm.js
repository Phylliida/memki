// Restores vendor/sqljs/sql-wasm.wasm from the pinned npm sql.js package.
// The wasm is a prebuilt binary, so it is NOT kept in git (F-Droid's source
// scanner rejects prebuilt binaries); package-lock.json pins sql.js, so local
// dev installs stay byte-identical. Runs as npm's postinstall for local dev.
// Release builds are different: F-Droid ships no prebuilt binaries, so its
// recipe (and the GitHub release workflow, byte-identical to F-Droid via
// reproducible builds) compiles sql.js from source instead — see
// scripts/build-sqljs-from-source.sh.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlJsDist = dirname(require.resolve("sql.js")); // node_modules/sql.js/dist
copyFileSync(
  join(sqlJsDist, "sql-wasm.wasm"),
  new URL("../vendor/sqljs/sql-wasm.wasm", import.meta.url),
);
