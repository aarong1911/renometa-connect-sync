// src/lib/pricing/price-book.test.ts
//
// Run:  node --test src/lib/pricing/price-book.test.ts
//
// Pricing Intelligence P4. Pure, deterministic tests for the Price Book: write validation + server-side normalization, matching
// tiers and rules (units, item types, project scope, ties), confidence, and evidence PRECEDENCE (Price Book -> history -> none,
// never blended, no AI/market source). No database, no network, no model, no wall clock.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "price-book-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/pricing/price-book";
      export * from "./src/lib/pricing/pricing-suggestions";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const P: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const NOW = "2026-10-15T00:00:00.000Z";
const ctx = (over: Record<string, unknown> = {}) => ({ now: NOW, projectType: "kitchen_remodel", ...over });

function entry(over: Record<string, unknown> = {}) {
  return {
    name: "Vanity installation", aliases: [], projectTypes: [], itemType: "labor", unit: "each",
    sellUnitPrice: 450, lowUnitPrice: null, highUnitPrice: null, reviewed: true, ...over,
  };
}
const req = (over: Record<string, unknown> = {}) => ({ name: "Vanity installation", itemType: "labor", unit: null, quantity: null, description: null, ...over });

function histLine(over: Record<string, unknown> = {}) {
  const d = new Date(NOW); d.setUTCMonth(d.getUTCMonth() - 1);
  return {
    source: "estimate_line", estimateStatus: "approved", name: "Vanity installation", itemType: "labor", unit: "each", unitPrice: 100,
    documentDate: d.toISOString(), projectType: "kitchen_remodel", ...over,
  };
}

// ── Write validation + server-side normalization ─────────────────────────

const validWrite = (over: Record<string, unknown> = {}) => ({ name: "  Vanity   Installation ", unit: "Each", sellUnitPrice: 450, ...over });

test("write — normalized_name / aliases / unit are computed server-side from the shared normalizer", () => {
  const r = P.normalizePriceBookWrite(validWrite({ aliases: ["Install vanity", "install vanity"], projectTypes: ["kitchen_remodel", "kitchen_remodel"] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof r.columns.normalized_name, "string");
  assert.ok(r.columns.normalized_name.length > 0);
  assert.deepEqual(r.columns.project_types, ["kitchen_remodel"], "project types de-duplicated");
  assert.equal(new Set(r.columns.aliases).size, r.columns.aliases.length, "aliases de-duplicated");
  assert.equal(r.columns.sell_unit_price, 450);
});

test("write — a browser-supplied normalized_name, org_id, reviewed_by, id, source or timestamps are REJECTED (strict schema)", () => {
  for (const extra of [{ normalized_name: "x" }, { normalizedName: "x" }, { org_id: "o" }, { orgId: "o" }, { reviewed_by: "u" }, { reviewedBy: "u" }, { id: "i" }, { source: "ai" }, { created_at: "t" }, { updated_at: "t" }, { reviewedAt: "t" }]) {
    assert.equal(P.normalizePriceBookWrite(validWrite(extra)).ok, false, `accepted ${Object.keys(extra)[0]}`);
  }
});

test("write — prices must be non-negative, finite and within bounds; low <= sell <= high", () => {
  for (const bad of [{ sellUnitPrice: -1 }, { sellUnitPrice: Number.NaN }, { sellUnitPrice: Infinity }, { sellUnitPrice: 1e15 }, { sellUnitPrice: "450" }]) {
    assert.equal(P.normalizePriceBookWrite(validWrite(bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(P.normalizePriceBookWrite(validWrite({ lowUnitPrice: 500 })).ok, false, "low above sell");
  assert.equal(P.normalizePriceBookWrite(validWrite({ highUnitPrice: 400 })).ok, false, "high below sell");
  assert.equal(P.normalizePriceBookWrite(validWrite({ lowUnitPrice: 400, highUnitPrice: 500 })).ok, true);
  assert.equal(P.normalizePriceBookWrite(validWrite({ sellUnitPrice: 0 })).ok, true, "a $0 sell price is representable (e.g. a free item)");
});

test("write — blank name/unit, bad project types, bad item types and over-long arrays are rejected", () => {
  assert.equal(P.normalizePriceBookWrite(validWrite({ name: "   " })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ unit: "" })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ projectTypes: ["not_a_type"] })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ itemType: "discount" })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ aliases: Array.from({ length: 26 }, (_, i) => `a${i}`) })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ aliases: ["  "] })).ok, false);
});

test("write — markup is bounded and optional; internal cost is carried only as configuration", () => {
  assert.equal(P.normalizePriceBookWrite(validWrite({ defaultMarkupPercent: -1 })).ok, false);
  assert.equal(P.normalizePriceBookWrite(validWrite({ defaultMarkupPercent: 1e6 })).ok, false);
  const ok = P.normalizePriceBookWrite(validWrite({ internalUnitCost: 200, defaultMarkupPercent: 125 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.columns.internal_unit_cost, 200);
  assert.equal(ok.columns.sell_unit_price, 450, "the sell price is NOT derived from cost x markup");
});

// ── Matching ─────────────────────────────────────────────────────────────

test("match — tiers: exact, alias, conservative token", () => {
  const book = [entry({ name: "Vanity installation", aliases: ["Install bathroom vanity"] })];
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, book, "kitchen_remodel").match.tier, "exact");
  assert.equal(P.matchPriceBook({ name: "Install bathroom vanity" }, book, "kitchen_remodel").match.tier, "alias");
  const token = P.matchPriceBook({ name: "Vanity installation labor" }, book, "kitchen_remodel");
  assert.ok(token.kind === "match" && ["token", "fuzzy"].includes(token.match.tier), JSON.stringify(token));
  assert.ok(token.kind === "match" && token.match.tier !== "exact", "a looser name is never reported as an exact match");
  assert.equal(P.matchPriceBook({ name: "Roof shingles" }, book, "kitchen_remodel").kind, "none");
});

test("match — incompatible units and incompatible item types never match; an open unit matches", () => {
  const book = [entry({ unit: "sqft", itemType: "material", name: "Tile" })];
  assert.equal(P.matchPriceBook({ name: "Tile", itemType: "material", unit: "hour" }, book, null).kind, "none", "unit mismatch");
  assert.equal(P.matchPriceBook({ name: "Tile", itemType: "labor", unit: "sqft" }, book, null).kind, "none", "item type mismatch");
  assert.equal(P.matchPriceBook({ name: "Tile", itemType: "material", unit: "sqft" }, book, null).kind, "match");
  assert.equal(P.matchPriceBook({ name: "Tile", itemType: "material", unit: null }, book, null).kind, "match", "open unit");
});

test("match — project-type specific beats generic; unknown project type uses generic only", () => {
  const generic = entry({ sellUnitPrice: 400 });
  const kitchen = entry({ sellUnitPrice: 550, projectTypes: ["kitchen_remodel"] });
  const m = P.matchPriceBook({ name: "Vanity installation" }, [generic, kitchen], "kitchen_remodel");
  assert.equal(m.match.item.sellUnitPrice, 550);
  assert.equal(m.match.projectTypeSpecific, true);
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [generic, kitchen], "roofing").match.item.sellUnitPrice, 400, "other type falls back to generic");
  const unknown = P.matchPriceBook({ name: "Vanity installation" }, [generic, kitchen], null);
  assert.equal(unknown.match.item.sellUnitPrice, 400, "unknown project type -> generic");
  assert.equal(unknown.match.projectTypeSpecific, false);
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [kitchen], null).kind, "none", "a type-specific entry is not used when the type is unknown");
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [kitchen], "roofing").kind, "none", "a different project type's entry is not used");
});

test("match — TIE RULE: best tier, then specific over generic, then reviewed over unreviewed; remaining DIFFERENT prices are ambiguous (nothing chosen)", () => {
  const a = entry({ sellUnitPrice: 400, reviewed: false });
  const b = entry({ sellUnitPrice: 500, reviewed: false });
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [a, b], "kitchen_remodel").kind, "ambiguous");
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [a, entry({ sellUnitPrice: 500, reviewed: true })], "kitchen_remodel").match.item.sellUnitPrice, 500, "reviewed wins");
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [b, a], "kitchen_remodel").kind, "ambiguous", "order independent");
  const dupA = entry({ sellUnitPrice: 400 }); const dupB = entry({ sellUnitPrice: 400 });
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [dupA, dupB], "kitchen_remodel").kind, "match", "identical pricing is not a conflict");
  // an exact match beats a looser one even when the looser entry is reviewed
  const exact = entry({ sellUnitPrice: 300, reviewed: false });
  const loose = entry({ name: "Vanity installation extra premium", sellUnitPrice: 900, reviewed: true });
  assert.equal(P.matchPriceBook({ name: "Vanity installation" }, [loose, exact], null).match.item.sellUnitPrice, 300);
});

// ── Confidence ───────────────────────────────────────────────────────────

test("confidence — HIGH reviewed exact/alias with specific match or generic+unknown type; MEDIUM unreviewed or generic fallback or token; LOW fuzzy", () => {
  const c = P.priceBookConfidence;
  assert.equal(c({ tier: "exact", reviewed: true, projectTypeSpecific: true, projectTypeKnown: true }), "high");
  assert.equal(c({ tier: "alias", reviewed: true, projectTypeSpecific: true, projectTypeKnown: true }), "high");
  assert.equal(c({ tier: "exact", reviewed: true, projectTypeSpecific: false, projectTypeKnown: false }), "high", "generic is fine when the type is unknown");
  assert.equal(c({ tier: "exact", reviewed: true, projectTypeSpecific: false, projectTypeKnown: true }), "medium", "generic fallback for a known type");
  assert.equal(c({ tier: "exact", reviewed: false, projectTypeSpecific: true, projectTypeKnown: true }), "medium", "unreviewed");
  assert.equal(c({ tier: "token", reviewed: true, projectTypeSpecific: true, projectTypeKnown: true }), "medium");
  assert.equal(c({ tier: "fuzzy", reviewed: true, projectTypeSpecific: true, projectTypeKnown: true }), "low");
});

// ── Precedence + suggestion contract ─────────────────────────────────────

test("precedence — a price book match wins over history and is NEVER blended with it", () => {
  const history = [histLine({ unitPrice: 100 }), histLine({ unitPrice: 110 }), histLine({ unitPrice: 120 }), histLine({ unitPrice: 130 }), histLine({ unitPrice: 140 })];
  const s = P.suggestPricingWithPriceBookForItem(req({ quantity: 2 }), [entry({ sellUnitPrice: 450 })], history, ctx());
  assert.equal(s.pricingSource, "price_book");
  assert.equal(s.suggestedUnitPrice, 450, "exactly the price book sell price (no averaging with the 100-140 history)");
  assert.equal(s.suggestedTotal, 900);
  assert.equal(s.evidence.kind, "price_book");
  assert.equal(s.evidence.sampleCount, 0, "no historical samples are counted for a price book result");
});

test("precedence — no price book match -> organization history; neither -> none", () => {
  const history = Array.from({ length: 5 }, (_, i) => histLine({ unitPrice: 100 + i }));
  const fromHistory = P.suggestPricingWithPriceBookForItem(req(), [entry({ name: "Crown molding", itemType: "material" })], history, ctx());
  assert.equal(fromHistory.pricingSource, "org_history");
  assert.equal(fromHistory.evidence.kind, "org_history");
  const none = P.suggestPricingWithPriceBookForItem(req({ name: "Unheard of widget" }), [entry()], history, ctx());
  assert.equal(none.pricingSource, "none");
  assert.equal(none.suggestedUnitPrice, null);
  assert.equal(none.confidence, "none");
  assert.ok(!JSON.stringify(none).includes("market"), "no market/AI source");
});

test("precedence — an inactive entry never matches (the reader filters it; the matcher is given only active entries)", () => {
  // the reader contract: inactive rows are not passed in. A suggestion therefore falls through to history/none.
  const s = P.suggestPricingWithPriceBookForItem(req(), [], [], ctx());
  assert.equal(s.pricingSource, "none");
});

test("range contract (Option B) — lowEstimate/highEstimate are null unless configured; suggestedUnitPrice is always the sell price", () => {
  const plain = P.suggestPricingWithPriceBookForItem(req({ quantity: 3 }), [entry({ sellUnitPrice: 450 })], [], ctx());
  assert.equal(plain.suggestedUnitPrice, 450);
  assert.equal(plain.lowEstimate, null);
  assert.equal(plain.highEstimate, null);
  assert.equal(plain.lowTotal, null);
  const ranged = P.suggestPricingWithPriceBookForItem(req({ quantity: 3 }), [entry({ sellUnitPrice: 450, lowUnitPrice: 400, highUnitPrice: 500 })], [], ctx());
  assert.equal(ranged.lowEstimate, 400);
  assert.equal(ranged.highEstimate, 500);
  assert.equal(ranged.suggestedTotal, 1350);
  assert.equal(ranged.lowTotal, 1200);
  assert.equal(ranged.highTotal, 1500);
  const lowOnly = P.suggestPricingWithPriceBookForItem(req(), [entry({ lowUnitPrice: 400 })], [], ctx());
  assert.equal(lowOnly.lowEstimate, 400);
  assert.equal(lowOnly.highEstimate, null, "a single configured bound is not mirrored into the other");
});

test("quantity — total is sell x quantity when known; otherwise null with 'quantity' reported missing; quantity is never guessed", () => {
  const known = P.suggestPricingWithPriceBookForItem(req({ quantity: 4 }), [entry({ sellUnitPrice: 12.5 })], [], ctx());
  assert.equal(known.suggestedTotal, 50);
  assert.ok(!known.missingInputs.includes("quantity"));
  const unknown = P.suggestPricingWithPriceBookForItem(req(), [entry()], [], ctx());
  assert.equal(unknown.suggestedTotal, null);
  assert.ok(unknown.missingInputs.includes("quantity"));
  assert.equal(unknown.quantity, null);
  for (const q of [0, -2, Number.NaN]) assert.equal(P.suggestPricingWithPriceBookForItem(req({ quantity: q }), [entry()], [], ctx()).suggestedTotal, null, `quantity ${q}`);
});

test("unknown project type — a generic entry is valid, 'project_type' is reported missing, HIGH is still possible when reviewed", () => {
  const s = P.suggestPricingWithPriceBookForItem(req(), [entry()], [], ctx({ projectType: null }));
  assert.equal(s.pricingSource, "price_book");
  assert.equal(s.confidence, "high");
  assert.ok(s.missingInputs.includes("project_type"));
  assert.equal(s.evidence.projectTypeSpecific, false);
});

test("evidence — price book evidence carries kind/reviewed/projectTypeSpecific/matchTier and NO catalog id, cost, markup, notes or reviewer", () => {
  const s = P.suggestPricingWithPriceBookForItem(req(), [{ ...entry({ projectTypes: ["kitchen_remodel"] }), id: "CATALOG-ID-123", internal_unit_cost: 77777, internalUnitCost: 77777, defaultMarkupPercent: 4321, notes: "SENTINEL-NOTE", reviewed_by: "SENTINEL-USER" }], [], ctx());
  assert.deepEqual({ kind: s.evidence.kind, reviewed: s.evidence.reviewed, projectTypeSpecific: s.evidence.projectTypeSpecific, matchTier: s.evidence.matchTier }, { kind: "price_book", reviewed: true, projectTypeSpecific: true, matchTier: "exact" });
  const json = JSON.stringify(s);
  for (const forbidden of ["CATALOG-ID-123", "77777", "4321", "SENTINEL"]) assert.ok(!json.includes(forbidden), `leaked ${forbidden}`);
});

test("ambiguity — several equal entries: no price book price is chosen; history (if any) is used and the ambiguity is stated", () => {
  const history = Array.from({ length: 5 }, (_, i) => histLine({ unitPrice: 100 + i }));
  const s = P.suggestPricingWithPriceBookForItem(req(), [entry({ sellUnitPrice: 400, reviewed: false }), entry({ sellUnitPrice: 500, reviewed: false })], history, ctx());
  assert.equal(s.pricingSource, "org_history");
  assert.ok(s.assumptions.some((a: string) => /Several price book entries match/.test(a)));
  const noHistory = P.suggestPricingWithPriceBookForItem(req(), [entry({ sellUnitPrice: 400, reviewed: false }), entry({ sellUnitPrice: 500, reviewed: false })], [], ctx());
  assert.equal(noHistory.pricingSource, "none");
  assert.equal(noHistory.suggestedUnitPrice, null);
});

test("determinism — same inputs, same output, regardless of price book order", () => {
  const book = [entry({ name: "A item", sellUnitPrice: 10 }), entry({ sellUnitPrice: 450 }), entry({ name: "Z item", sellUnitPrice: 20 })];
  const a = JSON.stringify(P.suggestPricingWithPriceBook([req()], book, [], ctx()));
  const b = JSON.stringify(P.suggestPricingWithPriceBook([req()], [...book].reverse(), [], ctx()));
  assert.equal(a, b);
});
