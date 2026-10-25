// netlify/functions/lib/ai/pricing-provenance.test.ts
//
// Run:  node --test netlify/functions/lib/ai/pricing-provenance.test.ts
//
// Pricing Intelligence v1 (P3). The money-guard PROVENANCE tests: staff-only pricing figures vs the customer-facing guard.
// Pure; no database, no network, no model.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "pricing-provenance-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/ai/pricing-provenance";
      export { guardEstimateReply, PRICE_SAFE_RESPONSE } from "./netlify/functions/lib/ai/agents/estimate-assistant";
      export { buildStaffPricingIntelligence } from "./src/lib/pricing/staff-pricing";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const G: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const RUN_1 = "run-1";
const RUN_2 = "run-2";
const toolOutput = {
  suggestions: [{
    itemName: "Vanity installation", suggestedUnitPrice: 325, suggestedTotal: 650, lowEstimate: 300, highEstimate: 350, lowTotal: 600, highTotal: 700,
    confidence: "medium", pricingSource: "org_history", evidence: { sampleCount: 6, medianUnitPrice: 320, minDate: "2026-01-01", maxDate: "2026-09-01", sameProjectTypeCount: 0, matchTier: "exact" },
    assumptions: [], missingInputs: [],
  }],
  currentEstimateLines: ["unknown"],
};

// A customer-facing context: the estimate's STORED figures ($1,250 total) and nothing about the suggestion.
const context: any = {
  organization: { id: "o", name: "Acme" }, channel: "sms",
  estimate: { found: true, estimate: { subtotal: 1250, discountTotal: 0, taxTotal: 0, total: 1250, depositAmount: 0, balanceDue: 1250, discountType: null, discountValue: 0, depositType: null, depositValue: 0 }, items: [] },
};
const event: any = { eventId: "e", channel: "sms", eventType: "message_received", content: { type: "text", text: "Hi" } };

// ── the requested proof points ───────────────────────────────────────────

test("MODEL-INVENTED $450 is blocked (customer-facing guard AND staff-only check)", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  const customer = G.guardEstimateReply("The vanity installation will be $450.", context, event, prov.figures);
  assert.equal(customer.replaced, true);
  assert.equal(customer.text, G.PRICE_SAFE_RESPONSE);
  assert.equal(customer.reason, "ungrounded", "an invented figure is not a staff figure");
  assert.deepEqual(G.checkStaffPricingText("Suggested price $450.", prov, RUN_1), { ok: false, reason: "ungrounded_figure" });
});

test("a TRUSTED tool-supplied $325 MAY render in staff-only pricing text for the same run", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  assert.deepEqual(G.checkStaffPricingText("Suggested unit price $325.00 (range $300 to $350).", prov, RUN_1), { ok: true });
  assert.deepEqual(G.checkStaffPricingText("Suggested total $650 for quantity 2.", prov, RUN_1), { ok: true });
  assert.deepEqual(G.checkStaffPricingText("No figures at all.", prov, RUN_1), { ok: true });
});

test("that SAME $325 can NOT appear in a CUSTOMER-facing reply: the guard replaces it and labels it a staff-only figure", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  const r = G.guardEstimateReply("We would typically charge $325 for that.", context, event, prov.figures);
  assert.equal(r.replaced, true);
  assert.equal(r.text, G.PRICE_SAFE_RESPONSE);
  assert.equal(r.reason, "staff_pricing_figure");
  // and with NO provenance supplied at all the result is the same block (provenance never allows, it only labels)
  const bare = G.guardEstimateReply("We would typically charge $325 for that.", context, event);
  assert.equal(bare.replaced, true);
  assert.equal(bare.text, G.PRICE_SAFE_RESPONSE);
});

test("a number NOT in the tool output cannot piggyback on the allowance", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  assert.deepEqual(G.checkStaffPricingText("Suggested $325, but maybe $999.", prov, RUN_1), { ok: false, reason: "ungrounded_figure" });
  assert.deepEqual(G.checkStaffPricingText("Between $300 and $351.", prov, RUN_1), { ok: false, reason: "ungrounded_figure" });
  assert.equal(prov.has(325), true);
  assert.equal(prov.has(999), false);
});

test("STALE pricing from a PREVIOUS run is not allowed: a provenance only vouches for its own run", () => {
  const prov1 = G.createPricingProvenance(RUN_1, toolOutput);
  assert.deepEqual(G.checkStaffPricingText("Suggested $325.", prov1, RUN_2), { ok: false, reason: "stale_run" });
  const payloadForRun2 = G.buildStaffPricingIntelligence({ runId: RUN_2, requestedItems: 1, toolOutput });
  assert.equal(G.isGroundedStaffPayload(payloadForRun2, prov1), false, "a payload for run 2 cannot be vouched for by run 1's provenance");
  const payloadForRun1 = G.buildStaffPricingIntelligence({ runId: RUN_1, requestedItems: 1, toolOutput });
  assert.equal(G.isGroundedStaffPayload(payloadForRun1, prov1), true);
});

// ── payload grounding ────────────────────────────────────────────────────

test("payload grounding — a payload carrying a figure the tool never produced is rejected", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  const payload = G.buildStaffPricingIntelligence({ runId: RUN_1, requestedItems: 1, toolOutput });
  assert.equal(G.isGroundedStaffPayload(payload, prov), true);
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.suggestions[0].suggestedUnitPrice = 450;
  assert.equal(G.isGroundedStaffPayload(tampered, prov), false);
  const tamperedRange = JSON.parse(JSON.stringify(payload));
  tamperedRange.suggestions[0].highEstimate = 351;
  assert.equal(G.isGroundedStaffPayload(tamperedRange, prov), false);
});

test("provenance — only dollar fields count (counts and dates are not figures), and non-objects yield an empty provenance", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  assert.deepEqual([...prov.figures].sort((a: number, b: number) => a - b), [300, 320, 325, 350, 600, 650, 700]);
  assert.equal(prov.has(6), false, "sampleCount is not a price");
  for (const bad of [null, undefined, "x", 3, { suggestions: "no" }]) assert.equal(G.createPricingProvenance(RUN_1, bad).figures.size, 0);
});

// ── the customer-facing guard is otherwise unchanged ─────────────────────

test("the customer-facing guard still ALLOWS grounded figures (the estimate's stored total) and ordinary replies", () => {
  const prov = G.createPricingProvenance(RUN_1, toolOutput);
  assert.equal(G.guardEstimateReply("The estimate total on file is $1,250.", context, event, prov.figures).replaced, false);
  assert.equal(G.guardEstimateReply("Our team will confirm pricing with you.", context, event, prov.figures).replaced, false);
});

test("a suggested figure that COINCIDES with a stored figure is allowed only because the stored estimate grounds it (provenance never grants)", () => {
  const coincident = { ...toolOutput, suggestions: [{ ...toolOutput.suggestions[0], suggestedUnitPrice: 1250 }] };
  const prov = G.createPricingProvenance(RUN_1, coincident);
  assert.equal(G.guardEstimateReply("The estimate total on file is $1,250.", context, event, prov.figures).replaced, false);
  const noStored: any = { ...context, estimate: undefined };
  assert.equal(G.guardEstimateReply("The estimate total on file is $1,250.", noStored, event, prov.figures).replaced, true, "without the stored figure the same number is blocked");
});

// ── guidance-request detector ────────────────────────────────────────────

test("pricing-guidance detector — explicit guidance requests match; read-only / status / plain price questions do not", () => {
  const yes = ["Can you give me pricing suggestions for these lines?", "What should we charge for the vanity?", "I need pricing guidance on the estimate", "Help me with pricing", "Price out the unpriced items", "how should we price the tile work", "show historical pricing for this"];
  const no = ["What's on my estimate?", "Is my proposal ready?", "What's the status of the estimate?", "How much is it?", "Thanks!", "Can you show me the estimate?", "I want to add a vanity", ""];
  for (const t of yes) assert.equal(G.detectPricingGuidanceRequest(t), true, t);
  for (const t of no) assert.equal(G.detectPricingGuidanceRequest(t), false, t);
  assert.equal(G.detectPricingGuidanceRequest(undefined), false);
});
