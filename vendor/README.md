# Vendored dependencies

Single-file ESM builds, checked in so the study app runs fully offline (no CDN
at runtime, no build step). Imported via relative paths from `src/`.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `marked.esm.js` | [marked](https://github.com/markedjs/marked) | 18.0.7 | MIT | `https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm` |
| `highlight.esm.js` | [highlight.js](https://github.com/highlightjs/highlight.js) (full build, 192 languages) | 11.11.1 | BSD-3 | `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/+esm` |
| `highlight-theme.css` | highlight.js `github-dark` theme | 11.11.1 | BSD-3 | `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github-dark.css` |

To upgrade: download the new `+esm` build over the file and bump the version
here, then run `npm test`.
