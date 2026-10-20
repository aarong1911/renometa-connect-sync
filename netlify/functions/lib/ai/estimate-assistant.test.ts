// netlify/functions/lib/ai/estimate-assistant.test.ts
//
// Run:  node --test netlify/functions/lib/ai/estimate-assistant.test.ts
//
// Estimate Assistant Foundation — END-TO-END through the REAL
// orchestrateAI(): real router.ts, real context-builder.ts, real
// agents/*.ts, real action-executor.ts, real estimate-handlers.ts, on the
// in-memory fake Supabase client and a scripted fake ModelProvider. No live
// Anthropic call, no Supabase, no network.
//
// Covers: Lead Qualification -> Estimate Assistant handoff (and the cases
// that must NOT hand off / route), no-price-hallucination, budget-is-not-a-
// price, structure-without-price proposals, approval-gated mutation (and the
// full approve -> execute -> replay cycle), Business Knowledge + Owner
// Clarification reuse, cross-org isolation, internal-field non-exposure,
// loop prevention, and failure honesty.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-assistant-e2e-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/ai/orchestrator";
      export { routeAIEvent } from "./netlify/functions/lib/ai/router";
      export { KNOWN_AI_AGENT_KEYS } from "./netlify/functions/lib/ai/types";
      export { executeApprovedStep } from "./src/lib/agentic/action-executor";
      export { CLARIFICATION_HOLDING_REPLY } from "./netlify/functions/lib/ai/knowledge-clarification";
      export { PRICE_SAFE_RESPONSE, GENERIC_FALLBACK_RESPONSE } from "./netlify/functions/lib/ai/agents/estimate-assistant";
    `,
    resolveDir: repoRoot,
    loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EST_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const EST_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const TZ = "America/New_York";

const SECRETS = { cost: 87654, margin: 31337, contingency: 4242, note: "INTERNAL-SECRET-NOTE", token: "tok_secret_xyz" };

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

function estimateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EST_1, org_id: ORG_A, number: "EST-000001", title: "Kitchen remodel", status: "draft",
    client_id: CONTACT_1, lead_id: LEAD_1, project_id: null, deal_id: null,
    scope: "Replace cabinets and countertops.", exclusions: null, assumptions: null, valid_until: null,
    tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
    subtotal: 0, discount_total: 0, tax_total: 0, total: 0, client_total: 0, deposit_amount: 0, balance_due: 0,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    cost_total: SECRETS.cost, contingency: SECRETS.contingency, contractor_margin: SECRETS.margin, notes: SECRETS.note, public_token: SECRETS.token,
    metadata: {},
    ...overrides,
  };
}
const pendingItem = (id: string, name: string, position = 0) => ({ id, estimate_id: EST_1, name, description: null, item_type: "material", quantity: 1, unit: "each", unit_price: 0, total: 0, position, taxable: true, optional: false, selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: { price_pending: true } });
const pricedItem = (id: string, name: string, price: number, qty: number, position = 0) => ({ ...pendingItem(id, name, position), unit_price: price, quantity: qty, total: price * qty, metadata: {} });

function makeDb(overrides: Record<string, any[]> = {}) {
  return withApprovalDefaults(
    createFakeSupabaseClient(
      {
        organizations: [
          { id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {}, integration_settings: {} },
          { id: ORG_B, name: "Beta Builders", timezone: TZ, ai_center_settings: {}, integration_settings: {} },
        ],
        contacts: [
          { id: CONTACT_1, org_id: ORG_A, full_name: "Jane Homeowner", email: null, phone: "+15550001111" },
          { id: CONTACT_B, org_id: ORG_B, full_name: "Bea Other", email: null, phone: "+15550003333" },
        ],
        leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Jane", estimated_value: null, custom_fields: { service: "Kitchen remodel — new cabinets, quartz countertops, new sink" } }],
        projects: [],
        estimates: [],
        estimate_items: [],
        marketing_contact_preferences: [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false }],
        appointments: [],
        agent_executions: [],
        agent_execution_steps: [],
        agent_approval_requests: [],
        agent_action_idempotency: [],
        agent_usage_events: [],
        conversation_states: [],
        sms_meta_messages: [],
        notifications: [],
        // The approving owner must be a real team member: estimates.created_by is NOT NULL on the live table.
        profiles: [{ id: "owner-1", organization_id: ORG_A }],
        business_knowledge_entries: [],
        ai_clarification_requests: [],
        ...overrides,
      },
      {},
      {
        uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]], business_knowledge_entries: [["org_id", "key"]] },
        notNullColumns: { estimates: ["created_by"] },
      },
    ),
  );
}

function scriptedProvider(scripts: string[]) {
  let i = 0;
  const requests: any[] = [];
  return {
    name: "fake",
    requests,
    run: async (req: unknown) => {
      requests.push(req);
      const text = scripts[i] ?? scripts[scripts.length - 1];
      i += 1;
      return { text, model: "fake-model", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" };
    },
  };
}

function trustedContext(extra: Record<string, unknown> = {}) {
  return {
    orgId: ORG_A,
    actor: { actorType: "workflow" as const, actorId: "test-actor", source: "test" },
    leadId: LEAD_1,
    contactId: CONTACT_1,
    autonomyLevel: 2 as const,
    ...extra,
  };
}
const smsEvent = (text: string) => ({ eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text } });

const handoffToEstimate = JSON.stringify({
  type: "handoff", toAgent: "estimate_assistant", reason: "Customer asked for an estimate",
  summary: "Kitchen remodel: new cabinets, quartz countertops, new sink. Customer wants an estimate.",
  knownFacts: { project: "kitchen remodel", countertops: "quartz" }, openQuestions: ["cabinet style", "measurements"],
});
const respond = (response: string) => JSON.stringify({ type: "respond", response });
const proposeDraft = JSON.stringify({
  type: "propose_estimate_draft", title: "Kitchen remodel", scope: "Replace cabinets, install quartz countertops, new sink.",
  items: [{ name: "Cabinet replacement", itemType: "material" }, { name: "Quartz countertop replacement", itemType: "material" }, { name: "Sink installation", itemType: "labor" }],
});
const proposeBacksplash = JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Tile backsplash", itemType: "material" }] });

async function run(db: any, text: string, scripts: string[], tc: Record<string, unknown> = {}, now?: Date) {
  const modelProvider = scriptedProvider(scripts);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent(text), trustedContext: trustedContext(tc), modelProvider, now });
  return { result, modelProvider };
}
const execRow = async (db: any, id: string) => (await db.from("agent_executions").select("*").eq("id", id).maybeSingle()).data;
const steps = async (db: any, id: string) => ((await db.from("agent_execution_steps").select("*").eq("execution_id", id)).data as any[]).sort((a, b) => a.sequence - b.sequence);
const dump = (db: any, t: string) => JSON.stringify(db.__dumpTable(t));
const allPromptText = (p: any) => p.requests.map((r: any) => `${r.system}\n${r.messages.map((m: any) => m.content).join("\n")}`).join("\n=====\n");

// ── TEST 1 — agent exists + handoff plumbing ────────────────────────────

test("TEST 1 — the Estimate Assistant is a registered agent key and is reachable through the real orchestrator", async () => {
  assert.ok(S.KNOWN_AI_AGENT_KEYS.includes("estimate_assistant"));
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, respond("Happy to help.")]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.status, "completed");
});

test("TEST 10 — Lead Qualification -> Estimate Assistant: ONE execution row, handoff attached + persisted, same trusted context, estimate read is an audited step, handoff context reaches the prompt", async () => {
  const db = makeDb({
    business_knowledge_entries: [{ id: "k1", org_id: ORG_A, key: "permit_handling", category: "permit_handling", question: "Do you handle permits?", answer: "We handle permits and inspections.", source: "owner_configured", status: "active", metadata: {} }],
  });
  const { result, modelProvider } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, respond("I have the kitchen scope; I still need cabinet selection, measurements and pricing.")]);

  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.handoff.fromAgent, "lead_qualification");
  assert.equal(result.handoff.toAgent, "estimate_assistant");
  assert.equal(modelProvider.requests.length, 2, "exactly one LQ decision call + one Estimate decision call");
  assert.equal(db.__dumpTable("agent_executions").length, 1, "no second execution row");

  const row = await execRow(db, result.executionId);
  assert.equal(row.agent_key, "estimate_assistant");
  assert.equal(row.input_summary.handoff.toAgent, "estimate_assistant");
  assert.equal(row.input_summary.estimate.contextLoaded, true);
  assert.equal(row.input_summary.estimate.estimateFound, false);
  assert.equal(row.target_entity_type, "lead");

  const st = await steps(db, result.executionId);
  assert.deepEqual(st.map((s) => [s.sequence, s.action_key, s.step_type, s.status]), [[1, "get_estimate_context", "read", "succeeded"]]);

  // The Estimate Assistant REUSED the already-built context (lead scope, Business Knowledge) and the handoff summary.
  const estimatePrompt = `${modelProvider.requests[1].system}\n${modelProvider.requests[1].messages[0].content}`;
  assert.match(estimatePrompt, /Kitchen remodel — new cabinets, quartz countertops, new sink/);
  assert.match(estimatePrompt, /Permit handling: We handle permits and inspections\./);
  assert.match(estimatePrompt, /Kitchen remodel: new cabinets, quartz countertops, new sink\. Customer wants an estimate\./);
  assert.match(estimatePrompt, /Still open: cabinet style; measurements/);
  assert.match(estimatePrompt, /Existing estimate: none found/);
});

test("TEST 11 — budget alone stays with Lead Qualification: with a respond decision there is NO estimate step, NO estimate read, and the agent is lead_qualification", async () => {
  const db = makeDb();
  const { result, modelProvider } = await run(db, "My budget is $25,000.", [respond("Thanks — $25,000 gives us a good starting point. What's the timeline?")]);
  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.handoff, undefined);
  assert.equal(modelProvider.requests.length, 1);
  assert.equal((await steps(db, result.executionId)).length, 0);
});

test("TEST 11b — the router can NEVER select the Estimate Assistant directly, whatever the event/context (it is handoff-only)", () => {
  const contexts: any[] = [
    { organization: { id: "o", name: "n" }, channel: "sms" },
    { organization: { id: "o", name: "n" }, channel: "sms", lead: { id: "l", status: "new" } },
    { organization: { id: "o", name: "n" }, channel: "sms", lead: { id: "l", status: "qualified" }, project: { id: "p", name: "x", status: "active" } },
    { organization: { id: "o", name: "n" }, channel: "sms", conversation: { channel: "sms", schedulingOfferActive: true } },
  ];
  for (const eventType of ["message_received", "new_lead", "manual_test", "internal_request", "workflow_trigger", "call_started", "call_ended", "missed_call", "anything_new"]) {
    for (const context of contexts) {
      const d = S.routeAIEvent({ eventId: "e", channel: "sms", eventType, content: { type: "text", text: "Can you prepare an estimate? My budget is $25,000. Thursday at 2 PM works." } }, context);
      assert.notEqual(d.agentKey, "estimate_assistant", `${eventType}`);
    }
  }
});

test("TEST 12 — scheduling stays scheduling: an active offer routes to Scheduling (the estimate agent is never involved), and Scheduling has no estimate tools", async () => {
  const d = S.routeAIEvent(smsEvent("Thursday at 2 PM works."), { organization: { id: "o", name: "n" }, channel: "sms", lead: { id: "l", status: "qualified" }, conversation: { channel: "sms", schedulingOfferActive: true } });
  assert.equal(d.agentKey, "scheduling");
  assert.equal(d.source, "conversation_state");
});

test("a handoff to the Estimate Assistant with NO trusted lead/contact/project/estimate is declined with a safe reply — no estimate read, no estimate agent", async () => {
  const db = makeDb();
  // No lead/contact -> the router falls back to Reception; Reception hands to
  // Lead Qualification; Lead Qualification then asks for the estimate handoff.
  const receptionToLq = JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "wants an estimate", summary: "Caller wants an estimate." });
  const { result, modelProvider } = await run(db, "Can you prepare an estimate?", [receptionToLq, handoffToEstimate], { leadId: undefined, contactId: undefined });
  assert.equal(result.agentKey, "lead_qualification", "the estimate handoff was declined — control stayed with Lead Qualification");
  assert.equal(modelProvider.requests.length, 2, "no Estimate Assistant model call");
  assert.match(result.responseText, /could you tell me a little about the project/);
  assert.ok(!(await steps(db, result.executionId)).some((s) => s.action_key === "get_estimate_context"));
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
});

// ── TEST 2/3 — no price hallucination ───────────────────────────────────

test("TEST 2 — NO PRICE HALLUCINATION: a model that invents an estimate total is overridden by the deterministic guard; nothing is written; the guard is audited", async () => {
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, respond("Your estimate is $24,800.")]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.responseText, S.PRICE_SAFE_RESPONSE);
  assert.ok(!/\$/.test(result.responseText));
  assert.equal(db.__dumpTable("estimates").length, 0);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_summary.estimate.priceGuardTriggered, true);
});

test("TEST 2 — a good reply (names what is missing, no figure) passes through untouched and the DB is untouched", async () => {
  const db = makeDb();
  const reply = "I have the kitchen scope, but I still need the cabinet selection, countertop material, measurements, and pricing before I can prepare an accurate estimate.";
  const { result } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, respond(reply)]);
  assert.equal(result.responseText, reply);
  assert.equal(db.__dumpTable("estimates").length, 0);
  assert.equal((await execRow(db, result.executionId)).input_summary.estimate.priceGuardTriggered, undefined);
});

test("TEST 3 — a known $25,000 budget may be acknowledged as a TARGET but never used as a price: acknowledging passes, treating it as the total is blocked", async () => {
  const leads = [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Jane", estimated_value: 25000, custom_fields: { service: "Kitchen remodel" } }];
  const ok = await run(makeDb({ leads }), "Can you prepare an estimate?", [handoffToEstimate, respond("Your target budget is $25,000 — I still need measurements and pricing to prepare the estimate.")]);
  assert.match(ok.result.responseText, /target budget is \$25,000/);

  const bad = await run(makeDb({ leads }), "Can you prepare an estimate?", [handoffToEstimate, respond("Great — the estimate total will be $25,000, and I'll lock that in.")]);
  assert.equal(bad.result.responseText, S.PRICE_SAFE_RESPONSE);

  const prompt = allPromptText(ok.modelProvider);
  assert.match(prompt, /target budget: \$25,000 — a customer target only, NOT a quote/);
});

test("unsupported money request ('do the whole project for $18,000?'): acknowledging is fine, ACCEPTING is blocked", async () => {
  const ack = await run(makeDb(), "Can you do the whole project for $18,000?", [handoffToEstimate, respond("I see $18,000 is your target; the estimate needs team review before anything can be confirmed.")]);
  assert.match(ack.result.responseText, /needs team review/);
  const accept = await run(makeDb(), "Can you do the whole project for $18,000?", [handoffToEstimate, respond("Yes, we can do it for $18,000.")]);
  assert.equal(accept.result.responseText, S.PRICE_SAFE_RESPONSE);
});

test("a non-JSON model reply (raw text) is NEVER shown: one repair, then the generic reply — even when the prose states a price", async () => {
  const { result, modelProvider } = await run(makeDb(), "Can you prepare an estimate?", [handoffToEstimate, "Sure! These usually cost around $40,000.", "Still just prose, about $40,000."]);
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.equal(modelProvider.requests.length, 3);
});
test("TEST 4 — an existing estimate is described from the DB: real items/prices/stored totals reach the prompt; a reply restating them passes the guard; the DB is untouched", async () => {
  const db = makeDb({
    estimates: [estimateRow({ subtotal: 200, tax_total: 20, total: 220, client_total: 220, tax_rate: 10 })],
    estimate_items: [pricedItem("i1", "Base cabinets", 100, 2)],
  });
  const before = { e: dump(db, "estimates"), i: dump(db, "estimate_items") };
  const { result, modelProvider } = await run(db, "What's in my estimate?", [handoffToEstimate, respond("It has base cabinets, two at $100 each ($200), and the total is $220.")]);
  assert.equal(result.responseText, "It has base cabinets, two at $100 each ($200), and the total is $220.");
  const prompt = allPromptText(modelProvider);
  assert.match(prompt, /Base cabinets \[material\] — 2 each @ \$100 = \$200/);
  assert.match(prompt, /total \$220/);
  assert.equal(dump(db, "estimates"), before.e);
  assert.equal(dump(db, "estimate_items"), before.i);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_summary.estimate.estimateFound, true);
  assert.equal(row.input_summary.estimate.itemCount, 1);
});

// ── TEST 5 / 14 — proposals ─────────────────────────────────────────────

test("TEST 5 + 14 — structure WITHOUT price: a draft proposal creates a pending approval, writes NO estimate/items, binds ONLY trusted ids, carries no money field, and the reply never claims it exists", async () => {
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, proposeDraft, "Thanks — I've passed the project details to our team to review and prepare your estimate. They'll confirm pricing and measurements with you."]);

  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.status, "awaiting_approval");
  assert.equal(db.__dumpTable("estimates").length, 0, "NOTHING is written before approval");
  assert.equal(db.__dumpTable("estimate_items").length, 0);

  const approvals = db.__dumpTable("agent_approval_requests");
  assert.equal(approvals.length, 1);
  const a = approvals[0];
  assert.equal(a.action_key, "create_estimate_draft");
  assert.equal(a.status, "pending");
  assert.equal(a.org_id, ORG_A);
  assert.equal(a.execution_id, result.executionId);
  assert.equal(a.proposed_input.contactId, CONTACT_1, "ids come from trusted context");
  assert.equal(a.proposed_input.leadId, LEAD_1);
  assert.equal(a.proposed_input.items.length, 3);
  const proposedJson = JSON.stringify(a.proposed_input);
  for (const forbidden of ["unitPrice", "quantity", "price", "taxRate", "discount", "deposit", "total"]) {
    assert.ok(!proposedJson.includes(forbidden), `proposed input must not contain ${forbidden}`);
  }
  assert.doesNotMatch(result.responseText, /\$\d/);
  assert.doesNotMatch(result.responseText, /has been (created|sent|prepared)/i);

  const st = await steps(db, result.executionId);
  assert.deepEqual(st.map((s) => [s.sequence, s.action_key, s.status]), [[1, "get_estimate_context", "succeeded"], [2, "create_estimate_draft", "awaiting_approval"]]);
  const row = await execRow(db, result.executionId);
  assert.equal(row.status, "awaiting_approval");
  assert.equal(row.input_summary.estimate.proposal, "create_estimate_draft");
});

test("the final-call prompt after a proposal states NOTHING was created and carries no price", async () => {
  const db = makeDb();
  const { modelProvider } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, proposeDraft, "The team will review."]);
  const finalUser = modelProvider.requests[2].messages[0].content;
  assert.match(finalUser, /NOTHING has been created, priced, saved, or sent yet/);
  assert.match(finalUser, /Do not say an estimate exists/);
});

test("TEST 15/16 — FULL CYCLE: owner approves -> exactly ONE transactional RPC call bound to trusted ids; a double approval (replay) never reaches the database again", async () => {
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, proposeDraft, "The team will review."]);
  const approval = db.__dumpTable("agent_approval_requests")[0];
  const key = `create_estimate_draft:${approval.id}`; // agent-approve-action.ts idempotencyKeyFor() — format pinned in tests/netlify-functions/agent-approve-action.test.ts

  // The handler is a thin caller of create_estimate_draft_transaction. The fake RECORDS the call and answers with the
  // shape the SQL function returns; the all-or-nothing behavior itself is a PL/pgSQL property verified separately
  // (supabase/verification/estimate_transactional_rpcs_verification.sql), NOT here.
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const rpcDb: any = {
    ...db,
    rpc: async (fn: string, args: any) => { rpcCalls.push({ fn, args }); return { data: { estimate_id: EST_1, number: "EST-000001", status: "draft", item_count: args.p_items.length, already_created: false }, error: null }; },
  };

  const approvedInput = approval.proposed_input;
  const first = await S.executeApprovedStep({ supabase: rpcDb, orgId: ORG_A, actor: { actorType: "user", actorId: "owner-1" }, executionId: approval.execution_id, stepId: approval.execution_step_id, actionKey: "create_estimate_draft", approvedInput, idempotencyKey: key });
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  assert.equal(first.output.status, "draft");
  assert.equal(first.output.itemCount, 3);
  assert.equal(first.output.total, 0, "no invented price");

  const second = await S.executeApprovedStep({ supabase: rpcDb, orgId: ORG_A, actor: { actorType: "user", actorId: "owner-1" }, executionId: approval.execution_id, stepId: approval.execution_step_id, actionKey: "create_estimate_draft", approvedInput, idempotencyKey: key });
  assert.equal(second.status, "skipped");

  assert.equal(rpcCalls.length, 1, "the replay is suppressed before the database function is called again");
  assert.equal(rpcCalls[0].fn, "create_estimate_draft_transaction");
  assert.equal(rpcCalls[0].args.p_org_id, ORG_A, "tenant comes from trusted server context");
  assert.equal(rpcCalls[0].args.p_created_by, "owner-1", "attribution is the verified approver");
  assert.equal(rpcCalls[0].args.p_execution_id, approval.execution_id);
  assert.equal(rpcCalls[0].args.p_client_id, CONTACT_1);
  assert.equal(rpcCalls[0].args.p_lead_id, LEAD_1);
  assert.equal(rpcCalls[0].args.p_items.length, 3);
  assert.ok(rpcCalls[0].args.p_items.every((i: any) => Object.keys(i).every((k) => ["name", "description", "itemType"].includes(k))), "no money field crosses the boundary");
  // The TypeScript layer itself wrote nothing to the estimate tables.
  assert.equal(db.__dumpTable("estimates").length, 0);
  assert.equal(db.__dumpTable("estimate_items").length, 0);
  assert.equal(db.__dumpTable("deals").length, 0);
  assert.equal(db.__dumpTable("invoices").length, 0);
});

test("add-to-existing: 'add a backsplash' proposes ONLY the missing item (existing ones are dropped server-side), targets the trusted estimate, writes nothing until approval", async () => {
  const db = makeDb({ estimates: [estimateRow()], estimate_items: [pendingItem("i1", "Cabinet replacement")] });
  const both = JSON.stringify({ type: "propose_add_line_items", items: [{ name: "cabinet replacement" }, { name: "Tile backsplash", itemType: "material" }] });
  const { result } = await run(db, "Can you add a backsplash to the estimate?", [handoffToEstimate, both, "I've noted the backsplash for the team to review; pricing still needs to be confirmed."]);
  assert.equal(result.status, "awaiting_approval");
  const [a] = db.__dumpTable("agent_approval_requests");
  assert.equal(a.action_key, "add_estimate_line_items");
  assert.equal(a.target_entity_type, "estimate");
  assert.equal(a.target_entity_id, EST_1);
  assert.equal(a.proposed_input.estimateId, EST_1);
  assert.deepEqual(a.proposed_input.items.map((i: any) => i.name), ["Tile backsplash"]);
  assert.equal(db.__dumpTable("estimate_items").length, 1, "unchanged before approval");
  assert.equal(dump(db, "estimates"), JSON.stringify([estimateRow()]), "estimate header untouched");
});

test("add proposals are REFUSED (no approval created) when: no estimate exists / it is no longer a draft / several match / everything requested is already listed", async () => {
  const cases: Array<[string, Record<string, any[]>]> = [
    ["none exists", {}],
    ["sent", { estimates: [estimateRow({ status: "sent" })], estimate_items: [] }],
    ["ambiguous", { estimates: [estimateRow(), estimateRow({ id: EST_B, created_at: "2026-10-02T00:00:00Z" })], estimate_items: [] }],
    ["already listed", { estimates: [estimateRow()], estimate_items: [pendingItem("i1", "Tile backsplash")] }],
  ];
  for (const [label, overrides] of cases) {
    const db = makeDb(overrides);
    const { result } = await run(db, "Can you add a backsplash?", [handoffToEstimate, proposeBacksplash, "The team will review that."]);
    assert.equal(result.status, "completed", label);
    assert.equal(db.__dumpTable("agent_approval_requests").length, 0, `${label}: no approval`);
    const row = await execRow(db, result.executionId);
    assert.equal(row.input_summary.tooling.skippedReason, "proposal_precondition_failed", label);
  }
});

test("a draft proposal is REFUSED when an estimate already exists (no duplicate drafts) and when the estimate could not be read (fail safe)", async () => {
  const exists = makeDb({ estimates: [estimateRow()], estimate_items: [] });
  const r1 = await run(exists, "Can you prepare an estimate?", [handoffToEstimate, proposeDraft, "There's already an estimate in progress."]);
  assert.equal(exists.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(r1.result.status, "completed");

  const base = makeDb();
  const broken = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimates") b.select = () => ({ eq() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle: async () => ({ data: null, error: { message: "db down" } }), then: (res: any) => res({ data: null, error: { message: "db down" } }) }); return b; } };
  const r2 = await run(broken, "Can you prepare an estimate?", [handoffToEstimate, proposeDraft, "The team will follow up."]);
  assert.equal(base.__dumpTable("agent_approval_requests").length, 0, "cannot prove no estimate exists -> no proposal");
  assert.equal((await execRow(base, r2.result.executionId)).input_summary.estimate.contextLoaded, false);
  assert.match(allPromptText(r2.modelProvider), /Estimate data could not be loaded\. Do not describe, assume, or promise anything about an existing estimate\./);
});

test("a proposal is refused outright (no approval, no write) when the emergency pause is engaged, but the read still works", async () => {
  const db = makeDb({ organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: { emergencyPaused: true }, integration_settings: {} }] });
  const { result } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, proposeDraft, "A teammate will follow up on the estimate."]);
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(db.__dumpTable("estimates").length, 0);
  const st = await steps(db, result.executionId);
  assert.equal(st.find((s) => s.action_key === "get_estimate_context").status, "succeeded");
  assert.equal(st.find((s) => s.action_key === "create_estimate_draft").status, "failed");
  assert.equal(result.status, "completed", "customer still hears back");
});

// ── TEST 7 / 9 / 19 / 20 — Business Knowledge + Owner Clarification ─────

test("TEST 7 / 19 — Business Knowledge is in the Estimate Assistant's real prompt and a BK-grounded answer is allowed; no clarification is created", async () => {
  const db = makeDb({
    business_knowledge_entries: [{ id: "k1", org_id: ORG_A, key: "permit_handling", category: "permit_handling", question: "Do you handle permits?", answer: "We handle permits and inspections.", source: "owner_configured", status: "active", metadata: {} }],
  });
  const { result, modelProvider } = await run(db, "Do you handle permits?", [handoffToEstimate, respond("Yes — we handle permits and inspections.")]);
  assert.equal(result.responseText, "Yes — we handle permits and inspections.");
  assert.match(allPromptText(modelProvider), /- Permit handling: We handle permits and inspections\./);
  assert.equal(db.__dumpTable("ai_clarification_requests").length, 0);
});

test("TEST 7b — a clarify decision the Business Knowledge already answers is overridden: answered from the entry, NO owner clarification created", async () => {
  const db = makeDb({
    business_knowledge_entries: [{ id: "k1", org_id: ORG_A, key: "permit_handling", category: "permit_handling", question: "Do you handle permits?", answer: "We handle permits and inspections.", source: "owner_configured", status: "active", metadata: {} }],
  });
  const clarify = JSON.stringify({ type: "clarify", category: "permit_handling", question: "Does the company handle permits?" });
  const { result, modelProvider } = await run(db, "Do you handle permits?", [handoffToEstimate, clarify, "Yes — we handle permits and inspections."]);
  assert.equal(db.__dumpTable("ai_clarification_requests").length, 0);
  assert.equal(result.responseText, "Yes — we handle permits and inspections.");
  assert.match(modelProvider.requests[2].messages[0].content, /Trusted Business Knowledge DOES answer the customer's question: "We handle permits and inspections\."/);
});

test("TEST 8 — 'Are permit fees included in this estimate?': the prompt carries the permits-vs-permit-fees rule, the estimate lists NO permit fee, and a reply asserting fees are included is not forced by anything", async () => {
  const db = makeDb({
    estimates: [estimateRow()], estimate_items: [pendingItem("i1", "Cabinet replacement")],
    business_knowledge_entries: [{ id: "k1", org_id: ORG_A, key: "permit_handling", category: "permit_handling", question: "q", answer: "We handle permits and inspections.", source: "owner_configured", status: "active", metadata: {} }],
  });
  const { modelProvider } = await run(db, "Are permit fees included in this estimate?", [handoffToEstimate, respond("Our team will confirm whether permit fees are covered in your estimate.")]);
  const p = allPromptText(modelProvider);
  assert.match(p, /is NOT the same as "permit fees are included in this estimate"/);
  assert.match(p, /We handle permits and inspections\./);
  assert.ok(!/permit fee/i.test(p.split("Estimate context (read from the CRM just now")[1].split("Known facts for the estimate")[0]), "the estimate itself says nothing about permit fees");
});

test("TEST 9 / 20 — a genuinely unknown company policy reuses the EXISTING Owner Clarification workflow (one request, deterministic holding reply, no model-authored promise)", async () => {
  const db = makeDb();
  const clarify = JSON.stringify({ type: "clarify", category: "warranty", question: "How long is the workmanship warranty on kitchen remodels?" });
  const { result } = await run(db, "How long is your warranty?", [handoffToEstimate, clarify]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.responseText, S.CLARIFICATION_HOLDING_REPLY);
  const rows = db.__dumpTable("ai_clarification_requests");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].knowledge_key, "warranty");
  assert.equal(rows[0].org_id, ORG_A);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_summary.clarification.outcome, "created");
  assert.equal(row.input_summary.handoff.toAgent, "estimate_assistant");
});

// ── TEST 17 / 18 — isolation + exposure ─────────────────────────────────

test("TEST 17 — Org A cannot read or mutate Org B's estimate even if its id is supplied as the trusted estimateId", async () => {
  const db = makeDb({ estimates: [estimateRow({ id: EST_B, org_id: ORG_B, client_id: CONTACT_B, lead_id: null, title: "Org B secret job" })], estimate_items: [{ ...pendingItem("ib", "Org B secret item"), estimate_id: EST_B }] });
  const { result, modelProvider } = await run(db, "Can you add a backsplash?", [handoffToEstimate, proposeBacksplash, "The team will review."], { estimateId: EST_B });
  const p = allPromptText(modelProvider);
  assert.ok(!p.includes("Org B secret"), "Org B data never reaches Org A's prompt");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(db.__dumpTable("estimate_items").length, 1);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_summary.estimate.estimateFound, false);
});

test("TEST 18 — internal cost / margin / contingency / notes / public token NEVER reach any model prompt, response, or persisted execution summary", async () => {
  const db = makeDb({
    estimates: [estimateRow({ subtotal: 200, total: 220, client_total: 220, tax_total: 20, tax_rate: 10 })],
    estimate_items: [pricedItem("i1", "Base cabinets", 100, 2)],
  });
  const { result, modelProvider } = await run(db, "What's included?", [handoffToEstimate, respond("Base cabinets, two of them.")]);
  const haystack = [allPromptText(modelProvider), JSON.stringify(result), dump(db, "agent_executions"), dump(db, "agent_execution_steps")].join("\n");
  for (const secret of [String(SECRETS.cost), String(SECRETS.margin), String(SECRETS.contingency), SECRETS.note, SECRETS.token]) {
    assert.ok(!haystack.includes(secret), `leaked ${secret}`);
  }
});

// ── Loop prevention / failure honesty ───────────────────────────────────

test("loop prevention: if the Estimate Assistant model emits a handoff it is NOT honored (strict schema rejects it, one repair, then the generic reply) and no second agent runs", async () => {
  const bounce = JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "x", summary: "y" });
  const db = makeDb();
  const { result, modelProvider } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, bounce]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(modelProvider.requests.length, 3, "LQ + decision + the single repair — never a scheduling call");
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.ok(!(await steps(db, result.executionId)).some((s) => /availability|schedule/.test(s.action_key)));
});
test("a Scheduling -> Lead Qualification reverse handoff can NOT then forward to the Estimate Assistant (one reverse hop, no onward hop)", async () => {
  const db = makeDb({
    conversation_states: [{ org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", scheduling_offered_slots: [{ start: "2027-03-17T14:00:00.000Z", end: "2027-03-17T15:00:00.000Z", timeZone: TZ }], scheduling_offered_at: new Date().toISOString() }],
  });
  const back = JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "moved on", summary: "Customer asked about an estimate instead." });
  const { result, modelProvider } = await run(db, "Actually can you prepare an estimate?", [back, handoffToEstimate, respond("never reached")], {}, new Date());
  assert.notEqual(result.agentKey, "estimate_assistant");
  assert.equal(modelProvider.requests.length, 2, "scheduling decision + lead-qualification decision only");
});

test("a failing model call is reported as failed — never a fabricated success or a claimed estimate", async () => {
  const db = makeDb();
  let calls = 0;
  const modelProvider = { name: "fake", run: async () => { calls += 1; if (calls === 1) return { text: handoffToEstimate, model: "m", usage: { inputTokens: 1, outputTokens: 1 }, provider: "fake" }; throw new Error("provider down"); } };
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Can you prepare an estimate?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "failed");
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("estimates").length, 0);
  assert.ok(!result.responseText);
});

test("usage totals fold in Lead Qualification's decision call so the execution row covers the whole run", async () => {
  const db = makeDb();
  const { result } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, respond("Happy to help.")]);
  const row = await execRow(db, result.executionId);
  assert.equal(row.input_tokens, 20, "LQ decision (10) + Estimate decision (10)");
  assert.equal(row.output_tokens, 20);
});

// ── Structured-decision robustness: bounded repair, value-free metadata, usage, caps ──

const badExtraKey = JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen remodel", location: "SENTINEL-123 Private Lane", items: [{ name: "Cabinet replacement", itemType: "material" }] });
const finalText = "Thanks — our team will review the project details and prepare your estimate.";

test("L + O — initial schema failure then a VALID repair: exactly one repair call, the proposal proceeds to a normal pending approval with trusted ids, and usage includes the repair call", async () => {
  const db = makeDb();
  const { result, modelProvider } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, badExtraKey, proposeDraft, finalText]);

  assert.equal(modelProvider.requests.length, 4, "LQ decision + estimate decision + ONE repair + final response");
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.responseText, finalText);

  const [a] = db.__dumpTable("agent_approval_requests");
  assert.equal(a.action_key, "create_estimate_draft");
  assert.equal(a.status, "pending");
  assert.equal(a.proposed_input.contactId, CONTACT_1);
  assert.equal(a.proposed_input.leadId, LEAD_1);
  assert.equal(db.__dumpTable("estimates").length, 0, "still nothing written before approval");

  const row = await execRow(db, result.executionId);
  assert.deepEqual(row.input_summary.estimate.decisionValidation, {
    initial: { status: "invalid", issues: [{ path: "(root)", code: "unrecognized_keys" }] },
    repairAttempted: true,
    repair: { status: "valid" },
  });
  assert.equal(row.input_tokens, 40, "usage includes the repair call (4 calls x 10)");
  assert.equal(row.output_tokens, 40);
  assert.equal((await db.from("agent_usage_events").select("id").eq("execution_id", result.executionId)).data.length, 4);
});

test("L — the repair prompt is value-free: carries the issue path/code and the same trusted context, never the invalid output", async () => {
  const { modelProvider } = await run(makeDb(), "Can you prepare an estimate for the kitchen?", [handoffToEstimate, badExtraKey, proposeDraft, finalText]);
  const repair = modelProvider.requests[2];
  const text = `${repair.system}\n${repair.messages[0].content}`;
  assert.match(text, /Your previous structured decision did not match the required schema/);
  assert.match(text, /- \(root\): unrecognized_keys/);
  assert.ok(!text.includes("SENTINEL-123 Private Lane"), "the invalid output is never fed back");
  assert.match(text, /Existing estimate: none found/);
  assert.equal(repair.system, modelProvider.requests[1].system, "same contract + trusted context");
});

test("M + O — initial failure AND invalid repair: exactly one repair call, GENERIC reply, no proposal, no approval, no write; usage counts both calls; the failure is recorded value-free", async () => {
  const db = makeDb();
  const bad2 = JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen", unitPrice: 25000 });
  const { result, modelProvider } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, badExtraKey, bad2]);

  assert.equal(modelProvider.requests.length, 3, "LQ + decision + exactly ONE repair — no recursion");
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(db.__dumpTable("estimates").length, 0);
  const steps_ = await steps(db, result.executionId);
  assert.deepEqual(steps_.map((s) => s.action_key), ["get_estimate_context"], "no proposal step");

  const row = await execRow(db, result.executionId);
  assert.deepEqual(row.input_summary.estimate.decisionValidation, {
    initial: { status: "invalid", issues: [{ path: "(root)", code: "unrecognized_keys" }] },
    repairAttempted: true,
    repair: { status: "invalid", issues: [{ path: "(root)", code: "unrecognized_keys" }] },
  });
  assert.equal(row.input_tokens, 30);
  assert.equal(row.status, "succeeded");
});

test("M — a non-JSON initial reply and a non-JSON repair reply: still exactly one repair, still only the generic reply (prose never reaches the customer)", async () => {
  const db = makeDb();
  const { result, modelProvider } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, "Sure! These usually cost around $40,000 — SENTINEL-PROSE.", "Happy to help, SENTINEL-PROSE-2"]);
  assert.equal(modelProvider.requests.length, 3);
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.ok(!JSON.stringify(result).includes("SENTINEL-PROSE"));
  const row = await execRow(db, result.executionId);
  assert.deepEqual(row.input_summary.estimate.decisionValidation.initial.issues, [{ path: "(root)", code: "not_json" }]);
  assert.ok(!JSON.stringify(row).includes("SENTINEL-PROSE"));
});

test("a truncated first reply is repaired like any invalid reply, and a repair model-call ERROR degrades to the generic reply (recorded as 'error'), never a failure that drops the customer", async () => {
  const truncated = JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen remodel", items: [{ name: "Cabinet replacement" }] }).slice(0, 70);
  const ok = await run(makeDb(), "Can you prepare an estimate?", [handoffToEstimate, truncated, proposeDraft, finalText]);
  assert.equal(ok.result.status, "awaiting_approval");

  const db = makeDb();
  let calls = 0;
  const modelProvider = { name: "fake", requests: [] as any[], run: async (req: any) => {
    modelProvider.requests.push(req); calls += 1;
    if (calls === 1) return { text: handoffToEstimate, model: "m", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" };
    if (calls === 2) return { text: truncated, model: "m", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" };
    throw new Error("provider down");
  } };
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Can you prepare an estimate?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.equal(calls, 3, "no second repair attempt after the error");
  assert.equal((await execRow(db, result.executionId)).input_summary.estimate.decisionValidation.repair.status, "error");
});

test("N — validation metadata AND server logs contain ONLY statuses / paths / codes: no raw output, no customer message, no field values, no ids", async () => {
  const db = makeDb();
  const warnings: unknown[][] = [];
  const prevWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  let result: any, modelProvider: any;
  try {
    ({ result, modelProvider } = await run(db, "Please estimate SENTINEL-MSG at 123 Private Lane, budget $50,000", [handoffToEstimate, badExtraKey, badExtraKey]));
  } finally { console.warn = prevWarn; }

  const row = await execRow(db, result.executionId);
  const persisted = JSON.stringify(row.input_summary.estimate.decisionValidation);
  const logged = JSON.stringify(warnings.filter((w) => String(w[0]).includes("decision validation failed")));
  assert.ok(warnings.some((w) => String(w[0]).includes("decision validation failed")), "failures are logged server-side");
  for (const [label, blob] of [["persisted metadata", persisted], ["server log", logged]] as const) {
    for (const forbidden of ["SENTINEL", "Private Lane", "50,000", "Kitchen remodel", "Cabinet replacement", CONTACT_1, LEAD_1, ORG_A, "location"]) {
      assert.ok(!blob.includes(forbidden), `${label} leaked ${forbidden}`);
    }
  }
  const logEntries = warnings.filter((w) => String(w[0]).includes("decision validation failed")).map((w) => w[1] as any);
  assert.deepEqual(logEntries.map((e) => e.stage), ["initial", "repair"]);
  for (const e of logEntries) {
    assert.deepEqual(Object.keys(e).sort(), ["event", "issues", "stage"]);
    for (const i of e.issues) assert.deepEqual(Object.keys(i).sort(), ["code", "path"]);
  }
  // …and the persisted record itself has only the documented keys.
  const dv = row.input_summary.estimate.decisionValidation;
  assert.deepEqual(Object.keys(dv).sort(), ["initial", "repair", "repairAttempted"]);
  assert.ok(modelProvider.requests.length === 3);
});

test("Q — end to end: a first reply with benign `scope: null` is normalized (NO repair call), reaches awaiting_approval, trusted ids bound, scope omitted from the approved input", async () => {
  const db = makeDb();
  const scopeNull = JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen remodel", scope: null, items: [{ name: "Cabinet replacement", description: "", itemType: "permit" }, { name: "Sink installation", itemType: "labor" }] });
  const { result, modelProvider } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, scopeNull, finalText]);

  assert.equal(modelProvider.requests.length, 3, "LQ + decision + final — normalization avoided the repair call");
  assert.equal(result.status, "awaiting_approval");
  const [a] = db.__dumpTable("agent_approval_requests");
  assert.equal(a.action_key, "create_estimate_draft");
  assert.equal(a.proposed_input.contactId, CONTACT_1);
  assert.equal(a.proposed_input.leadId, LEAD_1);
  assert.ok(!("scope" in a.proposed_input));
  assert.deepEqual(a.proposed_input.items, [{ name: "Cabinet replacement", itemType: "custom" }, { name: "Sink installation", itemType: "labor" }]);
  assert.equal(db.__dumpTable("estimates").length, 0);
  const row = await execRow(db, result.executionId);
  assert.deepEqual(row.input_summary.estimate.decisionValidation, { initial: { status: "valid", normalized: true }, repairAttempted: false });
});

test("a valid first reply records `valid` with no repair, and the Estimate Assistant decision calls use the 900 cap while the final response call keeps 400", async () => {
  const db = makeDb();
  const { result, modelProvider } = await run(db, "Can you prepare an estimate for the kitchen?", [handoffToEstimate, proposeDraft, finalText]);
  assert.deepEqual((await execRow(db, result.executionId)).input_summary.estimate.decisionValidation, { initial: { status: "valid" }, repairAttempted: false });
  assert.equal(modelProvider.requests[1].maxTokens, 900);
  assert.equal(modelProvider.requests[2].maxTokens, 400);

  const { modelProvider: mp2 } = await run(makeDb(), "Can you prepare an estimate?", [handoffToEstimate, badExtraKey, proposeDraft, finalText]);
  assert.equal(mp2.requests[1].maxTokens, 900);
  assert.equal(mp2.requests[2].maxTokens, 900, "the repair call uses the same Estimate Assistant cap");
  assert.equal(mp2.requests[3].maxTokens, 400);
});

test("an invalid-then-repaired DRAFT cannot smuggle money: a repair reply that adds a price is rejected (strict schema is the final authority) and nothing is proposed", async () => {
  const db = makeDb();
  const withPrice = JSON.stringify({ type: "propose_estimate_draft", title: "Kitchen remodel", items: [{ name: "Cabinet replacement", unitPrice: 12000 }] });
  const { result } = await run(db, "Can you prepare an estimate?", [handoffToEstimate, badExtraKey, withPrice]);
  assert.equal(result.responseText, S.GENERIC_FALLBACK_RESPONSE);
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.equal(db.__dumpTable("estimates").length, 0);
});
