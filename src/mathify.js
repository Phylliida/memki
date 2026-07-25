// MathJax delimiter normalization for card HTML (used by the display pipeline
// in web/app.js). Anki syntaxes — [latex]..[/latex], [$]..[/$], [$$]..[/$$] —
// plus bare $..$ / $$..$$ become the \( .. \) / \[ .. \] delimiters that the
// app's MathJax config typesets.

// A [latex] block whose content mixes prose/HTML with $..$ math is NOT pure
// TeX — wrapping it in \[ ..\] makes MathJax choke on the text, tags, and $
// signs. Such blocks (common in decks authored for Anki's old LaTeX-image
// era, which rendered full LaTeX documents) are unwrapped instead, and their
// $..$ / $$..$$ spans become math below.
const isMixedLatex = (x) => /\$|<[a-zA-Z]/.test(x);

// Text-mode list environments (unsupported by MathJax) become HTML lists.
const textEnvsToHtml = (x) =>
  x
    .replace(/\\begin\{(enumerate|itemize)\}/g, (_m, e) => (e === "itemize" ? "<ul>" : "<ol>"))
    .replace(/\\end\{(enumerate|itemize)\}/g, (_m, e) => (e === "itemize" ? "</ul>" : "</ol>"))
    .replace(/\\item(?:\[[^\]]*\])?/g, "<li>");

// LaTeX prose commands in unwrapped mixed blocks: spacing, breaks, and simple
// formatting. Math spans ($..$ / $$..$$) are stashed first — spacing commands
// inside math are MathJax's job and must not be rewritten.
function cleanLatexProse(x) {
  const stash = [];
  const stashed = x
    .replace(/\$\$[\s\S]+?\$\$/g, (m) => `\uE000${stash.push(m) - 1}\uE001`)
    .replace(/\$[^\s$](?:[^$]*[^\s$])?\$(?!\d)/g, (m) => `\uE000${stash.push(m) - 1}\uE001`);
  const fixed = stashed
    .replace(/\\\\/g, "<br>") // prose line break (before the spacing commands eat one backslash)
    .replace(/\\qquad\b/g, "\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0")
    .replace(/\\quad\b/g, "\u00a0\u00a0\u00a0\u00a0")
    .replace(/\\[,;:!]|\\ /g, "\u00a0") // \, \; \: \! and control space
    .replace(/\\(?:bigskip|medskip|smallskip|bigbreak|medbreak|smallbreak)\b/g, "")
    .replace(/\\textit\{([^{}]*)\}/g, "<i>$1</i>")
    .replace(/\\textbf\{([^{}]*)\}/g, "<b>$1</b>")
    .replace(/\\emph\{([^{}]*)\}/g, "<em>$1</em>")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\([{}%$#_])/g, "$1") // escaped punctuation
    .replace(/\\&/g, "&amp;")
    .replace(/~/g, "\u00a0");
  return fixed.replace(/\uE000(\d+)\uE001/g, (_m, i) => stash[Number(i)]);
}

// Math can't contain HTML, but authors sometimes use <div>/<br> as line
// breaks inside $$..$$ (their \\ separators already break the lines).
const stripTagsInMath = (x) => x.replace(/<[^>]+>/g, "");

/**
 * Normalize all math syntaxes in rendered card HTML to \( .. \) / \[ .. \].
 * `\[ .. \]` and `\( .. \)` pass through untouched (markdown.js may already
 * have produced them).
 */
export function mathify(html) {
  return html
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, x) =>
      isMixedLatex(x) ? textEnvsToHtml(cleanLatexProse(x)) : `\\[${x}\\]`)
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, x) => `\\[${stripTagsInMath(x)}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, x) => `\\(${stripTagsInMath(x)}\\)`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x) => `\\[${stripTagsInMath(x)}\\]`)
    .replace(/\$([^\s$](?:[^$]*[^\s$])?)\$(?!\d)/g, (_m, x) => `\\(${stripTagsInMath(x)}\\)`);
}
