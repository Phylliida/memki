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
      isMixedLatex(x) ? textEnvsToHtml(x) : `\\[${x}\\]`)
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, x) => `\\[${stripTagsInMath(x)}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, x) => `\\(${stripTagsInMath(x)}\\)`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x) => `\\[${stripTagsInMath(x)}\\]`)
    .replace(/\$([^\s$](?:[^$]*[^\s$])?)\$(?!\d)/g, (_m, x) => `\\(${stripTagsInMath(x)}\\)`);
}
