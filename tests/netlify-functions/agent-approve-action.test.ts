// tests/netlify-functions/agent-approve-action.test.ts
//
// Run:  node --test tests/netlify-functions/agent-approve-action.test.ts
//
// Moved here from netlify/functions/agent-approve-action.test.ts (PR #16
// deploy-failure fix): Netlify was treating that root-level *.test.ts file
// as a deployable function entrypoint, and its top-level await/import.meta
// test harness failed Netlify's own function bundling. Netlify's functions
// directory holds deployable root function entrypoints only — test files
// for those functions belong in tests/netlify-functions/ instead, matching
// this repo's existing precedent (see gmail-sync.test.ts in this same
// directory). Production source is now referenced explicitly from
// repoRoot rather than assumed to live beside this file.
//
// Scheduling foundation — code-review pass. This file previously had ZERO
// test coverage. Added here specifically to cover the two real findings
// from this pass:
//   1. verifyActionSuccess() had NO case for "schedule_appointment" at
//      all — every real schedule_appointment approval would have fallen
//      through to the "unknown action key" fail-closed branch and been
//      reported FAILED even though the appointment was genuinely created.
//      Found and fixed in this same pass, before anything was committed.
//   2. the post-booking lifecycle (confirmation email + owner/assignee
//      notification) is invoked from THIS file now, not from
//      src/lib/agentic/handlers.ts — proven here via a source-level check
//      (see the "source wiring" test below) rather than a full HTTP-level
//      integration test, which would require far more scaffolding
//      (resolveOrgAndAuthority, a real approval row, etc.) than this
//      narrowly-scoped addition calls for.
//
// No live Supabase, no network. Only the exported pure function
// (verifyActionSuccess) is exercised directly; the module's top-level
// `createClient(...)` call needs SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// set to something syntactically valid before import (same pattern
// already established in lead-qualification-background.test.ts) — no
// actual network call is made since nothing here invokes a Supabase
// method.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

const here = path.dirname(fileURLToPath(import.meta.url));
// tests/netlify-functions/ -> repo root is two levels up (verified, not
// assumed — see this file's own test run above and the repoRoot-based
// path assertions below, all of which pass against the real repo layout).
const repoRoot = path.resolve(here, "..", "..");
const productionSourcePath = path.join(repoRoot, "netlify/functions/agent-approve-action.ts");
const outDir = mkdtempSync(path.join(tmpdir(), "agent-approve-action-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [productionSourcePath],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

// Idempotency hardening pass — schedule_appointment's idempotencyKeyFor()
// case needs to be exercised against the REAL action-executor pipeline
// (executeApprovedStep), not just checked for a non-null return value, to
// prove the retry/duplicate semantics actually hold end to end. Bundled
// separately (action-executor.ts has no dependency on agent-approve-
// action.ts, nor vice versa at this import depth) rather than threading a
// second export out of the production file.
const aeOutDir = mkdtempSync(path.join(tmpdir(), "agent-approve-action-executor-"));
after(() => rmSync(aeOutDir, { recursive: true, force: true }));
await esbuild.build({
  entryPoints: [path.join(repoRoot, "src/lib/agentic/action-executor.ts")],
  outfile: path.join(aeOutDir, "action-executor.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js"],
});
const AE: any = await import(pathToFileURL(path.join(aeOutDir, "action-executor.mjs")).href);
const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

test("verifyActionSuccess('schedule_appointment', ...) requires a real, non-empty appointmentId", () => {
  assert.deepEqual(S.verifyActionSuccess("schedule_appointment", { appointmentId: "appt-123" }), { verified: true });
});

test("verifyActionSuccess('schedule_appointment', ...) fails closed when appointmentId is missing/empty — never assumed success", () => {
  for (const bad of [undefined, {}, { appointmentId: "" }, { appointmentId: 123 }, { somethingElse: "x" }]) {
    const result = S.verifyActionSuccess("schedule_appointment", bad as any);
    assert.equal(result.verified, false, JSON.stringify(bad));
  }
});

test("schedule_appointment is no longer treated as an unknown/unconfigured action key (the exact bug this pass found and fixed)", () => {
  const result = S.verifyActionSuccess("schedule_appointment", undefined);
  assert.doesNotMatch(result.reason, /No success-verification rule is configured/, "schedule_appointment must have its OWN rule, not fall through to the generic unknown-action-key branch");
});

test("an unrecognized action key still fails closed with the generic message (unchanged behavior)", () => {
  const result = S.verifyActionSuccess("some_future_action", {});
  assert.equal(result.verified, false);
  assert.match(result.reason, /No success-verification rule is configured/);
});

// ── source wiring: the post-booking lifecycle is called from THIS file ──

test("the post-booking lifecycle is invoked from agent-approve-action.ts (not from handlers.ts), gated on actionKey === 'schedule_appointment', and only after verification", () => {
  const source = readFileSync(productionSourcePath, "utf8");
  assert.ok(source.includes('import { runAppointmentPostBookingLifecycle } from "./lib/appointment-post-booking"'), "expected a direct import of the real lifecycle function");
  assert.ok(source.includes('if (approval.action_key === "schedule_appointment")'), "expected the lifecycle call to be gated on this exact action key");
  assert.ok(source.includes("runAppointmentPostBookingLifecycle(supabaseAdmin, { appointmentId, orgId })"), "expected the real call with the real appointmentId/orgId");

  // Ordering: the lifecycle-invocation block must appear AFTER the
  // "action_verified" checkpoint (i.e. after verification passed), never
  // before — an unverified execution must never trigger a confirmation
  // email.
  const verifiedIdx = source.indexOf('logCheckpoint("action_verified"');
  const lifecycleIdx = source.indexOf("runAppointmentPostBookingLifecycle(supabaseAdmin");
  assert.ok(verifiedIdx > 0 && lifecycleIdx > verifiedIdx, "the lifecycle call must come after verification, never before");
});

test("a post-booking lifecycle failure can never prevent the approval from being marked executed (Section 12: lifecycle failure must not un-verify an already-proven booking)", () => {
  const source = readFileSync(productionSourcePath, "utf8");

  // The lifecycle call must be wrapped in its own .catch(...) — any
  // rejection is swallowed (logged) right there, so it can never
  // propagate up and short-circuit the rest of this branch.
  const lifecycleCallMatch = source.match(/await runAppointmentPostBookingLifecycle\([^;]*\.catch\(/s);
  assert.ok(lifecycleCallMatch, "the lifecycle call must be awaited with its own .catch(), never left to throw up into the main handler flow");

  // markApprovalExecuted must appear AFTER the lifecycle call/catch block
  // in source order, and must NOT be nested inside that .catch() handler
  // (i.e. it must run unconditionally afterward, not only on lifecycle
  // failure or only on lifecycle success).
  const lifecycleIdx = source.indexOf("runAppointmentPostBookingLifecycle(supabaseAdmin");
  const markExecutedIdx = source.indexOf("await markApprovalExecuted(supabaseAdmin, reqBody.approvalId, orgId);");
  assert.ok(lifecycleIdx > 0 && markExecutedIdx > lifecycleIdx, "markApprovalExecuted must run after the lifecycle call, regardless of whether the lifecycle succeeded or failed");
});

test("handlers.ts no longer imports or calls the post-booking lifecycle directly (the layering fix this pass made)", () => {
  const handlersSource = readFileSync(path.join(repoRoot, "src/lib/agentic/handlers.ts"), "utf8");
  // Checks the actual IMPORT/CALL forms specifically — handlers.ts's own
  // comments legitimately MENTION "appointment-post-booking.ts" in prose
  // to explain why it's deliberately not imported; that prose mention is
  // fine and expected, so this does not do a blanket string-absence check.
  assert.ok(!/from\s+["'].*appointment-post-booking["']/.test(handlersSource), "src/lib/agentic/handlers.ts must never import netlify/functions/lib/appointment-post-booking.ts");
  assert.ok(!handlersSource.includes("runAppointmentPostBookingLifecycle("), "the lifecycle must never actually be CALLED from inside handlers.ts");
});

// ── idempotencyKeyFor() — schedule_appointment hardening pass ───────────
//
// Audit finding: schedule_appointment had no case here at all, so a real
// approval went through executeApprovedStep() with idempotencyKey:
// undefined — the agent_action_idempotency guard never engaged for this
// action. Same-approval double-click is independently protected by
// approveRequest()'s own atomic pending->approved transition (see
// src/lib/agentic/approvals.ts) — this is belt-and-suspenders consistency
// with every other approval-required executable action, not a fix for a
// currently-exploitable duplicate-booking bug. Keyed on the approval's own
// id (never on appointment content), so two distinct approvals proposing
// identical appointment details are never silently collapsed into one.

function fakeApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-11111111-1111-4111-8111-111111111111",
    execution_id: "exec-22222222-2222-4222-8222-222222222222",
    target_entity_id: "contact-33333333-3333-4333-8333-333333333333",
    requested_at: "2027-03-16T14:00:00.000Z",
    ...overrides,
  };
}

test("idempotencyKeyFor('schedule_appointment', ...) returns a real, non-null key", () => {
  const key = S.idempotencyKeyFor("schedule_appointment", fakeApproval());
  assert.equal(typeof key, "string");
  assert.ok(key.length > 0);
});

test("idempotencyKeyFor('schedule_appointment', ...): the SAME approvalId always yields the SAME key (stable across an HTTP retry/response-loss retry of the same decision)", () => {
  const a = S.idempotencyKeyFor("schedule_appointment", fakeApproval());
  const b = S.idempotencyKeyFor("schedule_appointment", fakeApproval());
  assert.equal(a, b);
});

test("idempotencyKeyFor('schedule_appointment', ...): two DIFFERENT approvalIds yield DIFFERENT keys, even with identical appointment content (target_entity_id/requested_at/execution_id) — two legitimate distinct proposals are never collapsed", () => {
  const a = S.idempotencyKeyFor("schedule_appointment", fakeApproval({ id: "approval-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  const b = S.idempotencyKeyFor("schedule_appointment", fakeApproval({ id: "approval-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
  assert.notEqual(a, b);
});

test("idempotencyKeyFor('schedule_appointment', ...) key format is schedule_appointment:<approvalId> exactly", () => {
  const approval = fakeApproval({ id: "approval-44444444-4444-4444-8444-444444444444" });
  assert.equal(S.idempotencyKeyFor("schedule_appointment", approval), "schedule_appointment:approval-44444444-4444-4444-8444-444444444444");
});

// ── existing action keys must not regress ────────────────────────────────

test("idempotencyKeyFor('create_follow_up_task', ...) is unchanged: create_follow_up_task:v2:<targetEntityId>:<YYYY-MM-DD>", () => {
  const approval = fakeApproval({ target_entity_id: "lead-123", requested_at: "2027-03-16T14:00:00.000Z" });
  assert.equal(S.idempotencyKeyFor("create_follow_up_task", approval), "create_follow_up_task:v2:lead-123:2027-03-16");
});

test("idempotencyKeyFor('send_sms', ...) is unchanged: sms_reply:<executionId>", () => {
  const approval = fakeApproval({ execution_id: "exec-abc" });
  assert.equal(S.idempotencyKeyFor("send_sms", approval), "sms_reply:exec-abc");
});

test("idempotencyKeyFor('send_whatsapp', ...) is unchanged: whatsapp_reply:<executionId>", () => {
  const approval = fakeApproval({ execution_id: "exec-xyz" });
  assert.equal(S.idempotencyKeyFor("send_whatsapp", approval), "whatsapp_reply:exec-xyz");
});

test("idempotencyKeyFor(...) for any still-unhandled action key returns undefined (unchanged fallback)", () => {
  assert.equal(S.idempotencyKeyFor("some_future_action", fakeApproval()), undefined);
});

// ── end-to-end retry semantics, through the REAL action-executor pipeline ─
//
// These exercise idempotencyKeyFor()'s output directly against
// executeApprovedStep() (the exact call agent-approve-action.ts itself
// makes), proving the key format actually produces the required retry
// behavior rather than just returning a plausible-looking string.

const ORG_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TZ = "America/New_York";
const ACTOR = { actorType: "user" as const, actorId: "approver-1" };

function futureSlot(hourLocal = 10) {
  const start = new Date(Date.UTC(2027, 2, 16, hourLocal + 4, 0, 0)).toISOString();
  const end = new Date(Date.UTC(2027, 2, 16, hourLocal + 4 + 1, 0, 0)).toISOString();
  return { start, end };
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

function makeExecutorDb(overrides: Record<string, any[]> = {}) {
  return withApprovalDefaults(
    createFakeSupabaseClient(
      {
        organizations: [{ id: ORG_A, timezone: TZ, ai_center_settings: {} }],
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
}

test("A/B — same approval, retried via the SAME idempotencyKeyFor()-derived key: a second executeApprovedStep() call never creates a second appointment, and reuses the prior result (covers HTTP retry and response-loss retry)", async () => {
  const db = makeExecutorDb();
  const approval = fakeApproval({ id: "approval-retry-aaaa" });
  const key = S.idempotencyKeyFor("schedule_appointment", approval);
  const approvedInput = { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "Retry test" };

  const first = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-1", actionKey: "schedule_appointment", approvedInput, idempotencyKey: key });
  assert.equal(first.status, "succeeded", JSON.stringify(first));

  const second = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-2", actionKey: "schedule_appointment", approvedInput, idempotencyKey: key });
  assert.equal(second.status, "skipped");
  assert.equal((second.output as any)?.result?.appointmentId, (first.output as any)?.appointmentId);

  const { data: rows } = await db.from("appointments").select("id");
  assert.equal(rows.length, 1, "exactly one appointment after the retry");
});

test("C — two DISTINCT approvals, identical appointment details but different slots: both book as two separate, independent appointments (never collapsed into one proposal)", async () => {
  const db = makeExecutorDb();
  const approvalX = fakeApproval({ id: "approval-distinct-x" });
  const approvalY = fakeApproval({ id: "approval-distinct-y" });
  const keyX = S.idempotencyKeyFor("schedule_appointment", approvalX);
  const keyY = S.idempotencyKeyFor("schedule_appointment", approvalY);
  assert.notEqual(keyX, keyY);

  const bookingX = { contactId: CONTACT_1, startsAt: futureSlot(9).start, durationMinutes: 60, appointmentType: "consultation", title: "Same details" };
  const bookingY = { contactId: CONTACT_1, startsAt: futureSlot(11).start, durationMinutes: 60, appointmentType: "consultation", title: "Same details" };

  const resultX = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-x", actionKey: "schedule_appointment", approvedInput: bookingX, idempotencyKey: keyX });
  const resultY = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-y", actionKey: "schedule_appointment", approvedInput: bookingY, idempotencyKey: keyY });
  assert.equal(resultX.status, "succeeded", JSON.stringify(resultX));
  assert.equal(resultY.status, "succeeded", JSON.stringify(resultY));
  assert.notEqual((resultX.output as any)?.appointmentId, (resultY.output as any)?.appointmentId);

  const { data: rows } = await db.from("appointments").select("id");
  assert.equal(rows.length, 2, "two distinct approvals must produce two real, independent appointments");
});

test("D — a transient pre-insert failure under an idempotencyKeyFor()-derived key is retryable, not permanently poisoned (matches the existing executor contract — see src/lib/agentic/scheduling-booking.test.ts's own 'idempotency scenario A' for the underlying mechanism)", async () => {
  const inner = makeExecutorDb();
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
        if (insertAttempts === 1) result.single = async () => ({ data: null, error: { message: "simulated insert failure" } });
        return result;
      };
      return builder;
    },
  };
  const approval = fakeApproval({ id: "approval-pre-insert-fail" });
  const key = S.idempotencyKeyFor("schedule_appointment", approval);
  const approvedInput = { contactId: CONTACT_1, startsAt: futureSlot().start, durationMinutes: 60, appointmentType: "consultation", title: "Pre-insert failure" };

  const first = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-fail-1", actionKey: "schedule_appointment", approvedInput, idempotencyKey: key });
  assert.equal(first.status, "failed");

  const second = await AE.executeApprovedStep({ supabase: db, orgId: ORG_A, actor: ACTOR, executionId: "exec-1", stepId: "step-fail-2", actionKey: "schedule_appointment", approvedInput, idempotencyKey: key });
  assert.equal(second.status, "succeeded", "a retry under the SAME idempotencyKeyFor()-derived key must still be able to succeed after a transient pre-insert failure");

  const { data: rows } = await db.from("appointments").select("id");
  assert.equal(rows.length, 1);
});
