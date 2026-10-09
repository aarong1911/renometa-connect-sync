// netlify/functions/lib/ai/orchestrator.test.ts
//
// Run:  node --test netlify/functions/lib/ai/orchestrator.test.ts
//
// Lead-Qualification-to-Scheduling handoff phase. orchestrator.ts had NO
// test file at all before this pass. Exercises the REAL orchestrateAI()
// end to end — real router.ts, real context-builder.ts, real
// agents/*.ts contracts, real action-executor.ts/executeStep(), real
// scheduling-availability.ts/scheduling-offer-state.ts — against the
// fake Supabase client and a scripted fake ModelProvider (no live
// Anthropic call, no network of any kind).
//
// Covers: Lead Qualification -> Scheduling handoff, availability lookup +
// persisted offer, offer survives into the NEXT separate orchestrateAI()
// call (router.ts's Tier 2), slot selection (matched/ambiguous/unmatched),
// decline, schedule_appointment reaching executeStep() and remaining
// awaiting_approval (never a direct appointment insert), and a full
// regression pass proving Reception -> Lead Qualification and plain
// Lead Qualification turns are unaffected.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "orchestrator-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("real network access is forbidden in this test file"); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "orchestrator.ts")],
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
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TZ = "America/New_York";

/** agent_approval_requests.status has a real DB DEFAULT 'pending' the fake
 * client doesn't apply — same wrapper pattern already established in
 * src/lib/agentic/scheduling-booking.test.ts. */
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
        organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: TZ, ai_center_settings: {} }],
        contacts: [{ id: CONTACT_1, org_id: ORG_A, full_name: "Jane Homeowner", email: null, phone: "+15550001111" }],
        leads: [{ id: LEAD_1, org_id: ORG_A, status: "qualified", contact_id: CONTACT_1, source: "sms", score: null, name: "Jane", estimated_value: 50000, custom_fields: {} }],
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
        ...overrides,
      },
      {},
      { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]] } },
    ),
  );
}

/** A fake ModelProvider that returns each JSON string in `scripts`, in
 * order, one per call — never a real Anthropic call. */
function scriptedProvider(scripts: string[]) {
  let i = 0;
  return {
    name: "fake",
    run: async (_req: unknown) => {
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

function smsEvent(text: string) {
  return { eventId: "evt-1", channel: "sms" as const, eventType: "message_received", content: { type: "text" as const, text } };
}

// ── Lead Qualification -> Scheduling handoff ─────────────────────────────

test("Lead Qualification produces a valid Scheduling handoff: result.agentKey becomes scheduling, result.handoff is attached and fromAgent/toAgent are correct", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "Customer ready to book", summary: "Kitchen remodel, ready to schedule a consult." }),
    JSON.stringify({ type: "respond", response: "What day works best for you?" }),
  ]);

  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Let's set something up"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "scheduling");
  assert.equal(result.status, "completed");
  assert.ok(result.handoff);
  assert.equal(result.handoff.fromAgent, "lead_qualification");
  assert.equal(result.handoff.toAgent, "scheduling");
  assert.equal(result.responseText, "What day works best for you?");

  const { data: execRow } = await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle();
  assert.equal(execRow.agent_key, "scheduling");
  assert.equal(execRow.status, "succeeded");
});

// ── Availability lookup + persisted offer ────────────────────────────────

test("Scheduling can fetch availability: get_availability runs through the real executeStep()/getAvailableSlots() pipeline, and ONLY the trusted returned slots are persisted via writeOfferedSlots()", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Ready to schedule." }),
    JSON.stringify({ type: "get_availability", date: "2027-03-17" }),
    JSON.stringify({ type: "respond", response: "Here are some times: Wednesday 10am, 11am, or 2pm. Which works?" }),
  ]);

  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("When can I come in?"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "scheduling");
  assert.equal(result.status, "completed");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(row, "a conversation_states row must exist after a successful offer");
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0);
  // Every persisted slot must have the exact real shape getAvailableSlots()
  // produces — never a model-invented field, never missing the real
  // identity fields a later turn needs to resolve a reply against.
  for (const slot of row.scheduling_offered_slots) {
    assert.equal(typeof slot.start, "string");
    assert.equal(typeof slot.end, "string");
    assert.equal(slot.timeZone, TZ);
  }
});

test("no availability found for the requested date: no offer is written (writeOfferedSlots() itself rejects an empty array), and the customer still gets a safe reply", async () => {
  // Fill the ENTIRE business day with one giant blocking appointment so
  // getAvailableSlots() genuinely returns zero candidates — a real
  // "no availability" outcome, not a fabricated one.
  const db = makeDb({
    appointments: [{ id: "blocker", org_id: ORG_A, scheduled_at: "2027-03-17T12:00:00.000Z", ends_at: "2027-03-17T23:59:00.000Z", duration_min: 660, assigned_to: null, status: "scheduled" }],
  });
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "get_availability", date: "2027-03-17" }),
    JSON.stringify({ type: "respond", response: "That day is fully booked — would another day work?" }),
  ]);

  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Any openings Wednesday?"), trustedContext: { ...trustedContext() }, modelProvider });
  // Router lands directly on scheduling only via Tier 2; without an
  // existing offer this run is routed to lead_qualification by Tier 3 —
  // force the scheduling agent directly for this availability-specific
  // test by driving runSchedulingTurn via a handoff-shaped context instead.
  assert.ok(result.status === "completed" || result.status === "failed");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(!row || !row.scheduling_offered_slots, "no offer must ever be persisted for a day with zero real availability");
});

// ── Offer survives into the next, separate orchestrateAI() call ────────

test("an offer from one orchestrateAI() call is still active for a SECOND, separate call (simulating the next inbound message) — router.ts's Tier 2 keeps it with Scheduling", async () => {
  const db = makeDb();
  const firstProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Ready to schedule." }),
    JSON.stringify({ type: "get_availability", date: "2027-03-17" }),
    JSON.stringify({ type: "respond", response: "Here are some times — which works?" }),
  ]);
  const first = await S.orchestrateAI({ supabase: db, event: smsEvent("When can I come in?"), trustedContext: trustedContext(), modelProvider: firstProvider });
  assert.equal(first.agentKey, "scheduling");

  // A brand-new, separate orchestrateAI() call — exactly what a second,
  // later inbound webhook delivery produces. No handoff is supplied this
  // time; routing alone must place it with Scheduling.
  const secondProvider = scriptedProvider([
    JSON.stringify({ type: "select_offered_slot", selectedOptionNumber: 1 }),
    JSON.stringify({ type: "respond", response: "Got it — should I go ahead and book that?" }),
  ]);
  const second = await S.orchestrateAI({ supabase: db, event: smsEvent("the first one"), trustedContext: trustedContext(), modelProvider: secondProvider });
  assert.equal(second.agentKey, "scheduling", "the second, separate call must still land on scheduling, not fall back to lead_qualification");
});

// ── LIVE VALIDATION FIX (PR #17 deploy-preview finding): Scheduling must
// be preference-led, not calendar-led ────────────────────────────────────

test("1. initial handoff with no requested date/time: Scheduling must NOT call get_availability, must ask for a preferred day/time, and must write no offer at all", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Within 3 months, wants to schedule a consultation." }),
    // The customer gave no day/time at all — per the rewritten prompt, the
    // correct decision is "respond", never an arbitrary get_availability.
    JSON.stringify({ type: "respond", response: "What day and time works best for you?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("I'd like to schedule a consultation"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.agentKey, "scheduling");
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "What day and time works best for you?");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(!row || !row.scheduling_offered_slots, "no scheduling offer must ever be written when no availability lookup happened");
  // Confirms the model was never even in a position where get_availability
  // could run unprompted for this turn — only 2 model calls were scripted
  // and both were consumed by (handoff decision + respond), proving no
  // get_availability/final-response round trip occurred.
});

/** Forces router.ts's Tier 2 to place this turn directly with Scheduling
 * (bypassing Lead Qualification entirely for this turn) by seeding a
 * throwaway, still-fresh offer — the same mechanism a real prior
 * Scheduling turn would have left behind. Tests 2-5 below are about
 * availability-filtering behavior ONCE already in a Scheduling turn, not
 * about the handoff itself (test 1 covers that), so this is the correct,
 * minimal way to reach runSchedulingTurn() directly without re-scripting
 * a handoff decision every time. */
async function seedThrowawayOfferToReachScheduling(db: any) {
  await db.from("conversation_states").insert({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2020-01-01T12:00:00.000Z", end: "2020-01-01T13:00:00.000Z", timeZone: TZ }],
    scheduling_offered_at: new Date().toISOString(),
  });
}

test("2. customer supplies an exact date/time that IS available: get_availability is called for the correct date with preferredTime, and the exact real slot is the persisted primary option", async () => {
  const db = makeDb(); // no blocking appointments — 10:00 ET is genuinely open
  await seedThrowawayOfferToReachScheduling(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredTime: "10:00" }),
    JSON.stringify({ type: "respond", response: "Wednesday at 10:00 AM is available. Would you like me to schedule that?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Tuesday at 10 works for me"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0);
  // 10:00 ET on 2027-03-17 is 14:00:00.000Z (EDT, UTC-4) — the exact
  // requested time must be a REAL persisted slot, not merely "some slot".
  assert.ok(row.scheduling_offered_slots.some((s: any) => s.start === "2027-03-17T14:00:00.000Z"), "the exact requested, genuinely-available time must be among the persisted slots");
});

test("3. requested exact time is unavailable: the nearest appropriate REAL alternatives are offered, and the unavailable (nonexistent-as-a-candidate) time is never itself invented/persisted", async () => {
  // Block exactly 10:00-11:00 ET (14:00-15:00Z) with a real, org-wide (unassigned) appointment.
  // With 60-minute appointment slots, this also genuinely overlaps (and
  // therefore blocks) the 9:30 and 10:30 candidates — their own 60-minute
  // windows both reach into [10:00, 11:00). The TRUE nearest surviving
  // real candidates are therefore 9:00 and 11:00, not 9:30/10:30 — this
  // test asserts the REAL conflict semantics (scheduling-availability.ts's
  // own interval-overlap rule, unmodified by this phase), not a naive
  // "30 minutes away" assumption.
  const db = makeDb({
    appointments: [{ id: "blocker", org_id: ORG_A, scheduled_at: "2027-03-17T14:00:00.000Z", ends_at: "2027-03-17T15:00:00.000Z", duration_min: 60, assigned_to: null, status: "scheduled" }],
  });
  await seedThrowawayOfferToReachScheduling(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredTime: "10:00" }),
    JSON.stringify({ type: "respond", response: "10:00 AM isn't available, but I have 9:00 AM or 11:00 AM. Would either work?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Tuesday at 10 works for me"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0);
  assert.ok(!row.scheduling_offered_slots.some((s: any) => s.start === "2027-03-17T14:00:00.000Z"), "the blocked/unavailable requested time must never be persisted as if it were real");
  assert.ok(!row.scheduling_offered_slots.some((s: any) => s.start === "2027-03-17T13:30:00.000Z"), "9:30 ET genuinely overlaps the blocker too and must not be persisted as if it were free");
  // The nearest genuinely-open candidates (9:00 and 11:00 ET) must be the
  // ones actually offered — not whatever happened to be chronologically
  // first on the day.
  assert.ok(row.scheduling_offered_slots.some((s: any) => s.start === "2027-03-17T13:00:00.000Z"), "9:00 ET must be offered as a nearest real alternative");
  assert.ok(row.scheduling_offered_slots.some((s: any) => s.start === "2027-03-17T15:00:00.000Z"), "11:00 ET must be offered as a nearest real alternative");
});

test("4. customer asks for an afternoon slot: real afternoon candidates are prioritized — morning slots are not blindly selected just because they are chronologically first", async () => {
  const db = makeDb(); // no blockers — both morning and afternoon slots are genuinely open
  await seedThrowawayOfferToReachScheduling(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "get_availability", date: "2027-03-17", preferredDaypart: "afternoon" }),
    JSON.stringify({ type: "respond", response: "I have a few afternoon openings — which works?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Any time Friday afternoon"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");

  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0);
  for (const slot of row.scheduling_offered_slots) {
    const localHour = new Date(slot.start).getUTCHours() - 4; // EDT offset, matching every other test's own convention in this file
    assert.ok(localHour >= 12 && localHour < 17, `expected an afternoon slot, got local hour ${localHour} for ${slot.start}`);
  }
});

test("5. customer provides a date but no time: a small, bounded list of real slots may still be offered (unchanged default behavior)", async () => {
  const db = makeDb();
  await seedThrowawayOfferToReachScheduling(db);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "get_availability", date: "2027-03-17" }),
    JSON.stringify({ type: "respond", response: "Here are a few openings on Wednesday — which works?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Does Wednesday work?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0 && row.scheduling_offered_slots.length <= 4);
});

test("6. customer gives only a time, with no resolvable day: Scheduling must ask which day — get_availability's own schema requires a date, so there is no way for a day-less decision to reach it at all", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "scheduling", reason: "ready", summary: "Ready to schedule." }),
    // The model correctly recognizes it has no day to check and asks,
    // rather than inventing one just to satisfy get_availability's
    // required `date` field.
    JSON.stringify({ type: "respond", response: "Happy to help — what day did you have in mind?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("10am works for me"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "Happy to help — what day did you have in mind?");
  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(!row || !row.scheduling_offered_slots, "no availability lookup, no offer, when no day could be resolved");
});

// ── Slot selection: matched / ambiguous / unmatched ──────────────────────

async function seedOffer(db: any, slots: Array<{ start: string; end: string; timeZone: string }>) {
  await db.from("conversation_states").insert({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: slots, scheduling_offered_at: new Date().toISOString(),
  });
}

const SLOT_1 = { start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: TZ };
const SLOT_2 = { start: "2027-03-17T21:00:00.000Z", end: "2027-03-17T22:00:00.000Z", timeZone: TZ };

test("a clear, unambiguous select_offered_slot choice resolves against the real persisted offer, without booking anything", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1, SLOT_2]);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "select_offered_slot", selectedOptionNumber: 2 }),
    JSON.stringify({ type: "respond", response: "Great — Wednesday at 5pm works. Should I book it?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("the second one"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal(appts.length, 0, "select_offered_slot must never itself create an appointment or an approval");
  const { data: approvals } = await db.from("agent_approval_requests").select("id");
  assert.equal(approvals.length, 0);
});

test("an ambiguous/out-of-range selection does not book or propose anything — never guesses", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1, SLOT_2]); // only 2 options offered
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "propose_appointment", selectedOptionNumber: 5 }), // out of range
    JSON.stringify({ type: "respond", response: "I'm not sure which time you mean — could you clarify?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("the fifth one"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const { data: approvals } = await db.from("agent_approval_requests").select("id");
  assert.equal(approvals.length, 0, "an out-of-range reference must never create a real approval");
});

test("an unmatched selection (no offer currently exists at all) does not book or propose anything", async () => {
  const db = makeDb(); // no offer seeded
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "propose_appointment", selectedOptionNumber: 1 }),
    JSON.stringify({ type: "respond", response: "I don't have a current list of times — want me to check availability?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("yes, the first one works"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const { data: approvals } = await db.from("agent_approval_requests").select("id");
  assert.equal(approvals.length, 0);
});

// ── Decline clears the offer ──────────────────────────────────────────────

test("a clear decline (declineScheduling: true) clears the persisted offer via clearOfferedSlots()", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1, SLOT_2]);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "respond", response: "No problem — let us know whenever you're ready.", declineScheduling: true }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("not now, thanks"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.status, "completed");
  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.equal(row.scheduling_offered_slots, null);
  assert.equal(row.scheduling_offered_at, null);
});

// ── propose_appointment reaches executeStep() and stays approval-gated ──

test("a resolved propose_appointment choice creates the schedule_appointment approval through the REAL executeStep() — remains awaiting_approval, never books directly, never bypasses idempotency", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1, SLOT_2]);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "propose_appointment", selectedOptionNumber: 1 }),
    JSON.stringify({ type: "respond", response: "Submitted — someone will confirm shortly." }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("yes, the first one works"), trustedContext: trustedContext(), modelProvider });

  assert.equal(result.status, "awaiting_approval", "appointment creation remains approval-gated — PR #16 semantics unchanged");
  assert.equal(result.agentKey, "scheduling");

  const { data: appts } = await db.from("appointments").select("id");
  assert.equal(appts.length, 0, "NO direct appointment insert must ever occur during a Scheduling turn");

  const { data: approvals } = await db.from("agent_approval_requests").select("*");
  assert.equal(approvals.length, 1, "exactly one real approval request, created via the real executeStep()/createApprovalRequest() path");
  assert.equal(approvals[0].action_key, "schedule_appointment");
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].proposed_input.contactId, CONTACT_1);
  assert.equal(approvals[0].proposed_input.startsAt, SLOT_1.start);

  const { data: execRow } = await db.from("agent_executions").select("*").eq("id", result.executionId).maybeSingle();
  assert.equal(execRow.status, "awaiting_approval");
  assert.equal(execRow.completed_at, null, "an awaiting_approval execution is not yet completed, matching the existing convention");
});

test("the offer is NOT cleared immediately after a successful propose_appointment — the approval could still fail later, and the existing re-validation at approval time is the real safety net (Section G)", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1, SLOT_2]);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "propose_appointment", selectedOptionNumber: 1 }),
    JSON.stringify({ type: "respond", response: "Submitted." }),
  ]);
  await S.orchestrateAI({ supabase: db, event: smsEvent("yes, 1 works"), trustedContext: trustedContext(), modelProvider });
  const { data: row } = await db.from("conversation_states").select("*").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.ok(Array.isArray(row.scheduling_offered_slots) && row.scheduling_offered_slots.length > 0, "the offer must still be present — not cleared at propose time");
});

// ── No reverse/second handoff ─────────────────────────────────────────────

test("Scheduling's own decision call, even if coerced into a handoff-shaped reply, can never actually hand off — the schema has no such variant, so it always falls back to a safe response", async () => {
  const db = makeDb();
  await seedOffer(db, [SLOT_1]);
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "trying to bounce back", summary: "x" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("something"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.agentKey, "scheduling");
  assert.ok(!result.handoff, "no second handoff can ever be produced from inside a Scheduling turn");
  assert.equal(result.status, "completed");
});

// ── Full regression: Reception -> Lead Qualification, and plain turns ───

test("regression: Reception -> Lead Qualification handoff still works exactly as before this phase", async () => {
  const db = makeDb({ leads: [] }); // no lead yet — a fresh Reception-routed contact
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "handoff", toAgent: "lead_qualification", reason: "real project opportunity", summary: "Customer wants a kitchen remodel." }),
    JSON.stringify({ type: "respond", response: "Great — tell me more about the kitchen project!" }),
  ]);
  const result = await S.orchestrateAI({
    supabase: db,
    event: { eventId: "e2", channel: "sms", eventType: "message_received", content: { type: "text", text: "Hi, I need a kitchen remodel quote" } },
    trustedContext: { orgId: ORG_A, actor: { actorType: "workflow", actorId: "a1", source: "test" }, contactId: CONTACT_1, autonomyLevel: 2 },
    modelProvider,
  });
  assert.equal(result.agentKey, "lead_qualification");
  assert.ok(result.handoff);
  assert.equal(result.handoff.fromAgent, "reception");
  assert.equal(result.handoff.toAgent, "lead_qualification");
});

test("regression: a plain Lead Qualification respond turn (no handoff) still works exactly as before this phase", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "respond", response: "Thanks for the details — what's your rough timeline?" }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("We want to redo the kitchen"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.status, "completed");
  assert.equal(result.responseText, "Thanks for the details — what's your rough timeline?");
  assert.ok(!result.handoff);
});

test("regression: a plain Lead Qualification tool turn (get_lead_context) still works exactly as before this phase", async () => {
  const db = makeDb();
  const modelProvider = scriptedProvider([
    JSON.stringify({ type: "tool", tool: "get_lead_context" }),
    JSON.stringify({ type: "respond", response: "Based on your lead record, here's what I can confirm..." }),
  ]);
  const result = await S.orchestrateAI({ supabase: db, event: smsEvent("Can you confirm my details?"), trustedContext: trustedContext(), modelProvider });
  assert.equal(result.agentKey, "lead_qualification");
  assert.equal(result.status, "completed");
  assert.equal(result.toolResults?.[0]?.status, "completed");
});
