// netlify/functions/lib/ai/existing-estimate-context.test.ts
//
// Run:  node --test netlify/functions/lib/ai/existing-estimate-context.test.ts
//
// Existing-estimate awareness for Lead Qualification -> Estimate Assistant.
//
// Production smoke test: a lead with an existing draft estimate (EST-000008) surfaced NO estimate in AI Center
// context, so Lead Qualification kept asking qualification questions instead of recognizing it. These tests drive
// the REAL buildAIContext() / orchestrateAI() / action-executor / estimate handlers on the in-memory fake Supabase
// client with a scripted fake ModelProvider (no live model, no network, no Supabase).
//
// Covers: existing estimate resolved by lead / contact / project, project > lead > contact priority, archived and
// cancelled estimates ignored, ambiguous active estimates (no id exposed, never guessed), cross-org isolation,
// the trusted estimateId handoff binding, "add to existing" proposing add_estimate_line_items (never
// create_estimate_draft), "no estimate" preserving create_estimate_draft, no model-chosen ids/orgs, graceful
// degradation when the lookup fails, and the leads.custom_fields.service-is-not-a-project finding.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "existing-estimate-ctx-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: `
      export * from "./netlify/functions/lib/ai/orchestrator";
      export { buildAIContext } from "./netlify/functions/lib/ai/context-builder";
      export { buildContextLines } from "./netlify/functions/lib/ai/prompting";
      export { detectExistingEstimateChangeIntent, detectExistingEstimateReference, classifyExistingEstimateIntent } from "./netlify/functions/lib/ai/existing-estimate-intent";
      export { lookupCurrentEstimate, INACTIVE_ESTIMATE_STATUSES } from "./src/lib/agentic/estimate-lookup";
      export { executeApprovedStep } from "./src/lib/agentic/action-executor";
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
const savedConsole = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = savedConsole[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PROJECT_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const EST_P = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1"; // linked by project
const EST_L = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2"; // linked by lead
const EST_C = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3"; // linked by contact only
const EST_L2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4"; // a second active estimate on the lead
const EST_X = "dddddddd-dddd-4ddd-8ddd-ddddddddddd9"; // other org
const TZ = "America/New_York";

const estimateRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, org_id: ORG_A, number: "EST-000008", title: "Bathroom Remodel", status: "draft",
  client_id: CONTACT_1, lead_id: null, project_id: null, deal_id: null,
  scope: "Bathroom remodel", exclusions: null, assumptions: null, valid_until: null,
  tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
  subtotal: 0, discount_total: 0, tax_total: 0, total: 0, client_total: 0, deposit_amount: 0, balance_due: 0,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", metadata: {},
  cost_total: 99999, notes: "INTERNAL-SECRET-NOTE", public_token: "tok_secret",
  ...over,
});
const item = (id: string, estimateId: string, name: string, over: Record<string, unknown> = {}) => ({
  id, estimate_id: estimateId, name, description: null, item_type: "material", quantity: 1, unit: "each", unit_price: 0, total: 0, position: 0,
  taxable: true, optional: false, selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: { price_pending: true }, ...over,
});

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

function makeDb(overrides: Record<string, any[]> = {}) {
  return withApprovalDefaults(
    createFakeSupabaseClient(
      {
        organizations: [
          { id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {}, integration_settings: {} },
          { id: ORG_B, name: "Beta Builders", timezone: TZ, ai_center_settings: {}, integration_settings: {} },
        ],
        contacts: [
          { id: CONTACT_1, org_id: ORG_A, full_name: "Michael Estimate", email: null, phone: "+15550001111" },
          { id: CONTACT_B, org_id: ORG_B, full_name: "Bea Other", email: null, phone: "+15550003333" },
        ],
        // NOTE: "Bathroom Remodel" lives ONLY in leads.custom_fields.service (free text) — there is no projects row.
        leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Michael Estimate", estimated_value: null, custom_fields: { service: "Bathroom Remodel" } }],
        projects: [],
        estimates: [],
        estimate_items: [],
        marketing_contact_preferences: [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false }],
        appointments: [], agent_executions: [], agent_execution_steps: [], agent_approval_requests: [], agent_action_idempotency: [], agent_usage_events: [],
        conversation_states: [], sms_meta_messages: [], notifications: [], business_knowledge_entries: [], ai_clarification_requests: [],
        profiles: [{ id: "owner-1", organization_id: ORG_A }],
        ...overrides,
      },
      {},
      { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]], business_knowledge_entries: [["org_id", "key"]] }, notNullColumns: { estimates: ["created_by"] } },
    ),
  );
}

function scriptedProvider(scripts: string[]) {
  let i = 0;
  const requests: any[] = [];
  return {
    name: "fake", requests,
    run: async (req: unknown) => {
      requests.push(req);
      const text = scripts[i] ?? scripts[scripts.length - 1];
      i += 1;
      return { text, model: "fake-model", usage: { inputTokens: 10, outputTokens: 10 }, provider: "fake" };
    },
  };
}
const trustedContext = (extra: Record<string, unknown> = {}) => ({
  orgId: ORG_A, actor: { actorType: "workflow" as const, actorId: "test-actor", source: "test" }, leadId: LEAD_1, contactId: CONTACT_1, autonomyLevel: 2 as const, ...extra,
});
const smsEvent = (text: string) => ({ eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text } });
async function run(db: any, text: string, scripts: string[], tc: Record<string, unknown> = {}) {
  const modelProvider = scriptedProvider(scripts);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent(text), trustedContext: trustedContext(tc), modelProvider });
  return { result, modelProvider };
}
const ctxFor = (db: any, scope: Record<string, string | undefined> = { contactId: CONTACT_1, leadId: LEAD_1 }) =>
  S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", ...scope });
const steps = async (db: any, id: string) => ((await db.from("agent_execution_steps").select("*").eq("execution_id", id)).data as any[]).sort((a, b) => a.sequence - b.sequence);

const respond = (response: string) => JSON.stringify({ type: "respond", response });
const handoffToEstimate = JSON.stringify({ type: "handoff", toAgent: "estimate_assistant", reason: "Customer asked for an estimate", summary: "Bathroom remodel. Customer wants an estimate." });
const proposeDraft = JSON.stringify({ type: "propose_estimate_draft", title: "Bathroom Remodel", items: [{ name: "Vanity installation", itemType: "labor" }] });
const proposeVanity = JSON.stringify({ type: "propose_add_line_items", items: [{ name: "Vanity installation", itemType: "labor" }] });

// ── Context Builder: resolution ──────────────────────────────────────────

test("existing estimate by LEAD — resolved with number, title, status, linked ids, item count, pending pricing and the stored total", async () => {
  const db = makeDb({
    estimates: [estimateRow(EST_L, { lead_id: LEAD_1, total: 1250 })],
    estimate_items: [item("i1", EST_L, "Demo"), item("i2", EST_L, "Tile", { unit_price: 400, total: 400, metadata: {} }), item("h1", EST_L, "Section", { is_heading: true, metadata: {} })],
  });
  const c = await ctxFor(db);
  assert.deepEqual(
    { ...c.existingEstimate },
    {
      state: "found", matchedBy: "lead", estimateId: EST_L, number: "EST-000008", title: "Bathroom Remodel", status: "draft",
      contactId: CONTACT_1, leadId: LEAD_1, projectId: null, total: 1250, editableByAssistant: true,
      itemCount: 2, pricePendingItemCount: 1, pricePending: true,
    },
  );
});

test("existing estimate by CONTACT — found when the estimate is linked only through client_id", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_C)] });
  const c = await ctxFor(db);
  assert.equal(c.existingEstimate.state, "found");
  assert.equal(c.existingEstimate.matchedBy, "contact");
  assert.equal(c.existingEstimate.estimateId, EST_C);
  assert.equal(c.existingEstimate.leadId, null);
});

test("existing estimate by PROJECT — found when only a trusted projectId is supplied (no lead, no contact)", async () => {
  const db = makeDb({ projects: [{ id: PROJECT_1, org_id: ORG_A, name: "Bathroom Remodel", status: "planning" }], estimates: [estimateRow(EST_P, { project_id: PROJECT_1 })] });
  const c = await ctxFor(db, { projectId: PROJECT_1 });
  assert.equal(c.existingEstimate.matchedBy, "project");
  assert.equal(c.existingEstimate.estimateId, EST_P);
  assert.equal(c.existingEstimate.projectId, PROJECT_1);
});

test("PRIORITY — project beats lead beats contact (same rule as get_estimate_context)", async () => {
  const db = makeDb({
    projects: [{ id: PROJECT_1, org_id: ORG_A, name: "Bathroom Remodel", status: "planning" }],
    estimates: [
      estimateRow(EST_P, { project_id: PROJECT_1, number: "EST-000001", created_at: "2026-10-01T00:00:00.000Z" }),
      estimateRow(EST_L, { lead_id: LEAD_1, number: "EST-000002", created_at: "2026-10-02T00:00:00.000Z" }),
      estimateRow(EST_C, { number: "EST-000003", created_at: "2026-10-03T00:00:00.000Z" }),
    ],
  });
  const all = { projectId: PROJECT_1, leadId: LEAD_1, contactId: CONTACT_1 };
  assert.equal((await ctxFor(db, all)).existingEstimate.estimateId, EST_P, "project wins even though it is the oldest");
  assert.equal((await ctxFor(db, { leadId: LEAD_1, contactId: CONTACT_1 })).existingEstimate.estimateId, EST_L, "lead beats contact");
  const contactOnly = (await ctxFor(db, { contactId: CONTACT_1 })).existingEstimate;
  assert.equal(contactOnly.matchedBy, "contact");
  assert.equal(contactOnly.state, "ambiguous", "three active estimates share client_id at contact scope");
});

test("TERMINAL — archived and cancelled estimates are never the current estimate; an active one beside them still wins", async () => {
  const onlyTerminal = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1, status: "cancelled" }), estimateRow(EST_C, { status: "archived" })] });
  assert.equal((await ctxFor(onlyTerminal)).existingEstimate, undefined, "no active estimate => nothing is surfaced");

  const mixed = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1, status: "cancelled", created_at: "2026-10-05T00:00:00.000Z" }), estimateRow(EST_L2, { lead_id: LEAD_1, status: "sent", number: "EST-000009", created_at: "2026-10-01T00:00:00.000Z" })] });
  const c = await ctxFor(mixed);
  assert.equal(c.existingEstimate.state, "found");
  assert.equal(c.existingEstimate.estimateId, EST_L2);
  assert.equal(c.existingEstimate.editableByAssistant, false, "a sent estimate is visible but not assistant-editable");
});

test("AMBIGUOUS — several active estimates at the winning scope: state ambiguous, NO estimate id exposed, candidates named without ids", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1, number: "EST-000008" }), estimateRow(EST_L2, { lead_id: LEAD_1, number: "EST-000009", title: "Kitchen" })] });
  const c = await ctxFor(db);
  assert.equal(c.existingEstimate.state, "ambiguous");
  assert.equal(c.existingEstimate.estimateId, undefined);
  assert.deepEqual(c.existingEstimate.candidates.map((x: any) => x.number).sort(), ["EST-000008", "EST-000009"]);
  assert.ok(!JSON.stringify(c.existingEstimate).includes(EST_L) && !JSON.stringify(c.existingEstimate).includes(EST_L2), "no id leaks through the candidates");
  const lines = S.buildContextLines(c).join("\n");
  assert.match(lines, /Several active estimates are on file/);
  assert.match(lines, /never guess/);
});

test("TENANT — an estimate in another organization is never surfaced, even for the same lead/contact ids", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_X, { org_id: ORG_B, lead_id: LEAD_1, client_id: CONTACT_1 })] });
  assert.equal((await ctxFor(db)).existingEstimate, undefined);
});

test("NO estimate — nothing is attached (so Lead Qualification keeps its normal behavior)", async () => {
  const c = await ctxFor(makeDb());
  assert.equal(c.existingEstimate, undefined);
  assert.ok(!S.buildContextLines(c).join("\n").includes("Existing estimate"));
});

test("a failing estimate lookup never breaks context building (best effort; the Estimate Assistant re-reads through the audited action)", async () => {
  const base = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const failing = { ...base, from: (t: string) => { const b = base.from(t); if (t === "estimates") b.select = () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) }); return b; } };
  const c = await S.buildAIContext({ supabase: failing, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, leadId: LEAD_1 });
  assert.equal(c.existingEstimate, undefined);
  assert.equal(c.lead.id, LEAD_1);
});

// ── Prompt context ───────────────────────────────────────────────────────

test("context lines mention the existing estimate (number, title, status, item count, pending pricing) but NEVER a dollar figure or an id", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1, total: 7777 })], estimate_items: [item("i1", EST_L, "Demo")] });
  const lines = S.buildContextLines(await ctxFor(db)).join("\n");
  assert.match(lines, /Existing estimate on file: EST-000008 "Bathroom Remodel", status draft, 1 line item, pricing still pending on 1 line/);
  assert.ok(!lines.includes("7777") && !lines.includes("7,777") && !lines.includes(EST_L));
});

test("the Lead Qualification decision prompt carries the EXISTING ESTIMATE RULE and the estimate in context", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const { modelProvider } = await run(db, "Thanks! Anything else you need from me on the bathroom project?", [respond("Let me check.")]);
  const req = modelProvider.requests[0];
  assert.match(req.system, /EXISTING ESTIMATE RULE/);
  assert.match(req.system, /MUST hand off to the Estimate Assistant/);
  assert.match(req.messages[0].content, /Existing estimate on file: EST-000008/);
});

// ── Orchestrator: the end-to-end behavior from the production smoke test ──

test("PRODUCTION CASE — 'Add a vanity installation line item to the existing bathroom remodel estimate' with EST-000008 linked proposes add_estimate_line_items, NOT create_estimate_draft; no qualification call is made", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })], estimate_items: [item("i1", EST_L, "Demo")] });
  const { result, modelProvider } = await run(db, "Add a vanity installation line item to the existing bathroom remodel estimate", [proposeVanity, "Thanks — the team will review adding the vanity."]);

  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.handoff.fromAgent, "lead_qualification");
  assert.equal(result.handoff.toAgent, "estimate_assistant");
  assert.equal(modelProvider.requests.length, 2, "NO Lead Qualification decision call: the first model call is the Estimate Assistant's own decision");
  assert.ok(!/Lead Qualification|qualification question/i.test(modelProvider.requests[0].system.split("\n").slice(0, 3).join(" ")));

  const st = await steps(db, result.executionId);
  assert.deepEqual(st.map((s) => [s.sequence, s.action_key]), [[1, "get_estimate_context"], [2, "add_estimate_line_items"]], "the audited estimate read happens BEFORE the proposal");
  assert.ok(!st.some((s) => s.action_key === "create_estimate_draft"));

  const approvals = db.__dumpTable("agent_approval_requests");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_key, "add_estimate_line_items");
  assert.equal(approvals[0].proposed_input.estimateId, EST_L, "bound to the server-resolved estimate");
  assert.equal(approvals[0].target_entity_type, "estimate");
  assert.equal(approvals[0].target_entity_id, EST_L);
  assert.equal(approvals[0].org_id, ORG_A);
  assert.equal(db.__dumpTable("estimates").length, 1, "nothing was created");
  assert.equal(db.__dumpTable("estimate_items").length, 1, "nothing was written before approval");
});

test("the handoff carries the TRUSTED resolved estimate id into the Estimate Assistant's audited read (execution record shows it found the estimate)", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const { result } = await run(db, "Add a vanity installation line item to the existing bathroom remodel estimate", [proposeVanity, "ok"]);
  const row = (await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle()).data;
  assert.equal(row.input_summary.estimate.estimateFound, true);
  assert.equal(row.input_summary.estimate.estimateId, EST_L);
  assert.equal(row.input_summary.context.existingEstimate, "found");
  assert.equal(row.input_summary.handoff.toAgent, "estimate_assistant");
  const read = (await steps(db, result.executionId)).find((x) => x.action_key === "get_estimate_context");
  assert.equal(read.input_snapshot.estimateId, EST_L, "the audited read was given the server-resolved estimateId (not just the lead/contact ids)");
});

test("model-driven path — a phrasing the backstop does not match still reaches the model WITH the estimate in context; a model handoff binds the same trusted id", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const { result, modelProvider } = await run(db, "Anything else you need from me on the bathroom project?", [handoffToEstimate, proposeVanity, "ok"]);
  assert.equal(modelProvider.requests.length, 3, "LQ decision + Estimate decision + final response");
  assert.match(modelProvider.requests[0].messages[0].content, /Existing estimate on file: EST-000008/);
  assert.equal(result.agentKey, "estimate_assistant");
  const approvals = db.__dumpTable("agent_approval_requests");
  assert.equal(approvals[0].proposed_input.estimateId, EST_L);
  assert.equal(approvals[0].action_key, "add_estimate_line_items");
});

test("NO existing estimate — the create_estimate_draft path is preserved (and an 'add … to the estimate' message gets NO backstop)", async () => {
  const db = makeDb();
  const created = await run(db, "Can you prepare an estimate for the bathroom remodel?", [handoffToEstimate, proposeDraft, "The team will review."]);
  assert.equal(created.result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("agent_approval_requests")[0].action_key, "create_estimate_draft");
  assert.deepEqual((await steps(db, created.result.executionId)).map((s) => s.action_key), ["get_estimate_context", "create_estimate_draft"]);

  // Same words as the production case, but nothing exists: no deterministic handoff, the normal Lead Qualification decision runs.
  const db2 = makeDb();
  const plain = await run(db2, "Add a vanity installation line item to the existing bathroom remodel estimate", [respond("Happy to help — what size is the bathroom?")]);
  assert.equal(plain.result.agentKey, "lead_qualification");
  assert.equal(plain.modelProvider.requests.length, 1);
  assert.match(plain.modelProvider.requests[0].system, /EXISTING ESTIMATE RULE/);
});

test("AMBIGUOUS end to end — two active estimates: the turn is handed to the Estimate Assistant, NO estimate id is bound, NO proposal is made, and it is told to ask which one", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 }), estimateRow(EST_L2, { lead_id: LEAD_1, number: "EST-000009", title: "Kitchen" })] });
  const { result, modelProvider } = await run(db, "Please add a vanity installation line item to the estimate", [proposeVanity, "Which estimate do you mean — the bathroom or the kitchen one?"]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0, "no proposal on an ambiguous target");
  assert.deepEqual((await steps(db, result.executionId)).map((s) => s.action_key), ["get_estimate_context"]);
  const finalPrompt = modelProvider.requests[modelProvider.requests.length - 1].messages[0].content;
  assert.match(finalPrompt, /More than one active estimate matches/);
  const row = (await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle()).data;
  assert.equal(row.input_summary.context.existingEstimate, "ambiguous");
  assert.equal(row.input_summary.estimate.ambiguous, true);
});

test("NO MODEL-SELECTED IDS — an estimateId/orgId smuggled into a Lead Qualification handoff or an Estimate Assistant proposal is rejected by the strict schemas; nothing is proposed", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  // Lead Qualification handoff with extra keys (model-chosen estimate/org) -> strict schema fails -> safe fallback, no handoff.
  const smuggledHandoff = JSON.stringify({ type: "handoff", toAgent: "estimate_assistant", reason: "r", summary: "s", estimateId: EST_X, orgId: ORG_B });
  const a = await run(db, "Anything else you need from me on the bathroom project?", [smuggledHandoff]);
  assert.equal(a.result.agentKey, "lead_qualification");
  assert.equal(a.result.handoff, undefined);

  // Estimate Assistant proposal naming a different estimate/org -> strict schema fails -> generic fallback, no approval.
  const smuggledAdd = JSON.stringify({ type: "propose_add_line_items", estimateId: EST_X, orgId: ORG_B, items: [{ name: "Vanity installation" }] });
  const b = await run(db, "Add a vanity installation line item to the existing estimate", [smuggledAdd, smuggledAdd]);
  assert.equal(b.result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.ok(!JSON.stringify(db.__dumpTable("agent_execution_steps")).includes(EST_X));
});

test("CROSS-ORG end to end — another organization's estimate on the same ids is never surfaced, bound, or proposed against", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_X, { org_id: ORG_B, lead_id: LEAD_1, client_id: CONTACT_1 })] });
  const { result } = await run(db, "Add a vanity installation line item to the existing bathroom remodel estimate", [respond("Happy to help — what size is the bathroom?")]);
  assert.equal(result.agentKey, "lead_qualification", "no estimate in THIS org => no existing-estimate handoff");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
});

test("LOOP SAFETY — the existing-estimate handoff is terminal (the Estimate Assistant has no handoff variant) and only ONE execution row exists", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const bounce = JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "r", summary: "s" });
  const { result } = await run(db, "Add a vanity installation line item to the estimate", [bounce, bounce]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("agent_executions").length, 1);
});

// ── The "Project unresolved" finding ─────────────────────────────────────

test("PROJECT — 'Bathroom Remodel' on the lead is leads.custom_fields.service FREE TEXT, not a projects row: project stays unresolved and no link is fabricated", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const c = await ctxFor(db);
  assert.equal(c.project, undefined, "no projects.id relationship exists, so no project is invented");
  assert.equal(c.lead.projectType, "Bathroom Remodel");
  assert.equal(c.existingEstimate.projectId, null, "the estimate has no project link either; none is fabricated");
  const lines = S.buildContextLines(c).join("\n");
  assert.match(lines, /Project type: Bathroom Remodel/);
  assert.ok(!/^Project: /m.test(lines));
});

// ── Backstop detector ────────────────────────────────────────────────────

test("detectExistingEstimateChangeIntent — needs BOTH an estimate noun and a change verb in the current message", () => {
  const yes = [
    "Add a vanity installation line item to the existing bathroom remodel estimate",
    "can you update the estimate with quartz countertops",
    "Please remove the backsplash from my quote",
    "I want to change the proposal",
    "swap the tile on the estimate for porcelain",
  ];
  const no = [
    "What's the status of my estimate?",
    "My budget is $25,000",
    "When can someone come out to look at it?",
    "Thanks!",
    "I'd like to add a deck",
    "",
  ];
  for (const t of yes) assert.equal(S.detectExistingEstimateChangeIntent(t), true, t);
  for (const t of no) assert.equal(S.detectExistingEstimateChangeIntent(t), false, t);
  assert.equal(S.detectExistingEstimateChangeIntent(undefined), false);
  assert.equal(S.detectExistingEstimateChangeIntent("add to the estimate " + "x".repeat(2100)), false, "oversized text is never auto-routed");
});

test("the lookup module keeps get_estimate_context semantics: explicit id wins, then project > lead > contact; archived/cancelled are inactive", async () => {
  assert.deepEqual([...S.INACTIVE_ESTIMATE_STATUSES].sort(), ["archived", "cancelled"]);
  const db = makeDb({ estimates: [estimateRow(EST_P, { project_id: PROJECT_1 }), estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const byId = await S.lookupCurrentEstimate(db, ORG_A, { estimateId: EST_L, projectId: PROJECT_1 }, "id, status, created_at");
  assert.equal(byId.row.id, EST_L);
  assert.equal(byId.matchedBy, "estimate_id");
  const byScope = await S.lookupCurrentEstimate(db, ORG_A, { projectId: PROJECT_1, leadId: LEAD_1 }, "id, status, created_at");
  assert.equal(byScope.row.id, EST_P);
  const wrongOrg = await S.lookupCurrentEstimate(db, ORG_B, { estimateId: EST_L }, "id, status, created_at");
  assert.equal(wrongOrg.kind, "none");
});

// ── Widened backstop: read-only references to the customer's OWN existing estimate ──────────────────────

const REFERENCE_PHRASES = [
  "What's on my estimate?",
  "What's the total on my quote?",
  "Is my proposal ready?",
  "Can you show me the estimate?",
];

for (const phrase of REFERENCE_PHRASES) {
  test(`REFERENCE "${phrase}" — with ONE resolved estimate, hands off to the Estimate Assistant BEFORE any Lead Qualification call (read-only: nothing proposed, nothing written)`, async () => {
    const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })], estimate_items: [item("i1", EST_L, "Demo")] });
    const { result, modelProvider } = await run(db, phrase, [respond("Here is what the estimate lists: Demo (pricing still to be confirmed).")]);

    assert.equal(result.agentKey, "estimate_assistant");
    assert.equal(result.handoff.fromAgent, "lead_qualification");
    assert.equal(result.handoff.toAgent, "estimate_assistant");
    assert.equal(modelProvider.requests.length, 1, "no Lead Qualification decision call: the only model call is the Estimate Assistant's");
    assert.match(modelProvider.requests[0].system, /Estimate Assistant/);

    const st = await steps(db, result.executionId);
    assert.deepEqual(st.map((s) => s.action_key), ["get_estimate_context"], "only the audited read; no mutation step");
    assert.equal(st[0].input_snapshot.estimateId, EST_L, "the audited read was given the server-resolved estimate id");
    assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
    assert.equal(db.__dumpTable("estimates").length, 1);
    assert.equal(db.__dumpTable("estimate_items").length, 1);
    const row = (await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle()).data;
    assert.equal(row.input_summary.handoff.reason, "The customer is asking about an estimate that already exists for them.");
  });
}

test("GENERIC — 'Do you provide estimates?' does NOT force a handoff even with an existing estimate: the normal Lead Qualification decision runs", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const { result, modelProvider } = await run(db, "Do you provide estimates?", [respond("Yes — we can look at your project and put one together.")]);
  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.handoff, undefined);
  assert.equal(modelProvider.requests.length, 1);
  assert.match(modelProvider.requests[0].system, /EXISTING ESTIMATE RULE/, "the model is still told about the existing estimate");
});

test("AMBIGUITY unchanged — a read-only reference is NOT forced when several active estimates exist (the model decides); a CHANGE request still hands off and asks which", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 }), estimateRow(EST_L2, { lead_id: LEAD_1, number: "EST-000009", title: "Kitchen" })] });
  const ref = await run(db, "What's on my estimate?", [respond("Which one do you mean?")]);
  assert.equal(ref.result.agentKey, "lead_qualification", "not forced when ambiguous");
  assert.equal(ref.modelProvider.requests.length, 1);

  const change = await run(db, "Please add a vanity installation line item to the estimate", [proposeVanity, "Which estimate do you mean?"]);
  assert.equal(change.result.agentKey, "estimate_assistant", "existing behavior: a change request still hands off");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
});

test("no existing estimate => the widened backstop never applies (read-only phrases go through the normal model decision)", async () => {
  for (const phrase of REFERENCE_PHRASES) {
    const db = makeDb();
    const { result, modelProvider } = await run(db, phrase, [respond("I don't see an estimate on file yet — would you like us to prepare one?")]);
    assert.equal(result.agentKey, "lead_qualification", phrase);
    assert.equal(modelProvider.requests.length, 1, phrase);
  }
});

test("the reference handoff cannot be steered by the model: a smuggled estimateId/orgId in the Estimate Assistant decision is rejected, and the trusted id is still the only one used", async () => {
  const db = makeDb({ estimates: [estimateRow(EST_L, { lead_id: LEAD_1 })] });
  const smuggled = JSON.stringify({ type: "propose_add_line_items", estimateId: EST_X, orgId: ORG_B, items: [{ name: "Vanity installation" }] });
  const { result } = await run(db, "What's on my estimate?", [smuggled, smuggled]);
  assert.equal(result.agentKey, "estimate_assistant");
  assert.equal(db.__dumpTable("agent_approval_requests").length, 0);
  assert.ok(!JSON.stringify(db.__dumpTable("agent_execution_steps")).includes(EST_X));
});

test("detectExistingEstimateReference — definite references match; generic talk about estimating does not", () => {
  const yes = [...REFERENCE_PHRASES, "Did you finish the quote?", "I looked at your estimate", "Any update on estimate EST-000008?", "Is this proposal still valid?", "what's in the existing estimate"];
  const no = ["Do you provide estimates?", "Do you offer free estimates?", "Can I get a quote?", "How much does an estimate cost?", "I need an estimate for my kitchen", "Do you do estimating?", "What's your estimating process?", "Thanks!", ""];
  for (const t of yes) assert.equal(S.detectExistingEstimateReference(t), true, t);
  for (const t of no) assert.equal(S.detectExistingEstimateReference(t), false, t);
  assert.equal(S.detectExistingEstimateReference("my estimate " + "x".repeat(2100)), false);
  assert.equal(S.classifyExistingEstimateIntent("add a vanity to my estimate"), "change");
  assert.equal(S.classifyExistingEstimateIntent("what's on my estimate"), "reference");
  assert.equal(S.classifyExistingEstimateIntent("do you provide estimates"), null);
});
