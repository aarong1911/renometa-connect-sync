// src/lib/pricing/pricing-engine.test.ts
//
// Run:  node --test src/lib/pricing/pricing-engine.test.ts
//
// Pricing Intelligence v1 (P1). Pure, deterministic tests for the pricing engine: eligibility, matching tiers, scope
// preference, recency weighting, outlier handling, confidence and the output contract. The clock is INJECTED (NOW below);
// no database, no network, no model, no wall-clock reads.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "pricing-engine-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: { contents: `export * from "./src/lib/pricing/pricing-engine";`, resolveDir: repoRoot, loader: "ts" },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const E: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const NOW = "2026-10-15T00:00:00.000Z";
const ctx = (over: Record<string, unknown> = {}) => ({ now: NOW, projectType: "kitchen_remodel", ...over });

function monthsAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
}

/** One historical line. Defaults: an APPROVED estimate "Vanity installation", labor, each, $100, one month ago, kitchen. */
function L(over: Record<string, unknown> = {}) {
  return {
    source: "estimate_line", name: "Vanity installation", itemType: "labor", unit: "each", unitPrice: 100,
    estimateStatus: "approved", documentDate: monthsAgo(1), projectType: "kitchen_remodel", ...over,
  };
}
const many = (n: number, over: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => L(over(i)));
const REQ = { name: "Vanity installation", itemType: "labor", unit: "each" };
const price = (evidence: any[], req: any = REQ, c: any = ctx()) => E.suggestPricingForItem(req, evidence, c);

// ── Normalization flows through matching ─────────────────────────────────

test("units — 'ea' evidence matches an 'each' request", () => {
  const r = price(many(4, (i) => ({ unit: "ea", unitPrice: 100 + i })));
  assert.equal(r.evidence.sampleCount, 4);
  assert.equal(r.unit, "each");
});

test("units — sqft / sf / square feet / sq ft evidence all pool for a 'sqft' request", () => {
  const r = price(
    [L({ unit: "sf", unitPrice: 10 }), L({ unit: "SQ FT", unitPrice: 11 }), L({ unit: "square feet", unitPrice: 12 }), L({ unit: "sqft", unitPrice: 11 })],
    { name: "Vanity installation", itemType: "labor", unit: "sqft" },
  );
  assert.equal(r.evidence.sampleCount, 4);
  assert.equal(r.unit, "sqft");
});

test("units — INCOMPATIBLE units are rejected: history in sqft never prices an 'each' request", () => {
  const r = price(many(6, () => ({ unit: "sqft", unitPrice: 12 })));
  assert.equal(r.pricingSource, "none");
  assert.equal(r.confidence, "none");
  assert.equal(r.suggestedUnitPrice, null);
  assert.equal(r.evidence.sampleCount, 0);
});

// ── Matching tiers ───────────────────────────────────────────────────────

test("tier — EXACT name match", () => {
  const r = price(many(4, (i) => ({ unitPrice: 100 + i })));
  assert.equal(r.evidence.matchTier, "exact");
  assert.equal(r.pricingSource, "org_history");
});

test("tier — ALIAS match (Sheetrock request vs Drywall history)", () => {
  const r = price(many(4, (i) => ({ name: "Drywall repair", unitPrice: 50 + i })), { name: "Sheetrock repair", itemType: "labor", unit: "each" });
  assert.equal(r.evidence.matchTier, "alias");
  assert.equal(r.evidence.sampleCount, 4);
});

test("tier — TOKEN match is capped at medium confidence", () => {
  const r = price(many(10, (i) => ({ name: "Remove kitchen cabinet", unitPrice: 200 + (i % 3) })), { name: "Remove old kitchen cabinet", itemType: "labor", unit: "each" });
  assert.equal(r.evidence.matchTier, "token");
  assert.equal(r.confidence, "medium");
});

test("tier — FUZZY match is only ever LOW confidence", () => {
  const r = price(many(10, (i) => ({ name: "Install tile floor", unitPrice: 300 + (i % 3) })), { name: "Install tile floor bathroom shower", itemType: "labor", unit: "each" });
  assert.equal(r.evidence.matchTier, "fuzzy");
  assert.equal(r.confidence, "low");
  assert.ok(r.assumptions.some((a: string) => /loosely similar/i.test(a)));
});

test("tier — a better tier is never diluted by worse matches (exact pool ignores token/fuzzy lines)", () => {
  const ev = [...many(4, (i) => ({ unitPrice: 100 + i })), ...many(4, () => ({ name: "Vanity installation extra", unitPrice: 900 }))];
  const r = price(ev);
  assert.equal(r.evidence.matchTier, "exact");
  assert.equal(r.evidence.sampleCount, 4);
  assert.ok(r.suggestedUnitPrice < 200);
});

test("tier — unrelated history gives no suggestion", () => {
  const r = price(many(5, () => ({ name: "Roof shingle replacement", unitPrice: 5000 })));
  assert.equal(r.pricingSource, "none");
  assert.equal(r.confidence, "none");
});

// ── Scope preference ─────────────────────────────────────────────────────

test("scope — SAME project type is preferred once it has >= 3 samples", () => {
  const ev = [...many(3, () => ({ unitPrice: 100, projectType: "kitchen_remodel" })), ...many(5, () => ({ unitPrice: 200, projectType: "bathroom_remodel" }))];
  const r = price(ev);
  assert.equal(r.evidence.scope, "same_project_type");
  assert.equal(r.evidence.sameProjectTypeCount, 3);
  assert.equal(r.suggestedUnitPrice, 100);
});

test("scope — a DIFFERENT project type falls back to org-wide history, says so, and is still MEDIUM (same-type evidence is a boost, not a requirement)", () => {
  const r = price(many(6, (i) => ({ unitPrice: 200 + i, projectType: "bathroom_remodel" })));
  assert.equal(r.evidence.scope, "org_wide");
  assert.equal(r.evidence.sameProjectTypeCount, 0);
  assert.equal(r.confidence, "medium");
  assert.ok(r.assumptions.some((a: string) => /broader history/i.test(a)));
});

test("scope — fewer than 3 same-type samples still uses org-wide history (and counts the same-type ones)", () => {
  const ev = [...many(2, () => ({ unitPrice: 100, projectType: "kitchen_remodel" })), ...many(4, () => ({ unitPrice: 200, projectType: "bathroom_remodel" }))];
  const r = price(ev);
  assert.equal(r.evidence.scope, "org_wide");
  assert.equal(r.evidence.sampleCount, 6);
  assert.equal(r.evidence.sameProjectTypeCount, 2);
});

test("scope — unknown project type: all history is used, 'project_type' is reported missing, confidence never exceeds medium", () => {
  const r = price(many(12, (i) => ({ unitPrice: 100 + (i % 3) })), REQ, ctx({ projectType: null }));
  assert.ok(r.missingInputs.includes("project_type"));
  assert.equal(r.evidence.scope, "org_wide");
  assert.equal(r.confidence, "medium");
});

// ── Window, recency ──────────────────────────────────────────────────────

test("window — evidence older than 36 months is excluded; 35 months is included", () => {
  const r = price([L({ documentDate: monthsAgo(37), unitPrice: 999 }), L({ documentDate: monthsAgo(35), unitPrice: 100 }), L({ documentDate: monthsAgo(34), unitPrice: 101 })]);
  assert.equal(r.evidence.sampleCount, 2);
  assert.ok(r.suggestedUnitPrice < 200);
});

test("window — future-dated and invalid-dated evidence is excluded", () => {
  const r = price([L({ documentDate: "2027-05-01T00:00:00Z", unitPrice: 999 }), L({ documentDate: "not-a-date", unitPrice: 999 }), L({ unitPrice: 100 })]);
  assert.equal(r.evidence.sampleCount, 1);
});

test("recency — newer samples weigh more: the suggested price follows recent pricing while the plain median does not", () => {
  const ev = [...many(3, () => ({ unitPrice: 100, documentDate: monthsAgo(30) })), ...many(3, () => ({ unitPrice: 200, documentDate: monthsAgo(1) }))];
  const r = price(ev);
  assert.equal(r.evidence.medianUnitPrice, 150, "plain median of the samples");
  assert.equal(r.suggestedUnitPrice, 200, "recency-weighted median favors the recent price");
});

test("recency — weight halves every 18 months", () => {
  const now = new Date(NOW);
  const w0 = E.recencyWeight(now, now);
  const w18 = E.recencyWeight(new Date(monthsAgo(18)), now);
  const w36 = E.recencyWeight(new Date(monthsAgo(36)), now);
  assert.equal(w0, 1);
  assert.ok(Math.abs(w18 - 0.5) < 0.01, String(w18));
  assert.ok(Math.abs(w36 - 0.25) < 0.01, String(w36));
});

// ── Outliers ─────────────────────────────────────────────────────────────

test("outliers — a wild price is trimmed when there are >= 4 samples (median-based, IQR fences)", () => {
  const ev = [...many(8, (i) => ({ unitPrice: 100 + i })), L({ unitPrice: 5000 })];
  const r = price(ev);
  assert.equal(r.evidence.outliersRemoved, 1);
  assert.equal(r.evidence.sampleCount, 8);
  assert.ok(r.highEstimate < 200);
  assert.ok(r.assumptions.some((a: string) => /outlier/i.test(a)));
});

test("outliers — NO trimming with fewer than 4 samples", () => {
  const r = price([L({ unitPrice: 100 }), L({ unitPrice: 105 }), L({ unitPrice: 5000 })]);
  assert.equal(r.evidence.outliersRemoved, 0);
  assert.equal(r.evidence.sampleCount, 3);
});

test("outliers — trimming starts at exactly 4 samples (the threshold is 4) and a true outlier is then removed", () => {
  assert.equal(E.MIN_SAMPLES_FOR_TRIMMING, 4);
  const four = E.trimOutliers([{ value: 100 }, { value: 100 }, { value: 101 }, { value: 1000 }]);
  assert.equal(four.removed, 1);
  assert.deepEqual(four.kept.map((x: any) => x.value), [100, 100, 101]);
  const three = E.trimOutliers([{ value: 100 }, { value: 101 }, { value: 1000 }]);
  assert.equal(three.removed, 0, "fewer than 4 samples are never trimmed");
});

test("outliers — trimming never leaves fewer than max(3, ceil(n/2)) samples", () => {
  const t = E.trimOutliers([{ value: 1 }, { value: 100 }, { value: 100 }, { value: 10000 }]);
  assert.ok(t.kept.length >= 3);
  const tight = E.trimOutliers([{ value: 100 }, { value: 101 }, { value: 102 }, { value: 103 }]);
  assert.equal(tight.removed, 0);
});

// ── Eligibility ──────────────────────────────────────────────────────────

test("eligibility — price_pending rows and AI placeholders are never evidence", () => {
  const r = price([L({ metadata: { price_pending: true } }), L({ metadata: { ai_proposed: true } }), L({ metadata: { price_pending: true, ai_proposed: true } })]);
  assert.equal(r.pricingSource, "none");
});

test("eligibility — a reviewed $0 / no-charge line (unit_price 0) is NOT price evidence, but a stale price_pending marker on a priced line also stays excluded", () => {
  const r = price([L({ unitPrice: 0, metadata: {} }), L({ unitPrice: -5 }), L({ unitPrice: Number.NaN })]);
  assert.equal(r.pricingSource, "none");
  assert.equal(E.evaluateEligibility(L({ unitPrice: 0 }), new Date(NOW)).reason, "unit_price_not_positive");
  assert.equal(E.evaluateEligibility(L({ metadata: { price_pending: true } }), new Date(NOW)).reason, "price_pending");
});

test("eligibility — headings, optional lines and discount lines are excluded", () => {
  const r = price([L({ isHeading: true }), L({ optional: true }), L({ itemType: "discount" })]);
  assert.equal(r.pricingSource, "none");
});

test("eligibility — DRAFT and every non-evidence estimate status are excluded", () => {
  for (const s of ["draft", "ready", "rejected", "cancelled", "archived", "expired", "changes_requested", "", null]) {
    assert.equal(E.evaluateEligibility(L({ estimateStatus: s }), new Date(NOW)).eligible, false, String(s));
  }
  assert.equal(price(many(5, () => ({ estimateStatus: "draft" }))).pricingSource, "none");
});

test("eligibility — approved / converted estimates are STRONG evidence", () => {
  for (const s of ["approved", "converted"]) {
    const e = E.evaluateEligibility(L({ estimateStatus: s }), new Date(NOW));
    assert.equal(e.eligible, true);
    assert.equal(e.strength, "strong");
  }
  const r = price([L({ estimateStatus: "approved" }), L({ estimateStatus: "converted" }), L({ estimateStatus: "approved" }), L({ estimateStatus: "converted" })]);
  assert.equal(r.evidence.strongSampleCount, 4);
});

test("eligibility — sent / viewed estimates are SECONDARY evidence (lower weight)", () => {
  for (const s of ["sent", "viewed"]) {
    const e = E.evaluateEligibility(L({ estimateStatus: s }), new Date(NOW));
    assert.equal(e.eligible, true);
    assert.equal(e.strength, "secondary");
    assert.equal(e.weightBase, E.SECONDARY_EVIDENCE_WEIGHT);
  }
  const r = price([L({ estimateStatus: "sent", unitPrice: 100 }), L({ estimateStatus: "viewed", unitPrice: 101 }), L({ estimateStatus: "approved", unitPrice: 102 }), L({ estimateStatus: "sent", unitPrice: 103 })]);
  assert.equal(r.evidence.secondarySampleCount, 3);
  assert.equal(r.evidence.strongSampleCount, 1);
});

test("eligibility — strong evidence outweighs secondary evidence at the same age", () => {
  const ev = [...many(3, () => ({ estimateStatus: "sent", unitPrice: 100 })), ...many(3, () => ({ estimateStatus: "approved", unitPrice: 200 }))];
  const r = price(ev);
  assert.equal(r.suggestedUnitPrice, 200);
});

test("eligibility — APPROVED change-order items are evidence; unapproved change orders are not", () => {
  const co = (status: string, p: number) => ({ source: "change_order_item", name: "Vanity installation", itemType: "service", unit: "each", unitPrice: p, changeOrderStatus: status, documentDate: monthsAgo(2), projectType: "kitchen_remodel" });
  const r = price([co("approved", 100), co("approved", 102), co("approved", 104), co("approved", 106), co("draft", 900), co("rejected", 900), co("superseded", 900), co("sent", 900)]);
  assert.equal(r.evidence.sampleCount, 4);
  assert.equal(r.evidence.changeOrderSampleCount, 4);
  assert.ok(r.assumptions.some((a: string) => /change-order/i.test(a)));
  assert.equal(E.evaluateEligibility(co("approved", 10) as any, new Date(NOW)).strength, "strong");
});

test("eligibility — estimate lines and change-order items can be combined as one pool", () => {
  const co = { source: "change_order_item", name: "Vanity installation", itemType: "labor", unit: "each", unitPrice: 101, changeOrderStatus: "approved", documentDate: monthsAgo(2), projectType: "kitchen_remodel" };
  const r = price([L({ unitPrice: 100 }), L({ unitPrice: 102 }), co]);
  assert.equal(r.evidence.sampleCount, 3);
  assert.equal(r.evidence.changeOrderSampleCount, 1);
});

// ── Quantity, unit, location ─────────────────────────────────────────────

test("quantity — MISSING: a unit price and range are returned, total is null, 'quantity' is reported missing", () => {
  const r = price(many(5, (i) => ({ unitPrice: 100 + i })));
  assert.equal(r.quantity, null);
  assert.equal(r.suggestedTotal, null);
  assert.equal(r.lowTotal, null);
  assert.ok(r.missingInputs.includes("quantity"));
  assert.ok(r.suggestedUnitPrice > 0);
});

test("quantity — SUPPLIED: totals are unit price x quantity (rounded to cents), ranges scale too", () => {
  const r = price(many(5, (i) => ({ unitPrice: 100 + i })), { ...REQ, quantity: 3 });
  assert.equal(r.quantity, 3);
  assert.equal(r.suggestedTotal, Math.round(r.suggestedUnitPrice * 3 * 100) / 100);
  assert.equal(r.lowTotal, Math.round(r.lowEstimate * 3 * 100) / 100);
  assert.equal(r.highTotal, Math.round(r.highEstimate * 3 * 100) / 100);
  assert.ok(!r.missingInputs.includes("quantity"));
  assert.equal(price([], { ...REQ, quantity: 0 }).quantity, null, "a non-positive quantity is treated as missing");
});

test("unit — an OPEN unit uses the dominant historical unit and reports it as an assumption + missing input", () => {
  const ev = [...many(4, (i) => ({ name: "Tile installation", unit: "sf", unitPrice: 10 + i })), ...many(2, () => ({ name: "Tile installation", unit: "each", unitPrice: 500 }))];
  const r = price(ev, { name: "Tile installation", itemType: "labor" });
  assert.equal(r.unit, "sqft");
  assert.equal(r.evidence.sampleCount, 4);
  assert.ok(r.missingInputs.includes("unit"));
  assert.ok(r.assumptions.some((a: string) => /most common unit/i.test(a)));
});

test("location — carried through as a note only: locationAdjustment is always null and the price is unchanged", () => {
  const ev = many(5, (i) => ({ unitPrice: 100 + i, location: "Austin, TX" }));
  const a = price(ev, REQ, ctx({ location: "San Francisco, CA" }));
  const b = price(ev, REQ, ctx());
  assert.equal(a.locationAdjustment, null);
  assert.equal(a.suggestedUnitPrice, b.suggestedUnitPrice);
  assert.ok(a.assumptions.some((x: string) => /no regional price adjustment/i.test(x)));
});

// ── Confidence ───────────────────────────────────────────────────────────

test("confidence — HIGH: >= 8 exact samples, same project type, recent, tight spread", () => {
  const prices = [98, 99, 100, 100, 101, 101, 102, 103];
  const r = price(prices.map((p, i) => L({ unitPrice: p, documentDate: monthsAgo(1 + (i % 4)) })));
  assert.equal(r.confidence, "high");
  assert.equal(r.evidence.sampleCount, 8);
  assert.equal(r.evidence.scope, "same_project_type");
});

test("confidence — MEDIUM: 4-7 samples (even with an exact match)", () => {
  const r = price(many(6, (i) => ({ unitPrice: 100 + i })));
  assert.equal(r.confidence, "medium");
});

test("confidence — MEDIUM: 8+ samples but a wider spread than 25% of the median", () => {
  const r = price([80, 90, 100, 110, 120, 130, 140, 150].map((p) => L({ unitPrice: p })));
  assert.equal(r.confidence, "medium");
});

test("confidence — LOW: 1-3 samples", () => {
  assert.equal(price(many(1, () => ({}))).confidence, "low");
  assert.equal(price(many(3, (i) => ({ unitPrice: 100 + i }))).confidence, "low");
});

test("confidence — LOW: stale evidence (nearly all samples are old)", () => {
  const r = price(many(8, (i) => ({ unitPrice: 100 + (i % 2), documentDate: monthsAgo(33) })));
  assert.equal(r.confidence, "low");
});

test("confidence — NONE: no usable evidence says so plainly, with no number", () => {
  const r = price([]);
  assert.equal(r.confidence, "none");
  assert.equal(r.pricingSource, "none");
  assert.equal(r.suggestedUnitPrice, null);
  assert.equal(r.lowEstimate, null);
  assert.equal(r.highEstimate, null);
  assert.equal(r.evidence.sampleCount, 0);
  assert.equal(r.evidence.matchTier, null);
  assert.equal(r.locationAdjustment, null);
});

test("computeConfidence — the rules table", () => {
  const base = { sampleCount: 10, matchTier: "exact", projectTypeKnown: true, scope: "same_project_type", sameProjectTypeShare: 1, recentWeightShare: 1, spreadRatio: 0.1 };
  assert.equal(E.computeConfidence(base), "high");
  assert.equal(E.computeConfidence({ ...base, sampleCount: 7 }), "medium");
  assert.equal(E.computeConfidence({ ...base, matchTier: "alias" }), "high");
  assert.equal(E.computeConfidence({ ...base, matchTier: "token" }), "medium");
  assert.equal(E.computeConfidence({ ...base, matchTier: "fuzzy" }), "low");
  assert.equal(E.computeConfidence({ ...base, sampleCount: 3 }), "low");
  assert.equal(E.computeConfidence({ ...base, sampleCount: 0 }), "none");
  assert.equal(E.computeConfidence({ ...base, spreadRatio: 0.3 }), "medium");
  assert.equal(E.computeConfidence({ ...base, spreadRatio: 0.7 }), "low");
  assert.equal(E.computeConfidence({ ...base, recentWeightShare: 0.1 }), "low");
  assert.equal(E.computeConfidence({ ...base, projectTypeKnown: false, scope: "org_wide" }), "medium");
  assert.equal(E.computeConfidence({ ...base, scope: "org_wide", sameProjectTypeShare: 0 }), "medium", "org-wide scope is never penalized to low on its own");
  assert.equal(E.computeConfidence({ ...base, scope: "org_wide", sameProjectTypeShare: 0, sampleCount: 20 }), "medium", "high needs same-project-type evidence");
});

// ── Contract, determinism, trust boundary ────────────────────────────────

test("output contract — exact keys, pricingSource limited to org_history | none, locationAdjustment null", () => {
  const r = price(many(5, (i) => ({ unitPrice: 100 + i })), { ...REQ, quantity: 2 });
  assert.deepEqual(Object.keys(r).sort(), [
    "assumptions", "confidence", "evidence", "highEstimate", "highTotal", "itemName", "itemType", "locationAdjustment", "lowEstimate", "lowTotal",
    "missingInputs", "pricingSource", "quantity", "suggestedTotal", "suggestedUnitPrice", "unit",
  ]);
  assert.deepEqual(Object.keys(r.evidence).sort(), [
    "changeOrderSampleCount", "matchTier", "maxDate", "medianUnitPrice", "minDate", "outliersRemoved", "sameProjectTypeCount", "sampleCount", "scope",
    "secondarySampleCount", "strongSampleCount",
  ]);
  assert.ok(["org_history", "none"].includes(r.pricingSource));
  assert.equal(r.itemName, "Vanity installation");
  assert.match(r.evidence.minDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.lowEstimate <= r.suggestedUnitPrice && r.suggestedUnitPrice <= r.highEstimate);
});

test("determinism — repeated calls are identical, and the INPUT ORDER of the evidence does not matter", () => {
  const ev = [...many(5, (i) => ({ unitPrice: 100 + i * 3, documentDate: monthsAgo(i + 1) })), L({ estimateStatus: "sent", unitPrice: 130 })];
  const a = JSON.stringify(price(ev));
  assert.equal(a, JSON.stringify(price(ev)));
  assert.equal(a, JSON.stringify(price([...ev].reverse())));
  assert.equal(a, JSON.stringify(price([ev[3], ev[0], ev[5], ev[1], ev[4], ev[2]])));
});

test("determinism — the engine reads no wall clock: the same evidence priced at two injected times differs only through recency", () => {
  const ev = many(5, (i) => ({ unitPrice: 100 + i, documentDate: monthsAgo(2) }));
  const early = E.suggestPricingForItem(REQ, ev, ctx({ now: NOW }));
  const again = E.suggestPricingForItem(REQ, ev, ctx({ now: new Date(NOW) }));
  assert.equal(JSON.stringify(early), JSON.stringify(again));
  assert.throws(() => E.suggestPricingForItem(REQ, ev, ctx({ now: "garbage" })), /valid date/);
});

test("the batch API returns one suggestion per requested item, in order", () => {
  const rs = E.suggestPricing([REQ, { name: "Unknown thing", itemType: "labor", unit: "each" }], many(4, (i) => ({ unitPrice: 100 + i })), ctx());
  assert.equal(rs.length, 2);
  assert.equal(rs[0].pricingSource, "org_history");
  assert.equal(rs[1].pricingSource, "none");
});

test("TRUST BOUNDARY — the engine's input contract has no organization concept and the module has no I/O or model access", () => {
  const src = readFileSync(path.join(repoRoot, "src/lib/pricing/pricing-engine.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /\borg_?id\b|\borganization_?id\b|\borganization\s*[:?]/i, "no org identifier or org field exists to be mixed up");
  assert.doesNotMatch(code, /supabase|fetch\(|require\(|process\.env|Date\.now\(|Math\.random|new Date\(\)/, "no database, network, env, wall clock or randomness");
  assert.doesNotMatch(code, /ai_market_estimate/, "no model-generated market pricing in v1");
  const norm = readFileSync(path.join(repoRoot, "src/lib/pricing/line-item-normalizer.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(norm, /^import /m, "the normalizer imports nothing");
});
