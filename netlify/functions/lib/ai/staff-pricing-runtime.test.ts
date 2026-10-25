// netlify/functions/lib/ai/staff-pricing-runtime.test.ts
//
// Run:  node --test netlify/functions/lib/ai/staff-pricing-runtime.test.ts
//
// Pricing Intelligence v1 (P3). The Estimate Assistant runtime integration, END TO END through the REAL orchestrateAI():
// real router, context builder, agents, action executor, estimate handlers, pricing tool and evidence reader on the in-memory
// fake Supabase client with a scripted fake ModelProvider. No live model, no database, no network.
//
// Proves: the staff-only pricing read is made ONLY for the right turns, with server-bound ids; its result is stored on the
// execution record (for the Run Inspector) and NEVER reaches a reply, a prompt, a proposal or an approval; reviewed prices
// are suppressed; sparse history is stated plainly; and the existing add/create proposal behavior is unchanged.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "staff-pricing-runtime-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/ai/orchestrator";
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
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EST_CUR = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const EST_X = "dddddddd-dddd-4ddd-8ddd-ddddddddddd9";
const TZ = "America/New_York";

const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString(); };
let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(8, "0")}-0000-4000-8000-000000000000`;

const currentEstimate = (over: Record<string, unknown> = {}) => ({
  id: EST_CUR, org_id: ORG_A, number: "EST-000008", title: "Bathroom Remodel", status: "draft", client_id: CONTACT_1, lead_id: LEAD_1, project_id: null, deal_id: null,
  scope: "Bathroom remodel", exclusions: null, assumptions: null, valid_until: null, tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
  subtotal: 0, discount_total: 0, tax_total: 0, total: 0, client_total: 0, deposit_amount: 0, balance_due: 0, created_at: monthsAgo(0), updated_at: monthsAgo(0), metadata: {},
  cost_total: 99999, notes: "INTERNAL-SECRET-NOTE", public_token: "tok_secret", ...over,
});
const curItem = (name: string, over: Record<string, unknown> = {}) => ({
  id: uid("ci"), estimate_id: EST_CUR, name, description: null, item_type: "labor", quantity: 1, unit: "each", unit_price: 0, total: 0, position: 0, taxable: true, optional: false,
  selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: { price_pending: true }, ...over,
});
/** n approved historical estimates in `org`, each with one line `name` at `price`. */
function history(org: string, name: string, n: number, price: number, extra: Record<string, unknown> = {}) {
  const estimates: any[] = []; const items: any[] = [];
  for (let i = 0; i < n; i++) {
    const e = { id: uid("h"), org_id: org, status: "approved", project_id: null, lead_id: null, client_id: uid("c"), approved_at: monthsAgo(2), converted_at: null, sent_at: null, created_at: monthsAgo(3), number: "EST-HISTORY", title: "SENTINEL-CUSTOMER Kitchen", ...extra };
    estimates.push(e);
    items.push({ id: uid("hi"), estimate_id: e.id, name, description: "SENTINEL-HISTORICAL-NOTE", item_type: "labor", unit: "each", quantity: 1, unit_price: price, total: price, is_heading: false, optional: false, metadata: {} });
  }
  return { estimates, items };
}

function withApprovalDefaults(db: any) {
  return {
    ...db,
    from: (table: string) => {
      const builder = db.from(table);
      if (table !== "agent_approval_requests") return builder;
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => originalInsert({ status: "pending", requested_at: new Date().toISOString(), ...row });
      return builder;
    },
  };
}
function makeDb(over: Record<string, any[]> = {}) {
  return withApprovalDefaults(
    createFakeSupabaseClient(
      {
        organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {}, integration_settings: {} }, { id: ORG_B, name: "Beta Builders", timezone: TZ, ai_center_settings: {}, integration_settings: {} }],
        contacts: [{ id: CONTACT_1, org_id: ORG_A, full_name: "Michael Estimate", email: null, phone: "+15550001111" }],
        leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Michael Estimate", estimated_value: null, custom_fields: { service: "Bathroom Remodel" } }],
        projects: [], estimates: [], estimate_items: [], project_change_orders: [], project_change_order_items: [],
        marketing_contact_preferences: [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false }],
        appointments: [], agent_executions: [], agent_execution_steps: [], agent_approval_requests: [], agent_action_idempotency: [], agent_usage_events: [],
        conversation_states: [], sms_meta_messages: [], notifications: [], business_knowledge_entries: [], ai_clarification_requests: [],
        profiles: [{ id: "owner-1", organization_id: ORG_A }],
        ...over,
      },
      {},
      { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]], business_knowledge_entries: [["org_id", "key"]] }, notNullColumns: { estimates: ["created_by"] } },
    ),
  );
}
function scriptedProvider(scripts: string[]) {
  let i = 0; const requests: any[] = [];
  return { name: "fake", requests, run: async (req: unknown) => { requests.push(req); const text = scripts[i] ?? scripts[scripts.length - 1]; i += 1; return { text, model: "fake-model", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" }; } };
}
const trustedContext = (extra: Record<string, unknown> = {}) => ({ orgId: ORG_A, actor: { actorType: "workflow" as const, actorId: "test-actor", source: "test" }, leadId: LEAD_1, contactId: CONTACT_1, autonomyLevel: 2 as const, ...extra });
const smsEvent = (text: string) => ({ eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text } });
async function run(db: any, text: string, scripts: string[], tc: Record<string, unknown> = {}) {
  const modelProvider = scriptedProvider(scripts);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent(text), trustedContext: trustedContext(tc), modelProvider });
  return { result, modelProvider };
}
const execRow = async (db: any, id: string) => (await db.from("agent_executions").select("*").eq("id", id).maybeSingle()).data;
const steps = async (db: any, id: string) => ((await db.from("agent_execution_steps").select("*").eq("execution_id", id)).data as any[]).sort((a, b) => a.sequence - b.sequence);
const stepKeys = async (db: any, id: string) => (await steps(db, id)).map((s) => [s.sequence, s.action_key]);
const allPromptText = (p: any) => p.requests.map((r: any) => `${r.system}\n${r.messages.map((m: any) => m.content).join("\n")}`).join("\n=====\n");

const respond = (response: string) => JSON.stringify({ type: "respond", response });
const handoffToEstimate = JSON.stringify({ type: "handoff", toAgent: "estimate_assistant", reason: "Customer asked for an estimate", summary: "Bathroom remodel. Customer wants an estimate." });
const proposeDraft = JSON.stringify({ type: "propose_estimate_draft", title: "Bathroom Remodel", items: [{ name: "Towel bar installation", itemType: "labor" }, { name: "Unheard of widget", itemType: "material" }] });
const proposeTowelBar = JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Towel bar installation", itemType: "labor" }] });
const ADD_TEXT = "Add a towel bar installation line item to the existing bathroom remodel estimate";

/** A db with an unpriced current estimate + 6 approved history lines for "Towel bar installation" at exactly $612 (org A) and $9,000 (org B). */
function fullDb(extra: { estimates?: any[]; items?: any[] } = {}) {
  const a = history(ORG_A, "Towel bar installation", 6, 612);
  const b = history(ORG_B, "Towel bar installation", 8, 9000);
  const v = history(ORG_A, "Vanity installation", 5, 410);
  return makeDb({
    estimates: [currentEstimate(), ...a.estimates, ...b.estimates, ...v.estimates, ...(extra.estimates ?? [])],
    estimate_items: [curItem("Vanity installation"), curItem("Tile backsplash", { item_type: "material" }), ...a.items, ...b.items, ...v.items, ...(extra.items ?? [])],
  });
}
const payloadOf = async (db: any, id: string) => (await execRow(db, id)).input_summary.pricingIntelligence;

// ── Runtime call conditions ──────────────────────────────────────────────

test("CALLED — add-line-item intent: the pricing read happens AFTER the proposal (sequence 3), the proposal keeps sequence 2", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "Thanks — the team will review adding the towel bar."]);
  assert.equal(result.status, "awaiting_approval");
  assert.deepEqual(await stepKeys(db, result.executionId), [[1, "get_estimate_context"], [2, "add_estimate_line_items"], [3, "get_pricing_suggestions"]]);
  const p = await payloadOf(db, result.executionId);
  assert.equal(p.staffOnly, true);
  assert.equal(p.available, true);
  assert.equal(p.requestedItems, 1);
  assert.equal(p.suggestions[0].itemName, "Towel bar installation");
  assert.equal(p.suggestions[0].status, "suggested");
  assert.equal(p.suggestions[0].suggestedUnitPrice, 612);
  assert.equal(p.suggestions[0].evidence.sampleCount, 6, "only org A's history (org B's $9,000 never counts)");
  assert.equal(p.suggestions[0].message, "Suggested only — not applied.");
});

test("CALLED — new estimate pricing guidance: a proposed DRAFT also gets a staff-only read (no estimateId; only the trusted lead/contact ids)", async () => {
  const a = history(ORG_A, "Towel bar installation", 6, 612);
  const db = makeDb({ estimates: a.estimates, estimate_items: a.items });
  const { result } = await run(db, "Can you prepare an estimate for the bathroom remodel?", [handoffToEstimate, proposeDraft, "The team will review."]);
  assert.equal(result.status, "awaiting_approval");
  assert.deepEqual(await stepKeys(db, result.executionId), [[1, "get_estimate_context"], [2, "create_estimate_draft"], [3, "get_pricing_suggestions"]]);
  const p = await payloadOf(db, result.executionId);
  assert.equal(p.requestedItems, 2);
  assert.equal(p.suggestions[0].status, "suggested");
  assert.equal(p.suggestions[1].status, "no_history");
  assert.equal(p.suggestions[1].message, "No reliable pricing found.");
  assert.equal(p.suggestions[1].suggestedUnitPrice, null);
  const snap = (await steps(db, result.executionId))[2].input_snapshot;
  assert.equal(snap.estimateId, undefined, "no estimate exists yet, so none is bound");
  assert.equal(snap.leadId, LEAD_1);
  assert.equal(snap.contactId, CONTACT_1);
});

test("CALLED — an explicit STAFF pricing-guidance request on an estimate with UNPRICED lines prices exactly those placeholder lines (no proposal)", async () => {
  const db = fullDb();
  // Staff-initiated (the Test Console shape): authenticated human actor on the internal channel.
  const modelProvider = scriptedProvider([respond("Pricing suggestions for those lines are attached to this run for staff.")]);
  const result = await S.orchestrateAI({
    supabase: db,
    event: { eventId: "evt-s", channel: "internal", eventType: "manual_test", content: { type: "text", text: "Please share pricing suggestions for the unpriced lines on the estimate." } },
    trustedContext: { orgId: ORG_A, actor: { actorType: "user", actorId: "owner-1", source: "ai_orchestrate_http" }, leadId: LEAD_1, contactId: CONTACT_1, autonomyLevel: 2 },
    modelProvider,
  });
  assert.equal(result.agentKey, "estimate_assistant");
  assert.deepEqual(await stepKeys(db, result.executionId), [[1, "get_estimate_context"], [2, "get_pricing_suggestions"]]);
  const p = await payloadOf(db, result.executionId);
  assert.deepEqual(p.suggestions.map((s: any) => [s.itemName, s.status]), [["Vanity installation", "suggested"], ["Tile backsplash", "no_history"]]);
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0, "guidance never creates a proposal");
});

test("NOT CALLED — a read-only 'what's on my estimate?' turn, a status question, and 'show me the estimate'", async () => {
  for (const text of ["What's on my estimate?", "Is my proposal ready?", "What's the status of my estimate?", "Can you show me the estimate?"]) {
    const db = fullDb();
    const { result } = await run(db, text, [respond("Here is what is listed on the estimate.")]);
    assert.equal(result.agentKey, "estimate_assistant", text);
    assert.deepEqual(await stepKeys(db, result.executionId), [[1, "get_estimate_context"]], text);
    assert.equal(await payloadOf(db, result.executionId), undefined, text);
  }
});

test("NOT CALLED — a guidance request when every line is already priced/reviewed, and a proposal that is refused", async () => {
  const priced = makeDb({
    estimates: [currentEstimate()],
    estimate_items: [curItem("Vanity installation", { unit_price: 450, total: 450, metadata: {} }), curItem("Tile backsplash", { unit_price: 0, metadata: {} })],
  });
  const a = await run(priced, "Please share pricing suggestions for the lines on the estimate.", [respond("Everything on the estimate is priced.")]);
  assert.deepEqual(await stepKeys(priced, a.result.executionId), [[1, "get_estimate_context"]]);
  assert.equal(await payloadOf(priced, a.result.executionId), undefined);

  // a non-draft estimate refuses the proposal => no approval => no pricing read
  const sent = fullDb();
  await sent.from("estimates").update({ status: "sent" }).eq("id", EST_CUR);
  const b = await run(sent, ADD_TEXT, [proposeTowelBar, "The team will review the change."]);
  assert.equal(sent.__dumpTable("agent_approval_requests").length, 0);
  assert.deepEqual(await stepKeys(sent, b.result.executionId), [[1, "get_estimate_context"]]);
});

// ── Trusted binding ──────────────────────────────────────────────────────

test("TRUSTED IDS — the pricing read is bound to the server-resolved estimate/lead/contact; no org or id is ever taken from model output", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "ok"]);
  const snap = (await steps(db, result.executionId))[2].input_snapshot;
  assert.equal(snap.estimateId, EST_CUR);
  assert.equal(snap.leadId, LEAD_1);
  assert.equal(snap.contactId, CONTACT_1);
  assert.deepEqual(Object.keys(snap).sort(), ["contactId", "estimateId", "items", "leadId"]);
  assert.deepEqual(snap.items, [{ name: "Towel bar installation", itemType: "labor" }]);
  assert.equal(JSON.stringify(snap).includes(ORG_A), false, "no org id in the input at all");
});

test("MODEL IDS CANNOT BE INJECTED — a proposal carrying estimateId/orgId/leadId (top-level or per item) is rejected by the strict schema: no approval, no pricing read", async () => {
  for (const evil of [
    JSON.stringify({ type: "propose_add_line_items", estimateId: EST_X, orgId: ORG_B, items: [{ name: "Towel bar installation" }] }),
    JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Towel bar installation", leadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", orgId: ORG_B }] }),
  ]) {
    const db = fullDb();
    const { result } = await run(db, ADD_TEXT, [evil, evil]);
    assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
    assert.deepEqual(await stepKeys(db, result.executionId), [[1, "get_estimate_context"]]);
    assert.ok(!JSON.stringify(db.__dumpTable("agent_execution_steps")).includes(EST_X));
  }
});

// ── Staff-only channel ───────────────────────────────────────────────────

test("STAFF-ONLY — the payload is on the execution record only: the customer reply, every model prompt and the approval proposal contain no suggested figure", async () => {
  const db = fullDb();
  const { result, modelProvider } = await run(db, ADD_TEXT, [proposeTowelBar, "Thanks — the team will review adding the towel bar and confirm pricing with you."]);
  const p = await payloadOf(db, result.executionId);
  const figures = [p.suggestions[0].suggestedUnitPrice, p.suggestions[0].lowEstimate, p.suggestions[0].highEstimate, p.suggestions[0].evidence.medianUnitPrice].map(String);
  assert.ok(figures.every((f) => f !== "null"));
  const reply = String(result.responseText);
  for (const f of figures) assert.ok(!reply.includes(f), `reply leaked ${f}`);
  assert.ok(!reply.includes("$"), "no dollar figure in the customer-facing reply");
  const prompts = allPromptText(modelProvider);
  for (const f of figures) assert.ok(!prompts.includes(f), `a prompt contained ${f}`);
  assert.ok(!/suggested only|reliable historical pricing/i.test(prompts), "no staff-panel wording or payload content in any prompt");
  const approval = db.__dumpTable("agent_approval_requests")[0];
  assert.deepEqual(Object.keys(approval.proposed_input).sort(), ["estimateId", "items"]);
  assert.deepEqual(approval.proposed_input.items, [{ name: "Towel bar installation", itemType: "labor" }]);
  for (const f of figures) assert.ok(!JSON.stringify(approval).includes(f), "the approval carries no price");
  assert.equal(result.responseText, "Thanks — the team will review adding the towel bar and confirm pricing with you.");
});

test("STAFF-ONLY — the run result object carries no pricing payload (it exists only on the persisted execution record)", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "ok"]);
  assert.ok(!("pricingIntelligence" in result));
  assert.ok(!JSON.stringify(result).includes("612"));
});

test("SENSITIVE EVIDENCE NEVER APPEARS — no history ids, customer/title text, notes, internal cost or tokens in the stored payload", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "ok"]);
  const row = await execRow(db, result.executionId);
  const json = JSON.stringify(row.input_summary.pricingIntelligence);
  for (const e of db.__dumpTable("estimates")) assert.ok(!json.includes(e.id) || e.id === EST_CUR && false, `estimate id leaked: ${e.id}`);
  for (const forbidden of ["SENTINEL", "INTERNAL-SECRET", "tok_secret", "99999", "Michael", "EST-HISTORY", EST_CUR, LEAD_1, CONTACT_1, ORG_A, ORG_B]) assert.ok(!json.includes(forbidden), `payload leaked ${forbidden}`);
});

test("REVIEWED PRICES ARE SUPPRESSED — a requested item that already has a reviewed/manual price on the estimate shows 'Existing reviewed price retained.' and no figures; an unpriced item still gets its suggestion", async () => {
  const a = history(ORG_A, "Crown molding installation", 6, 777);
  const t = history(ORG_A, "Towel bar installation", 6, 612);
  const db = makeDb({
    estimates: [currentEstimate(), ...a.estimates, ...t.estimates],
    estimate_items: [curItem("Crown molding", { unit_price: 450, total: 450, metadata: {} }), ...a.items, ...t.items],
  });
  const both = JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Crown molding installation", itemType: "labor" }, { name: "Towel bar installation", itemType: "labor" }] });
  const { result } = await run(db, ADD_TEXT, [both, "ok"]);
  const p = await payloadOf(db, result.executionId);
  assert.equal(p.suggestions[0].status, "reviewed_retained");
  assert.equal(p.suggestions[0].message, "Existing reviewed price retained.");
  assert.equal(p.suggestions[0].alreadyPricedOnEstimate, true);
  assert.equal(p.suggestions[0].suggestedUnitPrice, null);
  assert.ok(!JSON.stringify(p.suggestions[0]).includes("777"));
  assert.equal(p.suggestions[1].status, "suggested");
  assert.equal(p.suggestions[1].suggestedUnitPrice, 612);
});

test("FAILURE ISOLATION — if the pricing read fails the run still succeeds, the approval exists, the reply is unchanged, and the record says pricing was unavailable", async () => {
  const base = fullDb();
  const failing = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimate_items") { const real = b.select.bind(b); b.select = (...a: unknown[]) => { const q = real(...a); q.in = () => { throw new Error("boom SENTINEL"); }; return q; }; } return b; } };
  const { result } = await run(failing, ADD_TEXT, [proposeTowelBar, "Thanks — the team will review it."]);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.responseText, "Thanks — the team will review it.");
  assert.equal(base.__dumpTable("agent_approval_requests").length, 1);
  const p = await payloadOf(base, result.executionId);
  assert.equal(p.available, false);
  assert.equal(p.suggestions.length, 0);
  assert.match(p.note, /not available/i);
  assert.ok(!JSON.stringify(p).includes("SENTINEL"));
});

test("MONEY GUARD IN THE RUN — a model reply that repeats the staff-only suggested price is blocked and the audit record says it was a staff-only figure", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "A towel bar usually runs $612 per unit."]);
  assert.equal(result.responseText, S.PRICE_SAFE_RESPONSE);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_summary.estimate.priceGuardTriggered, true);
  assert.equal(row.input_summary.estimate.priceGuardReason, "staff_pricing_figure");
});

test("MONEY GUARD IN THE RUN — a model-invented price is blocked as ungrounded", async () => {
  const db = fullDb();
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "That will be $450."]);
  assert.equal(result.responseText, S.PRICE_SAFE_RESPONSE);
  assert.equal((await execRow(db, result.executionId)).input_summary.estimate.priceGuardReason, "ungrounded");
});

// ── Regression ───────────────────────────────────────────────────────────

test("REGRESSION — adding the staff-only read changes nothing else: the add proposal, approval policy and estimate tables are exactly as before", async () => {
  const db = fullDb();
  const before = JSON.stringify([db.__dumpTable("estimates"), db.__dumpTable("estimate_items")]);
  const { result } = await run(db, ADD_TEXT, [proposeTowelBar, "ok"]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.status, "awaiting_approval");
  const approvals = db.__dumpTable("agent_approval_requests");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_key, "add_estimate_line_items");
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].proposed_input.estimateId, EST_CUR);
  assert.equal(JSON.stringify([db.__dumpTable("estimates"), db.__dumpTable("estimate_items")]), before, "pricing read + proposal wrote nothing");
});

test("REGRESSION — with no estimate and no history the create path still proposes create_estimate_draft and pricing says 'No reliable pricing found.'", async () => {
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate for the bathroom remodel?", [handoffToEstimate, proposeDraft, "The team will review."]);
  assert.equal(db.__dumpTable("agent_approval_requests")[0].action_key, "create_estimate_draft");
  const p = await payloadOf(db, result.executionId);
  assert.deepEqual(p.suggestions.map((s: any) => s.message), ["No reliable pricing found.", "No reliable pricing found."]);
  assert.equal(result.status, "awaiting_approval");
});

test("PROMPTS — the Estimate Assistant instructions say suggestions are internal/advisory and never to be quoted, and do not tell the model to generate prices", async () => {
  const db = fullDb();
  const { modelProvider } = await run(db, ADD_TEXT, [proposeTowelBar, "ok"]);
  const system = modelProvider.requests[0].system;
  assert.match(system, /PRICING SUGGESTIONS ARE INTERNAL AND ADVISORY/);
  assert.match(system, /never guess a market price/i);
  assert.match(system, /never overwrite or contradict a reviewed\/manual price/i);
  assert.match(system, /never claim a price is final/i);
  assert.doesNotMatch(system, /estimate (?:a |the )?price yourself|generate (?:a )?price/i);
});
