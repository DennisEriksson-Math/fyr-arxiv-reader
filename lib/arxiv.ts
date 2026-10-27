/** Adapted from Fyr's arxiv_feed.py and interest_profile.py. MIT; see /FYR-LICENSE.txt. */
import type { Paper, PaperChange, Profile, ProfileSource, RankedPaper } from "./types";

export const MAX_PAPERS = 8000;
const MAX_LIST = 200;
const MAX_TERM = 200;
const ATOM = "http://www.w3.org/2005/Atom";
const ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/i;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const string = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit).trim() : "";

export function baseId(value: string): string {
  return value.trim().replace(/v\d+$/i, "");
}

export function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Stable evidence/merge identity, preserving the user's display spelling separately. */
export function interestKey(kind: "keyword" | "author", value: string): string {
  if (kind === "keyword") return normalizeText(value);
  let name = value.replace(/\[(?:also|orcid):[^\]]*\]/gi, "").split(" — ")[0].split("(")[0].trim();
  if (name.includes(",")) {
    const [last, first] = name.split(",", 2);
    name = `${first.trim()} ${last.trim()}`;
  }
  return normalizeText(name);
}

function strings(value: unknown, count = MAX_LIST, length = MAX_TERM): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, count).map(item => string(item, length).replace(/\s+/g, " ")).filter(Boolean))];
}

export function defaultProfile(): Profile {
  return { broad: [], sharp: [], authors: [], negative: [], exclude_ids: [], context: "", weights: {} };
}

/** Imports are bounded, type-checked, and reconstructed rather than trusted or spread. */
export function normalizeProfile(input: unknown): Profile {
  const source = record(input);
  const profile: Profile = {
    broad: strings(source.broad), sharp: strings(source.sharp), authors: strings(source.authors),
    negative: strings(source.negative),
    exclude_ids: strings(source.exclude_ids).filter(id => ID.test(id)).map(baseId),
    context: string(source.context, 16000), weights: {},
  };
  for (const [term, value] of Object.entries(record(source.weights)).slice(0, 400)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && term.length <= MAX_TERM
      && term !== "__proto__" && term !== "constructor" && term !== "prototype") {
      profile.weights[term] = Math.min(100000, Math.floor(value));
    }
  }
  if (Array.isArray(source.sources)) {
    const active = new Map<string, string>();
    for (const value of [...profile.broad, ...profile.sharp]) {
      const key = `keyword:${interestKey("keyword", value)}`;
      if (!active.has(key)) active.set(key, value);
    }
    for (const value of profile.authors) {
      const key = `author:${interestKey("author", value)}`;
      if (!active.has(key)) active.set(key, value);
    }
    const evidence = new Map<string, ProfileSource>();
    for (const raw of source.sources.slice(0, 400)) {
      const item = record(raw);
      if (item.kind !== "keyword" && item.kind !== "author") continue;
      const value = string(item.value, MAX_TERM), key = `${item.kind}:${interestKey(item.kind, value)}`;
      const current = active.get(key);
      if (!current || (!evidence.has(key) && evidence.size >= 100)) continue;
      const entry = evidence.get(key) || { kind: item.kind, value: current, documents: [] };
      for (const rawDocument of Array.isArray(item.documents) ? item.documents.slice(0, 20) : []) {
        const doc = record(rawDocument);
        const name = (typeof doc.name === "string" ? doc.name.slice(-1000).split(/[\\/]/).pop() || "" : "")
          .replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
        const excerpt = string(doc.excerpt, 1200).replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").slice(0, 300).trim();
        if (!name || !excerpt || entry.documents.some(d => d.name === name)) continue;
        if (entry.documents.length < 3) entry.documents.push({ name, excerpt });
      }
      if (entry.documents.length) evidence.set(key, entry);
    }
    if (evidence.size) profile.sources = [...evidence.values()];
  }
  return profile;
}

function isoDate(value: unknown): string {
  const date = string(value, 40).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}

export function normalizePapers(input: unknown): Paper[] {
  if (!Array.isArray(input)) return [];
  const papers: Paper[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, MAX_PAPERS)) {
    const p = record(raw), id = string(p.id, 80), title = string(p.title, 2000);
    const published = isoDate(p.published), updated = isoDate(p.updated) || published;
    if (!ID.test(id) || !title || !published || seen.has(baseId(id))) continue;
    seen.add(baseId(id));
    const change = ["new", "revised", "late-window"].includes(String(p.change))
      ? p.change as PaperChange : undefined;
    papers.push({ id, base_id: baseId(id), title, abstract: string(p.abstract, 16000),
      authors: strings(p.authors, 200, 160), categories: strings(p.categories, 30, 40),
      published, updated, ...(change ? { change } : {}) });
  }
  return papers;
}

/** New/revised within the week; a separate grace band covers delayed announcements. */
export function classifyPaper(paper: Paper, cutoff: string, grace: string): PaperChange | undefined {
  if (!isoDate(cutoff) || !isoDate(grace) || !isoDate(paper.published) || !isoDate(paper.updated)) return undefined;
  if (paper.published >= cutoff) return "new";
  if (paper.updated >= cutoff && paper.updated > paper.published) return "revised";
  if (paper.published >= grace) return "late-window";
  return undefined;
}

export function nameForms(spelling: string): string[] {
  let forms: string[];
  if (spelling.includes(",")) {
    const [last, rest] = spelling.split(",", 2);
    const first = rest.trim().split(/\s+/)[0] || "";
    forms = first ? [`${first} ${last}`, `${last} ${first}`] : [];
  } else forms = [spelling];
  return forms.map(normalizeText).filter(name => {
    const words = name.split(" ");
    // A surname or initials-only entry must not become a match for unrelated people.
    return words.length >= 2 && words.filter(word => word.length >= 2).length >= 2;
  });
}

export function authorForms(entry: string): string[] {
  const variants = /\[also:\s*([^\]]+)\]/i.exec(entry)?.[1].split(";") || [];
  const name = entry.replace(/\[(?:also|orcid):[^\]]*\]/gi, "").split(" — ")[0].split("(")[0].trim();
  return [name, ...variants].flatMap(nameForms);
}

export function hasPhrase(blob: string, phrase: string): boolean {
  // Word boundaries avoid e.g. 'log' matching 'topology'. Hyphen/dash variants normalize identically.
  return Boolean(phrase) && ` ${blob} `.includes(` ${phrase} `);
}

export function termMultiplier(saves: number): number {
  return saves > 0 ? Math.min(2, 1 + 0.35 * Math.log1p(saves) / Math.log(2)) : 1;
}

export function rankPartition(papers: Paper[], input: Profile): { ranked: RankedPaper[]; unmatched: Paper[] } {
  const profile = normalizeProfile(input), candidates = normalizePapers(papers);
  const blobs = candidates.map(p => ({ title: normalizeText(p.title), abstract: normalizeText(p.abstract) }));
  const phrases = [...profile.broad.map(phrase => ({ phrase, weight: 1 })), ...profile.sharp.map(phrase => ({ phrase, weight: 3 }))]
    .map(p => ({ ...p, norm: normalizeText(p.phrase) })).filter(p => p.norm);
  const n = candidates.length;
  const df = phrases.map(p => blobs.filter(b => (hasPhrase(b.title, p.norm) || hasPhrase(b.abstract, p.norm))).length);
  const names = new Set(profile.authors.flatMap(authorForms));
  const excluded = new Set(profile.exclude_ids.map(baseId));
  const negative = profile.negative.map(normalizeText).filter(Boolean);
  const ranked: RankedPaper[] = [], unmatched: Paper[] = [];
  candidates.forEach((paper, index) => {
    const blob = blobs[index];
    // Explicit exclusions take precedence even over followed authors and semantic discovery.
    if (excluded.has(paper.base_id) || negative.some(term => (hasPhrase(blob.title, term) || hasPhrase(blob.abstract, term)))) return;
    let score = 0;
    const matched: string[] = [];
    phrases.forEach((p, j) => {
      if (!hasPhrase(blob.title, p.norm) && !hasPhrase(blob.abstract, p.norm)) return;
      const idf = Math.log(1 + (n - df[j] + 0.5) / (df[j] + 0.5));
      score += p.weight * idf * (hasPhrase(blob.title, p.norm) ? 2 : 1) * termMultiplier(profile.weights[p.phrase] || 0);
      matched.push(p.phrase);
    });
    const author_match = paper.authors.some(author => nameForms(author).some(name => names.has(name)));
    if (author_match) score += 100;
    if (!author_match && score <= 0) unmatched.push(paper);
    else ranked.push({ ...paper, score: Math.round(score * 100) / 100, matched: [...new Set(matched)], author_match });
  });
  ranked.sort((a, b) => Number(b.author_match) - Number(a.author_match) || b.score - a.score || a.base_id.localeCompare(b.base_id));
  return { ranked, unmatched };
}

/** AI IDs must come from rankPartition().unmatched: never send excluded papers to the scout. */
export function makeShortlist(ranked: RankedPaper[], semantic: Array<{ id: string; connection: string }>, allPapers: Paper[], size = 20): RankedPaper[] {
  const limit = Math.max(5, Math.min(20, Number.isFinite(size) ? Math.floor(size || 20) : 20));
  const selected: RankedPaper[] = [], seen = new Set<string>();
  const add = (p: RankedPaper) => { if (!seen.has(p.base_id) && selected.length < limit) { seen.add(p.base_id); selected.push(p); } };
  ranked.filter(p => p.author_match).forEach(add);
  const rankedIds = new Set(ranked.map(p => p.base_id));
  const available = new Map(normalizePapers(allPapers).map(p => [p.base_id, p]));
  const discoveries: RankedPaper[] = [], discovered = new Set<string>();
  const semanticLimit = Math.min(5, Math.floor(limit / 4), limit - selected.length);
  for (const raw of Array.isArray(semantic) ? semantic.slice(0, 100) : []) {
    if (!raw || typeof raw.id !== "string") continue;
    const id = baseId(raw.id), paper = available.get(id);
    if (!paper || rankedIds.has(id) || seen.has(id) || discovered.has(id) || discoveries.length >= semanticLimit) continue;
    discovered.add(id);
    discoveries.push({ ...paper, score: 0, matched: [], author_match: false, semantic: string(raw.connection, 500) });
  }
  const ordinary = ranked.filter(p => !p.author_match);
  const lexicalRoom = limit - selected.length - discoveries.length;
  ordinary.slice(0, lexicalRoom).forEach(add);
  discoveries.forEach(add);
  ordinary.forEach(add);
  return selected;
}

/** Browser-only parser. Public abstracts are parsed as XML text; never injected as HTML. */
export function parseAtom(xml: string): Paper[] {
  if (typeof DOMParser === "undefined") throw new Error("arXiv XML parsing is available in the browser.");
  if (typeof xml !== "string" || xml.length > 8_000_000) throw new Error("The arXiv response is too large.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("arXiv returned an unreadable feed.");
  const entries = Array.from(doc.getElementsByTagNameNS(ATOM, "entry")).slice(0, MAX_PAPERS);
  const text = (el: Element, tag: string) => (el.getElementsByTagNameNS(ATOM, tag)[0]?.textContent || "").replace(/\s+/g, " ").trim();
  return normalizePapers(entries.map(entry => {
    const link = text(entry, "id");
    const id = link.replace(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\//i, "");
    return { id, title: text(entry, "title"), abstract: text(entry, "summary"),
      authors: Array.from(entry.getElementsByTagNameNS(ATOM, "author")).map(author => text(author, "name")),
      categories: Array.from(entry.getElementsByTagNameNS(ATOM, "category")).map(category => category.getAttribute("term") || ""),
      published: text(entry, "published"), updated: text(entry, "updated") };
  }));
}

type ExportPaper = Paper & Partial<Pick<RankedPaper, "matched" | "author_match" | "semantic">> & {
  priority?: string; summary?: string; why?: string; possible_use?: string; caveat?: string;
};

export function exportMarkdown(papers: ExportPaper[]): string {
  const safe = (value: string) => value.replace(/[\\[\]]/g, "\\$&").replace(/\r?\n/g, " ");
  const sections = papers.slice(0, MAX_PAPERS).map(p => {
    const lines = [`## [${safe(p.title)}](https://arxiv.org/abs/${encodeURI(baseId(p.id))})`, "", p.authors.join(", "), "",
      `Published ${p.published}${p.change ? ` · ${p.change}` : ""}`, ""];
    if (p.priority) lines.push(`Priority: ${p.priority}`, "");
    if (p.summary) lines.push(`**Summary:** ${p.summary}`, "");
    if (p.why) lines.push(`**Why it may interest you:** ${p.why}`, "");
    if (p.possible_use) lines.push(`**Possible use:** ${p.possible_use}`, "");
    if (p.caveat) lines.push(`**Caveat:** ${p.caveat}`, "");
    if (p.author_match) lines.push("Selected because you follow an author.", "");
    if (p.matched?.length) lines.push(`Matched: ${p.matched.join(", ")}`, "");
    if (p.semantic) lines.push(`Semantic connection: ${p.semantic}`, "");
    lines.push("**Abstract**", "", p.abstract);
    return lines.join("\n");
  });
  return `# Fyr arXiv reading list\n\n${sections.join("\n\n---\n\n")}\n`;
}
