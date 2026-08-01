#!/usr/bin/env bash
# Assemble the Capacitor webDir (dist/) for the Android app.
#
# The app is plain ES modules with relative imports (web/ -> ../src, ../vendor),
# so the webDir just needs that same tree laid out verbatim, plus a root
# index.html that forwards to the real entry page (Capacitor always loads
# webDir/index.html).
#
#   dist/index.html   ← redirect to ./web/
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

cat > "$DIST/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=./web/">
<title>oss-anki</title>
</head>
<body>
<p>Loading… <a href="./web/">tap here</a> if this page does not redirect.</p>
</body>
</html>
HTML

echo "Built $(du -sh "$DIST" | cut -f1) at $DIST/ ($(find "$DIST" -type f | wc -l) files)"
