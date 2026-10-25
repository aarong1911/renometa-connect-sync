// netlify/functions/lib/ai/staff-pricing-guidance.test.ts
//
// Run:  node --test netlify/functions/lib/ai/staff-pricing-guidance.test.ts
//
// REGRESSION for the P3 manual smoke-test failure. Staff in the AI Center Test Console asked for pricing guidance on
// EST-000008. The assistant resolved the estimate (get_estimate_context ran) but get_pricing_suggestions did NOT run, and the
// assistant answered "There's no price book configured for your business, so every unit price needs to come directly from you."
//
// ROOT CAUSES reproduced here (all through the REAL orchestrateAI(), on the in-memory fake Supabase client):
//   1. GATING: the pricing read only considered lines carrying metadata.price_pending. A line a person added in the estimate
//      editor with a blank price is stored as $0 with NO marker, so a real estimate full of unpriced lines produced zero
//      candidates and the tool was never called.
//   2. ORDER + PROMPT: the read happened only AFTER the model had already answered, and the model's own context block said
//      "no price book or catalog is configured, so every unit price must come from the business owner" — which is where the
//      unsupported wording came from. Organization-history pricing exists even without a price book.
//   3. DETECTOR: natural staff phrasings ("Price the remaining items", "What should these line items cost?") were not matched.
//
// The Test Console is staff-initiated (actor "user", channel "internal", event "manual_test", routed to Reception first).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "staff-pricing-guidance-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/ai/orchestrator";
      export { detectPricingGuidanceRequest, isStaffInitiated } from "./netlify/functions/lib/ai/pricing-provenance";
      export { PRICE_SAFE_RESPONSE } from "./netlify/functions/lib/ai/agents/estimate-assistant";
    `,
    resolveDir: repoRoot, loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "error",
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
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EST_CUR = "dddddddd-dddd-4ddd-8ddd-ddddddddddd8";
const TZ = "America/New_York";
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** EST-000008 as a person built it in the editor: draft, lines with a BLANK price (stored as $0, NO price_pending marker). */
const est8 = () => ({
  id: EST_CUR, org_id: ORG_A, number: "EST-000008", title: "Bathroom Remodel", status: "draft", client_id: CONTACT_1, lead_id: LEAD_1, project_id: null, deal_id: null,
  scope: "Bathroom remodel", exclusions: null, assumptions: null, valid_until: null, tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
  subtotal: 0, discount_total: 0, tax_total: 0, total: 0, client_total: 0, deposit_amount: 0, balance_due: 0, created_at: monthsAgo(0), updated_at: monthsAgo(0), metadata: {},
});
const manualLine = (name: string, over: Record<string, unknown> = {}) => ({
  id: uid("ci"), estimate_id: EST_CUR, name, description: null, item_type: "labor", quantity: 1, unit: "each", unit_price: 0, total: 0, position: 0, taxable: true, optional: false,
  selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: {}, ...over,
});
function history(name: string, n: number, price: number) {
  const estimates: any[] = []; const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const e = { id: uid("h"), org_id: ORG_A, status: "approved", project_id: null, lead_id: null, approved_at: monthsAgo(2), converted_at: null, sent_at: null, created_at: monthsAgo(3), number: "EST-HISTORY", title: "SENTINEL-CUSTOMER" };
    estimates.push(e);
    items.push({ id: uid("hi"), estimate_id: e.id, name, description: "SENTINEL-NOTE", item_type: "labor", unit: "each", quantity: 1, unit_price: price, total: price, is_heading: false, optional: false, metadata: {} });
  }
  return { estimates, items };
}
function withApprovalDefaults(db: any) {
  return { ...db, from: (table: string) => { const b = db.from(table); if (table !== "agent_approval_requests") return b; const ins = b.insert.bind(b); b.insert = (row: any) => ins({ status: "pending", requested_at: new Date().toISOString(), ...row }); return b; } };
}
function makeDb(over: Record<string, any[]> = {}) {
  return withApprovalDefaults(createFakeSupabaseClient({
    organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {}, integration_settings: {} }],
    contacts: [{ id: CONTACT_1, org_id: ORG_A, full_name: "Michael Estimate", email: null, phone: "+15550001111" }],
    leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Michael Estimate", estimated_value: null, custom_fields: { service: "Bathroom Remodel" } }],
    projects: [], estimates: [], estimate_items: [], project_change_orders: [], project_change_order_items: [],
    marketing_contact_preferences: [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false }],
    appointments: [], agent_executions: [], agent_execution_steps: [], agent_approval_requests: [], agent_action_idempotency: [], agent_usage_events: [],
    conversation_states: [], sms_meta_messages: [], notifications: [], business_knowledge_entries: [], ai_clarification_requests: [],
    profiles: [{ id: "owner-1", organization_id: ORG_A }],
    ...over,
  }, {}, { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]], business_knowledge_entries: [["org_id", "key"]] }, notNullColumns: { estimates: ["created_by"] } }));
}
function scriptedProvider(scripts: string[]) {
  let i = 0; const requests: any[] = [];
  return { name: "fake", requests, run: async (req: unknown) => { requests.push(req); const text = scripts[i] ?? scripts[scripts.length - 1]; i += 1; return { text, model: "fake-model", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" }; } };
}
const STAFF = { orgId: ORG_A, actor: { actorType: "user" as const, actorId: "owner-1", source: "ai_orchestrate_http" }, leadId: LEAD_1, contactId: CONTACT_1, autonomyLevel: 2 as const };
const CUSTOMER_SMS = { orgId: ORG_A, actor: { actorType: "workflow" as const, actorId: "twilio", source: "test" }, leadId: LEAD_1, contactId: CONTACT_1, autonomyLevel: 2 as const };
const consoleEvent = (text: string) => ({ eventId: "evt-1", channel: "internal" as const, eventType: "manual_test", content: { type: "text" as const, text } });
const smsEvent = (text: string) => ({ eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text } });

const respond = (response: string) => JSON.stringify({ type: "respond", response });
const handoffToLQ = JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "Staff asked about the estimate", summary: "Staff request about EST-000008." });
const handoffToEstimate = JSON.stringify({ type: "handoff", toAgent: "estimate_assistant", reason: "Pricing guidance", summary: "Staff request." });

async function runConsole(db: any, text: string, scripts: string[]) {
  const modelProvider = scriptedProvider(scripts);
  const result = await S.orchestrateAI({ supabase: db, event: consoleEvent(text), trustedContext: STAFF, modelProvider });
  return { result, modelProvider };
}
async function runSms(db: any, text: string, scripts: string[]) {
  const modelProvider = scriptedProvider(scripts);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent(text), trustedContext: CUSTOMER_SMS, modelProvider });
  return { result, modelProvider };
}
const execRow = async (db: any, id: string) => (await db.from("agent_executions").select("*").eq("id", id).maybeSingle()).data;
const steps = async (db: any, id: string) => ((await db.from("agent_execution_steps").select("*").eq("execution_id", id)).data as any[]).sort((a, b) => a.sequence - b.sequence);
const stepKeys = async (db: any, id: string) => (await steps(db, id)).map((s) => s.action_key);
const prompts = (p: any) => p.requests.map((r: any) => `${r.system}\n${r.messages.map((m: any) => m.content).join("\n")}`).join("\n=====\n");

/** EST-000008 with two blank-price manual lines + org history for ONE of them ($612) and none for the other. */
function db8() {
  const h = history("Vanity installation", 6, 612);
  return makeDb({ estimates: [est8(), ...h.estimates], estimate_items: [manualLine("Vanity installation"), manualLine("Tile backsplash", { item_type: "material" }), ...h.items] });
}
// The Test Console routes to Reception first. For a staff pricing-guidance request the fixed flow short-circuits Reception and Lead
// Qualification deterministically, so the FIRST model call is the Estimate Assistant's own decision (scripted below).
const GUIDANCE_SCRIPTS = [respond("Pricing suggestions for those lines are attached to this run for staff.")];

// ── THE SMOKE-TEST REPRODUCTION ──────────────────────────────────────────

test("REPRODUCTION — staff ask for pricing suggestions on EST-000008 (blank-price manual lines, no price_pending marker): get_estimate_context THEN get_pricing_suggestions both run", async () => {
  const db = db8();
  const { result } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.deepEqual(await stepKeys(db, result.executionId), ["get_estimate_context", "get_pricing_suggestions"]);
  const p = (await execRow(db, result.executionId)).input_summary.pricingIntelligence;
  assert.equal(p.staffOnly, true);
  assert.equal(p.available, true);
  assert.equal(p.requestedItems, 2);
  assert.deepEqual(p.suggestions.map((s: any) => [s.itemName, s.status]), [["Vanity installation", "suggested"], ["Tile backsplash", "no_history"]]);
  assert.equal(p.suggestions[0].suggestedUnitPrice, 612);
  assert.equal(p.suggestions[1].message, "No reliable historical pricing found.");
});

test("REPRODUCTION — the pricing read happens BEFORE the assistant's own decision, so the model cannot substitute its own pricing questions", async () => {
  const db = db8();
  const { result, modelProvider } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  const steps_ = await steps(db, result.executionId);
  assert.deepEqual(steps_.map((s) => s.sequence), [1, 2]);
  const decisionPrompt = modelProvider.requests.map((r: any) => `${r.system}\n${r.messages.map((m: any) => m.content).join("\n")}`).find((t: string) => /Estimate Assistant/.test(t));
  assert.ok(decisionPrompt, "the Estimate Assistant decision prompt exists");
  assert.match(decisionPrompt, /Pricing Intelligence has ALREADY run/i, "the model is told the lookup already ran");
  assert.match(decisionPrompt, /1 of 2 requested lines have organization-history price suggestions/);
  assert.match(decisionPrompt, /1 have no reliable historical pricing/);
});

// ── Phrases ──────────────────────────────────────────────────────────────

const STAFF_PHRASES = [
  "Give me pricing suggestions for the unpriced items.",
  "Can you give me pricing suggestions for this estimate?",
  "What should we charge for these items?",
  "Help me price the unpriced items.",
  "Suggest prices for this estimate.",
  "Can you help with pricing?",
  "Price the remaining items.",
  "What should these line items cost?",
  "Give me pricing suggestions for the unpriced items",
  "What should we charge?",
  "Help me price these items",
];

test("DETECTOR — every natural staff phrasing is recognized", () => {
  for (const t of STAFF_PHRASES) assert.equal(S.detectPricingGuidanceRequest(t), true, t);
});

test("DETECTOR — general / customer estimate phrasing is NOT staff pricing guidance", () => {
  for (const t of ["Can you give me the estimate?", "Can I get an estimate?", "How much is my estimate?", "What's on my estimate?", "Is my proposal ready?", "Do you provide estimates?", "I need a quote for a new deck", "How much does a bathroom remodel cost?", "Thanks!", ""]) {
    assert.equal(S.detectPricingGuidanceRequest(t), false, t);
  }
});

for (const phrase of STAFF_PHRASES) {
  test(`STAFF "${phrase}" → get_estimate_context then get_pricing_suggestions (Test Console path)`, async () => {
    const db = db8();
    const { result } = await runConsole(db, phrase, GUIDANCE_SCRIPTS);
    assert.equal(result.agentKey, "estimate_assistant", phrase);
    assert.deepEqual(await stepKeys(db, result.executionId), ["get_estimate_context", "get_pricing_suggestions"], phrase);
    assert.equal(db.__dumpTable("agent_approval_requests").length, 0, "guidance never creates a proposal");
  });
}

for (const phrase of ["Can you give me the estimate?", "Can I get an estimate?", "How much is my estimate?"]) {
  test(`NOT staff pricing: "${phrase}" never calls get_pricing_suggestions`, async () => {
    const db = db8();
    const { result } = await runConsole(db, phrase, [respond("Here is what is on the estimate."), respond("Here is what is on the estimate."), respond("Here is what is on the estimate.")]);
    assert.ok(!(await stepKeys(db, result.executionId)).includes("get_pricing_suggestions"), phrase);
    assert.equal((await execRow(db, result.executionId)).input_summary.pricingIntelligence, undefined);
  });
}

// ── Staff-only: customer channels are not broadened ──────────────────────

test("CUSTOMER CHANNEL — the same words from a customer SMS (non-staff actor) never trigger the staff pricing read", async () => {
  const db = db8();
  const { result } = await runSms(db, "Give me pricing suggestions for the unpriced items.", [respond("Our team will follow up on pricing."), respond("Our team will follow up on pricing.")]);
  assert.ok(!(await stepKeys(db, result.executionId)).includes("get_pricing_suggestions"));
  assert.equal((await execRow(db, result.executionId)).input_summary.pricingIntelligence, undefined);
  assert.equal(S.isStaffInitiated({ actorType: "workflow" }, "sms"), false);
  assert.equal(S.isStaffInitiated({ actorType: "user" }, "internal"), true);
  assert.equal(S.isStaffInitiated({ actorType: "integration" }, "whatsapp"), false);
});

// ── No unsupported "no price book" reasoning ─────────────────────────────

test("The assistant's prompts no longer claim 'no price book, so every unit price must come from you' — organization-history pricing exists", async () => {
  const db = db8();
  const { modelProvider } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  const all = prompts(modelProvider);
  // The only mentions left are PROHIBITIONS ("NEVER say …", "do NOT say …"); no prompt ASSERTS a missing price book.
  const asserted = all.replace(/NEVER say or imply that[^.]*./g, "").replace(/do NOT say a price book is missing/gi, "");
  assert.ok(!/no price book|price book (?:is|was) (?:missing|not configured)/i.test(asserted), "no prompt asserts a missing price book");
  assert.ok(!/every unit price (?:and quantity )?must (?:come from|be entered by) the business owner/i.test(all));
  assert.ok(!/Trusted pricing — no price book/i.test(all));
  assert.match(all, /organization'?s? (?:own )?(?:past|history)|organization-history/i);
});

test("An unsupported 'no price book → every price must come from you' reply from the model is REPLACED, never delivered", async () => {
  const bad = "There's no price book configured for your business, so every unit price needs to come directly from you.";
  const db = db8();
  const { result } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", [respond(bad)]);
  assert.ok(!/no price book/i.test(String(result.responseText)));
  assert.ok(!/every unit price/i.test(String(result.responseText)));
  assert.match(String(result.responseText), /Pricing Intelligence/i);
});

test("The assistant does not ask staff for prices instead of looking them up: the reply points to the staff-only panel", async () => {
  const db = db8();
  const { result } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  assert.equal(result.responseText, "Pricing suggestions for those lines are attached to this run for staff.");
});

// ── No-history, leakage ──────────────────────────────────────────────────

test("NO HISTORY — with no organization history the staff panel says 'No reliable historical pricing found.' for every line, and nothing is guessed", async () => {
  const db = makeDb({ estimates: [est8()], estimate_items: [manualLine("Vanity installation"), manualLine("Tile backsplash", { item_type: "material" })] });
  const { result, modelProvider } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  const p = (await execRow(db, result.executionId)).input_summary.pricingIntelligence;
  assert.deepEqual(p.suggestions.map((s: any) => s.message), ["No reliable historical pricing found.", "No reliable historical pricing found."]);
  assert.ok(p.suggestions.every((s: any) => s.suggestedUnitPrice === null && s.confidence === "none"));
  assert.match(prompts(modelProvider), /0 of 2 requested lines have organization-history price suggestions/);
});

test("NO LEAKAGE — the suggested figures never reach the reply or any prompt, and a reply that repeats one is blocked", async () => {
  const db = db8();
  const ok = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  const p = (await execRow(db, ok.result.executionId)).input_summary.pricingIntelligence;
  const figures = [p.suggestions[0].suggestedUnitPrice, p.suggestions[0].lowEstimate, p.suggestions[0].highEstimate].map(String);
  assert.ok(!String(ok.result.responseText).includes("$"));
  for (const f of figures) { assert.ok(!String(ok.result.responseText).includes(f)); assert.ok(!prompts(ok.modelProvider).includes(f), `prompt contained ${f}`); }

  const leak = await runConsole(db8(), "Give me pricing suggestions for the unpriced items.", [respond("The vanity should be about $612.")]);
  assert.equal(leak.result.responseText, S.PRICE_SAFE_RESPONSE);
});

test("REVIEWED prices are still protected: a priced line is not re-priced, only the genuinely unpriced lines are requested", async () => {
  const h = history("Vanity installation", 6, 612);
  const db = makeDb({ estimates: [est8(), ...h.estimates], estimate_items: [manualLine("Vanity installation", { unit_price: 450, total: 450 }), manualLine("Tile backsplash", { item_type: "material" }), ...h.items] });
  const { result } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  const p = (await execRow(db, result.executionId)).input_summary.pricingIntelligence;
  assert.deepEqual(p.suggestions.map((s: any) => s.itemName), ["Tile backsplash"]);
});

test("When every line already has a price, guidance makes NO pricing call (nothing is unpriced)", async () => {
  const db = makeDb({ estimates: [est8()], estimate_items: [manualLine("Vanity installation", { unit_price: 450, total: 450 })] });
  const { result } = await runConsole(db, "Give me pricing suggestions for the unpriced items.", GUIDANCE_SCRIPTS);
  assert.deepEqual(await stepKeys(db, result.executionId), ["get_estimate_context"]);
});
