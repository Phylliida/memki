#!/usr/bin/env bash
# Build sql.js from source and install the result over the vendored copy.
#
# Why: F-Droid only ships binaries it built from source itself, and its
# source scanner rejects the prebuilt sql-wasm.wasm that the npm sql.js
# package ships (scripts/copy-sqljs-wasm.js restores that one for local
# dev). The F-Droid recipe runs this script in its `build:` phase instead —
# AFTER the source scan, since the scanner flags .wasm by file type
# regardless of provenance.
#
# Reproducible-builds parity: F-Droid verifies its build against the APK
# from GitHub Releases, so both must contain byte-identical wasm. The
# GitHub release workflow runs this same script inside a debian:trixie
# container (matching the F-Droid buildserver image and its emscripten).
#
# Requires on PATH: git curl unzip make sha3sum emcc node
# (Debian: apt-get install emscripten make curl unzip libdigest-sha3-perl git nodejs)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SQLJS_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/sql.js'].version")"
echo "Building sql.js v$SQLJS_VERSION from source"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "v$SQLJS_VERSION" https://github.com/sql-js/sql.js.git "$WORK/sql.js"
cd "$WORK/sql.js"

# sql.js's Makefile downloads and checksums the SQLite amalgamation itself.
# EMFLAGS_OPTIMIZED override: the default adds `--closure 1`, which needs the
# Closure compiler (not reliably available) and only minifies the JS
# wrapper — the .wasm output is unaffected, and dropping it keeps the output
# deterministic across environments.
make -j"$(nproc)" EMFLAGS_OPTIMIZED='-Oz -flto' dist/sql-wasm.js

# Install over every copy the app build packages. dist/ and the android
# assets only exist after scripts/build-capacitor.sh / `cap sync` have run
# (F-Droid ordering); when run earlier (release workflow) only vendor/
# exists and the normal copy chain propagates it.
for dest in \
  vendor/sqljs \
  dist/vendor/sqljs \
  android/app/src/main/assets/public/vendor/sqljs; do
  if [ -d "$REPO_ROOT/$dest" ]; then
    cp dist/sql-wasm.js dist/sql-wasm.wasm "$REPO_ROOT/$dest/"
  fi
done
echo "Installed from-source sql.js $SQLJS_VERSION (wasm sha256: $(sha256sum dist/sql-wasm.wasm | cut -c1-16)…)"
