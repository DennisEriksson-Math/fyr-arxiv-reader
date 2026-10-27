/** Local, reviewable interest suggestions inspired by Fyr's title-based profile suggestions.
 * Documents never leave the browser. No LLM is used by this module.
 */
import type { Profile } from "./types";
import { parse as parseHtmlTree, type DefaultTreeAdapterTypes } from "parse5";

export interface ImportReport {
  files: number;
  characters: number;
  warnings: string[];
  sourceNames: string[];
}
export interface DocumentText {
  name: string;
  text: string;
  firstPage?: string;
  title?: string;
  authors?: string[];
}
export interface ProfileImportResult { profile: Profile; report: ImportReport }

const MAX_FILES = 50, MAX_BYTES = 15 * 1024 * 1024, MAX_TEXT = 1_000_000, MAX_PER_FILE = 100_000;
const SUPPORTED = /\.(pdf|txt|md|markdown|tex|bib|bibtex|html?|text)$/i;
const STOP = new Set((`a an the and or but not for with from into over under via its their this that these those are was were has have had can could does do did any all some each such when whether which what where how example examples problem problems question questions main getting started new more precise good choice thing case cases note notes theorem theorems conjecture lemma lemmas proof proofs study project test demo show shows shown showing prove proved proving result results paper papers article articles section sections proposition propositions corollary corollaries equation equations formula formulas definition definitions remark remarks introduction abstract references bibliography appendix acknowledgements acknowledgment author authors using towards toward certain general explicit application applications property properties existence non let suppose assume denote called given follows following first second third one two three see also since hence therefore thus then however now our we us it is be as at on to in of by if there here than so other same very both only respectively indeed use used consider considered corresponding follows namely thus particular particularity exactly enough many most much need want known well set statement version preprint arxiv doi http https www com org math journal university department institute mathematics mathematical sciences address email received accepted published copyright volume pages press eds editor edited springer verlag cambridge oxford ams american society else begin end document documentclass usepackage maketitle textbf textit emph label ref eqref cite pageref thanks footnote frac mathbb mathcal mathrm mathsf operatorname left right quad qquad cdot times leq geq forall exists alpha beta gamma delta theta lambda sigma omega epsilon newcommand renewcommand providecommand theoremstyle theoremname bibitem bibliographystyle bibliography href url hspace vspace item enumerate itemize center figure table includegraphics caption centering small large normalfont roman bold italic author title date chapter subsections subsection subsubsection paragraph`).split(/\s+/));
const NAME_BAD = new Set((`abstract introduction references theorem proof proposition conjecture lemma geometry geometric algebraic algebra topology topological arithmetic analytic analysis holomorphic invariants invariant theory symmetry mirror modular moduli calabi yau singularity singularities cohomology homology curve curves surface surfaces manifold manifolds projective affine complex real smooth local global canonical birational kähler kahler differential elliptic hyperbolic parabolic riemannian quantum classical numerical computational mathematical mathematics university department institute school faculty college laboratory research sciences journal press volume series lecture notes submitted revised published accepted supported grant email address foundation council association society copyright doi arxiv contents acknowledgements acknowledgment correspondence author authors appendix references bibliography anonymous editor editors edited translated version preliminary preliminary`.split(/\s+/)));

const cleanSpace = (value: string) => value.replace(/\s+/g, " ").trim();
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Read balanced TeX/BibTeX braces without evaluating commands. */
function braceValue(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== "{") return null;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    if (text[i] === "}") { depth--; if (depth === 0) return { value: text.slice(start + 1, i), end: i + 1 }; }
  }
  return null;
}

function bracedCommands(text: string, command: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`\\\\${command}(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && values.length < 200) {
    const value = braceValue(text, pattern.lastIndex - 1);
    if (value) { values.push(value.value); pattern.lastIndex = value.end; }
  }
  return values;
}

function bibFields(text: string, field: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`(?:^|[,\\n])\\s*${field}\\s*=\\s*`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && values.length < 200) {
    const start = pattern.lastIndex;
    if (text[start] === "{") {
      const v = braceValue(text, start); if (v) { values.push(v.value); pattern.lastIndex = v.end; }
    } else if (text[start] === '"') {
      let end = start + 1;
      while (end < text.length && (text[end] !== '"' || text[end - 1] === "\\")) end++;
      values.push(text.slice(start + 1, end)); pattern.lastIndex = end + 1;
    }
  }
  return values;
}

function stripTex(input: string): string {
  let text = input.replace(/(?<!\\)%[^\n]*/g, "");
  // Resolve common accent notation before discarding command syntax.
  text = text.replace(/\\['"`^~=.uvHckbr]\s*\{?([A-Za-z])\}?/g, "$1");
  for (const command of ["thanks", "footnote", "label", "cite", "ref", "eqref", "url", "href", "includegraphics"]) {
    const pattern = new RegExp(`\\\\${command}\\*?(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const value = braceValue(text, pattern.lastIndex - 1);
      if (!value) continue;
      text = text.slice(0, match.index) + " " + text.slice(value.end);
      pattern.lastIndex = match.index + 1;
    }
  }
  return text.replace(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$])*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, " ")
    .replace(/\\begin\{(?:equation\*?|align\*?|gather\*?|tikzpicture)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|gather\*?|tikzpicture)\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}_^&$]/g, " ");
}

function probableName(raw: string): string | undefined {
  let name = stripTex(raw).replace(/[†‡*\d]/g, " ").replace(/\\\\/g, " ");
  name = cleanSpace(name).replace(/^[,;:\s]+|[,;:\s]+$/g, "");
  if (!name || name.length > 95 || /[@:/=<>()[\]]/.test(name)) return undefined;
  if (name.includes(",")) {
    const parts = name.split(",").map(part => part.trim());
    if (parts.length !== 2) return undefined;
    name = `${parts[1]} ${parts[0]}`;
  }
  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 5) return undefined;
  if (words.some(word => NAME_BAD.has(normalize(word).replace(/[.']/g, "")))) return undefined;
  const substantive = words.filter(word => !/^(de|del|van|von|der|den|le|la|di|da|dos|du|i|y|e)$/i.test(word));
  if (substantive.length < 2 || substantive.some(word => !/^[\p{Lu}][\p{L}'’.-]+$/u.test(word))) return undefined;
  // Full given name + surname, not ambiguous 'J. Smith'.
  if (substantive.some(word => word.replace(/[^\p{L}]/gu, "").length < 2)) return undefined;
  if (substantive.every(word => word === word.toUpperCase())) {
    name = words.map(word => word.charAt(0) + word.slice(1).toLowerCase()).join(" ");
  }
  return name;
}

function splitAuthorList(raw: string): string[] {
  return raw.split(/\\and\b|\band\b|;|\\\\|\n/).map(probableName).filter((n): n is string => Boolean(n));
}

/** Bibliography and LaTeX authors are preferable to guessing from ordinary prose. */
function authorsFrom(doc: DocumentText): string[] {
  const structured = [...(doc.authors || []).map(probableName).filter((n): n is string => Boolean(n)),
    ...bibFields(doc.text, "author").flatMap(splitAuthorList),
    ...bracedCommands(doc.text, "author").flatMap(splitAuthorList)];
  if (structured.length) return [...new Set(structured)].slice(0, 80);
  const front = (doc.firstPage || doc.text.slice(0, 2500)).split(/\babstract\b/i)[0];
  const lines = front.split(/\r?\n/).map(cleanSpace).filter(Boolean).slice(0, 25);
  const candidates: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?:by|authors?)\s*[: ]/i.test(line)) candidates.push(...splitAuthorList(line.replace(/^(?:by|authors?)\s*[: ]/i, "")));
    else if (i > 0 && line.length < 130 && (doc.firstPage || /\band\b|;/.test(line))) candidates.push(...splitAuthorList(line));
  }
  return [...new Set(candidates)].slice(0, 15);
}

function titlesFrom(doc: DocumentText): string[] {
  const bib = bibFields(doc.text, "title").map(stripTex).map(cleanSpace);
  const tex = bracedCommands(doc.text, "title").map(stripTex).map(cleanSpace);
  const markdown = [...doc.text.matchAll(/^#{1,2}\s+(.+)$/gm)].slice(0, 8).map(m => m[1]);
  const declared = doc.title ? [doc.title] : [];
  const inferred = !bib.length && !tex.length && !markdown.length && !declared.length
    ? (doc.firstPage || doc.text).split(/\r?\n/).map(cleanSpace).filter(line => line.length > 12 && line.length < 200 && !/^(?:arxiv|doi|https?|copyright|by |author|abstract)/i.test(line)).slice(0, 2)
    : [];
  return [...declared, ...tex, ...bib, ...markdown, ...inferred].filter(Boolean).slice(0, 100);
}

function phraseCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Punctuation, equations and stopwords break phrases: no invented adjacency across sentences.
  const chunks = normalize(text).replace(/([a-z])[-‐‑–]\n\s*([a-z])/g, "$1$2")
    .split(/[\n.!?;:()[\]{}=+*/<>|\\\d]/);
  for (const chunk of chunks) {
    const words = chunk.match(/[\p{L}][\p{L}'’-]*/gu) || [];
    let run: string[] = [];
    const consume = () => {
      for (let length = 2; length <= 4; length++) for (let start = 0; start + length <= run.length; start++) {
        const phrase = run.slice(start, start + length).join(" ");
        if (phrase.length >= 7 && phrase.length <= 90) counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
      run = [];
    };
    for (const word of words) { if (word.length < 3 || STOP.has(word)) consume(); else run.push(word); }
    consume();
  }
  return counts;
}

export function analyzeDocumentTexts(input: DocumentText[]): ProfileImportResult {
  const warnings = ["These are local keyword and author suggestions, not an AI assessment. Review them before using the profile.",
    "Suggested authors can include you and your coauthors. Remove anyone you do not want to follow."];
  const docs: DocumentText[] = []; let total = 0;
  for (const raw of input.slice(0, MAX_FILES)) {
    if (!raw || typeof raw.text !== "string") continue;
    const text = raw.text.slice(0, Math.min(MAX_PER_FILE, MAX_TEXT - total));
    if (!text.trim()) continue;
    total += text.length;
    docs.push({ ...raw, name: String(raw.name || "Document").split(/[\\/]/).pop()!.slice(0, 200), text });
    if (total >= MAX_TEXT) break;
  }
  if (input.length > MAX_FILES) warnings.push("Only the first 50 documents were considered.");
  if (total >= MAX_TEXT) warnings.push("The text limit of one million characters was reached.");
  const stats = new Map<string, { count: number; documents: number; titles: number }>();
  const titleList: string[] = [], authors: string[] = [];
  for (const doc of docs) {
    const titles = titlesFrom(doc); titleList.push(...titles); authors.push(...authorsFrom(doc));
    const body = /\.(?:tex|bib|bibtex)$/i.test(doc.name) ? stripTex(doc.text) : doc.text;
    const counts = phraseCounts(body), titleCounts = phraseCounts(titles.join(". "));
    for (const phrase of new Set([...counts.keys(), ...titleCounts.keys()])) {
      const value = stats.get(phrase) || { count: 0, documents: 0, titles: 0 };
      value.count += counts.get(phrase) || 0; value.documents++; value.titles += titleCounts.get(phrase) || 0; stats.set(phrase, value);
    }
  }
  const normalizedAuthors = authors.map(normalize);
  const scored = [...stats].filter(([phrase, value]) => (value.titles || value.count >= 2) && !normalizedAuthors.some(author => author.includes(phrase)))
    .map(([phrase, value]) => ({ phrase, ...value,
      score: (Math.log1p(value.count) + 4 * value.titles) * Math.log(1 + docs.length / (1 + value.documents)) * Math.sqrt(value.documents) * (1 + 0.12 * (phrase.split(" ").length - 2)) }))
    .sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  const sharp: string[] = [];
  for (const candidate of scored) {
    if (sharp.some(phrase => phrase.includes(candidate.phrase) || candidate.phrase.includes(phrase))) continue;
    sharp.push(candidate.phrase); if (sharp.length >= 18) break;
  }
  const broadCounts = new Map<string, number>();
  for (const phrase of sharp) for (const word of phrase.split(" ")) {
    if (word.length >= 5 && !STOP.has(word)) broadCounts.set(word, (broadCounts.get(word) || 0) + 1);
  }
  const broad = [...broadCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([word]) => word);
  if (!sharp.length) warnings.push("Not enough recurring mathematical phrases were found. Add a few topics manually.");
  const authorMap = new Map<string, string>();
  for (const author of authors) if (!authorMap.has(normalize(author))) authorMap.set(normalize(author), author);
  const profile: Profile = { broad, sharp, authors: [...authorMap.values()].slice(0, 60), negative: [], exclude_ids: [], weights: {},
    context: titleList.length ? `Topics suggested from these document titles:\n${[...new Set(titleList)].slice(0, 20).map(title => `- ${title}`).join("\n")}`.slice(0, 16000) : "" };
  return { profile, report: { files: docs.length, characters: total, warnings, sourceNames: docs.map(doc => doc.name) } };
}

/** Parse a syntax tree only: no DOM, scripts, resource elements or network side effects. */
export function extractHtmlText(html: string): string {
  const ignored = new Set(["script", "style", "nav", "footer", "header", "iframe", "frame", "object", "embed", "svg", "template"]);
  const blocks = new Set(["title", "p", "h1", "h2", "h3", "h4", "li", "section", "article", "div", "br", "tr"]);
  const tree = parseHtmlTree(html);
  const walk = (node: DefaultTreeAdapterTypes.Node): string => {
    if ("tagName" in node && ignored.has(node.tagName)) return "";
    if (node.nodeName === "#text" && "value" in node) return node.value;
    if (!("childNodes" in node)) return "";
    const value = node.childNodes.map(walk).join("");
    return "tagName" in node && blocks.has(node.tagName) ? `\n${value}\n` : value;
  };
  return walk(tree).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
}

type PdfEngine = Pick<typeof import("pdfjs-dist"), "getDocument">;

/** Engine injection permits a real, dependency-only PDF smoke test without a browser worker shim. */
export async function extractPdfWithEngine(file: File, warnings: string[], pdfjs: PdfEngine): Promise<DocumentText> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useWorkerFetch: false, disableFontFace: true, useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const count = Math.min(pdf.numPages, 50); let text = "", firstPage = "";
    for (let pageNumber = 1; pageNumber <= count && text.length < MAX_PER_FILE; pageNumber++) {
      const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
      let pageText = "", lastY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > 3) pageText += "\n";
        pageText += item.str + (item.hasEOL ? "\n" : " "); lastY = y;
      }
      if (pageNumber === 1) firstPage = pageText;
      text += pageText + "\n"; page.cleanup();
    }
    if (pdf.numPages > 50 || text.length >= MAX_PER_FILE) warnings.push(`${file.name}: analyzed the opening pages within the text limit.`);
    if (text.trim().length < 100) warnings.push(`${file.name}: little selectable text found. Scanned PDFs need OCR before import.`);
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = metadata?.info as { Title?: string; Author?: string } | undefined;
    const title = info?.Title && !/^(?:untitled|microsoft|latex|document)/i.test(info.Title) ? info.Title : undefined;
    return { name: file.name, text, firstPage, title, authors: info?.Author ? splitAuthorList(info.Author) : [] };
  } finally { await task.destroy(); }
}

async function extractPdf(file: File, warnings: string[]): Promise<DocumentText> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return extractPdfWithEngine(file, warnings, pdfjs);
}

export async function analyzeDocuments(files: File[], onProgress?: (message: string) => void): Promise<ProfileImportResult> {
  const warnings: string[] = [], docs: DocumentText[] = [];
  const eligible = Array.from(files).filter(file => SUPPORTED.test(file.name));
  const unsupported = files.length - eligible.length;
  if (unsupported) warnings.push(`${unsupported} unsupported file${unsupported === 1 ? " was" : "s were"} skipped. Use PDF, TXT, Markdown, LaTeX, BibTeX or HTML.`);
  if (eligible.length > MAX_FILES) warnings.push("Only the first 50 supported documents were considered.");
  let total = 0;
  for (const [index, file] of eligible.slice(0, MAX_FILES).entries()) {
    onProgress?.(`Reading ${index + 1} of ${Math.min(eligible.length, MAX_FILES)}: ${file.name}`);
    if (file.size > MAX_BYTES) { warnings.push(`${file.name}: skipped because it exceeds 15 MB.`); continue; }
    try {
      let doc: DocumentText;
      if (/\.pdf$/i.test(file.name)) doc = await extractPdf(file, warnings);
      else {
        let text = await file.text();
        if (/\.html?$/i.test(file.name)) {
          text = extractHtmlText(text);
        }
        doc = { name: file.name, text };
      }
      const room = Math.min(MAX_PER_FILE, MAX_TEXT - total);
      if (doc.text.length > room) warnings.push(`${file.name}: only the first ${room.toLocaleString()} characters were analyzed.`);
      doc.text = doc.text.slice(0, room); total += doc.text.length;
      if (doc.text.trim()) docs.push(doc);
      else warnings.push(`${file.name}: no readable text found.`);
      if (total >= MAX_TEXT) { warnings.push("The batch reached one million characters. Remaining documents were skipped."); break; }
    } catch (error) { warnings.push(`${file.name}: ${error instanceof Error ? error.message.slice(0, 180) : "could not read this document"}`); }
  }
  onProgress?.("Finding recurring topics and author names…");
  const result = analyzeDocumentTexts(docs);
  result.report.warnings = [...new Set([...warnings, ...result.report.warnings])];
  return result;
}
