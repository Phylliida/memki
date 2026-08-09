# Vendored dependencies

Single-file ESM builds, checked in so the study app runs fully offline (no CDN
at runtime, no build step). Imported via relative paths from `src/`.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `marked.esm.js` | [marked](https://github.com/markedjs/marked) | 18.0.7 | MIT | `https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm` |
| `highlight.esm.js` | [highlight.js](https://github.com/highlightjs/highlight.js) (full build, 192 languages) | 11.11.1 | BSD-3 | `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/+esm` |
| `highlight-theme.css` | highlight.js `github-dark` theme | 11.11.1 | BSD-3 | `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github-dark.css` |
| `turndown.esm.js` | [turndown](https://github.com/mixmark-io/turndown) (HTML → markdown) | 7.2.4 | MIT | `https://cdn.jsdelivr.net/npm/turndown@7.2.4/+esm` |
| `turndown-gfm.esm.js` | [turndown-plugin-gfm](https://github.com/laurent22/turndown-plugin-gfm) | 1.0.2 | MIT | `https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/+esm` |
| `domino.esm.js` | [@mixmark-io/domino](https://github.com/fgnass/domino) (DOM for turndown in node; the browser uses its native DOMParser) | 2.2.0 | BSD-2 | `https://cdn.jsdelivr.net/npm/@mixmark-io/domino@2.2.0/+esm` |
| `fflate.esm.js` | [fflate](https://github.com/101arrowz/fflate) (`esm/browser.js`) | 0.8.3 | MIT | `https://cdn.jsdelivr.net/npm/fflate@0.8.3/+esm` |
| `fzstd.esm.js` | [fzstd](https://github.com/101arrowz/fzstd) (`esm/index.mjs`) | 0.1.1 | MIT | `https://cdn.jsdelivr.net/npm/fzstd@0.1.1/+esm` |
| `sqljs/` | [sql.js](https://github.com/sql-js/sql.js) — `sql-wasm.js` + `sqljs.esm.js` ESM facade in git; `sql-wasm.wasm` is NOT in git (prebuilt binary, F-Droid's scanner rejects blobs) — npm's postinstall (`scripts/copy-sqljs-wasm.js`) restores it from the lockfile-pinned sql.js package | 1.14.1 | MIT | `https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/` |
| `mathjax/` | [MathJax](https://github.com/mathjax/MathJax) — `tex-mml-chtml.js`; fonts from `@mathjax/mathjax-newcm-font` in `output/chtml/fonts/woff2` (v4 needed: 3.2's es5 build ships without the linebreaking engine) | 4.1.3 | Apache-2.0 | `https://cdn.jsdelivr.net/npm/mathjax@4.1.3/tex-mml-chtml.js` |

To upgrade: download the new `+esm` build over the file and bump the version
here, then run `npm test`.

`fflate`, `fzstd`, `sqljs/`, and `mathjax/` are only referenced from
`web/index.html` / `web/app.js` (deck import/export and math rendering) and
load lazily — the scheduling core never touches them.
