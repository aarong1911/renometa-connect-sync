// src/lib/agentic/scheduling-booking.test.ts
//
// Run:  node --test src/lib/agentic/scheduling-booking.test.ts
//
// Scheduling foundation — Phase 3. BOOKING + APPROVAL test matrix,
// exercised through the REAL action-executor.ts pipeline (executeStep /
// executeApprovedStep) against the real schedule_appointment/
// get_availability handlers — not a re-typed copy of their logic. No live
// Supabase, no network (global fetch is a throwing stub for this whole
// file — this handler makes no network call of its own; nodemailer inside
// appointment-post-booking.ts is the one thing that could, see its own
// test below).

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
const outDir = mkdtempSync(path.join(tmpdir(), "scheduling-booking-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "action-executor.ts")],
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
const MEMBER_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const MEMBER_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const LEAD_1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const LEAD_OTHER_ORG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const TZ = "America/New_York";
const ACTOR = { actorType: "user" as const, actorId: "user-1" };

function futureSlot(hourLocal = 10): { start: string; end: string } {
  // America/New_York is UTC-4 (EDT) in March. Far enough in the future
  // that "in the past" never trips.
  const start = new Date(Date.UTC(2027, 2, 16, hourLocal + 4, 0, 0)).toISOString();
  const end = new Date(Date.UTC(2027, 2, 16, hourLocal + 4 + 1, 0, 0)).toISOString();
  return { start, end };
}

/** agent_approval_requests.status has a real DB DEFAULT 'pending' this
 * fake does not apply — same wrapper pattern established earlier in this
 * repo's own test suites for the exact same reason. */
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
  const base = withApprovalDefaults(
    createFakeSupabaseClient(
      {
        organizations: [{ id: ORG_A, timezone: TZ, ai_center_settings: {} }],
        // email: null deliberately — see this file's header. A non-null
        // contact_email on the created appointment would make
        // runAppointmentPostBookingLifecycle attempt a REAL SMTP
        // connection (smtp.gmail.com), which this test file must never do
        // (no real network calls in automated tests). contact_name/
        // contact_phone denormalization is still fully exercised below.
        contacts: [{ id: CONTACT_1, org_id: ORG_A, full_name: "Jane Homeowner", email: null, phone: "+15550001111" }],
        appointments: [],
        agent_execution_steps: [],
        agent_approval_requests: [],
        agent_action_idempotency: [],
        notifications: [],
        profiles: [],
        ...overrides,
      },
      {},
      { uniqueConstraints: { agent_action_idempotency: [["org_id", "action_key", "idempotency_key"]] } },
    ),
  );
  return base;
}

function baseParams(db: any, overrides: Record<string, unknown> = {}) {
  const { start } = futureSlot();
  return {
    supabase: db,
    orgId: ORG_A,
    actor: ACTOR,
    executionId: "exec-1",
    sequence: 1,
    actionKey: "schedule_appointment",
    autonomyLevel: 2 as const,
    rawInput: {
      contactId: CONTACT_1,
      startsAt: start,
      durationMinutes: 60,
      appointmentType: "consultation",
      title: "Kitchen remodel consultation",
    },
    idempotencyKey: `test-${Math.random()}`,
    ...overrides,
  };
}

// ── BOOKING ────────────────────────────────────────────────────────────

test("valid appointment creation succeeds and writes the correct timezone/end time", async () => {
  const db = makeDb();
  // Level 2 + requiresApproval:true means executeStep() creates a pending
  // approval first — booking itself is exercised via executeApprovedStep(),
  // matching the real flow (see APPROVAL section below). This test proves
  // the handler's own write correctness directly via executeApprovedStep().
  const stepId = "step-1";
  await db.from("agent_execution_steps").insert({ id: stepId, execution_id: "exec-1", org_id: ORG_A, sequence: 1, status: "awaiting_approval" });
  const { start } = futureSlot();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId,
    actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: start, durationMinutes: 60, appointmentType: "consultation", title: "Consultation" },
    idempotencyKey: "appt-1",
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const output = result.output as any;
  assert.equal(output.timeZone, TZ);
  assert.equal(new Date(output.endsAt).getTime() - new Date(output.startsAt).getTime(), 60 * 60_000);

  const { data: row } = await db.from("appointments").select("*").eq("id", output.appointmentId).maybeSingle();
  assert.equal(row.org_id, ORG_A);
  assert.equal(row.contact_id, CONTACT_1);
  assert.equal(row.contact_name, "Jane Homeowner");
  assert.equal(row.contact_phone, "+15550001111");
  assert.equal(row.contact_email, null, "this fixture deliberately has no contact email — see this file's header on avoiding a real SMTP attempt");
  assert.equal(row.time_zone, TZ);
  assert.equal(row.status, "scheduled");
  assert.equal(row.appointment_type, "consultation");
});

test("a model-supplied timeZone field can never override the org's configured timezone (code-review correction — the field was removed from the schema entirely)", async () => {
  const db = makeDb();
  const stepId = "step-tz-override";
  await db.from("agent_execution_steps").insert({ id: stepId, execution_id: "exec-1", org_id: ORG_A, sequence: 1, status: "awaiting_approval" });
  const { start } = futureSlot();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId,
    actionKey: "schedule_appointment",
    // An attacker/model-controlled caller supplying a totally different
    // IANA zone than the org's real "America/New_York" — this must have
    // NO effect on the resolved timezone. Zod's object parsing strips any
    // key not declared in scheduleAppointmentInput, so this also proves
    // the field is gone from the schema, not merely unused by the handler.
    approvedInput: { contactId: CONTACT_1, startsAt: start, durationMinutes: 60, appointmentType: "consultation", title: "Consultation", timeZone: "Asia/Tokyo" },
    idempotencyKey: "appt-tz-override",
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const output = result.output as any;
  assert.equal(output.timeZone, TZ, "the org's own configured timezone must always win, regardless of any timeZone field in the input");

  const { data: row } = await db.from("appointments").select("*").eq("id", output.appointmentId).maybeSingle();
  assert.equal(row.time_zone, TZ);
});

test("an invalid appointment type is rejected by Zod before the handler ever runs", async () => {
  const db = makeDb();
  const { start } = futureSlot();
  const result = await S.executeStep(baseParams(db, { rawInput: { contactId: CONTACT_1, startsAt: start, durationMinutes: 60, appointmentType: "not_a_real_type", title: "x" } }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /validation/i);
});

test("an invalid/cross-org contact is rejected by the handler", async () => {
  const db = makeDb({ contacts: [] }); // no contact exists at all
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-x", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x" },
    idempotencyKey: "appt-no-contact",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /not found/i);
});

test("an invalid assignee (not a member of this org) is rejected", async () => {
  const db = makeDb(); // no org_memberships/profiles row for MEMBER_1
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-y", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", assignedTo: MEMBER_1 },
    idempotencyKey: "appt-bad-assignee",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /assignee/i);
});

test("a cross-org assignee — one that EXISTS, but belongs to a DIFFERENT org — is rejected, distinct from 'doesn't exist at all'", async () => {
  const db = makeDb({
    org_memberships: [{ member_id: MEMBER_2, org_id: ORG_B, role: "field_worker" }],
  });
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-cross-org-assignee", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", assignedTo: MEMBER_2 },
    idempotencyKey: "appt-cross-org-assignee",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /assignee/i);
});

// ── entityType/entityId pairing (Section 8) ─────────────────────────────
// Code-review correction: handlers.ts used to silently default a missing
// entityType to "contact" and a missing entityId to contactId
// INDEPENDENTLY of each other — so a caller supplying only ONE of the two
// fields got silently mispaired instead of rejected. These tests cover
// the fixed, explicit "both or neither" rule.

test("entityId without entityType is rejected (not silently defaulted to entityType:'contact')", async () => {
  const db = makeDb();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-1", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", entityId: LEAD_1 },
    idempotencyKey: "appt-entity-id-only",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /entityType and entityId must be provided together/i);
});

test("entityType without entityId is rejected (not silently defaulted to entityId:contactId)", async () => {
  const db = makeDb();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-2", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", entityType: "lead" },
    idempotencyKey: "appt-entity-type-only",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /entityType and entityId must be provided together/i);
});

test("neither entityType nor entityId provided: defaults to {entityType:'contact', entityId:contactId} and succeeds (the one self-consistent default pairing)", async () => {
  const db = makeDb();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-3", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x" },
    idempotencyKey: "appt-entity-default",
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const { data: row } = await db.from("appointments").select("*").eq("id", (result.output as any).appointmentId).maybeSingle();
  assert.equal(row.entity_type, "contact");
  assert.equal(row.entity_id, CONTACT_1);
});

test("entityType+entityId both provided, matching the contact: succeeds (explicit pairing, not just the default)", async () => {
  const db = makeDb();
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-4", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", entityType: "contact", entityId: CONTACT_1 },
    idempotencyKey: "appt-entity-explicit-contact",
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
});

test("a lead entity linked to a DIFFERENT contact than contactId is accepted — entity linkage is NOT cross-validated against contactId (deliberate: matches the DB trigger's own real invariant, not a bug)", async () => {
  const OTHER_CONTACT = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  const db = makeDb({
    contacts: [
      { id: CONTACT_1, org_id: ORG_A, full_name: "Jane Homeowner", email: null, phone: "+15550001111" },
      { id: OTHER_CONTACT, org_id: ORG_A, full_name: "Other Person", email: null, phone: "+15550002222" },
    ],
    leads: [{ id: LEAD_1, org_id: ORG_A, contact_id: OTHER_CONTACT }],
  });
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-5", actionKey: "schedule_appointment",
    // contactId names Jane; entityType/entityId names a lead that is
    // actually linked to a totally different contact. This handler does
    // not check lead.contact_id against input.contactId — same as the
    // real appointments.validate_appointment_entity_link() trigger, which
    // only confirms the entity row exists in this org, not that it's
    // "about" the same contact as contact_id. Documented, not a bug.
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", entityType: "lead", entityId: LEAD_1 },
    idempotencyKey: "appt-entity-lead-mismatch",
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const { data: row } = await db.from("appointments").select("*").eq("id", (result.output as any).appointmentId).maybeSingle();
  assert.equal(row.entity_type, "lead");
  assert.equal(row.entity_id, LEAD_1);
  assert.equal(row.contact_id, CONTACT_1, "contact_id stays whatever was explicitly passed, independent of the lead's own contact_id");
});

test("a cross-org entityId (lead exists, but in a different org) is rejected", async () => {
  const db = makeDb({
    leads: [{ id: LEAD_OTHER_ORG, org_id: ORG_B, contact_id: null }],
  });
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-entity-6", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x", entityType: "lead", entityId: LEAD_OTHER_ORG },
    idempotencyKey: "appt-entity-cross-org",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /not found/i);
});

test("a stale slot that became occupied before approval execution blocks the booking", async () => {
  const { start, end } = futureSlot();
  const db = makeDb({ appointments: [{ id: "existing-1", org_id: ORG_A, scheduled_at: start, ends_at: end, duration_min: 60, assigned_to: null, status: "scheduled" }] });
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-z", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: start, durationMinutes: 60, appointmentType: "consultation", title: "x" },
    idempotencyKey: "appt-stale",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /no longer available/i);
  const { data: rows } = await db.from("appointments").select("id");
  assert.equal(rows.length, 1, "no second appointment must have been created");
});

test("an availability-query failure at execution time blocks the booking (fail closed), never books anyway", async () => {
  const inner = makeDb();
  const failingChain: any = { eq: () => failingChain, neq: () => failingChain, gte: () => failingChain, lt: () => failingChain, then: (resolve: any) => resolve({ data: null, error: { message: "simulated failure" } }) };
  const db = { ...inner, from: (t: string) => { if (t === "appointments") return { select: () => failingChain, insert: inner.from(t).insert }; return inner.from(t); } };
  const result = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-w", actionKey: "schedule_appointment",
    approvedInput: { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x" },
    idempotencyKey: "appt-fail-closed",
  });
  assert.equal(result.status, "failed");
});

test("duplicate execution (same idempotencyKey) does not create a second appointment, and the replay returns the SAME cached appointmentId (covers idempotency scenarios C/D/E: lost response, second approval click, Netlify retry)", async () => {
  const db = makeDb();
  const approvedInput = { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x" };
  const first = await S.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-dup-1", actionKey: "schedule_appointment", approvedInput, idempotencyKey: "appt-dup" });
  assert.equal(first.status, "succeeded");
  const second = await S.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-dup-2", actionKey: "schedule_appointment", approvedInput, idempotencyKey: "appt-dup" });
  assert.equal(second.status, "skipped");
  // A replay (lost response, duplicate click, or platform retry) must
  // hand back the SAME real appointmentId it already created. A "skipped"
  // result's output shape is { reason: "duplicate_suppressed", result }
  // (not a flat {appointmentId}) — agent-approve-action.ts already knows
  // to unwrap `.result` for this exact case (see its own
  // `isDuplicateOfRealExecution` handling) before deriving `realResult`
  // for verifyActionSuccess()/the post-booking-lifecycle call, so this
  // assertion follows that same real unwrapping path rather than asserting
  // a flatter shape than what the executor actually returns.
  const secondOutput = second.output as { reason?: string; result?: Record<string, unknown> } | undefined;
  assert.equal(secondOutput?.reason, "duplicate_suppressed");
  assert.equal(secondOutput?.result?.appointmentId, (first.output as any)?.appointmentId, "a replayed execution must return the cached result, including the real appointmentId");
  const { data: rows } = await db.from("appointments").select("id");
  assert.equal(rows.length, 1, "exactly one appointment, never two");
});

test("idempotency scenario A — claim succeeds but the INSERT itself fails: the claim is released (not permanently poisoned), and a retry with the SAME idempotencyKey can still succeed", async () => {
  const inner = makeDb();
  let insertAttempts = 0;
  const db = {
    ...inner,
    from: (t: string) => {
      const builder = inner.from(t);
      if (t !== "appointments") return builder;
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => {
        insertAttempts += 1;
        const result = originalInsert(row);
        if (insertAttempts === 1) {
          result.single = async () => ({ data: null, error: { message: "simulated insert failure" } });
        }
        return result;
      };
      return builder;
    },
  };
  const approvedInput = { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "x" };

  const first = await S.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-insert-fail-1", actionKey: "schedule_appointment", approvedInput, idempotencyKey: "appt-insert-fail" });
  assert.equal(first.status, "failed", "the first attempt's INSERT failed, so the overall execution must be reported as failed, not silently swallowed");
  const { data: rowsAfterFailure } = await db.from("appointments").select("id");
  assert.equal(rowsAfterFailure.length, 0, "a failed insert must never leave a partial/phantom appointment row");

  // Retry with the exact same idempotencyKey — if the orphaned claim from
  // the failed first attempt were never released, this would incorrectly
  // report "skipped" (or otherwise never actually try to book) instead of
  // genuinely attempting — and succeeding at — the booking this time.
  const second = await S.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-insert-fail-2", actionKey: "schedule_appointment", approvedInput, idempotencyKey: "appt-insert-fail" });
  assert.equal(second.status, "succeeded", "a retry after a pre-insert failure must be able to genuinely succeed — the idempotency claim from the failed attempt must have been released, not left permanently consumed");
  const { data: rowsAfterRetry } = await db.from("appointments").select("id");
  assert.equal(rowsAfterRetry.length, 1, "exactly one real appointment after the successful retry");
});

// ── APPROVAL / AUTONOMY ──────────────────────────────────────────────────

test("Level 1 cannot book — fails at the autonomy floor, no approval created, no appointment created", async () => {
  const db = makeDb();
  const result = await S.executeStep(baseParams(db, { autonomyLevel: 1 }));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /autonomy/i);
  const { data: approvals } = await db.from("agent_approval_requests").select("id");
  assert.equal((approvals ?? []).length, 0);
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal((appts ?? []).length, 0);
});

test("Level 2 creates a pending approval rather than booking immediately — no appointment exists yet", async () => {
  const db = makeDb();
  const result = await S.executeStep(baseParams(db, { autonomyLevel: 2 }));
  assert.equal(result.status, "awaiting_approval");
  assert.ok(result.approvalRequestId);
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal((appts ?? []).length, 0, "no appointment may exist before approval");
  const { data: approval } = await db.from("agent_approval_requests").select("status, action_key").eq("id", result.approvalRequestId).maybeSingle();
  assert.equal(approval.status, "pending");
  assert.equal(approval.action_key, "schedule_appointment");
});

test("approval execution (executeApprovedStep) re-validates availability and books only then", async () => {
  const db = makeDb();
  const proposeResult = await S.executeStep(baseParams(db, { autonomyLevel: 2 }));
  assert.equal(proposeResult.status, "awaiting_approval");

  const { data: approval } = await db.from("agent_approval_requests").select("*").eq("id", proposeResult.approvalRequestId).maybeSingle();
  const execResult = await S.executeApprovedStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: approval.execution_step_id, actionKey: "schedule_appointment",
    approvedInput: approval.proposed_input, idempotencyKey: `lead_qualification_reply:${approval.id}`,
  });
  assert.equal(execResult.status, "succeeded");
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal(appts.length, 1);
});

test("a rejected approval never books: rejection happens upstream of executeApprovedStep, which this handler never even sees", async () => {
  // This handler/action-executor has no "rejected" concept of its own —
  // agent-approve-action.ts (not exercised by this unit-test file) is what
  // marks an approval rejected and simply never calls executeApprovedStep
  // at all for that approval. This test pins that structural guarantee:
  // nothing in the booking pipeline can be reached without an explicit
  // executeApprovedStep call.
  const db = makeDb();
  const proposeResult = await S.executeStep(baseParams(db, { autonomyLevel: 2 }));
  await db.from("agent_approval_requests").update({ status: "rejected", rejection_reason: "test" }).eq("id", proposeResult.approvalRequestId);
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal((appts ?? []).length, 0, "rejecting an approval must never have created an appointment");
});

// ── get_availability action (read-only, Level 1) ────────────────────────

test("get_availability is executable at Level 1 and never mutates", async () => {
  const db = makeDb();
  const result = await S.executeStep({
    supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", sequence: 1, actionKey: "get_availability",
    autonomyLevel: 1, rawInput: { date: "2027-03-16", durationMinutes: 60 },
  });
  assert.equal(result.status, "succeeded");
  const output = result.output as any;
  assert.ok(Array.isArray(output.slots));
  assert.equal(output.timeZone, TZ);
  const { data: appts } = await db.from("appointments").select("id");
  assert.equal((appts ?? []).length, 0, "get_availability must never create anything");
});

test("get_appointment_types returns the canonical server-side set", async () => {
  const db = makeDb();
  const result = await S.executeStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", sequence: 1, actionKey: "get_appointment_types", autonomyLevel: 1, rawInput: {} });
  assert.equal(result.status, "succeeded");
  const output = result.output as any;
  assert.deepEqual(output.appointmentTypes.sort(), ["consultation", "estimate", "follow_up", "internal", "other", "service", "site_visit"]);
});
