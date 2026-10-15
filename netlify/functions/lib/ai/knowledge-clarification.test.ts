// netlify/functions/lib/ai/knowledge-clarification.test.ts
//
// Run:  node --test netlify/functions/lib/ai/knowledge-clarification.test.ts
//
// Business Knowledge + Owner Clarification phase. Exercises the REAL
// orchestrateAI() (real router, context-builder, agents, executor) and the
// REAL clarification/knowledge modules against the in-memory fake Supabase
// client and a scripted fake ModelProvider. No live Anthropic call, no real
// Supabase, no real Twilio: the only fetch allowed is a recording stub for
// api.twilio.com — anything else throws (deny-by-default, same rule as
// orchestrator.test.ts / scripts/test-network-guard.mjs).
//
// Numbered "TEST n" comments map to the acceptance list for this phase.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "knowledge-clarification-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// ── Deny-by-default network: only a recording Twilio stub is allowed ────
const twilio = { calls: [] as Array<{ url: string; body: string }>, mode: "ok" as "ok" | "fail" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (!String(url).startsWith("https://api.twilio.com/")) throw new Error("real network access is forbidden in this test file: " + String(url));
  twilio.calls.push({ url: String(url), body: String(init?.body ?? "") });
  if (twilio.mode === "fail") return { ok: false, status: 500, json: async () => ({ code: 1, message: "boom" }) } as any;
  return { ok: true, status: 201, json: async () => ({ sid: `SM${twilio.calls.length}` }) } as any;
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  stdin: {
    contents: [
      'export { orchestrateAI } from "./orchestrator.ts";',
      'export { dispatchLeadQualification } from "./lead-qualification-dispatch.ts";',
      'export { approveRequest } from "../../../../src/lib/agentic/approvals.ts";',
      'export * from "./knowledge-clarification.ts";',
      'export * from "./knowledge-requests.ts";',
      'export * from "./business-knowledge-store.ts";',
      'export { buildAIContext } from "./context-builder.ts";',
      'export { buildBusinessKnowledgeSection } from "./prompting.ts";',
      'export * from "../../../../src/lib/agentic/business-knowledge-catalog.ts";',
    ].join("\n"),
    resolveDir: here,
    loader: "ts",
  },
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js"],
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
const CONTACT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CONTACT_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LEAD_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const OWNER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const TZ = "America/New_York";

const TWILIO_SETTINGS = { twilio: { accountSid: "ACtest", authToken: "tok", phoneNumber: "+15559990000" } };

function makeDb(overrides: Record<string, any[]> = {}) {
  const db = createFakeSupabaseClient(
    {
      organizations: [
        { id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {}, integration_settings: TWILIO_SETTINGS },
        { id: ORG_B, name: "Beta Builders", timezone: TZ, ai_center_settings: {}, integration_settings: TWILIO_SETTINGS },
      ],
      contacts: [
        { id: CONTACT_1, org_id: ORG_A, full_name: "John Test", email: null, phone: "+15550001111" },
        { id: CONTACT_2, org_id: ORG_A, full_name: "Maria Second", email: null, phone: "+15550002222" },
        { id: CONTACT_B, org_id: ORG_B, full_name: "Bea Other", email: null, phone: "+15550003333" },
      ],
      leads: [
        { id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "John", estimated_value: null, custom_fields: {} },
        { id: LEAD_2, org_id: ORG_A, status: "qualified", contact_id: CONTACT_2, source: "sms", score: null, name: "Maria", estimated_value: null, custom_fields: {} },
      ],
      marketing_contact_preferences: [
        { org_id: ORG_A, contact_id: CONTACT_1, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false },
        { org_id: ORG_A, contact_id: CONTACT_2, sms_status: "eligible", email_unsubscribed: false, email_suppressed: false },
      ],
      appointments: [],
      agent_executions: [],
      agent_execution_steps: [],
      agent_approval_requests: [],
      agent_action_idempotency: [],
      agent_usage_events: [],
      conversation_states: [],
      sms_meta_messages: [],
      notifications: [],
      profiles: [],
      business_knowledge_entries: [],
      ai_clarification_requests: [],
      ...overrides,
    },
    {},
    { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]], business_knowledge_entries: [["org_id", "key"]] } },
  );
  return db;
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

function smsEvent(text: string, metadata?: Record<string, unknown>) {
  return { eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text }, ...(metadata ? { metadata } : {}) };
}

const PERMIT_ENTRY = (extra: Record<string, unknown> = {}) => ({
  id: "k-permit", org_id: ORG_A, key: "permit_handling", category: "permit_handling", question: "Do you handle permits?",
  answer: "We handle permits and inspections.", source: "owner_configured", status: "active", metadata: {}, created_by: OWNER, updated_at: new Date().toISOString(), ...extra,
});

const clarifyPermit = JSON.stringify({ type: "clarify", category: "permit_handling", question: "Does the company handle permits for kitchen remodels?" });
const respond = (response: string) => JSON.stringify({ type: "respond", response });

async function clarifications(db: any, orgId = ORG_A) {
  const { data } = await db.from("ai_clarification_requests").select("*").eq("org_id", orgId);
  return data as any[];
}
async function knowledge(db: any, orgId = ORG_A) {
  const { data } = await db.from("business_knowledge_entries").select("*").eq("org_id", orgId);
  return data as any[];
}
async function askUnknownPermit(db: any, contactId = CONTACT_1, leadId = LEAD_1) {
  const modelProvider = scriptedProvider([clarifyPermit]);
  const result = await S.orchestrateAI({
    supabase: db,
    event: smsEvent("Do you handle permits?", { messageRowId: "msg-row-1" }),
    trustedContext: trustedContext({ contactId, leadId }),
    modelProvider,
  });
  return { result, modelProvider };
}

// ── TEST 1 — KNOWN PERMIT ANSWER ────────────────────────────────────────

test("TEST 1 — KNOWN PERMIT ANSWER: the active Business Knowledge entry reaches Lead Qualification's real prompt as authoritative; the model answers from it; no clarification request exists", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  const modelProvider = scriptedProvider([respond("Yes — we handle permits and inspections.")]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Do you handle permits?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "Yes — we handle permits and inspections.");
  const system = modelProvider.requests[0].system;
  assert.match(system, /Trusted Business Knowledge \(facts the business owner has configured/);
  assert.match(system, /- Permit handling: We handle permits and inspections\./);
  assert.match(system, /AUTHORITATIVE for facts about THIS business/);
  assert.equal((await clarifications(db)).length, 0);
});

test("TEST 1b — a model that wrongly asks the owner something Business Knowledge already answers is overridden: server re-checks, answers from the entry, creates NO request", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  // The response-only final call returns natural language (never JSON), exactly like the tool path.
  const modelProvider = scriptedProvider([clarifyPermit, "We handle permits and inspections."]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Do you handle permits?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "We handle permits and inspections.");
  assert.equal(modelProvider.requests.length, 2, "decision call + response-only call grounded in the entry");
  assert.match(modelProvider.requests[1].messages[0].content, /Trusted Business Knowledge DOES answer the customer's question: "We handle permits and inspections\."/);
  assert.equal((await clarifications(db)).length, 0);
  const { data: exec } = await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle();
  assert.equal(exec.input_summary.clarification.outcome, "answered_from_knowledge");
});

// ── TEST 2 — UNKNOWN PERMIT ANSWER ──────────────────────────────────────

test("TEST 2 — UNKNOWN PERMIT ANSWER: a clarification request is created with full traceability and the customer gets ONLY the deterministic holding reply, never a fabricated answer", async () => {
  const db = makeDb();
  const { result, modelProvider } = await askUnknownPermit(db);

  assert.equal(result.status, "completed");
  assert.equal(result.responseText, S.CLARIFICATION_HOLDING_REPLY);
  assert.doesNotMatch(result.responseText, /\b(yes|we handle|we do)\b/i);
  assert.equal(modelProvider.requests.length, 1, "no second model call — the holding reply is deterministic, not model-written");

  const rows = await clarifications(db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.org_id, ORG_A);
  assert.equal(row.contact_id, CONTACT_1);
  assert.equal(row.lead_id, LEAD_1);
  assert.equal(row.channel, "sms");
  assert.equal(row.knowledge_key, "permit_handling");
  assert.equal(row.execution_id, result.executionId);
  assert.equal(row.inbound_message_id, "msg-row-1");
  assert.equal(row.suggested_options.length, 4, "permit handling has the four predefined choices");

  const { data: exec } = await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle();
  assert.equal(exec.status, "succeeded");
  assert.equal(exec.input_summary.clarification.outcome, "created");
  assert.equal(exec.input_summary.clarification.clarificationId, row.id);
  // Nothing was sent to the customer and no action approval was created.
  assert.equal(twilio.calls.length, 0);
  assert.equal((await db.from("agent_approval_requests").select("id")).data.length, 0);
});

test("TEST 2b — Business Knowledge unavailable (read failed): NO clarification is created (we can't know the owner hasn't answered) and the reply promises nothing automatic", async () => {
  const db = makeDb();
  const failing = {
    ...db,
    from: (t: string) => {
      const b = db.from(t);
      if (t === "business_knowledge_entries") {
        // Awaited select chain resolves to an error.
        const chain: any = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, then: (res: any) => res({ data: null, error: { message: "db down" } }) };
        return chain;
      }
      return b;
    },
  };
  const modelProvider = scriptedProvider([clarifyPermit]);
  const result = await S.orchestrateAI({ supabase: failing, event: smsEvent("Do you handle permits?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, S.CLARIFICATION_UNSUPPORTED_REPLY);
  assert.equal((await clarifications(db)).length, 0);
  assert.match(modelProvider.requests[0].system, /Trusted Business Knowledge: currently unavailable/);
});

// ── TEST 3 / 4 — OWNER RESOLUTION ───────────────────────────────────────

test("TEST 3 — OWNER RESOLVES WITHOUT SAVE: the answer is sent to the ORIGINAL customer through the trusted send path, the outbound message is persisted, the request is resolved, and NO Business Knowledge is created", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);

  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We assist with permits, but the homeowner files them.", optionId: "assist", saveToKnowledge: false });

  assert.equal(res.status, "resolved");
  assert.equal(res.knowledge, "not_requested");
  assert.equal(twilio.calls.length, 1);
  assert.match(decodeURIComponent(twilio.calls[0].body), /To=\+15550001111/, "sent to the original contact's phone, resolved server-side");
  assert.match(decodeURIComponent(twilio.calls[0].body).replace(/\+/g, " "), /We assist with permits, but the homeowner files them\./);

  const [after] = await clarifications(db);
  assert.equal(after.status, "resolved");
  assert.equal(after.answer, "We assist with permits, but the homeowner files them.");
  assert.equal(after.resolved_by, OWNER);
  assert.ok(after.resolved_at && after.provider_message_id);
  assert.equal((await knowledge(db)).length, 0);

  const { data: out } = await db.from("sms_meta_messages").select("*").eq("org_id", ORG_A).eq("direction", "out");
  assert.equal(out.length, 1, "outbound message persisted via the existing send_sms handler");
  assert.equal(out[0].contact_id, CONTACT_1);
});

test("TEST 4 — OWNER RESOLVES AND SAVES: answer sent, Business Knowledge upserted under the canonical key with owner_clarification provenance, request resolved", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);

  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(res.status, "resolved");
  assert.equal(res.knowledge, "saved");
  assert.equal(twilio.calls.length, 1);

  const entries = await knowledge(db);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "permit_handling");
  assert.equal(entries[0].category, "permit_handling");
  assert.equal(entries[0].answer, "We handle permits and inspections.");
  assert.equal(entries[0].source, "owner_clarification");
  assert.equal(entries[0].status, "active");
  assert.equal(entries[0].org_id, ORG_A);
  assert.deepEqual(entries[0].metadata, { optionId: "handle_all" });
  assert.equal(entries[0].created_by, OWNER);

  const [after] = await clarifications(db);
  assert.equal(after.status, "resolved");
  assert.ok(after.knowledge_saved_at);
});

// ── TEST 5 — FUTURE CUSTOMER REUSES SAVED KNOWLEDGE ─────────────────────

test("TEST 5 — FUTURE CUSTOMER: after the owner saves the answer, a DIFFERENT customer's differently-worded permit question is answered immediately from Business Knowledge — no second clarification", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });

  const modelProvider = scriptedProvider([respond("Yes, we take care of permits and inspections for you.")]);
  const result = await S.orchestrateAI({
    supabase: db,
    event: smsEvent("Do you take care of permits?"),
    trustedContext: trustedContext({ contactId: CONTACT_2, leadId: LEAD_2 }),
    modelProvider,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "Yes, we take care of permits and inspections for you.");
  assert.match(modelProvider.requests[0].system, /- Permit handling: We handle permits and inspections\./);
  assert.equal((await clarifications(db)).length, 1, "still only the original, already-resolved request");
});

// ── TEST 6 — DUPLICATE CLARIFICATION ────────────────────────────────────

test("TEST 6 — DUPLICATE CLARIFICATION: the same customer asking the same unresolved question twice (even phrased differently) yields ONE pending request and the second reply is the 'still confirming' holding reply", async () => {
  const db = makeDb();
  const first = await askUnknownPermit(db);
  assert.equal(first.result.responseText, S.CLARIFICATION_HOLDING_REPLY);

  const modelProvider = scriptedProvider([JSON.stringify({ type: "clarify", category: "permit_handling", question: "Will you pull the permit for my kitchen job?" })]);
  const second = await S.orchestrateAI({ supabase: db, event: smsEvent("Will you pull the permit?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(second.responseText, S.CLARIFICATION_STILL_PENDING_REPLY);
  const rows = await clarifications(db);
  assert.equal(rows.length, 1, "no duplicate owner card");
  const { data: exec } = await db.from("agent_executions").select("*").eq("id", second.executionId).maybeSingle();
  assert.equal(exec.input_summary.clarification.outcome, "coalesced");
  assert.equal(exec.input_summary.clarification.clarificationId, rows[0].id);
});

test("TEST 6b — coalescing is per customer: a DIFFERENT customer asking the same unknown question gets their own request (their answer must reach them)", async () => {
  const db = makeDb();
  await askUnknownPermit(db, CONTACT_1, LEAD_1);
  await askUnknownPermit(db, CONTACT_2, LEAD_2);
  assert.equal((await clarifications(db)).length, 2);
});

test("TEST 6c — once resolved/dismissed, the same question can be raised again (history never blocks a new request)", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  const dismissed = await S.dismissClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(twilio.calls.length, 0, "dismiss never sends anything");
  await askUnknownPermit(db);
  assert.equal((await clarifications(db)).length, 2);
});

// ── TEST 7 — CUSTOM BUSINESS QUESTION ───────────────────────────────────

test("TEST 7 — CUSTOM QUESTION: no predefined options, deterministic custom key, optional save creates ONE custom entry that a repeat answer updates instead of duplicating", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  const modelProvider = scriptedProvider([JSON.stringify({ type: "clarify", category: "custom", question: "Do you work on historic homes?" })]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Do you work on historic homes?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.responseText, S.CLARIFICATION_HOLDING_REPLY);

  const [row] = await clarifications(db);
  assert.equal(row.category, "custom");
  assert.match(row.knowledge_key, /^custom_/);
  assert.equal(row.knowledge_key, S.customKeyForQuestion("Do you work on historic homes?"));
  assert.deepEqual(row.suggested_options, [], "never invent misleading choices for an arbitrary question");

  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "Yes, we specialize in historic restorations.", saveToKnowledge: true });
  assert.equal(res.status, "resolved");
  let entries = await knowledge(db);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "custom");
  assert.equal(entries[0].question, "Do you work on historic homes?");
  assert.equal(entries[0].key, row.knowledge_key);

  // Saving the same custom question again updates, never duplicates.
  const again = await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, question: "do you work on historic homes", answer: "Yes — historic restorations are a specialty.", source: "owner_configured" });
  assert.equal(again.ok, true);
  entries = await knowledge(db);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].answer, "Yes — historic restorations are a specialty.");
});

test("TEST 7b — an unknown category or an unusably short custom question is never trusted: no request, no owner card, safe non-promising reply", async () => {
  const db = makeDb();
  // Unknown category: passes the schema, rejected by the server's catalog check.
  const unknownCategory = await S.orchestrateAI({
    supabase: db, event: smsEvent("hmm"), trustedContext: trustedContext(),
    modelProvider: scriptedProvider([JSON.stringify({ type: "clarify", category: "budget", question: "What is my budget for the kitchen?" })]),
  });
  assert.equal(unknownCategory.responseText, S.CLARIFICATION_UNSUPPORTED_REPLY);
  // Unusably short question: fails the strict decision schema -> the existing generic safe fallback.
  const shortQuestion = await S.orchestrateAI({
    supabase: db, event: smsEvent("hmm"), trustedContext: trustedContext(),
    modelProvider: scriptedProvider([JSON.stringify({ type: "clarify", category: "custom", question: "ok?" })]),
  });
  assert.match(shortQuestion.responseText, /gather a bit more information/);
  assert.equal((await clarifications(db)).length, 0);
});

// ── TEST 8 / 9 — NO CLARIFICATION FOR CRM FACTS OR SCHEDULING ───────────

test("TEST 8 — CRM PROJECT FACT: known budget/timeline reach the prompt as 'already known', the prompt forbids clarify for CRM facts, and a normal respond creates no request", async () => {
  const db = makeDb({
    leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "John", estimated_value: 30000, custom_fields: { timeline: "within 2 months" } }],
  });
  const modelProvider = scriptedProvider([respond("A $30,000 budget and a two-month timeline give us a good starting point.")]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("What was my budget again?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const system = modelProvider.requests[0].system;
  assert.match(system, /Budget: \$30,000 \(already known/);
  assert.match(system, /Do NOT use clarify for:[^]*facts already in the CRM context \(budget, timeline, project type, location, name\)/);
  assert.match(system, /greetings or small talk/);
  assert.equal((await clarifications(db)).length, 0);
});

const SLOT_1 = { start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: TZ };
const SLOT_2 = { start: "2027-03-17T21:00:00.000Z", end: "2027-03-17T22:00:00.000Z", timeZone: TZ };
async function seedOffer(db: any) {
  await db.from("conversation_states").insert({ org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", scheduling_offered_slots: [SLOT_1, SLOT_2], scheduling_offered_at: new Date().toISOString() });
}

test("TEST 9 — SCHEDULING MESSAGE: '1 PM works.' stays in the existing Scheduling flow and creates no clarification; Scheduling's schema has no clarify variant at all, so even a rogue decision cannot create one", async () => {
  const db = makeDb();
  await seedOffer(db);
  const ok = await S.orchestrateAI({
    supabase: db, event: smsEvent("1 PM works."), trustedContext: trustedContext(),
    modelProvider: scriptedProvider([JSON.stringify({ type: "select_offered_slot", selectedOptionNumber: 1 }), respond("Great — should I book that?")]),
  });
  assert.equal(ok.agentKey, "scheduling");
  assert.ok(!ok.handoff);

  const rogue = await S.orchestrateAI({
    supabase: db, event: smsEvent("1 PM works."), trustedContext: trustedContext(),
    modelProvider: scriptedProvider([clarifyPermit]),
  });
  assert.equal(rogue.agentKey, "scheduling");
  assert.equal((await clarifications(db)).length, 0, "a clarify decision from Scheduling fails its strict schema and is never acted on");
});

// ── TEST 10 / 11 — REVERSE HANDOFF + UNKNOWN / KNOWN FACT ───────────────

test("TEST 10 — REVERSE HANDOFF + UNKNOWN FACT: Scheduling -> Lead Qualification in the same execution, offer cleared, Lead Qualification sees NO permit knowledge, a clarification is created, and no permit answer is hallucinated", async () => {
  const db = makeDb();
  await seedOffer(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "permits question", summary: "Customer asked whether we handle permits." }),
    clarifyPermit,
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Also, do you handle permits?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.handoff.fromAgent, "scheduling");
  assert.equal(result.handoff.toAgent, "lead_qualification");
  assert.equal(result.responseText, S.CLARIFICATION_HOLDING_REPLY);
  assert.doesNotMatch(result.responseText, /\b(yes|we handle)\b/i);
  assert.match(modelProvider.requests[1].system, /Trusted Business Knowledge: none has been configured yet/);

  const { data: state } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.equal(state.scheduling_offered_slots, null, "scheduling offer cleared");
  const rows = await clarifications(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].execution_id, result.executionId, "same single execution");
  assert.equal((await db.from("agent_executions").select("id")).data.length, 1);
  assert.equal((await db.from("appointments").select("id")).data.length, 0);
});

test("TEST 11 — REVERSE HANDOFF + KNOWN FACT: Scheduling -> Lead Qualification, offer cleared, the grounded answer is available to the model immediately, and NO clarification is created", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  await seedOffer(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "permits question", summary: "Customer asked whether we handle permits." }),
    respond("Yes — we handle permits and inspections."),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Also, do you handle permits?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.responseText, "Yes — we handle permits and inspections.");
  assert.match(modelProvider.requests[1].system, /- Permit handling: We handle permits and inspections\./);
  // Scheduling saw it too (shared context, fetched once).
  assert.match(modelProvider.requests[0].system, /- Permit handling: We handle permits and inspections\./);
  const { data: state } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.equal(state.scheduling_offered_slots, null);
  assert.equal((await clarifications(db)).length, 0);
});

test("Reception receives the same trusted Business Knowledge block and the answer-priority rule (shared context, no per-agent fetch)", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()], leads: [] });
  const modelProvider = scriptedProvider([respond("We handle permits and inspections.")]);
  await S.orchestrateAI({
    supabase: db,
    event: smsEvent("Do you handle permits?"),
    trustedContext: { orgId: ORG_A, actor: { actorType: "workflow", actorId: "a", source: "t" }, contactId: CONTACT_1, autonomyLevel: 2 },
    modelProvider,
  });
  assert.match(modelProvider.requests[0].system, /Permit handling: We handle permits and inspections\./);
  assert.match(modelProvider.requests[0].system, /State a company-specific fact ONLY if it is written in Trusted Business Knowledge/);
});

// ── TEST 12 / 13 / 14 — SEND FAILURE, SAVE FAILURE, DUPLICATE SUBMIT ───

test("TEST 12 — OUTBOUND SEND FAILURE: NOT marked resolved; status send_failed with the answer kept; requested knowledge save still happens once; a retry then sends exactly once and resolves", async () => {
  twilio.calls.length = 0; twilio.mode = "fail";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);

  const failed = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(failed.status, "send_failed");
  assert.equal(failed.knowledge, "saved", "the owner's authored fact is saved even though this customer's send failed");
  let [cur] = await clarifications(db);
  assert.equal(cur.status, "send_failed");
  assert.equal(cur.resolved_at ?? null, null);
  assert.ok(cur.send_error);
  assert.equal(cur.answer, "We handle permits and inspections.");
  assert.equal((await db.from("sms_meta_messages").select("id").eq("direction", "out")).data.length, 0, "nothing persisted as sent");

  twilio.mode = "ok";
  const retry = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(retry.status, "resolved");
  assert.equal(retry.knowledge, "saved");
  assert.equal(twilio.calls.filter((c) => true).length, 2, "one failed attempt + one successful attempt");
  [cur] = await clarifications(db);
  assert.equal(cur.status, "resolved");
  assert.equal((await knowledge(db)).length, 1, "no duplicate knowledge entry from the retry");
});

test("TEST 12b — an opted-out customer fails closed at send time: send_failed, nothing sent (consent re-checked FRESH, not at card-creation time)", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  await db.from("marketing_contact_preferences").update({ sms_status: "opted_out" }).eq("org_id", ORG_A).eq("contact_id", CONTACT_1);
  const [row] = await clarifications(db);
  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits.", saveToKnowledge: false });
  assert.equal(res.status, "send_failed");
  assert.equal(twilio.calls.length, 0);
});

test("TEST 13 — KNOWLEDGE SAVE FAILURE: the send succeeded so the customer HAS the answer -> resolved, knowledge:'failed' reported and recorded; re-submitting retries ONLY the save, never the send", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);

  let breakSave = true;
  const flaky = {
    ...db,
    from: (t: string) => {
      const b = db.from(t);
      if (t === "business_knowledge_entries" && breakSave) {
        const failing = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) });
        b.insert = failing;
      }
      return b;
    },
  };

  const first = await S.resolveClarification({ supabase: flaky, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(first.status, "resolved");
  assert.equal(first.knowledge, "failed");
  let [cur] = await clarifications(db);
  assert.equal(cur.status, "resolved");
  assert.ok(cur.knowledge_save_error);
  assert.equal(cur.knowledge_saved_at ?? null, null);
  assert.equal((await knowledge(db)).length, 0);
  assert.equal(twilio.calls.length, 1);

  breakSave = false;
  const healed = await S.resolveClarification({ supabase: flaky, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(healed.status, "resolved");
  assert.equal(healed.alreadyResolved, true);
  assert.equal(healed.knowledge, "saved");
  assert.equal(twilio.calls.length, 1, "the retry did NOT send a second SMS");
  assert.equal((await knowledge(db)).length, 1);
  [cur] = await clarifications(db);
  assert.ok(cur.knowledge_saved_at);
});

test("TEST 14 — DUPLICATE OWNER SUBMIT: sequential double-click AND concurrent double-submit each produce exactly ONE SMS", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  const params = { supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", saveToKnowledge: false };

  const [a, b] = await Promise.all([S.resolveClarification(params), S.resolveClarification(params)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["in_progress", "resolved"], "exactly one caller wins the atomic claim");
  assert.equal(twilio.calls.length, 1);

  const third = await S.resolveClarification(params);
  assert.equal(third.status, "resolved");
  assert.equal(third.alreadyResolved, true);
  assert.equal(twilio.calls.length, 1, "a later duplicate never re-sends");
  assert.equal((await db.from("sms_meta_messages").select("id").eq("direction", "out")).data.length, 1);
});

test("an in-flight 'sending' claim is never double-processed, and a dismissed request cannot be answered", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  await db.from("ai_clarification_requests").update({ status: "sending" }).eq("id", row.id);
  const inflight = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "x answer", saveToKnowledge: false });
  assert.equal(inflight.status, "in_progress");
  await db.from("ai_clarification_requests").update({ status: "dismissed" }).eq("id", row.id);
  const dismissed = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "x answer", saveToKnowledge: false });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(twilio.calls.length, 0);
});

test("empty / oversized answers are rejected before anything is claimed or sent", async () => {
  twilio.calls.length = 0;
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  for (const answer of ["   ", "x".repeat(1001)]) {
    const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer, saveToKnowledge: true });
    assert.equal(res.status, "invalid");
  }
  assert.equal((await clarifications(db))[0].status, "pending");
  assert.equal(twilio.calls.length, 0);
});

// ── TEST 15 — TENANT ISOLATION ──────────────────────────────────────────

test("TEST 15 — TENANT ISOLATION: Org B cannot resolve/dismiss Org A's clarification, cannot read/modify/delete Org A's knowledge, and Org A's knowledge never enters Org B's AI context", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY(), PERMIT_ENTRY({ id: "k-custom", key: "custom_historic_homes", category: "custom", question: "Do you work on historic homes?", answer: "Yes." })] });
  await askUnknownPermit(db); // creates an org-A request for... (permit knowledge exists -> answered, not created)
  // Create an org-A clarification for a key with no knowledge, directly via the real path:
  const modelProvider = scriptedProvider([JSON.stringify({ type: "clarify", category: "financing", question: "Do you offer financing for kitchens?" })]);
  await S.orchestrateAI({ supabase: db, event: smsEvent("Do you offer financing?"), trustedContext: trustedContext(), modelProvider });
  const [row] = await clarifications(db);
  assert.ok(row);

  assert.equal((await S.resolveClarification({ supabase: db, orgId: ORG_B, userId: OWNER, clarificationId: row.id, answer: "Sure thing", saveToKnowledge: true })).status, "not_found");
  assert.equal((await S.dismissClarification({ supabase: db, orgId: ORG_B, userId: OWNER, clarificationId: row.id })).status, "not_found");
  assert.equal(twilio.calls.length, 0);
  assert.equal((await clarifications(db))[0].status, "pending");

  assert.equal((await S.setKnowledgeStatus(db, { orgId: ORG_B, key: "permit_handling", status: "inactive" })).ok, false);
  assert.equal((await S.deleteCustomKnowledgeEntry(db, { orgId: ORG_B, key: "custom_historic_homes" })).ok, false);
  assert.equal((await knowledge(db, ORG_A)).length, 2, "Org A's entries untouched");
  assert.equal((await knowledge(db, ORG_A)).find((e) => e.key === "permit_handling").status, "active");

  // Org B writing the SAME key creates its own row — never overwrites Org A's.
  const own = await S.upsertKnowledgeEntry(db, { orgId: ORG_B, userId: OWNER, key: "permit_handling", answer: "Homeowners handle permits.", source: "owner_configured" });
  assert.equal(own.ok, true);
  assert.equal((await knowledge(db, ORG_A)).find((e) => e.key === "permit_handling").answer, "We handle permits and inspections.");
  assert.equal((await knowledge(db, ORG_B)).length, 1);

  // Context isolation.
  const ctxB = await S.buildAIContext({ supabase: db, orgId: ORG_B, channel: "sms", contactId: CONTACT_B });
  assert.deepEqual(ctxB.businessKnowledge.entries.map((e: any) => e.answer), ["Homeowners handle permits."]);
  const ctxA = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1 });
  assert.ok(ctxA.businessKnowledge.entries.every((e: any) => e.answer !== "Homeowners handle permits."));
});

test("the clarification trusted org comes from trusted context, never the model: a decision carrying an orgId/contactId field fails the strict schema and creates nothing", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([JSON.stringify({ type: "clarify", category: "permit_handling", question: "Do you handle permits?", orgId: ORG_B, contactId: CONTACT_B })]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Do you handle permits?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  assert.equal((await clarifications(db, ORG_A)).length + (await clarifications(db, ORG_B)).length, 0);
});

// ── TEST 16-18 — REGRESSIONS WITH BUSINESS KNOWLEDGE PRESENT ────────────

test("TEST 16 — PR #20 REGRESSION: the reverse handoff itself is unchanged with Business Knowledge configured (and loop prevention still blocks a bounce back to Scheduling)", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  await seedOffer(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "off topic", summary: "Asked something else." }),
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "bounce", summary: "Back to scheduling." }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Also, what's your service area?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.handoff.fromAgent, "scheduling");
  assert.equal(result.status, "completed", "a second hop back to Scheduling is rejected with a safe fallback, not executed");
  assert.equal(modelProvider.requests.length, 2);
});

test("TEST 17 — PR #19 DATE REGRESSION: 'Thursday' still resolves to 2026-10-15 with Business Knowledge present", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Ready to schedule." }),
    JSON.stringify({ type: "get_availability", dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" } }),
    respond("Thursday has a few openings — which works?"),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Does Thursday work?"), trustedContext: trustedContext(), modelProvider, now: new Date("2026-10-11T16:00:00.000Z") });
  assert.equal(result.status, "completed");
  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(row.scheduling_offered_slots.length > 0);
  for (const slot of row.scheduling_offered_slots) {
    assert.ok(slot.start.startsWith("2026-10-15"));
    assert.ok(!slot.start.startsWith("2026-10-16"));
  }
});

test("TEST 18 — PR #19 DAYPART REGRESSION: 'Thursday afternoon' with real afternoon slots never reports afternoon unavailable, with Business Knowledge present", async () => {
  const db = makeDb({ business_knowledge_entries: [PERMIT_ENTRY()] });
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Ready to schedule." }),
    JSON.stringify({ type: "get_availability", dateIntent: { kind: "weekday", weekday: "thursday", occurrence: "next_occurrence" }, preferredDaypart: "afternoon" }),
    respond("Thursday afternoon has openings — which works?"),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Thursday afternoon works for me"), trustedContext: trustedContext(), modelProvider, now: new Date("2026-10-11T16:00:00.000Z") });
  assert.equal(result.status, "completed");
  const factualOutcome = modelProvider.requests[2].messages[0].content;
  assert.match(factualOutcome, /genuinely HAS real availability/);
  assert.doesNotMatch(factualOutcome, /NOT available/);
});

// ── Business Knowledge store / catalog / context / prompt units ─────────

test("catalog: stable canonical keys, option lists only where meaningful, deterministic custom keys, invalid categories rejected", () => {
  const permit = S.getCatalogCategory("permit_handling");
  assert.equal(permit.options.length, 4);
  assert.equal(S.getCatalogCategory("service_area").options.length, 0, "free-text categories have no invented choices");
  assert.equal(S.customKeyForQuestion("Do you work on historic homes?"), S.customKeyForQuestion("  do YOU work on historic homes "));
  assert.ok(S.customKeyForQuestion("Do you work on historic homes?").startsWith("custom_"));
  assert.ok(!S.isCatalogKey(S.customKeyForQuestion("permit_handling")));
  assert.equal(S.resolveKnowledgeTarget("permit_handling", "x")?.key, "permit_handling");
  assert.equal(S.resolveKnowledgeTarget("not_a_category", "A real question here?"), null);
  assert.equal(S.resolveKnowledgeTarget("custom", "short"), null);
});

test("store: catalog keys always take the canonical question/category (never caller-supplied), answers are validated, custom delete is custom-only", async () => {
  const db = makeDb();
  const saved = await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, key: "permit_handling", question: "attacker supplied question", answer: "  We handle permits.  ", source: "owner_configured" });
  assert.equal(saved.ok, true);
  assert.equal(saved.entry.question, "Do you handle permits?");
  assert.equal(saved.entry.answer, "We handle permits.");
  assert.equal((await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, key: "permit_handling", answer: "   ", source: "owner_configured" })).ok, false);
  assert.equal((await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, key: "bogus_key", question: "A long enough question", answer: "ok", source: "owner_configured" })).ok, false);
  assert.equal((await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, answer: "no question or key", source: "owner_configured" })).ok, false);
  assert.equal((await S.deleteCustomKnowledgeEntry(db, { orgId: ORG_A, key: "permit_handling" })).ok, false, "built-in entries are disabled, never deleted");

  const disabled = await S.setKnowledgeStatus(db, { orgId: ORG_A, key: "permit_handling", status: "inactive" });
  assert.equal(disabled.entry.status, "inactive");
  const ctx = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms" });
  assert.equal(ctx.businessKnowledge.status, "ok");
  assert.equal(ctx.businessKnowledge.entries.length, 0, "inactive entries never reach the AI");
});

test("prompt block: explicit wording for configured / none configured / unavailable, so silence is never read as permission", () => {
  const base = { organization: { id: ORG_A, name: "Acme" }, channel: "sms" };
  const configured = S.buildBusinessKnowledgeSection({ ...base, businessKnowledge: { status: "ok", entries: [{ key: "permit_handling", category: "permit_handling", question: "Do you handle permits?", answer: "We handle permits and inspections." }, { key: "custom_x", category: "custom", question: "Do you work on historic homes?", answer: "Yes." }] } });
  assert.match(configured, /- Permit handling: We handle permits and inspections\./);
  assert.match(configured, /- Do you work on historic homes\? — Yes\./);
  assert.match(S.buildBusinessKnowledgeSection({ ...base, businessKnowledge: { status: "ok", entries: [] } }), /none has been configured yet/);
  assert.match(S.buildBusinessKnowledgeSection({ ...base, businessKnowledge: { status: "unavailable", entries: [] } }), /currently unavailable/);
  assert.match(S.buildBusinessKnowledgeSection(base), /currently unavailable/);
});

// ── HTTP request-processing layer ───────────────────────────────────────

test("business-knowledge request layer: source is never taken from the body, unknown actions 400, org comes only from the verified actor", async () => {
  const db = makeDb();
  const up = await S.processBusinessKnowledgeRequest(db, { orgId: ORG_A, userId: OWNER }, { action: "upsert", key: "financing", answer: "We offer financing.", source: "system_seeded", orgId: ORG_B, org_id: ORG_B });
  assert.equal(up.statusCode, 200);
  assert.equal(up.body.entry.source, "owner_configured");
  assert.equal(up.body.entry.org_id, ORG_A);
  assert.equal((await knowledge(db, ORG_B)).length, 0);

  assert.equal((await S.processBusinessKnowledgeRequest(db, { orgId: ORG_A, userId: OWNER }, { action: "nope" })).statusCode, 400);
  assert.equal((await S.processBusinessKnowledgeRequest(db, { orgId: ORG_A, userId: OWNER }, { action: "set_status", key: "financing", status: "inactive" })).statusCode, 200);
  assert.equal((await S.processBusinessKnowledgeRequest(db, { orgId: ORG_A, userId: OWNER }, { action: "set_status", key: "financing", status: "weird" })).statusCode, 400);
  assert.equal((await S.processBusinessKnowledgeRequest(db, { orgId: ORG_A, userId: OWNER }, { action: "delete", key: "financing" })).statusCode, 400);
  assert.equal((await S.processBusinessKnowledgeRequest(db, { orgId: ORG_B, userId: OWNER }, { action: "set_status", key: "financing", status: "active" })).statusCode, 404);
});

test("clarification request layer: answer/dismiss routing and status-code mapping (send_failed is a 200 success:false, matching agent-approve-action)", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = makeDb();
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  const actor = { orgId: ORG_A, userId: OWNER };

  assert.equal((await S.processClarificationRequest(db, actor, {})).statusCode, 400);
  assert.equal((await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "bogus" })).statusCode, 400);
  assert.equal((await S.processClarificationRequest(db, { orgId: ORG_B, userId: OWNER }, { clarificationId: row.id, action: "answer", answer: "x answer" })).statusCode, 404);
  assert.equal((await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "answer", answer: "" })).statusCode, 400);

  twilio.mode = "fail";
  const failed = await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "answer", answer: "We handle permits.", saveToKnowledge: true });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.body.success, false);
  assert.equal(failed.body.status, "send_failed");

  twilio.mode = "ok";
  const ok = await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "answer", answer: "We handle permits.", saveToKnowledge: true });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.success, true);
  const dup = await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "answer", answer: "We handle permits.", saveToKnowledge: true });
  assert.equal(dup.body.status, "already_resolved");
  assert.equal((await S.processClarificationRequest(db, actor, { clarificationId: row.id, action: "dismiss" })).statusCode, 409);
});

// ── Static wiring guarantees ────────────────────────────────────────────

test("the model can never write Business Knowledge: no agent, tool, or the orchestrator imports the write store, and neither table is writable by `authenticated` under RLS", () => {
  const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");
  for (const f of [
    "netlify/functions/lib/ai/orchestrator.ts",
    "netlify/functions/lib/ai/agents/lead-qualification.ts",
    "netlify/functions/lib/ai/agents/reception.ts",
    "netlify/functions/lib/ai/agents/scheduling.ts",
    "netlify/functions/lib/ai/tools/registry.ts",
    "netlify/functions/lib/ai/context-builder.ts",
  ]) {
    assert.doesNotMatch(read(f), /business-knowledge-store/, `${f} must not import the knowledge write store`);
  }
  const migration = read("supabase/migrations/20261013_business_knowledge_and_clarifications.sql");
  assert.equal((migration.match(/enable row level security/g) ?? []).length, 2);
  assert.equal((migration.match(/create policy/g) ?? []).length, 2);
  assert.equal((migration.match(/for select/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /for (insert|update|delete|all)/i);
  assert.match(migration, /unique \(org_id, key\)/);
  assert.match(migration, /uq_ai_clarification_open_per_contact_key/);
  assert.match(migration, /ai_clarification_requests_validate_same_org/);
});

// ── created_by / updated_by semantics (validation pass) ─────────────────

test("created_by is the ORIGINAL author and immutable; updated_by tracks the latest human editor — across Settings edits, re-saves, and a later clarification save", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const OWNER_2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
  const db = makeDb();

  const first = await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER, key: "permit_handling", answer: "We handle permits.", source: "owner_configured" });
  assert.equal(first.entry.created_by, OWNER);
  assert.equal(first.entry.updated_by, OWNER);

  const edited = await S.upsertKnowledgeEntry(db, { orgId: ORG_A, userId: OWNER_2, key: "permit_handling", answer: "We assist with permits.", source: "owner_configured" });
  assert.equal(edited.entry.created_by, OWNER, "an edit by someone else never changes the original author");
  assert.equal(edited.entry.updated_by, OWNER_2);
  assert.equal((await knowledge(db)).length, 1, "still one row");

  // Disabling/enabling is an edit too, but must not touch authorship.
  const disabled = await S.setKnowledgeStatus(db, { orgId: ORG_A, key: "permit_handling", status: "inactive" });
  assert.equal(disabled.entry.created_by, OWNER);

  // A later owner clarification re-saves the same canonical key.
  await askUnknownPermit(db);
  const [row] = await clarifications(db);
  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER_2, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  const [entry] = await knowledge(db);
  assert.equal(entry.answer, "We handle permits and inspections.");
  assert.equal(entry.source, "owner_clarification");
  assert.equal(entry.status, "active", "an explicit owner save re-activates the entry");
  assert.equal(entry.created_by, OWNER, "created_by still the first author");
  assert.equal(entry.updated_by, OWNER_2);
});

// ═══════════════════════════════════════════════════════════════════════
// VALIDATION PASS — scripted end-to-end through the REAL dispatcher
// (lead-qualification-dispatch.ts): the same entry point a live inbound SMS
// reaches. Covers scenarios A-D and the holding-reply / stale-approval fix.
// ═══════════════════════════════════════════════════════════════════════

async function e2eDb(autonomy: 1 | 2, extra: Record<string, any[]> = {}) {
  const settings = { defaultAutonomyLevel: autonomy, agents: { lead_qualification: { enabled: true } } };
  const base = makeDb(extra);
  await base.from("organizations").update({ ai_center_settings: settings }).eq("id", ORG_A);
  // The fake client applies no DB column defaults (real Postgres does).
  return {
    ...base,
    from: (t: string) => {
      const b = base.from(t);
      if (t === "agent_approval_requests") {
        const ins = b.insert.bind(b);
        b.insert = (row: any) => ins({ status: "pending", requested_at: new Date().toISOString(), ...row });
      }
      return b;
    },
  };
}

let msgCounter = 0;
async function inbound(db: any, text: string, provider: any, contactId = CONTACT_1, leadId = LEAD_1) {
  msgCounter += 1;
  return S.dispatchLeadQualification({
    supabase: db, orgId: ORG_A, source: "inbound_lead_message", leadId, contactId,
    inboundEvent: { channel: "sms", messageRowId: `row-${msgCounter}`, text, externalMessageId: `ext-${msgCounter}`, candidate: { channel: "sms", direction: "in", authoredByBusiness: false, syncOrigin: "live" } },
    modelProvider: provider,
  });
}
const approvals = async (db: any) => (await db.from("agent_approval_requests").select("*")).data as any[];

test("SCENARIO A — unknown permit question via the real dispatcher (REVIEW mode, autonomy 2): one clarification with permit options linked to execution/contact/channel; the ONLY customer-bound approval is the deterministic holding reply; no fabricated answer anywhere", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  const r = await inbound(db, "Do you handle permits for kitchen remodels?", scriptedProvider([clarifyPermit]));

  assert.equal(r.status, "awaiting_approval");
  const rows = await clarifications(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].knowledge_key, "permit_handling");
  assert.equal(rows[0].contact_id, CONTACT_1);
  assert.equal(rows[0].channel, "sms");
  assert.equal(rows[0].execution_id, r.executionId);
  assert.match(rows[0].inbound_message_id, /^row-/, "linked to the persisted inbound message");
  assert.deepEqual(rows[0].suggested_options.map((o: any) => o.id), ["handle_all", "assist", "case_by_case", "homeowner"]);

  const apps = await approvals(db);
  assert.equal(apps.length, 1, "review mode: exactly one send_sms approval card next to the clarification card");
  assert.equal(apps[0].action_key, "send_sms");
  assert.equal(apps[0].status, "pending");
  assert.equal(apps[0].proposed_input.body, S.CLARIFICATION_HOLDING_REPLY);
  assert.doesNotMatch(apps[0].proposed_input.body, /\b(yes|we handle|we do)\b/i);
  assert.equal(twilio.calls.length, 0, "nothing is sent until a human acts");
});

test("holding-reply behavior at autonomy 1 (the shipped default): recommendation only — NO approval card, NO SMS; the clarification card is the single owner item", async () => {
  twilio.calls.length = 0;
  const db = await e2eDb(1);
  const r = await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  assert.equal(r.status, "recommendation");
  assert.equal((await approvals(db)).length, 0);
  assert.equal((await clarifications(db)).length, 1);
  assert.equal(twilio.calls.length, 0);
});

test("STALE HOLDING REPLY (the correctness fix): once the owner ANSWERS, the pending holding-reply approval is cancelled and can never be approved afterwards — the customer receives exactly one SMS, the real answer", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  const [holding] = await approvals(db);
  assert.equal(holding.status, "pending");

  // Owner resolves the clarification WITHOUT touching the holding approval.
  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal(res.status, "resolved");
  assert.equal(twilio.calls.length, 1);

  const [after] = await approvals(db);
  assert.equal(after.status, "cancelled");
  assert.match(after.rejection_reason, /Superseded/);

  // Late approval attempt (stale tab / second owner click) is refused — nothing further is sent.
  const late = await S.approveRequest(db, holding.id, ORG_A, OWNER, holding.proposed_input);
  assert.equal(late.ok, false);
  assert.equal(late.reason, "already_decided");
  assert.equal(twilio.calls.length, 1, "still exactly one customer SMS");
});

test("holding reply approved FIRST, then the owner answers: both go out in the natural order; the already-approved holding approval is never overwritten by the cleanup", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  const [holding] = await approvals(db);
  const ok = await S.approveRequest(db, holding.id, ORG_A, OWNER, holding.proposed_input);
  assert.equal(ok.ok, true, "approving the holding reply first is allowed (it is still true at that moment)");
  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", saveToKnowledge: false });
  const [a] = await approvals(db);
  assert.equal(a.status, "approved");
});

test("DISMISSING the clarification also cancels the pending holding reply (a 'we'll get back to you' promise nobody will keep)", async () => {
  twilio.calls.length = 0;
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  await S.dismissClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id });
  assert.equal((await approvals(db))[0].status, "cancelled");
  assert.equal(twilio.calls.length, 0);
});

test("a FAILED send keeps the clarification open AND leaves the holding reply untouched (the question is still unanswered)", async () => {
  twilio.calls.length = 0; twilio.mode = "fail";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  const res = await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", saveToKnowledge: false });
  assert.equal(res.status, "send_failed");
  assert.equal((await approvals(db))[0].status, "pending");
  twilio.mode = "ok";
});

test("cleanup is NARROW: an unrelated pending reply to the same customer, a different customer's holding reply, and another org's approval are never cancelled", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  const now = new Date().toISOString();
  const seed = (id: string, org: string, contactId: string, body: string) =>
    db.from("agent_approval_requests").insert({ id, org_id: org, execution_id: row.execution_id, action_key: "send_sms", proposed_input: { contactId, body }, status: "pending", requested_at: now });
  await seed("unrelated", ORG_A, CONTACT_1, "Thanks! What's your timeline?");
  await seed("other-contact", ORG_A, CONTACT_2, S.CLARIFICATION_HOLDING_REPLY);
  await seed("other-org", ORG_B, CONTACT_1, S.CLARIFICATION_HOLDING_REPLY);

  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", saveToKnowledge: false });
  const byId = Object.fromEntries((await approvals(db)).map((a: any) => [a.id, a.status]));
  assert.equal(byId["unrelated"], "pending");
  assert.equal(byId["other-contact"], "pending");
  assert.equal(byId["other-org"], "pending");
});

test("SCENARIO D — duplicate pending via the real dispatcher: repeating the question before the owner answers reuses the SAME clarification (no second owner card); the extra 'still confirming' reply is also cancelled when the owner answers", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const again = await inbound(db, "Hello? Do you do permits??", scriptedProvider([JSON.stringify({ type: "clarify", category: "permit_handling", question: "Does the company do permits?" })]));
  assert.equal(again.status, "awaiting_approval");

  const rows = await clarifications(db);
  assert.equal(rows.length, 1, "ONE owner clarification card");
  const bodies = (await approvals(db)).map((a: any) => a.proposed_input.body).sort();
  assert.deepEqual(bodies, [S.CLARIFICATION_HOLDING_REPLY, S.CLARIFICATION_STILL_PENDING_REPLY].sort());

  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: rows[0].id, answer: "We handle permits and inspections.", saveToKnowledge: true });
  assert.ok((await approvals(db)).every((a: any) => a.status === "cancelled"), "both stale holding replies cancelled");
  assert.equal(twilio.calls.length, 1);
});

test("SCENARIOS B+C — owner answers with save, then a DIFFERENT contact's equivalent question is answered from the saved fact via the real dispatcher: no new clarification, the fact is in the prompt, exactly one deterministic permit_handling row", async () => {
  twilio.calls.length = 0; twilio.mode = "ok";
  const db = await e2eDb(2);
  await inbound(db, "Do you handle permits?", scriptedProvider([clarifyPermit]));
  const [row] = await clarifications(db);
  await S.resolveClarification({ supabase: db, orgId: ORG_A, userId: OWNER, clarificationId: row.id, answer: "We handle permits and inspections.", optionId: "handle_all", saveToKnowledge: true });
  assert.equal((await clarifications(db))[0].status, "resolved");
  assert.equal((await knowledge(db)).filter((e) => e.key === "permit_handling").length, 1);

  const provider = scriptedProvider([respond("Yes — we take care of permits and inspections.")]);
  const r = await inbound(db, "Do you take care of permits?", provider, CONTACT_2, LEAD_2);
  assert.equal(r.status, "awaiting_approval", "the grounded answer is proposed as the normal reply approval");
  assert.match(provider.requests[0].system, /- Permit handling: We handle permits and inspections\./);
  assert.equal((await clarifications(db)).length, 1, "no new clarification");
  assert.equal((await knowledge(db)).filter((e) => e.key === "permit_handling").length, 1, "still exactly one knowledge row");
  const proposed = (await approvals(db)).filter((a: any) => a.status === "pending");
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].proposed_input.body, "Yes — we take care of permits and inspections.");
  assert.equal(proposed[0].proposed_input.contactId, CONTACT_2);
});
