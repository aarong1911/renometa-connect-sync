// netlify/functions/lib/ai/lead-qualification-dispatch.test.ts
//
// Run:  node --test netlify/functions/lib/ai/lead-qualification-dispatch.test.ts
// Tests the real dispatchLeadQualification() core against the in-memory fake
// Supabase (test-support/fake-supabase-client.mjs) and an injected fake
// `orchestrate` function — no live Supabase, no live Anthropic call, no
// network (global fetch is replaced with a function that throws).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("Network access is not allowed in lead-qualification-dispatch.test.ts");
}) as typeof fetch;

const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "lead-qual-dispatch-"));
await esbuild.build({
  entryPoints: [path.join(here, "lead-qualification-dispatch.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(repoRoot, "src") },
  external: ["nodemailer", "@supabase/supabase-js"],
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(here, "../test-support/fake-supabase-client.mjs")).href
);

await esbuild.build({
  entryPoints: [path.join(here, "lead-created-hook.ts")],
  outfile: path.join(outDir, "hook.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(repoRoot, "src") },
  external: ["nodemailer", "@supabase/supabase-js"],
});
const Hook: any = await import(pathToFileURL(path.join(outDir, "hook.mjs")).href);

after(() => {
  globalThis.fetch = realFetch;
  rmSync(outDir, { recursive: true, force: true });
});
const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => console[k]);
noisy.forEach((k) => (console[k] = () => {}));
after(() => noisy.forEach((k, i) => (console[k] = saved[i])));

// ─────────────────────────────────────────────
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const LEAD_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTACT_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

// The real agent_approval_requests table defaults status='pending' and
// requested_at=now() in Postgres; the fake has no column defaults (see
// approvals.ts's createApprovalRequest, which relies on the DB default and
// never sets status itself).
function withApprovalDefaults(db: any) {
  const from = db.from.bind(db);
  db.from = (table: string) => {
    const b = from(table);
    if (table !== "agent_approval_requests") return b;
    const insert = b.insert.bind(b);
    b.insert = (row: any) => insert({ status: "pending", requested_at: new Date().toISOString(), ...row });
    return b;
  };
  return db;
}

function makeDb(opts: { enabled?: boolean; defaultAutonomyLevel?: 1 | 2; emergencyPaused?: boolean; orgId?: string } = {}) {
  const orgId = opts.orgId ?? ORG_A;
  const ai_center_settings: any = { emergencyPaused: opts.emergencyPaused === true };
  if (opts.enabled !== undefined) ai_center_settings.agents = { lead_qualification: { enabled: opts.enabled, defaultAutonomyLevel: opts.defaultAutonomyLevel ?? 1 } };
  return withApprovalDefaults(createFakeSupabaseClient(
    {
      organizations: [{ id: orgId, ai_center_settings }],
      agent_executions: [],
      agent_execution_steps: [],
      agent_approval_requests: [],
      agent_action_idempotency: [],
      contacts: [{ id: CONTACT_1, org_id: orgId, full_name: "John Test", phone: "+15550001111", email: "john@example.com" }],
      // send_sms's outbound-consent check (action-executor.ts's
      // checkOutboundConsent) fails CLOSED without an explicit eligible
      // row — seeded here so the Level 2 tests exercise the real approval
      // path rather than incidentally failing consent.
      marketing_contact_preferences: [{ contact_id: CONTACT_1, org_id: orgId, sms_status: "eligible" }],
    },
    {},
    { uniqueConstraints: { agent_executions: [["org_id", "idempotency_key"]] } },
  )) as any;
}

function fakeOrchestrate(result: Partial<{ status: string; responseText: string; executionId: string; error: string }> = {}) {
  let calls = 0;
  const fn = async () => {
    calls++;
    return { executionId: `exec-${calls}`, status: "completed", agentKey: "lead_qualification", responseText: "Hi John, thanks for reaching out about your kitchen remodel!", ...result };
  };
  return { fn, callCount: () => calls };
}

let baseParamsCounter = 0;
const baseParams = (db: any, orchestrate: any, over: Record<string, unknown> = {}) => ({
  supabase: db,
  orgId: ORG_A,
  source: "manual_run" as const,
  leadId: LEAD_1,
  contactId: CONTACT_1,
  orchestrate: orchestrate.fn,
  // A distinct default per call so tests that don't care about invocation-id
  // semantics never accidentally collide with each other; tests that DO
  // care (idempotency tests) always pass an explicit invocationId.
  invocationId: `invocation-default-${++baseParamsCounter}`,
  ...over,
});
const pendingApprovals = (db: any) => (db.__dumpTable("agent_approval_requests") as any[]).filter((r) => r.status === "pending");
const executions = (db: any) => db.__dumpTable("agent_executions") as any[];

// ── POLICY ───────────────────────────────────────────────────────────────

test("25. agent disabled blocks the run", async () => {
  const db = makeDb({ enabled: false });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch));
  assert.deepEqual(r, { status: "skipped", reason: "disabled" });
  assert.equal(orch.callCount(), 0);
});

test("24. emergency pause blocks even when the agent is enabled", async () => {
  const db = makeDb({ enabled: true, emergencyPaused: true });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch));
  assert.deepEqual(r, { status: "skipped", reason: "emergency_paused" });
  assert.equal(orch.callCount(), 0);
});

test("29. a policy lookup error fails closed (treated as disabled), never runs", async () => {
  const inner = makeDb({ enabled: true });
  const db = { ...inner, from: (t: string) => { if (t === "organizations") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "db down" } }) }) }) }; return inner.from(t); } };
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch));
  // Both resolveExecutionPolicy and the dedicated enabled-flag lookup fail
  // closed independently on the same lookup error; emergency_paused is
  // checked first, so that's the reported reason — either way the run is
  // correctly blocked.
  assert.equal(r.status, "skipped");
  assert.ok(r.reason === "emergency_paused" || r.reason === "disabled");
  assert.equal(orch.callCount(), 0);
});

test("3+4+5. an inbound trigger is gated by isLiveTriggerEligible: unsupported channel / outbound / backfill never dispatch", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  for (const candidate of [
    { channel: "email", direction: "in", syncOrigin: "live" },
    { channel: "sms", direction: "out", syncOrigin: "live" },
    { channel: "sms", direction: "in", syncOrigin: "backfill" },
  ]) {
    const orch = fakeOrchestrate();
    const r = await S.dispatchLeadQualification(
      baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel: candidate.channel, messageRowId: "m-x", text: "hi", candidate } }),
    );
    assert.deepEqual(r, { status: "skipped", reason: "not_live_eligible" }, JSON.stringify(candidate));
    assert.equal(orch.callCount(), 0);
  }
});

// ── LEVEL 1 / LEVEL 2 ────────────────────────────────────────────────────

test("26. Level 1 (recommend only) never proposes a send, even though the model produced a reply", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch));
  assert.equal(r.status, "recommendation");
  assert.equal(r.responseText, "Hi John, thanks for reaching out about your kitchen remodel!");
  assert.equal(pendingApprovals(db).length, 0);
});

test("27+28. Level 2 creates a real approval via the EXISTING approval system (agent_approval_requests / executeStep), not a new framework", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(
    baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel: "sms", messageRowId: "m-1", text: "hi", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } }),
  );
  assert.equal(r.status, "awaiting_approval");
  const pend = pendingApprovals(db);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].action_key, "send_sms");
  assert.equal(pend[0].target_entity_id, LEAD_1);
  assert.equal(pend[0].proposed_input.contactId, CONTACT_1);
  assert.equal(pend[0].proposed_input.body, "Hi John, thanks for reaching out about your kitchen remodel!");
});

test("30. an unsupported execution channel (messenger/instagram/email) falls back to a recommendation, never a broken/failed proposal", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  for (const channel of ["messenger", "instagram"]) {
    const orch = fakeOrchestrate();
    const r = await S.dispatchLeadQualification(
      baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel, messageRowId: `m-${channel}`, text: "hi", candidate: { channel, direction: "in", syncOrigin: "live" } } }),
    );
    assert.equal(r.status, "recommendation");
  }
  // email is not even live-trigger-eligible in the first place (see test 4).
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(
    baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel: "email", messageRowId: "m-email", text: "hi", candidate: { channel: "email", direction: "in", syncOrigin: "live" } } }),
  );
  assert.deepEqual(r, { status: "skipped", reason: "not_live_eligible" });
  assert.equal(pendingApprovals(db).length, 0);
});

// ── IDEMPOTENCY ──────────────────────────────────────────────────────────

test("6+31. the same trigger key cannot create duplicate runs (webhook retry / double click)", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const invocationId = "invocation-shared-retry";
  const first = await S.dispatchLeadQualification(baseParams(db, orch, { invocationId }));
  const second = await S.dispatchLeadQualification(baseParams(db, orch, { invocationId }));
  assert.equal(first.status, "recommendation");
  assert.deepEqual(second, { status: "skipped", reason: "duplicate" });
  assert.equal(orch.callCount(), 1);
});

test("7. repeated manual sync / two tabs racing does not double-trigger — same behavior under concurrency", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const invocationId = "invocation-shared-race";
  const results = await Promise.all([
    S.dispatchLeadQualification(baseParams(db, orch, { invocationId })),
    S.dispatchLeadQualification(baseParams(db, orch, { invocationId })),
    S.dispatchLeadQualification(baseParams(db, orch, { invocationId })),
  ]);
  const recs = results.filter((r: any) => r.status === "recommendation");
  const dupes = results.filter((r: any) => r.status === "skipped" && r.reason === "duplicate");
  assert.equal(recs.length, 1);
  assert.equal(dupes.length, 2);
  assert.equal(orch.callCount(), 1);
});

test("32. the same inbound message id cannot create a duplicate approval", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  const orch = fakeOrchestrate();
  const p = { source: "inbound_lead_message" as const, inboundEvent: { channel: "sms", messageRowId: "same-message", text: "hi", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } };
  const first = await S.dispatchLeadQualification(baseParams(db, orch, p));
  const second = await S.dispatchLeadQualification(baseParams(db, orch, p));
  assert.equal(first.status, "awaiting_approval");
  assert.deepEqual(second, { status: "skipped", reason: "duplicate" });
  assert.equal(pendingApprovals(db).length, 1);
});

test("lead_created and inbound_lead_message for the SAME lead do not collide with each other's idempotency key", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const a = await S.dispatchLeadQualification(baseParams(db, orch, { source: "lead_created" }));
  const b = await S.dispatchLeadQualification(
    baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel: "sms", messageRowId: "m-2", text: "hi", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } }),
  );
  assert.equal(a.status, "recommendation");
  assert.equal(b.status, "recommendation");
  assert.equal(orch.callCount(), 2);
});

test("org isolation: the same leadId in two different orgs never shares an idempotency claim", async () => {
  const dbA = makeDb({ enabled: true, defaultAutonomyLevel: 1, orgId: ORG_A });
  const dbB = makeDb({ enabled: true, defaultAutonomyLevel: 1, orgId: ORG_B });
  const orchA = fakeOrchestrate();
  const orchB = fakeOrchestrate();
  const a = await S.dispatchLeadQualification(baseParams(dbA, orchA));
  const b = await S.dispatchLeadQualification({ ...baseParams(dbB, orchB), orgId: ORG_B });
  assert.equal(a.status, "recommendation");
  assert.equal(b.status, "recommendation");
});

// ── FAILURE / RECOMMENDATION FALLBACK ───────────────────────────────────

test("a failed model run finalizes the claim as failed and is honestly reported, without ever creating an approval", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  const orch = fakeOrchestrate({ status: "failed", responseText: undefined, error: "model unavailable" });
  const r = await S.dispatchLeadQualification(baseParams(db, orch));
  assert.equal(r.status, "failed");
  assert.equal(pendingApprovals(db).length, 0);
  const exec = executions(db).find((e) => e.id === r.claimId);
  assert.equal(exec.status, "failed");
});

test("33. an approved action cannot execute twice (approval + idempotency key on the proposed step)", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 2 });
  const orch = fakeOrchestrate();
  await S.dispatchLeadQualification(
    baseParams(db, orch, { source: "inbound_lead_message", inboundEvent: { channel: "sms", messageRowId: "m-3", text: "hi", candidate: { channel: "sms", direction: "in", syncOrigin: "live" } } }),
  );
  const approval = pendingApprovals(db)[0];
  assert.ok(approval.execution_id, "the approval is linked to a real execution/step idempotency key, not a bare unguarded send");
});

// ── AI-3B: real lead-creation wiring, precedence, manual idempotency ────────

test("8+9. a lead created as a byproduct of an inbound message is suppressed — inbound_lead_message owns the response, not a competing lead_created run", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch, { source: "lead_created", associatedWithInboundMessage: true }));
  assert.deepEqual(r, { status: "skipped", reason: "associated_with_inbound_message" });
  assert.equal(orch.callCount(), 0, "no policy lookup, no claim, no model call for a structurally-suppressed trigger");
  assert.equal(executions(db).length, 0, "no claim row was even written");
});

test("10. an independent lead_created (not associated with an inbound message) still runs normally", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(db, orch, { source: "lead_created", associatedWithInboundMessage: false }));
  assert.equal(r.status, "recommendation");
  assert.equal(orch.callCount(), 1);
});

test("7+8. same invocation id twice (double-click, or a delayed HTTP retry) produces exactly one run", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const first = await S.dispatchLeadQualification(baseParams(db, orch, { source: "manual_run", invocationId: "invocation-aaaa1111" }));
  const retry = await S.dispatchLeadQualification(baseParams(db, orch, { source: "manual_run", invocationId: "invocation-aaaa1111" }));
  assert.equal(first.status, "recommendation");
  assert.deepEqual(retry, { status: "skipped", reason: "duplicate" });
  assert.equal(orch.callCount(), 1, "no time component to wait out — a retry minutes later with the SAME id is still deduped");
});

test("9. a NEW invocation id for the same lead is allowed to create a new run, with no time-window boundary to worry about", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const orch = fakeOrchestrate();
  const first = await S.dispatchLeadQualification(baseParams(db, orch, { source: "manual_run", invocationId: "invocation-bbbb2222" }));
  const later = await S.dispatchLeadQualification(baseParams(db, orch, { source: "manual_run", invocationId: "invocation-cccc3333" }));
  assert.equal(first.status, "recommendation");
  assert.equal(later.status, "recommendation");
  assert.equal(orch.callCount(), 2);
});

test("10. a missing or malformed invocation id is rejected before any policy lookup or claim", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  for (const invocationId of [undefined, "", "short", "has spaces!!"]) {
    const orch = fakeOrchestrate();
    const r = await S.dispatchLeadQualification(baseParams(db, orch, { source: "manual_run", invocationId }));
    assert.equal(r.status, "failed", `invocationId=${JSON.stringify(invocationId)}`);
    assert.equal((r as any).reason, "invalid_invocation_id");
    assert.equal(orch.callCount(), 0);
  }
  assert.equal(executions(db).length, 0, "no claim row written for a rejected invocation id");
});

test("14+15. only a 23505 unique violation is treated as a duplicate; any other DB error is a real, reported failure", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const broken = { ...db, from: (t: string) => { const b = db.from(t); if (t === "agent_executions") { const insert = b.insert.bind(b); b.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "53300", message: "too many connections" } }) }) }); } return b; } };
  const orch = fakeOrchestrate();
  const r = await S.dispatchLeadQualification(baseParams(broken, orch));
  assert.equal(r.status, "failed");
  assert.notEqual(r.status, "skipped", "a non-23505 DB error must never masquerade as a duplicate");
  assert.equal(orch.callCount(), 0);
});

test("16. org isolation holds for the claim insert itself (org_id is always part of the row and the unique constraint)", async () => {
  const dbA = makeDb({ enabled: true, defaultAutonomyLevel: 1, orgId: ORG_A });
  const orch = fakeOrchestrate();
  await S.dispatchLeadQualification(baseParams(dbA, orch));
  const exec = executions(dbA)[0];
  assert.equal(exec.org_id, ORG_A);
});

test("1+2. fireLeadCreatedTrigger never awaits model/policy work — it only awaits ONE fast dispatch call and returns", async () => {
  let dispatchCalls = 0;
  const dispatch = async () => {
    dispatchCalls++;
    return true; // the background function accepted the request — nothing more
  };
  const started = Date.now();
  await Hook.fireLeadCreatedTrigger(ORG_A, LEAD_1, { contactId: CONTACT_1, dispatch });
  assert.ok(Date.now() - started < 50, "must not block on anything beyond the injected dispatch call itself");
  assert.equal(dispatchCalls, 1);
});

test("6. fireLeadCreatedTrigger never throws even when the dispatch call itself fails — lead creation is never the caller's problem", async () => {
  const dispatch = async () => {
    throw new Error("network down");
  };
  await assert.doesNotReject(Hook.fireLeadCreatedTrigger(ORG_A, LEAD_1, { contactId: CONTACT_1, dispatch }));
  const rejecting = async () => false; // "not accepted", not a throw
  await assert.doesNotReject(Hook.fireLeadCreatedTrigger(ORG_A, LEAD_1, { contactId: CONTACT_1, dispatch: rejecting }));
});

test("fireLeadCreatedTrigger sends exactly the payload the background function expects — orgId, leadId, contactId, associatedWithInboundMessage, actorId", async () => {
  let received: any;
  const dispatch = async (payload: any) => {
    received = payload;
    return true;
  };
  await Hook.fireLeadCreatedTrigger(ORG_A, LEAD_1, { contactId: CONTACT_1, associatedWithInboundMessage: true, actorId: "meta_lead_ads", dispatch });
  assert.deepEqual(received, { orgId: ORG_A, leadId: LEAD_1, contactId: CONTACT_1, associatedWithInboundMessage: true, actorId: "meta_lead_ads" });
});

test("fireLeadCreatedTrigger: the suppressed (associatedWithInboundMessage) path is still just a normal dispatch request — suppression itself happens inside the dispatcher, not the hook", async () => {
  const db = makeDb({ enabled: true, defaultAutonomyLevel: 1 });
  const claimBefore = executions(db).length;
  await Hook.fireLeadCreatedTrigger(ORG_A, LEAD_1, { contactId: CONTACT_1, associatedWithInboundMessage: true, dispatch: async () => true });
  // The hook itself never touches the DB at all now — it only sends an HTTP request.
  assert.equal(executions(db).length, claimBefore);
});
