import test from "node:test";
import assert from "node:assert/strict";
const { analyzeDocumentTexts, analyzeDocuments, extractHtmlText, extractPdfWithEngine } = await import(new URL("../lib/profile-import.ts", import.meta.url).href);

test("local suggestions emphasize recurring title phrases and keep exclusions blank", () => {
  const result = analyzeDocumentTexts([
    { name: "mirror.md", text: "# Mirror symmetry and Calabi-Yau manifolds\nMirror symmetry describes Calabi-Yau manifolds. The study of mirror symmetry concerns period integrals.\n" },
    { name: "periods.md", text: "# Mirror symmetry for complete intersections\nMirror symmetry relates period integrals and Gromov-Witten invariants. Complete intersections have period integrals." },
  ]);
  assert.ok(result.profile.sharp.includes("mirror symmetry"));
  assert.ok(result.profile.sharp.some((p: string) => p.includes("period integrals") || p.includes("complete intersections")));
  assert.deepEqual(result.profile.exclude_ids, []);
  assert.equal(result.report.files, 2);
  assert.match(result.report.warnings.join(" "), /not an AI assessment/);
});

test("BibTeX extracts full names and balanced titles, omits initials and institutions", () => {
  const result = analyzeDocumentTexts([{ name: "refs.bib", text: `@article{one,
    author = {Noether, Emmy and David Hilbert and J. Smith and University Press},
    title = {The {Cohomology} of Algebraic Varieties},
    year = {2026}
  }
  @article{two, author = "Emmy Noether and David Hilbert", title = "Cohomology of algebraic varieties"}` }]);
  assert.deepEqual(result.profile.authors, ["Emmy Noether", "David Hilbert"]);
  assert.ok(result.profile.sharp.some((p: string) => p.includes("algebraic varieties")));
  assert.ok(!result.profile.sharp.some((p: string) => p.includes("david hilbert")));
});

test("LaTeX author/title extraction preserves nested braces and removes thanks", () => {
  const result = analyzeDocumentTexts([{ name: "paper.tex", text: String.raw`\title{Mirror symmetry for {Calabi--Yau} manifolds}
\author{Dennis Eriksson\thanks{Supported by a research grant} \and G\'erard Freixas i Montplet}
\begin{document}
Mirror symmetry and mirror symmetry with period integrals.
\end{document}` }]);
  assert.ok(result.profile.authors.includes("Dennis Eriksson"));
  assert.ok(result.profile.authors.some((p: string) => p.startsWith("Gerard Freixas")));
  assert.match(result.profile.context, /Mirror symmetry/);
});

test("author guesses ignore mathematical headings and ambiguous initials", () => {
  const result = analyzeDocumentTexts([{ name: "paper.pdf", text: "Mirror symmetry and mirror symmetry", firstPage: "MIRROR SYMMETRY\nAlgebraic Geometry\nEmmy Noether and David Hilbert\nDepartment of Mathematics\nAbstract\nOur work" }]);
  assert.deepEqual(result.profile.authors, ["Emmy Noether", "David Hilbert"]);
});

test("batch and per-document bounds hold, names do not expose folder paths", () => {
  const result = analyzeDocumentTexts(Array.from({ length: 55 }, (_, i) => ({ name: `private/research/doc${i}.txt`, text: "mirror symmetry ".repeat(10000) })));
  assert.ok(result.report.characters <= 1_000_000);
  assert.ok(result.report.files <= 50);
  assert.ok(result.report.sourceNames.every((n: string) => !n.includes("/")));
  assert.ok(result.report.warnings.some((w: string) => /limit/.test(w)));
});

test("File entry point skips unsupported and oversized files, processes text locally", async () => {
  const file = new File(["# Gromov-Witten invariants\nGromov-Witten invariants connect enumerative geometry and enumerative geometry."], "paper.md", { type: "text/markdown" });
  const unsupported = new File(["not a paper"], "photo.png");
  const huge = { name: "huge.txt", size: 16 * 1024 * 1024, text: () => { throw new Error("must not read"); } } as unknown as File;
  const progress: string[] = [];
  const result = await analyzeDocuments([file, unsupported, huge], (message: string) => progress.push(message));
  assert.equal(result.report.files, 1);
  assert.ok(result.report.warnings.some((w: string) => w.includes("unsupported")));
  assert.ok(result.report.warnings.some((w: string) => w.includes("15 MB")));
  assert.ok(progress.length > 0);
});

test("HTML is parsed without DOM or network, and resource/script contents never become suggestions", async () => {
  const savedFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => { networkCalls++; throw new Error("Unexpected network request"); }) as typeof fetch;
  try {
    const html = `<html><head><title>Mirror symmetry</title><link rel="stylesheet" href="https://example.invalid/style"></head><body>
      <img src="https://example.invalid/track"><iframe src="https://example.invalid/frame">private tracking phrase</iframe>
      <script src="https://example.invalid/code">fetch('https://example.invalid/leak')</script>
      <h1>Mirror symmetry and Calabi-Yau manifolds</h1><p>Mirror symmetry involves period integrals &amp; enumerative geometry.</p>
    </body></html>`;
    const text = extractHtmlText(html);
    assert.match(text, /period integrals & enumerative geometry/);
    assert.doesNotMatch(text, /https|fetch|tracking/);
    const result = await analyzeDocuments([new File([html], "paper.html", { type: "text/html" })]);
    assert.equal(result.report.files, 1);
    assert.ok(result.profile.sharp.includes("mirror symmetry"));
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = savedFetch; }
});

function syntheticPdf(): Uint8Array {
  const stream = `BT /F1 18 Tf 50 750 Td (Mirror symmetry for complete intersections) Tj 0 -26 Td /F1 12 Tf (Emmy Noether and David Hilbert) Tj 0 -35 Td (Abstract) Tj 0 -20 Td (Mirror symmetry connects period integrals and enumerative geometry.) Tj 0 -18 Td (Complete intersections yield period integrals in mirror symmetry.) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Title (Mirror symmetry for complete intersections) /Author (Emmy Noether and David Hilbert) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test("real PDF v6 extraction reads a synthetic paper, metadata and authors, then destroys its task", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let destroyed = false;
  const engine = { getDocument: (options: Parameters<typeof pdfjs.getDocument>[0]) => {
    const task = pdfjs.getDocument(options);
    const original = task.destroy.bind(task);
    task.destroy = async () => { await original(); destroyed = true; };
    return task;
  } };
  const warnings: string[] = [];
  const file = new File([new Uint8Array(syntheticPdf()).buffer], "synthetic-paper.pdf", { type: "application/pdf" });
  const doc = await extractPdfWithEngine(file, warnings, engine);
  assert.match(doc.text, /period integrals/);
  assert.equal(doc.title, "Mirror symmetry for complete intersections");
  assert.deepEqual(doc.authors, ["Emmy Noether", "David Hilbert"]);
  const result = analyzeDocumentTexts([doc]);
  assert.ok(result.profile.sharp.includes("mirror symmetry"));
  assert.ok(destroyed);
});
