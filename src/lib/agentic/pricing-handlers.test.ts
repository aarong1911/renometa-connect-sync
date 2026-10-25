// src/lib/agentic/pricing-handlers.test.ts
//
// Run:  node --test src/lib/agentic/pricing-handlers.test.ts
//
// Pricing Intelligence v1 (P2). The read-only get_pricing_suggestions action, end to end through the REAL action executor,
// AI tool registry and evidence reader on the in-memory fake Supabase client. No live database, no network, no model.
//
// SECURITY FOCUS: org isolation, no model-supplied ids/org/prices, evidence eligibility, trusted-context-only lookups,
// aggregate-only output, and no writes.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "pricing-handlers-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./src/lib/agentic/action-executor";
      export * from "./src/lib/agentic/pricing-handlers";
      export { getActionDefinition } from "./src/lib/agentic/action-registry";
      export { listAITools, getAITool, executeAITool } from "./netlify/functions/lib/ai/tools/registry";
      export { ESTIMATE_ASSISTANT_TOOL_ALLOWLIST } from "./netlify/functions/lib/ai/agents/estimate-assistant";
      export { LEAD_QUALIFICATION_TOOL_ALLOWLIST } from "./netlify/functions/lib/ai/agents/lead-qualification";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  external: ["@supabase/supabase-js"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const savedConsole = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = savedConsole[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const LEAD_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LEAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PROJECT_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const PROJECT_B = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const EST_CUR = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"; // the CURRENT draft estimate (org A)
const EST_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";   // an estimate in org B
const ACTOR = { actorType: "user" as const, actorId: "user-1" };

// Real "now": the registered handler uses new Date(); fixtures are built relative to it so they are in-window either way.
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;

const histEstimate = (over: Record<string, unknown> = {}) => ({ id: uid("h"), org_id: ORG_A, status: "approved", project_id: null, lead_id: null, approved_at: monthsAgo(2), converted_at: null, sent_at: null, created_at: monthsAgo(3), ...over });
const histLine = (estimateId: string, over: Record<string, unknown> = {}) => ({ id: uid("i"), estimate_id: estimateId, name: "Vanity installation", item_type: "labor", unit: "each", quantity: 1, unit_price: 100, total: 100, is_heading: false, optional: false, metadata: {}, ...over });

/** n approved historical estimates, each with one "Vanity installation" line priced base+i. */
function history(org: string, n: number, base = 100, over: Record<string, unknown> = {}) {
  const estimates: any[] = []; const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const e = histEstimate({ org_id: org, ...over });
    estimates.push(e);
    items.push(histLine(e.id, { unit_price: base + i }));
  }
  return { estimates, items };
}

function makeDb(over: Record<string, any[]> = {}) {
  return createFakeSupabaseClient(
    {
      organizations: [{ id: ORG_A, ai_center_settings: {} }, { id: ORG_B, ai_center_settings: {} }],
      estimates: [], estimate_items: [], projects: [], leads: [], project_change_orders: [], project_change_order_items: [],
      agent_execution_steps: [], agent_approval_requests: [], agent_action_idempotency: [], marketing_contact_preferences: [],
      ...over,
    },
    {},
    { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]] } },
  );
}

const ITEM = { name: "Vanity installation", itemType: "labor", unit: "each" };
const ctxFor = (db: any, org = ORG_A) => ({ supabase: db, orgId: org, actor: ACTOR, executionId: "exec-1" });
const fixedNow = new Date();
const handler = S.createGetPricingSuggestions({ now: () => fixedNow });
const call = (db: any, input: any, org = ORG_A) => handler(ctxFor(db, org), input);
const tool = (db: any, input: any, org = ORG_A) =>
  S.executeAITool({ toolName: "get_pricing_suggestions", input }, { supabase: db, orgId: org, actor: ACTOR, executionId: "exec-1", sequence: 1, autonomyLevel: 1 });

// ── Registration ─────────────────────────────────────────────────────────

test("REGISTRATION — get_pricing_suggestions is a read-only, idempotent, no-approval, executable action with no outbound effect", () => {
  const a = S.getActionDefinition("get_pricing_suggestions");
  assert.equal(a.riskLevel, "read");
  assert.equal(a.requiresApproval, false);
  assert.equal(a.idempotent, true);
  assert.equal(a.isExecutable, true);
  assert.equal(a.minimumAutonomyLevel, 1);
  assert.equal(a.outboundChannel, undefined);
  assert.equal(a.category, "estimate");
});

test("REGISTRATION — reachable through the AI tool registry and ONLY on the Estimate Assistant's allowlist", () => {
  assert.ok(S.getAITool("get_pricing_suggestions"));
  assert.ok(S.listAITools().some((t: any) => t.name === "get_pricing_suggestions"));
  assert.ok(S.ESTIMATE_ASSISTANT_TOOL_ALLOWLIST.has("get_pricing_suggestions"));
  assert.ok(!S.LEAD_QUALIFICATION_TOOL_ALLOWLIST.has("get_pricing_suggestions"), "Lead Qualification must not be able to request pricing");
});

test("REGISTRATION — the model-visible argument list is ITEMS ONLY: no org, no ids, no prices", () => {
  const def = S.getAITool("get_pricing_suggestions");
  assert.deepEqual(def.arguments.map((a: any) => a.name), ["items"]);
  assert.equal(def.requiresApproval, false);
  assert.equal(def.riskLevel, "read");
});

// ── Model input: strict, no ids, no prices ───────────────────────────────

test("MODEL INPUT — a model can supply { items } and nothing else: orgId / estimateId / projectId / leadId / contactId / customer ids / sample ids / prices are all rejected", () => {
  const ok = { items: [{ name: "Vanity", itemType: "labor", unit: "each", quantity: 1 }] };
  assert.doesNotThrow(() => S.getPricingSuggestionsModelInput.parse(ok));
  for (const key of ["orgId", "organizationId", "org_id", "estimateId", "projectId", "leadId", "contactId", "customerId", "sampleId", "sampleIds", "price", "unitPrice", "total", "actorId"]) {
    assert.throws(() => S.getPricingSuggestionsModelInput.parse({ ...ok, [key]: "x" }), Error, `top-level ${key} must be rejected`);
    assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [{ name: "Vanity", [key]: "x" }] }), Error, `item-level ${key} must be rejected`);
  }
});

test("MODEL INPUT — bounds: 1..10 items, a name is required, discount is not a pricing type, quantity must be positive", () => {
  const item = { name: "Vanity" };
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [] }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: Array.from({ length: 11 }, () => item) }));
  assert.doesNotThrow(() => S.getPricingSuggestionsModelInput.parse({ items: Array.from({ length: 10 }, () => item) }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [{ name: "" }] }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [{ name: "x", itemType: "discount" }] }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [{ name: "x", quantity: 0 }] }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({ items: [{ name: "x", quantity: -3 }] }));
  assert.throws(() => S.getPricingSuggestionsModelInput.parse({}));
});

test("BINDING — ids come ONLY from the trusted runtime scope; a model-supplied id makes the bind throw", () => {
  const bound = S.bindTrustedPricingInput({ items: [{ name: "Vanity" }] }, { estimateId: EST_CUR, leadId: LEAD_A });
  assert.deepEqual(bound, { items: [{ name: "Vanity" }], estimateId: EST_CUR, leadId: LEAD_A });
  assert.deepEqual(S.bindTrustedPricingInput({ items: [{ name: "Vanity" }] }, {}), { items: [{ name: "Vanity" }] });
  assert.throws(() => S.bindTrustedPricingInput({ items: [{ name: "Vanity" }], estimateId: EST_B }, { estimateId: EST_CUR }));
  assert.throws(() => S.bindTrustedPricingInput({ items: [{ name: "Vanity" }], orgId: ORG_B }, {}));
  assert.throws(() => S.bindTrustedPricingInput({ items: [{ name: "Vanity", projectId: PROJECT_B }] }, {}));
});

test("REGISTERED INPUT — the action's own schema is strict too: no orgId or price field exists at all", () => {
  const a = S.getActionDefinition("get_pricing_suggestions");
  for (const key of ["orgId", "price", "unitPrice", "organizationId"]) assert.throws(() => a.inputSchema.parse({ items: [{ name: "x" }], [key]: "x" }), Error, key);
  assert.throws(() => a.inputSchema.parse({ items: [{ name: "x" }], leadId: "not-a-uuid" }));
  assert.doesNotThrow(() => a.inputSchema.parse({ items: [{ name: "x" }], leadId: LEAD_A, projectId: PROJECT_A, contactId: CONTACT_A, estimateId: EST_CUR }));
});

// ── Execution through the real executor ──────────────────────────────────

test("EXECUTION — through executeStep at autonomy Level 1: succeeds, creates NO approval request, and writes nothing to CRM tables", async () => {
  const h = history(ORG_A, 5);
  const db = makeDb({ estimates: h.estimates, estimate_items: h.items });
  const before = JSON.stringify([db.__dumpTable("estimates"), db.__dumpTable("estimate_items")]);
  const res = await S.executeStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", sequence: 1, actionKey: "get_pricing_suggestions", rawInput: { items: [ITEM] }, autonomyLevel: 1 });
  assert.equal(res.status, "succeeded", JSON.stringify(res));
  assert.equal(res.output.suggestions[0].pricingSource, "org_history");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(JSON.stringify([db.__dumpTable("estimates"), db.__dumpTable("estimate_items")]), before);
});

test("EXECUTION — through executeAITool: completed, staff-only, aggregate output", async () => {
  const h = history(ORG_A, 5);
  const r = await tool(makeDb({ estimates: h.estimates, estimate_items: h.items }), { items: [ITEM] });
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.output.staffOnly, true);
  assert.match(r.output.pricingNote, /staff review only/i);
});

test("READ ONLY — no insert / update / delete / upsert is ever issued against any CRM table", async () => {
  const h = history(ORG_A, 5);
  const base = makeDb({ estimates: h.estimates, estimate_items: h.items });
  const guarded = { ...base, from: (t: string) => { const b = base.from(t); if (!t.startsWith("agent_")) for (const m of ["insert", "update", "delete", "upsert"]) b[m] = () => { throw new Error(`write ${m} on ${t}`); }; return b; } };
  const res = await call(guarded, { items: [ITEM] });
  assert.equal(res.ok, true);
});

// ── Org isolation ────────────────────────────────────────────────────────

test("ORG ISOLATION — org A's suggestion is built only from org A's history; org B's very different prices never leak in", async () => {
  const a = history(ORG_A, 5, 100);
  const b = history(ORG_B, 12, 900);
  const db = makeDb({ estimates: [...a.estimates, ...b.estimates], estimate_items: [...a.items, ...b.items] });
  const ra = await call(db, { items: [ITEM] }, ORG_A);
  const rb = await call(db, { items: [ITEM] }, ORG_B);
  assert.equal(ra.output.suggestions[0].evidence.sampleCount, 5);
  assert.ok(ra.output.suggestions[0].highEstimate < 200);
  assert.equal(rb.output.suggestions[0].evidence.sampleCount, 12);
  assert.ok(rb.output.suggestions[0].lowEstimate > 800);
});

test("ORG ISOLATION — an org with no history of its own gets NO suggestion (it never borrows another organization's)", async () => {
  const b = history(ORG_B, 12, 900);
  const res = await call(makeDb({ estimates: b.estimates, estimate_items: b.items }), { items: [ITEM] }, ORG_A);
  assert.equal(res.output.suggestions[0].pricingSource, "none");
  assert.equal(res.output.suggestions[0].confidence, "none");
  assert.equal(res.output.suggestions[0].suggestedUnitPrice, null);
});

test("ORG ISOLATION — a trusted-scope estimateId from ANOTHER org is 'not found', identical to a nonexistent id (no probing)", async () => {
  const eB = histEstimate({ id: EST_B, org_id: ORG_B, status: "draft" });
  const db = makeDb({ estimates: [eB] });
  const foreign = await call(db, { items: [ITEM], estimateId: EST_B });
  const missing = await call(db, { items: [ITEM], estimateId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd9" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, missing.error);
  assert.equal(foreign.error, "The requested record was not found in this organization.");
});

test("ORG ISOLATION — a foreign lead / project id resolves to 'unknown project type', never to another org's data", async () => {
  const db = makeDb({
    leads: [{ id: LEAD_B, org_id: ORG_B, custom_fields: { service: "Kitchen Remodel" } }],
    projects: [{ id: PROJECT_B, org_id: ORG_B, project_type: "roofing" }],
  });
  const r1 = await call(db, { items: [ITEM], leadId: LEAD_B });
  const r2 = await call(db, { items: [ITEM], projectId: PROJECT_B });
  for (const r of [r1, r2]) {
    assert.equal(r.ok, true);
    assert.equal(r.output.basis.projectType, null);
    assert.equal(r.output.basis.projectTypeSource, "unknown");
  }
});

// ── Evidence eligibility (end to end) ────────────────────────────────────

test("ELIGIBILITY — draft / rejected / expired / cancelled / archived / ready estimates never influence the suggestion", async () => {
  const good = history(ORG_A, 5, 100);
  const bad = ["draft", "rejected", "expired", "cancelled", "archived", "ready"].flatMap((status) => history(ORG_A, 3, 9000, { status }).estimates.map((e) => e));
  const badItems = bad.map((e) => histLine(e.id, { unit_price: 9000 }));
  const res = await call(makeDb({ estimates: [...good.estimates, ...bad], estimate_items: [...good.items, ...badItems] }), { items: [ITEM] });
  const s = res.output.suggestions[0];
  assert.equal(s.evidence.sampleCount, 5);
  assert.ok(s.highEstimate < 200);
});

test("ELIGIBILITY — sent / viewed are SECONDARY and approved / converted are STRONG in the output evidence", async () => {
  const ests = ["approved", "converted", "sent", "viewed"].map((status) => histEstimate({ status, sent_at: monthsAgo(2) }));
  const res = await call(makeDb({ estimates: ests, estimate_items: ests.map((e) => histLine(e.id)) }), { items: [ITEM] });
  const ev = res.output.suggestions[0].evidence;
  assert.equal(ev.strongSampleCount, 2);
  assert.equal(ev.secondarySampleCount, 2);
});

test("ELIGIBILITY — approved change-order items count as strong evidence; unapproved ones do not", async () => {
  const cos = [{ id: uid("c"), org_id: ORG_A, project_id: null, status: "approved", approved_at: monthsAgo(1), created_at: monthsAgo(2) }, { id: uid("c"), org_id: ORG_A, project_id: null, status: "draft", approved_at: null, created_at: monthsAgo(2) }];
  const items = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: uid("ci"), org_id: ORG_A, change_order_id: cos[0].id, name: "Vanity installation", item_type: "labor", unit: "each", quantity: 1, unit_price: 100 + i })),
    { id: uid("ci"), org_id: ORG_A, change_order_id: cos[1].id, name: "Vanity installation", item_type: "labor", unit: "each", quantity: 1, unit_price: 9999 },
  ];
  const res = await call(makeDb({ project_change_orders: cos, project_change_order_items: items }), { items: [ITEM] });
  const s = res.output.suggestions[0];
  assert.equal(s.evidence.changeOrderSampleCount, 4);
  assert.equal(s.evidence.strongSampleCount, 4);
  assert.ok(s.highEstimate < 200);
  assert.equal(res.output.basis.changeOrderEvidenceLines, 4);
});

test("ELIGIBILITY — future-dated, >36-month, price_pending, ai_proposed, heading, optional and zero-price evidence is excluded", async () => {
  const future = histEstimate({ approved_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  const old = histEstimate({ approved_at: monthsAgo(40), created_at: monthsAgo(41) });
  const ok = histEstimate();
  const items = [
    histLine(future.id, { unit_price: 5000 }), histLine(old.id, { unit_price: 5001 }),
    histLine(ok.id, { unit_price: 100 }),
    histLine(ok.id, { unit_price: 5002, metadata: { price_pending: true } }), histLine(ok.id, { unit_price: 5003, metadata: { ai_proposed: true } }),
    histLine(ok.id, { unit_price: 5004, is_heading: true }), histLine(ok.id, { unit_price: 5005, optional: true }), histLine(ok.id, { unit_price: 0 }),
  ];
  const res = await call(makeDb({ estimates: [future, old, ok], estimate_items: items }), { items: [ITEM] });
  const s = res.output.suggestions[0];
  assert.equal(s.evidence.sampleCount, 1);
  assert.equal(s.suggestedUnitPrice, 100);
});

// ── Project type: boost, never required; estimateId may be null ──────────

test("PROJECT TYPE — same-project-type evidence is passed through and BOOSTS confidence", async () => {
  const proj = { id: PROJECT_A, org_id: ORG_A, project_type: "kitchen_remodel" };
  const mk = (n: number, base: number, projectId: string | null) => { const e: any[] = []; const it: any[] = []; for (let i = 0; i < n; i++) { const x = histEstimate({ project_id: projectId, approved_at: monthsAgo(1 + (i % 3)) }); e.push(x); it.push(histLine(x.id, { unit_price: base + (i % 3) })); } return { e, it }; };
  const same = mk(8, 100, PROJECT_A);
  const db = makeDb({ estimates: same.e, estimate_items: same.it, projects: [proj] });
  const res = await call(db, { items: [ITEM], projectId: PROJECT_A });
  const s = res.output.suggestions[0];
  assert.equal(res.output.basis.projectType, "kitchen_remodel");
  assert.equal(res.output.basis.projectTypeSource, "project");
  assert.equal(s.evidence.sameProjectTypeCount, 8);
  assert.equal(s.evidence.scope, "same_project_type");
  assert.equal(s.confidence, "high");
});

test("PROJECT TYPE — SPARSE data still works: evidence with NO project type yields a usable suggestion (never required)", async () => {
  const h = history(ORG_A, 6, 100); // no project ids, no leads
  const res = await call(makeDb({ estimates: h.estimates, estimate_items: h.items }), { items: [ITEM], projectId: PROJECT_A });
  const s = res.output.suggestions[0];
  assert.equal(s.pricingSource, "org_history");
  assert.equal(s.evidence.sameProjectTypeCount, 0);
  assert.notEqual(s.confidence, "none");
  assert.notEqual(s.confidence, "high");
});

test("PROJECT TYPE — missing project type stays null all the way through (no fabricated type, no fabricated project id)", async () => {
  const h = history(ORG_A, 5);
  const res = await call(makeDb({ estimates: h.estimates, estimate_items: h.items }), { items: [ITEM] });
  assert.equal(res.output.basis.projectType, null);
  assert.equal(res.output.basis.projectTypeSource, "unknown");
  assert.ok(res.output.suggestions[0].missingInputs.includes("project_type"));
});

test("ESTIMATE ID NULL — works from a trusted LEAD context: the lead's service text is the fallback classification (still no project link)", async () => {
  const h = history(ORG_A, 6, 100);
  const lead = { id: LEAD_A, org_id: ORG_A, custom_fields: { service: "Bathroom Remodel" } };
  const res = await call(makeDb({ estimates: h.estimates, estimate_items: h.items, leads: [lead] }), { items: [ITEM], leadId: LEAD_A });
  assert.equal(res.ok, true);
  assert.equal(res.output.basis.projectType, "bathroom_remodel");
  assert.equal(res.output.basis.projectTypeSource, "lead_service");
  assert.equal(res.output.basis.currentEstimateStatus, null, "no current estimate exists");
  assert.deepEqual(res.output.currentEstimateLines, ["unknown"]);
});

test("ESTIMATE ID NULL — works from a trusted PROJECT context and from a trusted CONTACT context", async () => {
  const h = history(ORG_A, 5);
  const proj = { id: PROJECT_A, org_id: ORG_A, project_type: "roofing" };
  const db = makeDb({ estimates: h.estimates, estimate_items: h.items, projects: [proj] });
  const byProject = await call(db, { items: [ITEM], projectId: PROJECT_A });
  assert.equal(byProject.output.basis.projectType, "roofing");
  const byContact = await call(db, { items: [ITEM], contactId: CONTACT_A });
  assert.equal(byContact.ok, true);
  assert.equal(byContact.output.suggestions[0].pricingSource, "org_history");
});

// ── The CURRENT estimate: protect reviewed pricing ───────────────────────

test("CURRENT ESTIMATE — reports whether each requested item already exists on the current estimate (priced / reviewed $0 / placeholder / not present) so reviewed pricing is never overwritten later", async () => {
  const h = history(ORG_A, 5);
  const cur = { id: EST_CUR, org_id: ORG_A, status: "draft", project_id: null, lead_id: LEAD_A, client_id: CONTACT_A, created_at: monthsAgo(0) };
  const rows = [
    { id: uid("x"), estimate_id: EST_CUR, name: "Vanity installation", item_type: "labor", unit: "each", unit_price: 450, is_heading: false, metadata: {} },
    { id: uid("x"), estimate_id: EST_CUR, name: "Included site visit", item_type: "service", unit: "each", unit_price: 0, is_heading: false, metadata: {} },
    { id: uid("x"), estimate_id: EST_CUR, name: "Backsplash tile", item_type: "material", unit: "each", unit_price: 0, is_heading: false, metadata: { price_pending: true } },
  ];
  const db = makeDb({ estimates: [...h.estimates, cur], estimate_items: [...h.items, ...rows] });
  const res = await call(db, {
    items: [{ name: "Vanity installation", itemType: "labor" }, { name: "Included site visit", itemType: "service" }, { name: "Backsplash tile", itemType: "material" }, { name: "Crown molding", itemType: "material" }],
    estimateId: EST_CUR,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.output.currentEstimateLines, ["priced", "reviewed_zero", "unpriced_placeholder", "not_on_estimate"]);
  assert.equal(res.output.basis.currentEstimateStatus, "draft");
});

test("CURRENT ESTIMATE — an AMBIGUOUS scope (several active estimates) is never treated as 'the' estimate", async () => {
  const mk = () => ({ id: uid("cur"), org_id: ORG_A, status: "draft", project_id: null, lead_id: LEAD_A, client_id: CONTACT_A, created_at: monthsAgo(0) });
  const db = makeDb({ estimates: [mk(), mk()] });
  const res = await call(db, { items: [ITEM], leadId: LEAD_A });
  assert.equal(res.output.basis.currentEstimateStatus, null);
  assert.deepEqual(res.output.currentEstimateLines, ["unknown"]);
});

// ── Output hygiene ───────────────────────────────────────────────────────

test("OUTPUT — aggregate only: no customer / contact / project names, no database ids, no historical line text, no internal cost, no vendor data", async () => {
  const proj = { id: PROJECT_A, org_id: ORG_A, project_type: "kitchen_remodel", name: "SENTINEL-CUSTOMER Residence" };
  const lead = { id: LEAD_A, org_id: ORG_A, custom_fields: { service: "Kitchen", address: "123 SENTINEL Lane", customer_name: "SENTINEL-NAME" } };
  const ests = Array.from({ length: 5 }, (_, i) => histEstimate({ project_id: PROJECT_A, lead_id: LEAD_A }));
  const items = ests.map((e, i) => histLine(e.id, { name: `SENTINEL-HISTORICAL-TEXT vanity ${i}`, unit_price: 100 + i, description: "SENTINEL-NOTE", cost: 77777, vendor: "SENTINEL-VENDOR" }));
  // make the historical names match the request through the alias-free token path
  const co = { id: uid("c"), org_id: ORG_A, project_id: PROJECT_A, status: "approved", approved_at: monthsAgo(1), created_at: monthsAgo(2) };
  const coItem = { id: uid("ci"), org_id: ORG_A, change_order_id: co.id, name: "Vanity installation", item_type: "labor", unit: "each", quantity: 1, unit_price: 110, internal_cost: 98765, internal_markup: 4321 };
  const cleanItems = ests.map((e, i) => histLine(e.id, { unit_price: 100 + i }));
  const db = makeDb({ estimates: ests, estimate_items: [...items, ...cleanItems], projects: [proj], leads: [lead], project_change_orders: [co], project_change_order_items: [coItem] });
  const res = await tool(db, { items: [ITEM], estimateId: undefined, projectId: PROJECT_A, leadId: LEAD_A });
  assert.equal(res.status, "completed", JSON.stringify(res));
  const json = JSON.stringify(res.output);
  for (const forbidden of ["SENTINEL", "98765", "4321", "77777", PROJECT_A, LEAD_A, ...ests.map((e) => e.id), co.id]) assert.ok(!json.includes(forbidden), `output leaked: ${forbidden}`);
  assert.deepEqual(Object.keys(res.output).sort(), ["basis", "currentEstimateLines", "pricingNote", "staffOnly", "suggestions"]);
  assert.deepEqual(Object.keys(res.output.basis).sort(), ["changeOrderEvidenceAvailable", "changeOrderEvidenceLines", "currentEstimateStatus", "estimateEvidenceLines", "evidenceWindowMonths", "priceBookAvailable", "priceBookItems", "projectType", "projectTypeSource", "truncated"]);
  assert.ok(res.output.suggestions.every((s: any) => ["org_history", "none"].includes(s.pricingSource)), "no model-generated market pricing");
});

test("OUTPUT — echoes only the requested item name; the engine contract keys are unchanged", async () => {
  const h = history(ORG_A, 5);
  const res = await call(makeDb({ estimates: h.estimates, estimate_items: h.items }), { items: [{ ...ITEM, quantity: 2 }] });
  const s = res.output.suggestions[0];
  assert.equal(s.itemName, "Vanity installation");
  assert.equal(s.quantity, 2);
  assert.equal(s.suggestedTotal, Math.round(s.suggestedUnitPrice * 2 * 100) / 100);
  assert.deepEqual(Object.keys(s).sort(), [
    "assumptions", "confidence", "evidence", "highEstimate", "highTotal", "itemName", "itemType", "locationAdjustment", "lowEstimate", "lowTotal",
    "missingInputs", "pricingSource", "quantity", "suggestedTotal", "suggestedUnitPrice", "unit",
  ]);
  assert.equal(s.locationAdjustment, null);
});

test("FAILURE — an evidence read failure returns a generic safe error (no rows, no ids, no SQL)", async () => {
  const base = makeDb();
  const failing = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimates") b.select = () => ({ eq: () => ({ in: () => ({ or: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom SENTINEL-SQL select * from estimates" } }) }) }) }) }) }); return b; } };
  const res = await call(failing, { items: [ITEM] });
  assert.deepEqual(res, { ok: false, error: "Could not load pricing suggestions." });
});

test("SCOPE — the orchestrator reaches the tool ONLY through the single staff-only runStaffPricing path and never from a prompt builder", async () => {
  const { readFileSync } = await import("node:fs");
  const orch = readFileSync(path.join(repoRoot, "netlify/functions/lib/ai/orchestrator.ts"), "utf8");
  assert.equal(orch.split('toolName: "get_pricing_suggestions"').length - 1, 1, "exactly one call site");
  assert.ok(orch.includes("bindTrustedPricingInput("), "ids are bound by the trusted binder");
  const prompts = readFileSync(path.join(repoRoot, "netlify/functions/lib/ai/agents/estimate-assistant.ts"), "utf8");
  assert.ok(!/pricingIntelligence|suggestedUnitPrice|lowEstimate|highEstimate/.test(prompts.replace(/\/\/[^\n]*/g, "")), "no pricing figure or payload is wired into the Estimate Assistant prompt builders");
});

// ── P4: Price Book through the Estimate Assistant tool ───────────────────

const catalogRow = (over: Record<string, unknown> = {}) => ({
  id: uid("pb"), org_id: ORG_A, name: "Vanity installation", normalized_name: "vanity installation", aliases: [], project_types: [], item_type: "labor", unit: "each",
  sell_unit_price: 450, low_unit_price: null, high_unit_price: null, reviewed_at: "2026-09-01T00:00:00Z", active: true,
  internal_unit_cost: 77777, default_markup_percent: 4321, notes: "SENTINEL-NOTE", reviewed_by: "SENTINEL-USER", ...over,
});

test("PRICE BOOK — the tool transparently prefers the org's price book over history; staff-only fields never reach the model-visible output", async () => {
  const h = history(ORG_A, 5);
  const db = makeDb({ estimates: h.estimates, estimate_items: h.items, pricing_catalog_items: [catalogRow()] });
  const res = await tool(db, { items: [{ ...ITEM, quantity: 2 }] });
  assert.equal(res.status, "completed", JSON.stringify(res));
  const s = res.output.suggestions[0];
  assert.equal(s.pricingSource, "price_book");
  assert.equal(s.suggestedUnitPrice, 450);
  assert.equal(s.suggestedTotal, 900);
  assert.equal(res.output.basis.priceBookItems, 1);
  assert.equal(res.output.basis.priceBookAvailable, true);
  const json = JSON.stringify(res);
  for (const forbidden of ["77777", "4321", "SENTINEL", "pb-"]) assert.ok(!json.includes(forbidden), `tool output leaked ${forbidden}`);
});

test("PRICE BOOK — another organization's price book is never used; history still works when the book is empty", async () => {
  const h = history(ORG_A, 5);
  const db = makeDb({ estimates: h.estimates, estimate_items: h.items, pricing_catalog_items: [catalogRow({ org_id: ORG_B, sell_unit_price: 9999 })] });
  const res = await tool(db, { items: [ITEM] });
  assert.equal(res.output.suggestions[0].pricingSource, "org_history");
  assert.ok(!JSON.stringify(res).includes("9999"));
});

test("PRICE BOOK — an inactive entry is ignored; a missing price book table degrades to history, not an error", async () => {
  const h = history(ORG_A, 5);
  const inactive = makeDb({ estimates: h.estimates, estimate_items: h.items, pricing_catalog_items: [catalogRow({ active: false })] });
  assert.equal((await tool(inactive, { items: [ITEM] })).output.suggestions[0].pricingSource, "org_history");
  // makeDb without the pricing_catalog_items table: the fake fails loudly on unknown tables, which the reader must absorb.
  const noTable = makeDb({ estimates: h.estimates, estimate_items: h.items });
  const res = await tool(noTable, { items: [ITEM] });
  assert.equal(res.status, "completed");
  assert.equal(res.output.suggestions[0].pricingSource, "org_history");
});

test("PRICE BOOK — the model still cannot supply a price, cost, markup, catalog id or org through the tool input", async () => {
  const db = makeDb({ pricing_catalog_items: [catalogRow()] });
  for (const extra of [{ unitPrice: 1 }, { internalUnitCost: 1 }, { markup: 1 }, { catalogItemId: "x" }, { orgId: ORG_B }]) {
    const res = await tool(db, { items: [{ ...ITEM, ...extra }] });
    assert.notEqual(res.status, "completed", `accepted ${Object.keys(extra)[0]}`);
  }
});
