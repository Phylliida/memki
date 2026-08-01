#!/usr/bin/env bash
# Assemble the Capacitor webDir (dist/) for the Android app.
#
# The app is plain ES modules with relative imports (web/ -> ../src, ../vendor),
# so the webDir just needs that same tree laid out verbatim, plus a root
# index.html that forwards to the real entry page (Capacitor always loads
# webDir/index.html).
#
#   dist/index.html   ← copy of web/index.html with <base href="./web/">
#                       injected (Capacitor always loads webDir/index.html;
#                       a meta-refresh redirect to ./web/ doesn't navigate
#                       in the Android WebView, so we serve the app directly)
#   dist/web/*        ← the app (minus the dev server script)
#   dist/src/*        ← the scheduling core
#   dist/vendor/*     ← vendored deps (sql.js/fflate/fzstd/MathJax/...)
#
# Run before `npx cap sync android` (npm run build:android does both).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
DIST="${1:-dist}"

rm -rf "$DIST"
mkdir -p "$DIST"

cp -R web "$DIST/web"
rm -f "$DIST/web/serve.py" # dev-only static server
cp -R src "$DIST/src"
cp -R vendor "$DIST/vendor"

# Root entry page: Capacitor always loads webDir/index.html. Instead of a
# redirect stub (meta-refresh to ./web/ doesn't navigate in the Android
# WebView — the app hung on the "Loading…" page), ship the real entry page
# with <base href="./web/"> injected as the FIRST thing in <head>, so every
# relative URL in the document (import map, styles, app.js) resolves under
# web/ exactly as if the page were served from web/index.html. Module-level
# resolution (import.meta.url, relative imports in .js files) is unaffected
# by <base> and keeps working. All URLs stay relative — everything is
# served from the APK's bundled assets, zero network requests.
sed 's|<head>|<head>\n  <base href="./web/" />|' web/index.html > "$DIST/index.html"

echo "Built $(du -sh "$DIST" | cut -f1) at $DIST/ ($(find "$DIST" -type f | wc -l) files)"
