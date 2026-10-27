import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeHtml, renderMathText, tokenizeMathText } from "../lib/math-text.ts";

test("ordinary prose, whitespace, escaped dollars, and prices stay readable", () => {
  const prose = "A sentence.\nAnother line & a < b.";
  assert.deepEqual(tokenizeMathText(prose), [{ kind: "text", text: prose }]);
  assert.equal(renderMathText(prose), "A sentence.\nAnother line &amp; a &lt; b.");
  assert.equal(renderMathText(String.raw`It costs \$5 and \$10.`), "It costs $5 and $10.");
  assert.equal(renderMathText("It costs $5 and $10."), "It costs $5 and $10.");
  assert.equal(escapeHtml(`<&"'>`), "&lt;&amp;&quot;&#39;&gt;");
});

test("all four delimiters distinguish inline and display math", () => {
  const tokens = tokenizeMathText(String.raw`Let $x^2$ and \(y_1\) satisfy $$x=y$$, hence \[x+y=0\].`);
  const math = tokens.filter((token) => token.kind === "math");
  assert.deepEqual(math.map(({ text, display }) => ({ text, display })), [
    { text: "x^2", display: false }, { text: "y_1", display: false },
    { text: "x=y", display: true }, { text: "x+y=0", display: true },
  ]);
  const html = renderMathText(String.raw`A $\mathbb{P}^2$ and \[\sum_{i=1}^{n} i\].`);
  assert.match(html, /class="math-inline"/);
  assert.match(html, /class="math-display"/);
  assert.match(html, /class="katex-mathml"/);
  assert.doesNotMatch(html, /math-fallback/);
});

test("equation, align, gather, and displaymath environments render independently", () => {
  for (const environment of ["equation", "equation*", "align", "align*", "gather", "gather*", "displaymath"]) {
    const source = `Before \\begin{${environment}}x=1\\end{${environment}} after`;
    const math = tokenizeMathText(source).filter((token) => token.kind === "math");
    assert.equal(math.length, 1, environment);
    assert.equal(math[0].display, true);
    assert.match(renderMathText(source), /class="katex-display"/, environment);
    assert.doesNotMatch(renderMathText(source), /math-fallback/, environment);
  }
  assert.doesNotMatch(renderMathText(String.raw`\begin{align}x&=1\\y&=2\end{align}`), /math-fallback/);
});

test("escaped delimiters, grouped dollars, and comments do not end math early", () => {
  const escaped = tokenizeMathText(String.raw`$\text{cost: \$5}+x$ after`);
  assert.equal(escaped[0].kind, "math");
  assert.equal(escaped[0].text, String.raw`\text{cost: \$5}+x`);
  const commented = tokenizeMathText("$x % $ ignored\n+y$ after");
  assert.equal(commented[0].kind, "math");
  assert.equal(commented[0].text, "x % $ ignored\n+y");
  assert.deepEqual(tokenizeMathText(String.raw`\\(ordinary text\\)`), [{ kind: "text", text: String.raw`\\(ordinary text\\)` }]);
});

test("unclosed, empty, and unsupported math keeps readable original source", () => {
  for (const source of ["Unclosed $x+1", String.raw`Unclosed \[x`, "Empty $$$$", String.raw`\begin{align}x=1`]) {
    assert.equal(renderMathText(source), escapeHtml(source));
  }
  const unsupported = String.raw`Before $\notARealFyrCommand{x}$ after`;
  assert.equal(renderMathText(unsupported), String.raw`Before <span class="math-inline math-fallback">$\notARealFyrCommand{x}$</span> after`);
  assert.match(renderMathText(String.raw`\[\frac{x}\]`), /math-fallback/);
});

test("prose and malformed math cannot introduce executable markup", () => {
  const malicious = `<img src=x onerror="alert(1)"><script>alert(1)</script>`;
  assert.equal(renderMathText(malicious), escapeHtml(malicious));
  for (const source of [
    `$\\text{${malicious}}$`, `$\\unknown{${malicious}}$`,
    String.raw`$\href{javascript:alert(1)}{click}$`,
    String.raw`$\includegraphics{https://example.com/tracker}$`,
    String.raw`$\htmlStyle{position:fixed;inset:0}{cover}$`,
    String.raw`$\htmlData{onclick=alert(1)}{click}$`,
  ]) {
    const html = renderMathText(source);
    assert.doesNotMatch(html, /<(?:script|img|iframe|object|embed|a)\b/i);
    assert.doesNotMatch(html, /<[^>]*\s(?:on[a-z]+|href|src)\s*=/i);
    assert.doesNotMatch(html, /<[^>]*style="[^"]*(?:position:fixed|inset:0)/i);
  }
});

test("macro definitions may be shared within a field but never cross fields", () => {
  const definition = String.raw`$\gdef\FyrLocal{z}$ then $\FyrLocal+1$`;
  assert.doesNotMatch(renderMathText(definition), /math-fallback/);
  const independent = renderMathText(String.raw`$\FyrLocal+1$`);
  assert.match(independent, /math-fallback/);
  assert.equal(renderMathText(definition), renderMathText(definition));
});

test("recursive macros, oversized input, and user-supplied dimensions are bounded", () => {
  assert.match(renderMathText(String.raw`$\def\loop{\loop}\loop$`), /math-fallback/);
  const long = `$${"x".repeat(9_000)}$`;
  assert.equal(renderMathText(long), long);
  const sized = renderMathText(String.raw`$\rule{999em}{999em}$`);
  assert.doesNotMatch(sized, /style="[^"]*999em/);
  assert.match(sized, /12em/);
  const many = renderMathText(Array.from({ length: 140 }, () => "$x$").join(" "));
  assert.equal((many.match(/class="math-inline math-fallback"/g) ?? []).length, 12);
});

test("representative arXiv titles and abstracts preserve surrounding prose", () => {
  const source = String.raw`We study $L^2$-cohomology of $\mathbb{Q}$-Gorenstein varieties. For every $n\geq 2$, the map \(H^i(X,\mathcal{O}_X)\to H^i(Y,\mathcal{O}_Y)\) is an isomorphism.`;
  const html = renderMathText(source);
  assert.ok(html.startsWith("We study "));
  assert.match(html, /-cohomology of /);
  assert.ok(html.endsWith(" is an isomorphism."));
  assert.doesNotMatch(html, /math-fallback/);
});

test("current public feed titles and abstracts render without throwing or raw HTML", () => {
  const feed = JSON.parse(readFileSync(new URL("../public/data/arxiv.json", import.meta.url), "utf8")) as { papers: Array<{ title: string; abstract: string }> };
  // Feed content changes daily; sample deterministically across its whole range.
  const stride = Math.max(1, Math.floor(feed.papers.length / 80));
  for (let index = 0; index < feed.papers.length; index += stride) {
    for (const text of [feed.papers[index].title, feed.papers[index].abstract]) {
      const html = renderMathText(text);
      assert.equal(typeof html, "string");
      assert.doesNotMatch(html, /<(?:script|img|iframe|object|embed)\b/i);
    }
  }
});
