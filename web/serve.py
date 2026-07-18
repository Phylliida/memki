#!/usr/bin/env python3
"""Dev server: python http.server with caching disabled, so edited modules
are always refetched (plain `python -m http.server` lets browsers cache
app.js heuristically, serving stale code after edits)."""

import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
