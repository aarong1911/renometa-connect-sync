// src/lib/pricing/staff-pricing.test.ts
//
// Run:  node --test src/lib/pricing/staff-pricing.test.ts
//
// Pricing Intelligence v1 (P3). Pure tests for the STAFF-ONLY payload builder, its defensive reader and the Run Inspector's
// display view-model. No database, no network, no model.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "staff-pricing-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: { contents: `export * from "./src/lib/pricing/staff-pricing";`, resolveDir: repoRoot, loader: "ts" },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
});
const P: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const evidence = (over: Record<string, unknown> = {}) => ({ sampleCount: 6, medianUnitPrice: 325, minDate: "2026-01-02", maxDate: "2026-09-01", sameProjectTypeCount: 2, matchTier: "exact", scope: "org_wide", outliersRemoved: 0, strongSampleCount: 6, secondarySampleCount: 0, changeOrderSampleCount: 0, ...over });
const suggestion = (over: Record<string, unknown> = {}) => ({
  itemName: "Vanity installation", itemType: "labor", unit: "each", quantity: 2,
  suggestedUnitPrice: 325, suggestedTotal: 650, lowEstimate: 300, highEstimate: 350, lowTotal: 600, highTotal: 700,
  confidence: "medium", pricingSource: "org_history", evidence: evidence(), assumptions: ["Matched on similar line item names."], missingInputs: ["project_type"], locationAdjustment: null,
  ...over,
});
const none = (name: string) => suggestion({ itemName: name, suggestedUnitPrice: null, suggestedTotal: null, lowEstimate: null, highEstimate: null, lowTotal: null, highTotal: null, confidence: "none", pricingSource: "none", evidence: evidence({ sampleCount: 0, medianUnitPrice: null, minDate: null, maxDate: null, matchTier: null }) });
const build = (suggestions: any[], currentEstimateLines: string[]) =>
  P.buildStaffPricingIntelligence({ runId: "run-1", requestedItems: suggestions.length, toolOutput: { suggestions, currentEstimateLines } });

test("payload — staff-only, bound to the run, with the documented shape and a staff-only note", () => {
  const p = build([suggestion()], ["unpriced_placeholder"]);
  assert.equal(p.staffOnly, true);
  assert.equal(p.available, true);
  assert.equal(p.runId, "run-1");
  assert.equal(p.requestedItems, 1);
  assert.match(p.note, /staff only/i);
  assert.match(p.note, /never to be shared with the customer/i);
  assert.deepEqual(Object.keys(p).sort(), ["available", "note", "requestedItems", "runId", "staffOnly", "suggestions"]);
  assert.deepEqual(Object.keys(p.suggestions[0]).sort(), [
    "alreadyPricedOnEstimate", "assumptions", "confidence", "evidence", "highEstimate", "itemName", "lowEstimate", "message", "missingInputs",
    "pricingSource", "status", "suggestedTotal", "suggestedUnitPrice",
  ]);
});

test("UNPRICED / price_pending lines MAY show a suggestion; the neutral 'Suggested only — not applied.' message is attached", () => {
  for (const state of ["unpriced_placeholder", "not_on_estimate", "unknown"]) {
    const s = build([suggestion()], [state]).suggestions[0];
    assert.equal(s.status, "suggested", state);
    assert.equal(s.suggestedUnitPrice, 325);
    assert.equal(s.lowEstimate, 300);
    assert.equal(s.highEstimate, 350);
    assert.equal(s.message, "Suggested only — not applied.");
    assert.equal(s.alreadyPricedOnEstimate, false);
    assert.equal(s.evidence.sampleCount, 6);
    assert.equal(s.evidence.sameProjectTypeCount, 2);
  }
});

test("REVIEWED lines are SUPPRESSED: a priced line or a reviewed $0 line gets 'Existing reviewed price retained.' and NO figures, no replacement", () => {
  for (const state of ["priced", "reviewed_zero"]) {
    const s = build([suggestion()], [state]).suggestions[0];
    assert.equal(s.status, "reviewed_retained");
    assert.equal(s.message, "Existing reviewed price retained.");
    assert.equal(s.alreadyPricedOnEstimate, true);
    for (const f of ["suggestedUnitPrice", "suggestedTotal", "lowEstimate", "highEstimate"]) assert.equal(s[f], null, f);
    assert.equal(s.confidence, "none");
    assert.equal(s.pricingSource, "none");
    assert.equal(s.evidence.sampleCount, 0);
    assert.ok(!JSON.stringify(s).includes("325"));
  }
});

test("SPARSE history says so plainly: 'No reliable historical pricing found.' and carries no guessed price", () => {
  const s = build([none("Crown molding")], ["not_on_estimate"]).suggestions[0];
  assert.equal(s.status, "no_history");
  assert.equal(s.message, "No reliable historical pricing found.");
  assert.equal(s.suggestedUnitPrice, null);
  assert.equal(s.confidence, "none");
  assert.equal(s.pricingSource, "none");
});

test("a suggestion with a price but no org_history source is treated as no history (never shown as a price)", () => {
  const s = build([suggestion({ pricingSource: "none" })], ["unknown"]).suggestions[0];
  assert.equal(s.status, "no_history");
  assert.equal(s.suggestedUnitPrice, null);
});

test("WHITELIST — only the documented fields survive: ids, customer names, costs, vendor data and free text in the tool output are dropped", () => {
  const dirty = suggestion({
    id: "SENTINEL-ID", estimateId: "SENTINEL-EST", customerName: "SENTINEL-CUSTOMER", internalCost: 9999, vendor: "SENTINEL-VENDOR", notes: "SENTINEL-NOTE",
    evidence: evidence({ sampleRefs: ["SENTINEL-REF"], projectId: "SENTINEL-PROJECT", customer: "SENTINEL-CUST" }),
  });
  const json = JSON.stringify(build([dirty], ["unknown"]));
  assert.ok(!json.includes("SENTINEL"), "nothing outside the whitelist is copied");
  assert.ok(!json.includes("9999"));
});

test("reader — validates the jsonb read back from the database: garbage / non-staff payloads are rejected, valid ones round-trip", () => {
  assert.equal(P.readStaffPricingIntelligence(null), null);
  assert.equal(P.readStaffPricingIntelligence("x"), null);
  assert.equal(P.readStaffPricingIntelligence({ suggestions: [] }), null, "staffOnly flag is required");
  assert.equal(P.readStaffPricingIntelligence({ staffOnly: true, suggestions: "nope" }), null);
  const p = build([suggestion(), none("Crown molding")], ["unknown", "priced"]);
  const round = P.readStaffPricingIntelligence(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(round.suggestions.map((s: any) => s.status), ["suggested", "reviewed_retained"]);
  const weird = P.readStaffPricingIntelligence({ staffOnly: true, suggestions: [{ status: "suggested", itemName: 5, suggestedUnitPrice: "325", evidence: "x" }, { status: "bogus" }, null] });
  assert.equal(weird.suggestions.length, 1);
  assert.equal(weird.suggestions[0].suggestedUnitPrice, null, "a string is not a number");
});

test("view-model — suggested rows render item, price, range, confidence, samples, same-project-type count, source and the not-applied line", () => {
  const view = P.describeStaffPricing(build([suggestion()], ["unknown"]));
  const row = view.rows[0];
  assert.equal(row.itemName, "Vanity installation");
  assert.equal(row.price, "$325.00");
  assert.equal(row.range, "$300.00 – $350.00");
  assert.equal(row.total, "$650.00");
  assert.equal(row.confidence, "medium");
  assert.equal(row.sampleCount, 6);
  assert.equal(row.sameProjectTypeCount, 2);
  assert.equal(row.source, "Organization history");
  assert.equal(row.message, "Suggested only — not applied.");
  assert.deepEqual(row.assumptions, ["Matched on similar line item names."]);
  assert.deepEqual(row.missingInputs, ["project type"]);
  assert.equal(view.available, true);
});

test("view-model — 'none' confidence shows 'No reliable historical pricing found.' and reviewed lines show 'Existing reviewed price retained.' with NO figures", () => {
  const view = P.describeStaffPricing(build([none("Crown molding"), suggestion()], ["not_on_estimate", "priced"]));
  assert.equal(view.rows[0].message, "No reliable historical pricing found.");
  assert.equal(view.rows[1].message, "Existing reviewed price retained.");
  for (const r of view.rows) {
    assert.equal(r.price, null);
    assert.equal(r.range, null);
    assert.equal(r.total, null);
    assert.equal(r.confidence, null);
    assert.equal(r.source, null);
  }
});

test("view-model — an unavailable run shows a neutral note and no rows", () => {
  const view = P.describeStaffPricing(P.unavailableStaffPricing("run-1", 3));
  assert.equal(view.available, false);
  assert.equal(view.rows.length, 0);
  assert.match(view.note, /not available/i);
});

test("the Run Inspector renders the payload through the validated reader + view-model, and the customer-facing proposal UI never references it", () => {
  const inspector = readFileSync(path.join(repoRoot, "src/components/ai-center/ai-run-inspector.tsx"), "utf8");
  assert.match(inspector, /readStaffPricingIntelligence\(input\.pricingIntelligence\)/);
  assert.match(inspector, /describeStaffPricing\(/);
  assert.match(inspector, /Pricing Intelligence/);
  assert.match(inspector, />Staff only</);
  assert.match(inspector, /label="Same project type"/);
  assert.match(inspector, /label="Source"/);
  for (const customerFacing of ["src/lib/ai-estimate-proposal.ts", "src/components/ai-center/ai-approvals-tab.tsx"]) {
    const src = readFileSync(path.join(repoRoot, customerFacing), "utf8");
    assert.ok(!/pricingIntelligence|staff-pricing/.test(src), `${customerFacing} must not reference staff pricing`);
  }
});
