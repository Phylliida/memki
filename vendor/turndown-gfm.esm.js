/**
 * Bundled by jsDelivr using Rollup v4.62.2 and esbuild v0.28.1.
 * Original file: /npm/turndown-plugin-gfm@1.0.2/lib/turndown-plugin-gfm.es.js
 *
 * Do NOT use SRI with dynamically generated files! More information: https://www.jsdelivr.com/using-sri-with-dynamic-files
 */
var u=/highlight-(?:text|source)-([a-z0-9]+)/;function f(e){e.addRule("highlightedCodeBlock",{filter:function(t){var n=t.firstChild;return t.nodeName==="DIV"&&u.test(t.className)&&n&&n.nodeName==="PRE"},replacement:function(t,n,r){var i=n.className||"",l=(i.match(u)||[null,""])[1];return`

`+r.fence+l+`
`+n.firstChild.textContent+`
`+r.fence+`

`}})}function s(e){e.addRule("strikethrough",{filter:["del","s","strike"],replacement:function(t){return"~"+t+"~"}})}var p=Array.prototype.indexOf,N=Array.prototype.every,a={};a.tableCell={filter:["th","td"],replacement:function(e,t){return d(e,t)}},a.tableRow={filter:"tr",replacement:function(e,t){var n="",r={left:":--",right:"--:",center:":-:"};if(o(t))for(var i=0;i<t.childNodes.length;i++){var l="---",c=(t.childNodes[i].getAttribute("align")||"").toLowerCase();c&&(l=r[c]||l),n+=d(l,t.childNodes[i])}return`
`+e+(n?`
`+n:"")}},a.table={filter:function(e){return e.nodeName==="TABLE"&&o(e.rows[0])},replacement:function(e){return e=e.replace(`

`,`
`),`

`+e+`

`}},a.tableSection={filter:["thead","tbody","tfoot"],replacement:function(e){return e}};function o(e){var t=e.parentNode;return t.nodeName==="THEAD"||t.firstChild===e&&(t.nodeName==="TABLE"||g(t))&&N.call(e.childNodes,function(n){return n.nodeName==="TH"})}function g(e){var t=e.previousSibling;return e.nodeName==="TBODY"&&(!t||t.nodeName==="THEAD"&&/^\s*$/i.test(t.textContent))}function d(e,t){var n=p.call(t.parentNode.childNodes,t),r=" ";return n===0&&(r="| "),r+e+" |"}function h(e){e.keep(function(n){return n.nodeName==="TABLE"&&!o(n.rows[0])});for(var t in a)e.addRule(t,a[t])}function m(e){e.addRule("taskListItems",{filter:function(t){return t.type==="checkbox"&&t.parentNode.nodeName==="LI"},replacement:function(t,n){return(n.checked?"[x]":"[ ]")+" "}})}function v(e){e.use([f,s,h,m])}export{v as gfm,f as highlightedCodeBlock,s as strikethrough,h as tables,m as taskListItems};
//# sourceMappingURL=/sm/608bb61c3c1560fa2fca78aa79887c20e9b35719c80f106c616679dada40d545.map