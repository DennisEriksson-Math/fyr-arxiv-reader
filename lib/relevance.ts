/** Deterministic, inspectable reasons. No model output or stored ranking is trusted here. */
import { authorForms, baseId, hasPhrase, interestKey, nameForms, normalizePapers, normalizeProfile, normalizeText, termMultiplier } from "./arxiv.ts";
import type { Paper, Profile, RankedPaper } from "./types.ts";

export interface RelevanceReason {
  kind: "keyword" | "author";
  label: "Specific interest" | "Broad interest" | "Followed author";
  term: string;
  location: "title" | "abstract" | "authors";
  excerpt: string;
  documents: Array<{ name: string; excerpt: string }>;
  boosted: boolean;
}

interface IndexedText { text: string; normalized: string; starts: number[]; ends: number[] }

/** Preserve the public spelling while locating a normalized phrase in its original text. */
function indexText(raw: string): IndexedText {
  const text = raw.replace(/\s+/g, " ").trim();
  let normalized = "", offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const original of text) {
    const start = offset; offset += original.length;
    const folded = original.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");
    if (!folded) {
      // Include a decomposed accent in an excerpt's endpoint, although it is not a match token.
      if (ends.length) ends[ends.length - 1] = offset;
      continue;
    }
    for (const character of folded) {
      if (/[\p{L}\p{N}]/u.test(character)) {
        normalized += character;
        for (let unit = 0; unit < character.length; unit++) { starts.push(start); ends.push(offset); }
      } else if (normalized && !normalized.endsWith(" ")) {
        normalized += " "; starts.push(start); ends.push(offset);
      }
    }
  }
  if (normalized.endsWith(" ")) { normalized = normalized.slice(0, -1); starts.pop(); ends.pop(); }
  return { text, normalized, starts, ends };
}

function excerptAround(field: IndexedText, phrase: string): string {
  const match = ` ${field.normalized} `.indexOf(` ${phrase} `);
  if (match < 0) return "";
  const startOfMatch = field.starts[match] ?? 0;
  const endOfMatch = field.ends[match + phrase.length - 1] ?? field.text.length;
  const budget = Math.max(220, endOfMatch - startOfMatch);
  let start = Math.max(0, startOfMatch - Math.floor((budget - (endOfMatch - startOfMatch)) / 2));
  let end = Math.min(field.text.length, start + budget);
  start = Math.max(0, Math.min(start, end - budget));
  // Do not cut surrounding words, or the actual matched phrase.
  if (start > 0) {
    const nextSpace = field.text.indexOf(" ", start);
    if (nextSpace >= 0 && nextSpace < startOfMatch) start = nextSpace + 1;
  }
  if (end < field.text.length) {
    const previousSpace = field.text.lastIndexOf(" ", end);
    if (previousSpace >= endOfMatch) end = previousSpace;
  }
  return `${start ? "…" : ""}${field.text.slice(start, end).trim()}${end < field.text.length ? "…" : ""}`;
}

/** Recompute matches against today's profile, including for kept or removed papers. */
export function explainRelevance(input: Paper | RankedPaper, rawProfile: Profile): RelevanceReason[] {
  const paper = normalizePapers([input])[0];
  if (!paper) return [];
  const profile = normalizeProfile(rawProfile);
  const title = indexText(paper.title), abstract = indexText(paper.abstract);
  const inEither = (term: string) => hasPhrase(title.normalized, term) || hasPhrase(abstract.normalized, term);
  if (profile.exclude_ids.some(id => baseId(id) === paper.base_id)
    || profile.negative.some(term => inEither(normalizeText(term)))) return [];

  const evidence = (kind: "keyword" | "author", value: string) => {
    const key = interestKey(kind, value), seen = new Set<string>();
    return (profile.sources ?? []).filter(source => source.kind === kind && interestKey(kind, source.value) === key)
      .flatMap(source => source.documents).filter(document => {
        const id = `${document.name}\u0000${document.excerpt}`;
        if (seen.has(id)) return false;
        seen.add(id); return true;
      }).slice(0, 3).map(document => ({ ...document }));
  };
  const reasons: RelevanceReason[] = [], seenAuthors = new Set<string>(), seenPhrases = new Set<string>();
  for (const followed of profile.authors) {
    const names = new Set(authorForms(followed));
    const matching = paper.authors.filter(author => nameForms(author).some(name => names.has(name)));
    if (!matching.length) continue;
    const key = matching.map(normalizeText).sort().join("\u0000");
    if (seenAuthors.has(key)) continue;
    seenAuthors.add(key);
    reasons.push({ kind: "author", label: "Followed author", term: followed, location: "authors",
      excerpt: matching.join(", "), documents: evidence("author", followed), boosted: false });
  }
  for (const [terms, label] of [[profile.sharp, "Specific interest"], [profile.broad, "Broad interest"]] as const) {
    for (const term of terms) {
      const normalized = normalizeText(term);
      if (!normalized || seenPhrases.has(normalized) || !inEither(normalized)) continue;
      seenPhrases.add(normalized);
      const location = hasPhrase(title.normalized, normalized) ? "title" : "abstract";
      const boosted = [...profile.sharp, ...profile.broad].some(value => normalizeText(value) === normalized
        && termMultiplier(profile.weights[value] || 0) > 1);
      reasons.push({ kind: "keyword", label, term, location,
        excerpt: excerptAround(location === "title" ? title : abstract, normalized),
        documents: evidence("keyword", term), boosted });
    }
  }
  return reasons;
}
