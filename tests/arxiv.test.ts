import test from "node:test";
import assert from "node:assert/strict";
// Tests run directly with Node 22.18+ type stripping, without a build or extra dependencies.
const { defaultProfile, normalizeProfile, normalizePapers, normalizeText, baseId, classifyPaper, rankPartition, makeShortlist, termMultiplier, exportMarkdown } = await import(new URL("../lib/arxiv.ts", import.meta.url).href);
import type { Paper, Profile, RankedPaper } from "../lib/types";

const paper = (id: string, title: string, extra: Partial<Paper> = {}): Paper => ({
  id, base_id: baseId(id), title, abstract: "", authors: [], published: "2026-10-23", updated: "2026-10-23", categories: ["math.AG"], ...extra,
});
const profile = (extra: Partial<Profile> = {}): Profile => ({ ...defaultProfile(), ...extra });

test("blank profiles are independent and imports are bounded and type safe", () => {
  const a = defaultProfile(), b = defaultProfile(); a.broad.push("geometry"); assert.deepEqual(b.broad, []);
  const p = normalizeProfile({ broad: ["  geometry  ", "geometry", 2, null], sharp: "invalid", context: "x".repeat(20000), weights: { geometry: 3, bad: Infinity } });
  assert.deepEqual(p.broad, ["geometry"]); assert.deepEqual(p.sharp, []); assert.equal(p.context.length, 16000); assert.deepEqual(p.weights, { geometry: 3 });
  assert.deepEqual(normalizeProfile(null), defaultProfile());
});
test("precise phrases outrank broad terms, titles outrank abstracts", () => {
  const { ranked } = rankPartition([paper("2610.00001", "Geometry"), paper("2610.00002", "Mirror symmetry"), paper("2610.00003", "A theorem", { abstract: "mirror symmetry" })], profile({ broad: ["geometry"], sharp: ["mirror symmetry"] }));
  assert.equal(ranked[0].id, "2610.00002");
  assert.ok(ranked.find((p: Paper) => p.id === "2610.00002").score > ranked.find((p: Paper) => p.id === "2610.00003").score);
  const equalFrequency = rankPartition([paper("2610.00001", "Geometry"), paper("2610.00002", "Mirror symmetry")], profile({ broad: ["geometry"], sharp: ["mirror symmetry"] })).ranked;
  assert.equal(equalFrequency[0].id, "2610.00002");
});
test("dash/diacritic normalization agrees, but phrase boundaries avoid collisions", () => {
  assert.equal(normalizeText("Gromov—Witten"), normalizeText("Gromov--Witten"));
  const { ranked } = rankPartition([paper("2610.00001", "Gromov--Witten invariants"), paper("2610.00002", "Topology")], profile({ sharp: ["Gromov-Witten", "log"] }));
  assert.equal(ranked.length, 1); assert.deepEqual(ranked[0].matched, ["Gromov-Witten"]);
});
test("full followed names and explicit variants match, surname/initial collisions do not", () => {
  const papers = [paper("2610.00001", "A", { authors: ["Gérard Dubois-Lambert"] }), paper("2610.00002", "B", { authors: ["Mei Ling Chen"] }), paper("2610.00003", "C", { authors: ["Other Chen"] }), paper("2610.00004", "D", { authors: ["T. Saito"] })];
  const { ranked, unmatched } = rankPartition(papers, profile({ authors: ["Dubois-Lambert, Gerard (Paris) — colleague", "Mei-Ling Chen [also: Mei Ling Chen]", "Saito"] }));
  assert.equal(ranked.length, 2); assert.ok(ranked.every((p: RankedPaper) => p.author_match)); assert.equal(unmatched.length, 2);
});
test("negative phrases and own IDs explicitly veto even followed authors", () => {
  const { ranked, unmatched } = rankPartition([paper("math/0601234v2", "Geometry", { authors: ["Emmy Noether"] }), paper("2610.00002", "Financial geometry", { authors: ["Emmy Noether"] }), paper("2610.00003", "Adjacent methods")], profile({ broad: ["geometry"], authors: ["Emmy Noether"], negative: ["financial"], exclude_ids: ["math/0601234"] }));
  assert.equal(ranked.length, 0); assert.deepEqual(unmatched.map((p: Paper) => p.id), ["2610.00003"]);
});
test("weekly windows distinguish new, revised, grace and outside records", () => {
  const c = "2026-10-20", g = "2026-10-16";
  assert.equal(classifyPaper(paper("2610.00001", "New"), c, g), "new");
  assert.equal(classifyPaper(paper("math/0601234v2", "Revision", { published: "2006-01-10" }), c, g), "revised");
  assert.equal(classifyPaper(paper("2610.00003", "Grace", { published: "2026-10-18", updated: "2026-10-18" }), c, g), "late-window");
  assert.equal(classifyPaper(paper("2610.00004", "Old", { published: "2026-10-10", updated: "2026-10-10" }), c, g), undefined);
});
test("paper import keeps old-style IDs, strips versions only at the end, deduplicates and skips broken records", () => {
  const rows = normalizePapers([paper("math/0601234v2", "Old ID"), paper("math/0601234v1", "Duplicate"), paper("2610.00001v3", "Modern ID"), paper("bad/id", "Bad"), { id: "2610.00004", title: "No date" }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].base_id, "math/0601234"); assert.equal(rows[1].base_id, "2610.00001");
});
test("semantic selection is deduplicated, bounded, and cannot displace followed authors", () => {
  const all = Array.from({ length: 30 }, (_, i) => paper(`2610.${String(i + 1).padStart(5, "0")}`, `Paper ${i}`));
  const ranked = all.slice(0, 16).map((p, i) => ({ ...p, score: 100-i, matched: ["topic"], author_match: i < 3 }));
  const semantic = all.slice(16).map(p => ({ id: p.id, connection: "Adjacent method" }));
  semantic.push(semantic[0], { id: "2610.99999", connection: "Invented" });
  const selected = makeShortlist(ranked, semantic, all, 20);
  assert.equal(selected.length, 20); assert.equal(selected.filter((p: RankedPaper) => p.semantic).length, 5); assert.equal(selected.filter((p: RankedPaper) => p.author_match).length, 3);
  assert.equal(new Set(selected.map((p: Paper) => p.base_id)).size, 20);
  const small = makeShortlist(ranked, semantic, all, 5); assert.equal(small.length, 5); assert.equal(small.filter((p: RankedPaper) => p.semantic).length, 1);
});
test("feedback boost is positive-only and capped; export retains provenance", () => {
  assert.equal(termMultiplier(0), 1); assert.ok(termMultiplier(1) > 1); assert.equal(termMultiplier(1000), 2);
  const md = exportMarkdown([{ ...paper("math/0601234v2", "A [paper]"), matched: ["geometry"], author_match: true, caveat: "Abstract only" }]);
  assert.match(md, /https:\/\/arxiv.org\/abs\/math\/0601234/); assert.match(md, /Matched: geometry/); assert.match(md, /Abstract only/);
});
