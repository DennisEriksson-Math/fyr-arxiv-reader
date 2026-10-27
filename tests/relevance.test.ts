import test from "node:test";
import assert from "node:assert/strict";
import type { Paper, Profile, RankedPaper } from "../lib/types.ts";
import { defaultProfile } from "../lib/arxiv.ts";
import { explainRelevance } from "../lib/relevance.ts";

const paper = (extra: Partial<Paper> = {}): Paper => ({ id: "2610.12345v2", base_id: "2610.12345", title: "A new theorem",
  abstract: "", authors: [], published: "2026-10-20", updated: "2026-10-27", categories: ["math.AG"], ...extra });
const profile = (extra: Partial<Profile> = {}): Profile => ({ ...defaultProfile(), ...extra });

test("reasons recompute current interests and ignore stale ranked metadata", () => {
  const stale: RankedPaper = { ...paper({ title: "Mirror symmetry for Kähler manifolds" }), score: 100,
    matched: ["number theory"], author_match: true };
  const reasons = explainRelevance(stale, profile({ sharp: ["mirror symmetry"], broad: ["Kahler"] }));
  assert.deepEqual(reasons.map(reason => [reason.term, reason.label]), [["mirror symmetry", "Specific interest"], ["Kahler", "Broad interest"]]);
  assert.deepEqual(explainRelevance(stale, profile({ sharp: ["number theory"] })), []);
});

test("normalized dashes and diacritics match without inventing substring matches", () => {
  const reasons = explainRelevance(paper({ title: "Kähler geometry and Gromov—Witten theory in topology" }),
    profile({ sharp: ["kahler geometry", "Gromov-Witten", "log"] }));
  assert.deepEqual(reasons.map(reason => reason.term), ["kahler geometry", "Gromov-Witten"]);
  assert.ok(reasons.every(reason => reason.location === "title"));
  assert.match(reasons[0].excerpt, /Kähler/);
  assert.match(reasons[1].excerpt, /Gromov—Witten/);
});

test("title evidence takes precedence and abstract excerpts retain actual public wording", () => {
  const p = paper({ title: "Mirror symmetry", abstract: `${"Earlier discussion. ".repeat(40)}We compute Gromov—Witten invariants using mirror symmetry. ${"Later discussion. ".repeat(40)}` });
  const reasons = explainRelevance(p, profile({ sharp: ["mirror symmetry", "Gromov-Witten"] }));
  assert.equal(reasons[0].location, "title");
  assert.equal(reasons[0].excerpt, "Mirror symmetry");
  assert.equal(reasons[1].location, "abstract");
  assert.match(reasons[1].excerpt, /Gromov—Witten/);
  assert.ok(reasons[1].excerpt.length <= 222);
  assert.ok(p.abstract.includes(reasons[1].excerpt.replace(/^…|…$/g, "")));
});

test("phrases do not match across the title / abstract boundary", () => {
  const p = paper({ title: "Mirror", abstract: "Symmetry appears in this theorem." });
  assert.deepEqual(explainRelevance(p, profile({ sharp: ["mirror symmetry"] })), []);
  assert.equal(explainRelevance(p, profile({ sharp: ["symmetry"], negative: ["mirror symmetry"] })).length, 1);
});

test("full author names and explicit variants follow the ranking's exact rules", () => {
  const reasons = explainRelevance(paper({ authors: ["Gérard Dubois-Lambert", "Mei Ling Chen", "T. Saito", "Other Chen"] }),
    profile({ authors: ["Dubois-Lambert, Gerard (Paris) — colleague", "Mei-Ling Chen [also: Mei Ling Chen]", "Saito"] }));
  assert.deepEqual(reasons.map(reason => reason.excerpt), ["Gérard Dubois-Lambert", "Mei Ling Chen"]);
  assert.ok(reasons.every(reason => reason.kind === "author" && reason.location === "authors" && reason.label === "Followed author" && !reason.boosted));
});

test("imported-work evidence attaches only to current matching interests", () => {
  const interests = profile({ sharp: ["Gromov-Witten"], authors: ["Gerard Dubois-Lambert"], sources: [
    { kind: "keyword", value: "Gromov—Witten", documents: [{ name: "my-paper.tex", excerpt: "We study Gromov-Witten invariants." }] },
    { kind: "author", value: "Dubois-Lambert, Gérard", documents: [{ name: "references.bib", excerpt: "Gérard Dubois-Lambert" }] },
    { kind: "keyword", value: "unrelated topic", documents: [{ name: "other.txt", excerpt: "Other material." }] },
  ] });
  const reasons = explainRelevance(paper({ title: "Gromov-Witten invariants", authors: ["Gérard Dubois-Lambert"] }), interests);
  assert.deepEqual(reasons.find(reason => reason.kind === "keyword")?.documents, [{ name: "my-paper.tex", excerpt: "We study Gromov-Witten invariants." }]);
  assert.deepEqual(reasons.find(reason => reason.kind === "author")?.documents, [{ name: "references.bib", excerpt: "Gérard Dubois-Lambert" }]);
  assert.ok(reasons.every(reason => reason.documents.every(document => document.name !== "other.txt")));
});

test("manual profiles have real reasons without fabricated document provenance", () => {
  const reasons = explainRelevance(paper({ title: "Algebraic geometry" }), profile({ broad: ["geometry"] }));
  assert.equal(reasons.length, 1);
  assert.deepEqual(reasons[0].documents, []);
  assert.equal(reasons[0].boosted, false);
});

test("negative phrases and excluded IDs veto keyword and followed-author reasons", () => {
  const p = paper({ title: "Financial geometry", authors: ["Emmy Noether"] });
  const interests = profile({ broad: ["geometry"], authors: ["Emmy Noether"] });
  assert.deepEqual(explainRelevance(p, { ...interests, negative: ["financial"] }), []);
  assert.deepEqual(explainRelevance(p, { ...interests, exclude_ids: ["2610.12345v1"] }), []);
});

test("duplicate normalized keywords produce one specific reason with a truthful feedback flag", () => {
  const reasons = explainRelevance(paper({ title: "Gromov—Witten theory" }), profile({
    sharp: ["Gromov-Witten"], broad: ["Gromov—Witten"], weights: { "Gromov—Witten": 2, unrelated: 100 },
  }));
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].label, "Specific interest");
  assert.equal(reasons[0].boosted, true);
});

test("decomposed accents and compatibility characters preserve public excerpt spelling", () => {
  const p = paper({ title: "A new theorem", abstract: `${"Preface. ".repeat(30)}We study Ka\u0308hler manifolds and ﬁnite covers. ${"Consequences. ".repeat(30)}` });
  const reasons = explainRelevance(p, profile({ sharp: ["kahler manifolds", "finite covers"] }));
  assert.equal(reasons.length, 2);
  assert.match(reasons[0].excerpt, /Ka\u0308hler manifolds/);
  assert.match(reasons[1].excerpt, /ﬁnite covers/);
});
