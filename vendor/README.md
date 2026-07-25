# Vendored dependencies

Single-file ESM builds, checked in so the study app runs fully offline (no CDN
at runtime, no build step). Imported via relative paths from `src/`.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `marked.esm.js` | [marked](https://github.com/markedjs/marked) | 18.0.7 | MIT | `https://cdn.jsdelivr.net/npm/marked@18.0.7/+esm` |

To upgrade: download the new `+esm` build over the file and bump the version
here, then run `npm test`.
