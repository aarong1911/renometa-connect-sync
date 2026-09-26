// netlify/functions/lib/meta-whatsapp-coalesce.test.ts
//
// Run:  node --test netlify/functions/lib/meta-whatsapp-coalesce.test.ts
// (Node 22/24 native TypeScript type stripping + built-in test runner, same
//  convention as voice-scheduling.test.ts. The code under test is bundled with
//  esbuild — resolved through vite — only because it imports src/ modules
//  that use the "@/" alias.)
//
// SAFETY: in-memory fake Supabase only (test-support/fake-supabase-client.mjs).
// No production Supabase, Meta/WhatsApp, Twilio or Anthropic: the AI
// orchestrator is injected as a fake and global fetch is replaced with a
// function that throws, so any accidental network call fails the test.
//
// Covers WhatsApp burst coalescing + the one-active-pending-approval invariant:
//   creation / burst / isolation (contact, org) / supersede / concurrent
//   reconcile / stale approve+reject / normal approve+reject / other actions
//   untouched / pending count / debounce config / retry + idempotency /
//   watermark + quiet window / failed newest run.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

// Deny-by-default network.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("Network access is not allowed in meta-whatsapp-coalesce.test.ts");
}) as typeof fetch;

const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "wa-coalesce-"));
await esbuild.build({
  entryPoints: [path.join(here, "test-support/whatsapp-coalesce-subject.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(repoRoot, "src") },
  external: ["nodemailer", "@supabase/supabase-js"],
  define: {
    "import.meta.env.VITE_SUPABASE_URL": '"https://fake.supabase.co"',
    "import.meta.env.VITE_SUPABASE_ANON_KEY": '"fake"',
    "import.meta.env.DEV": "false",
  },
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(here, "test-support/fake-supabase-client.mjs")).href);

after(() => {
  globalThis.fetch = realFetch;
  rmSync(outDir, { recursive: true, force: true });
});

// Silence the code under test's own logging.
const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => console[k]);
noisy.forEach((k) => {
  console[k] = () => {};
});
after(() => noisy.forEach((k, i) => (console[k] = saved[i])));

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const C2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const C3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const BASE = Date.now() - 3600_000; // inside WhatsApp's 24h reply window
const at = (sec: number) => new Date(BASE + sec * 1000).toISOString();

function msg(org: string, contact: string, id: string, sec: number, direction = "in", body = id) {
  return { id, org_id: org, contact_id: contact, channel: "whatsapp", direction, body, from_address: "+1", created_at: at(sec), meta: null, provider_message_id: `pm-${id}` };
}

/** The real approvals table defaults status='pending' and requested_at=now(); the fake has no column defaults. */
function withDefaults(db: any) {
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

function makeDb(rows: any[] = []) {
  return withDefaults(
    createFakeSupabaseClient({
      contacts: [
        { id: C1, org_id: ORG_A },
        { id: C2, org_id: ORG_A },
        { id: C3, org_id: ORG_B },
      ],
      sms_meta_messages: rows,
      agent_approval_requests: [],
      agent_executions: [],
      agent_execution_steps: [],
      agent_action_idempotency: [],
      agent_events: [],
      agent_usage_events: [],
      organizations: [{ id: ORG_A }, { id: ORG_B }],
    }),
  );
}

let seq = 0;
type Orch = { calls: string[]; fn: any };
function makeOrchestrator(opts: { fail?: boolean; onRun?: (db: any) => Promise<void>; throwOnce?: boolean } = {}): Orch {
  const calls: string[] = [];
  let threw = false;
  const fn = async (a: any) => {
    calls.push(a.event.content.text);
    if (opts.throwOnce && !threw) {
      threw = true;
      throw new Error("simulated orchestrator crash");
    }
    const executionId = `exec-${++seq}`;
    await a.supabase.from("agent_executions").insert({ id: executionId, org_id: a.trustedContext.orgId, status: "awaiting_approval" });
    if (opts.onRun) await opts.onRun(a.supabase);
    if (opts.fail) return { status: "failed", executionId, error: "model unavailable" };
    return { status: "completed", executionId, responseText: `reply to: ${a.event.content.text}` };
  };
  return { calls, fn };
}

const payload = (org: string, contact: string, id: string) => ({ orgId: org, contactId: contact, phone: "+1", body: id, providerMessageId: `pm-${id}`, inboundMessageId: id });
const deps = (db: any, orch: Orch, extra: any = {}) => ({ supabase: db, orchestrate: orch.fn, debounceMs: 5, sleep: async () => {}, ...extra });
const run = (db: any, orch: Orch, org: string, contact: string, id: string, extra: any = {}) => S.processWhatsAppBackground(payload(org, contact, id), deps(db, orch, extra));

const approvals = async (db: any, status?: string, org?: string) => {
  let rows = (await db.from("agent_approval_requests").select("*")).data as any[];
  if (status) rows = rows.filter((r) => r.status === status);
  if (org) rows = rows.filter((r) => r.org_id === org);
  return rows;
};
const pending = (db: any, org?: string) => approvals(db, "pending", org);
const insertApproval = (db: any, row: Record<string, unknown>) =>
  db.from("agent_approval_requests").insert({ org_id: ORG_A, action_key: "send_whatsapp", target_entity_type: "contact", target_entity_id: C1, ...row });

// ─────────────────────────────────────────────
// 1–4. Creation, burst, isolation
// ─────────────────────────────────────────────
test("1. one inbound -> one AI run and one pending approval carrying trigger metadata", async () => {
  const db = makeDb([msg(ORG_A, C1, "m1", 1)]);
  const orch = makeOrchestrator();
  const r = await run(db, orch, ORG_A, C1, "m1");
  const pend = await pending(db);
  assert.equal(orch.calls.length, 1);
  assert.equal(r.proposeResult.status, "awaiting_approval");
  assert.equal(pend.length, 1);
  assert.equal(pend[0].metadata.inbound_message_id, "m1");
  assert.equal(pend[0].metadata.conversation_key, `${C1}::whatsapp`);
});

test("2. three rapid same-conversation messages (concurrent invocations) -> one AI run, one pending approval", async () => {
  const db = makeDb([msg(ORG_A, C1, "b1", 1, "in", "47"), msg(ORG_A, C1, "b2", 2, "in", "👍"), msg(ORG_A, C1, "b3", 3, "in", "OK")]);
  const orch = makeOrchestrator();
  const results = await Promise.all(["b1", "b2", "b3"].map((id) => run(db, orch, ORG_A, C1, id)));
  assert.equal(orch.calls.length, 1);
  assert.equal(orch.calls[0], "47\n👍\nOK", "the single run sees the whole burst");
  assert.equal(results.filter((x: any) => x.coalesced).length, 2);
  assert.equal((await pending(db)).length, 1);
  assert.equal((await db.from("sms_meta_messages").select("id").eq("org_id", ORG_A)).data.length, 3, "no message is lost");
});

test("2b. burst text covers only inbound messages since the last outbound message", async () => {
  const db = makeDb([msg(ORG_A, C1, "o1", 1, "in", "old"), msg(ORG_A, C1, "o2", 2, "out", "reply"), msg(ORG_A, C1, "o3", 3, "in", "new1"), msg(ORG_A, C1, "o4", 4, "in", "new2")]);
  assert.equal(await S.collectInboundBurstText(db, ORG_A, C1, "x"), "new1\nnew2");
});

test("3. two contacts in one org -> isolated approvals", async () => {
  const db = makeDb([msg(ORG_A, C1, "x1", 1), msg(ORG_A, C2, "x2", 1)]);
  const orch = makeOrchestrator();
  await Promise.all([run(db, orch, ORG_A, C1, "x1"), run(db, orch, ORG_A, C2, "x2")]);
  const pend = await pending(db);
  assert.equal(orch.calls.length, 2);
  assert.deepEqual(pend.map((p: any) => p.target_entity_id).sort(), [C1, C2]);
});

test("4. two orgs -> isolated approvals; one org's messages never coalesce or cancel the other's", async () => {
  const db = makeDb([msg(ORG_A, C1, "y1", 1), msg(ORG_B, C3, "y2", 2)]);
  const orch = makeOrchestrator();
  await Promise.all([run(db, orch, ORG_A, C1, "y1"), run(db, orch, ORG_B, C3, "y2")]);
  assert.equal((await pending(db, ORG_A)).length, 1);
  assert.equal((await pending(db, ORG_B)).length, 1);
  // A newer message in org B must not touch org A's pending approval.
  await db.from("sms_meta_messages").insert(msg(ORG_B, C3, "y3", 50));
  await run(db, orch, ORG_B, C3, "y3");
  assert.equal((await pending(db, ORG_A)).length, 1);
  assert.equal((await approvals(db, "cancelled", ORG_A)).length, 0);
});

// ─────────────────────────────────────────────
// 5–7. Supersede + deterministic reconcile
// ─────────────────────────────────────────────
test("5+6+14. new inbound while an approval is pending -> one active pending; old one cancelled (history kept); pending count is active-only", async () => {
  const db = makeDb([msg(ORG_A, C1, "p1", 1)]);
  const orch = makeOrchestrator();
  await run(db, orch, ORG_A, C1, "p1");
  const [first] = await pending(db);
  assert.ok(first);

  await db.from("sms_meta_messages").insert(msg(ORG_A, C1, "p2", 100));
  await run(db, orch, ORG_A, C1, "p2");

  const pend = await pending(db);
  assert.equal(pend.length, 1, "badge count = active pending only");
  assert.notEqual(pend[0].id, first.id);
  assert.equal(pend[0].metadata.inbound_message_id, "p2");
  const old = (await approvals(db)).find((a) => a.id === first.id);
  assert.equal(old.status, "cancelled", "superseded row is kept for audit, not deleted");
  assert.equal(old.metadata.superseded_at_watermark, "p2");
  const execs = (await db.from("agent_executions").select("id, status").eq("org_id", ORG_A)).data;
  assert.equal(execs.filter((e: any) => e.status === "cancelled").length, 1);
  assert.equal(execs.filter((e: any) => e.status === "awaiting_approval").length, 1);
});

test("7. concurrent reconcile -> deterministic winner is the approval for the newest message, not the newest row", async () => {
  const db = makeDb([msg(ORG_A, C1, "n-old", 10), msg(ORG_A, C1, "n-new", 50)]);
  // The approval for the OLDER message happens to be created LATER (slow run).
  await insertApproval(db, { id: "for-new", execution_id: "e1", requested_at: at(60), metadata: { inbound_message_id: "n-new" } });
  await insertApproval(db, { id: "for-old-created-later", execution_id: "e2", requested_at: at(70), metadata: { inbound_message_id: "n-old" } });
  const [r1, r2] = await Promise.all([S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1), S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1)]);
  const pend = await pending(db);
  assert.equal(pend.length, 1, "never zero, never two");
  assert.equal(pend[0].id, "for-new");
  assert.equal(r1.keptApprovalId, "for-new");
  assert.equal(r2.keptApprovalId, "for-new");
});

test("7b. duplicate pending approvals for the SAME trigger collapse to the latest one", async () => {
  const db = makeDb([msg(ORG_A, C1, "d1", 10)]);
  await insertApproval(db, { id: "dup-a", execution_id: "e1", requested_at: at(20), metadata: { inbound_message_id: "d1" } });
  await insertApproval(db, { id: "dup-b", execution_id: "e2", requested_at: at(21), metadata: { inbound_message_id: "d1" } });
  await S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1);
  assert.deepEqual((await pending(db)).map((p: any) => p.id), ["dup-b"]);
});

// ─────────────────────────────────────────────
// 8–11. Approve / reject, stale race
// ─────────────────────────────────────────────
async function approvalFixture() {
  const db = makeDb();
  const input = { contactId: C1, body: "hello" };
  const hash = await S.hashProposedInput(input);
  const ins = (id: string, status: string) =>
    insertApproval(db, { id, status, execution_id: `e-${id}`, proposed_input: input, proposed_input_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  return { db, input, ins };
}

test("8. a stale/superseded approval cannot be approved", async () => {
  const { db, input, ins } = await approvalFixture();
  await ins("stale", "cancelled");
  const r = await S.approveRequest(db, "stale", ORG_A, "u1", input);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "already_decided");
  assert.equal((await approvals(db)).find((a) => a.id === "stale").status, "cancelled", "not resurrected");
});

test("9. a stale/superseded approval cannot be rejected (status stays cancelled)", async () => {
  const { db, ins } = await approvalFixture();
  await ins("stale", "cancelled");
  const r = await S.rejectRequest(db, "stale", ORG_A, "u1", "no");
  assert.equal(r.reason, "already_decided");
  assert.equal((await approvals(db)).find((a) => a.id === "stale").status, "cancelled");
});

test("10. the current approval approves normally", async () => {
  const { db, input, ins } = await approvalFixture();
  await ins("cur", "pending");
  const r = await S.approveRequest(db, "cur", ORG_A, "u1", input);
  assert.equal(r.ok, true);
  assert.equal(r.approval.status, "approved");
});

test("11. the current approval rejects normally", async () => {
  const { db, ins } = await approvalFixture();
  await ins("rej", "pending");
  const r = await S.rejectRequest(db, "rej", ORG_A, "u1", "not now");
  assert.equal(r.ok, true);
  assert.equal(r.approval.status, "rejected");
});

test("E. approve racing a supersede: exactly one wins — A never sends after it was superseded", async () => {
  // Interleaving 1: the supersede commits between approve's read and its write.
  {
    const { db, input, ins } = await approvalFixture();
    await ins("A", "pending");
    const from = db.from.bind(db);
    db.from = (table: string) => {
      const b = from(table);
      if (table !== "agent_approval_requests") return b;
      const update = b.update.bind(b);
      b.update = (o: any) => {
        if (o.status === "approved") from("agent_approval_requests").update({ status: "cancelled" }).eq("id", "A").then(() => {});
        return update(o);
      };
      return b;
    };
    const r = await S.approveRequest(db, "A", ORG_A, "u1", input);
    assert.equal(r.ok, false, "approve lost the race: caller must not execute/send");
    assert.equal((await approvals(db)).find((a) => a.id === "A").status, "cancelled");
  }
  // Interleaving 2: approve commits first -> the supersede's conditional update matches nothing.
  {
    const { db, input, ins } = await approvalFixture();
    await db.from("sms_meta_messages").insert(msg(ORG_A, C1, "newer", 5));
    await ins("A", "pending");
    await db.from("agent_approval_requests").update({ metadata: { inbound_message_id: "older" } }).eq("id", "A");
    const r = await S.approveRequest(db, "A", ORG_A, "u1", input);
    assert.equal(r.ok, true);
    const res = await S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1);
    assert.deepEqual(res.cancelledApprovalIds, [], "an approval already claimed is never cancelled");
    assert.equal((await approvals(db)).find((a) => a.id === "A").status, "approved");
  }
});

// ─────────────────────────────────────────────
// 12–13. Other approvals untouched
// ─────────────────────────────────────────────
test("12+13. SMS and non-send_whatsapp approvals are unaffected by WhatsApp reconciliation", async () => {
  const db = makeDb([msg(ORG_A, C1, "z1", 1)]);
  await insertApproval(db, { id: "sms1", action_key: "send_sms", execution_id: "e1", requested_at: at(1), metadata: { inbound_message_id: "old" } });
  await insertApproval(db, { id: "task1", action_key: "create_follow_up_task", execution_id: "e2", requested_at: at(2) });
  await insertApproval(db, { id: "wa-stale", execution_id: "e3", requested_at: at(3), metadata: { inbound_message_id: "old" } });
  await insertApproval(db, { id: "wa-cur", execution_id: "e4", requested_at: at(4), metadata: { inbound_message_id: "z1" } });
  await S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1);
  assert.deepEqual((await pending(db)).map((p: any) => p.id).sort(), ["sms1", "task1", "wa-cur"]);
});

// ─────────────────────────────────────────────
// 15. Debounce config
// ─────────────────────────────────────────────
test("15. debounce config: default, override, clamp, invalid, zero", () => {
  assert.equal(S.resolveWhatsAppDebounceMs(undefined), 4000);
  assert.equal(S.resolveWhatsAppDebounceMs(""), 4000);
  assert.equal(S.resolveWhatsAppDebounceMs("2500"), 2500);
  assert.equal(S.resolveWhatsAppDebounceMs("999999"), 10000);
  assert.equal(S.resolveWhatsAppDebounceMs("abc"), 4000);
  assert.equal(S.resolveWhatsAppDebounceMs("-5"), 4000);
  assert.equal(S.resolveWhatsAppDebounceMs("0"), 0);
});

// ─────────────────────────────────────────────
// 16. Retry / idempotency
// ─────────────────────────────────────────────
test("16a. duplicate delivery of the same message runs the AI once", async () => {
  const db = makeDb([msg(ORG_A, C1, "r1", 1)]);
  const orch = makeOrchestrator();
  const results = await Promise.all([run(db, orch, ORG_A, C1, "r1"), run(db, orch, ORG_A, C1, "r1")]);
  assert.equal(orch.calls.length, 1);
  assert.equal(results.filter((x: any) => x.claimed === false).length, 1);
  assert.equal((await pending(db)).length, 1);
  // A later redelivery after completion is also a no-op.
  const again = await run(db, orch, ORG_A, C1, "r1");
  assert.equal(again.claimed, false);
  assert.equal(orch.calls.length, 1);
});

test("16b. an invocation that dies while waiting burns nothing: a retry converges on the same single run", async () => {
  const db = makeDb([msg(ORG_A, C1, "s1", 1)]);
  const orch = makeOrchestrator();
  // Force a real wait, and have the sleep blow up (instance killed mid-debounce).
  const now = () => new Date(at(1)).getTime() + 1;
  await assert.rejects(run(db, orch, ORG_A, C1, "s1", { debounceMs: 4000, now, sleep: async () => { throw new Error("instance killed"); } }));
  assert.equal(orch.calls.length, 0);
  const row = (await db.from("sms_meta_messages").select("meta").eq("id", "s1").maybeSingle()).data;
  assert.equal(row.meta, null, "message is still unclaimed");
  await run(db, orch, ORG_A, C1, "s1", { debounceMs: 4000, now, sleep: async () => {} });
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
});

test("16c. an orchestrator crash releases the claim so a platform retry can run; still one pending approval", async () => {
  const db = makeDb([msg(ORG_A, C1, "t1", 1)]);
  const orch = makeOrchestrator({ throwOnce: true });
  await assert.rejects(run(db, orch, ORG_A, C1, "t1"), /simulated orchestrator crash/);
  await run(db, orch, ORG_A, C1, "t1");
  assert.equal(orch.calls.length, 2);
  assert.equal((await pending(db)).length, 1);
});

// ─────────────────────────────────────────────
// 17. Watermark + quiet window
// ─────────────────────────────────────────────
test("17a. an older message's invocation exits without side effects once a newer inbound exists", async () => {
  const db = makeDb([msg(ORG_A, C1, "w1", 1), msg(ORG_A, C1, "w2", 2)]);
  const orch = makeOrchestrator();
  const r = await run(db, orch, ORG_A, C1, "w1");
  assert.equal(r.coalesced, true);
  assert.equal(orch.calls.length, 0);
  const row = (await db.from("sms_meta_messages").select("meta").eq("id", "w1").maybeSingle()).data;
  assert.equal(row.meta, null, "not claimed: a retry re-derives the same decision from the DB");
});

test("17b. the quiet window is measured from the message's DB timestamp, and the sleep is only the remainder", async () => {
  const db = makeDb([msg(ORG_A, C1, "q1", 1)]);
  const orch = makeOrchestrator();
  const slept: number[] = [];
  const created = new Date(at(1)).getTime();
  await run(db, orch, ORG_A, C1, "q1", { debounceMs: 4000, now: () => created + 1500, sleep: async (ms: number) => void slept.push(ms) });
  assert.deepEqual(slept, [2500]);
  // Already quiet for longer than the window (e.g. a late retry): no sleep at all.
  const db2 = makeDb([msg(ORG_A, C1, "q2", 1)]);
  const slept2: number[] = [];
  await run(db2, makeOrchestrator(), ORG_A, C1, "q2", { debounceMs: 4000, now: () => created + 60_000, sleep: async (ms: number) => void slept2.push(ms) });
  assert.deepEqual(slept2, []);
  assert.equal(S.remainingQuietMs("not-a-date", 4000, 0), 4000);
});

test("17c. a message that arrives during the quiet window takes over the watermark; the earlier run stands down", async () => {
  const db = makeDb([msg(ORG_A, C1, "v1", 1)]);
  const orch = makeOrchestrator();
  const created = new Date(at(1)).getTime();
  const r = await run(db, orch, ORG_A, C1, "v1", {
    debounceMs: 4000,
    now: () => created + 100,
    sleep: async () => {
      await db.from("sms_meta_messages").insert(msg(ORG_A, C1, "v2", 2));
    },
  });
  assert.equal(r.coalesced, true);
  assert.equal(orch.calls.length, 0);
  await run(db, orch, ORG_A, C1, "v2");
  assert.equal(orch.calls.length, 1);
  assert.equal(orch.calls[0], "v1\nv2");
  assert.equal((await pending(db)).length, 1);
});

// ─────────────────────────────────────────────
// 18. Failure of the newest run never resurrects/keeps a stale approval
// ─────────────────────────────────────────────
test("18a. newest run FAILS -> the older approval stays cancelled and no stale approval is pending", async () => {
  const db = makeDb([msg(ORG_A, C1, "f1", 1)]);
  await run(db, makeOrchestrator(), ORG_A, C1, "f1");
  const [stale] = await pending(db);
  assert.ok(stale);

  await db.from("sms_meta_messages").insert(msg(ORG_A, C1, "f2", 100));
  const failing = makeOrchestrator({ fail: true });
  await run(db, failing, ORG_A, C1, "f2");
  assert.equal(failing.calls.length, 1);
  assert.equal((await pending(db)).length, 0, "nothing stale left approvable");
  assert.equal((await approvals(db)).find((a) => a.id === stale.id).status, "cancelled");

  // Even a later reconcile / redelivery cannot bring it back.
  await S.reconcilePendingWhatsAppApprovals(db, ORG_A, C1);
  await run(db, makeOrchestrator(), ORG_A, C1, "f1");
  assert.equal((await approvals(db)).find((a) => a.id === stale.id).status, "cancelled");
});

test("18b. an older run that finishes AFTER a newer message arrived has its approval cancelled on creation", async () => {
  const db = makeDb([msg(ORG_A, C1, "g1", 1)]);
  // g2 lands while g1's AI run is in flight (after g1 passed the gate).
  const orch = makeOrchestrator({ onRun: async (d) => void (await d.from("sms_meta_messages").insert(msg(ORG_A, C1, "g2", 2))) });
  await run(db, orch, ORG_A, C1, "g1");
  assert.equal((await pending(db)).length, 0);
  assert.equal((await approvals(db, "cancelled")).length, 1);
  await run(db, makeOrchestrator(), ORG_A, C1, "g2");
  const pend = await pending(db);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].metadata.inbound_message_id, "g2");
});

// ─────────────────────────────────────────────
// 19+. Claim LEASE: hard-kill recovery without duplicate runs
// ─────────────────────────────────────────────
const LEASE = 5 * 60 * 1000;
const metaOf = async (db: any, id: string) => (await db.from("sms_meta_messages").select("meta").eq("id", id).maybeSingle()).data.meta;

test("19. lease constant is bounded and covers the worst-case AI run (4 model calls x 55s)", () => {
  assert.equal(S.WHATSAPP_AI_CLAIM_LEASE_MS, LEASE);
  assert.ok(S.WHATSAPP_AI_CLAIM_LEASE_MS > 4 * 55_000);
  assert.ok(S.WHATSAPP_AI_CLAIM_LEASE_MS <= 15 * 60_000);
});

test("20. an active claim cannot be stolen", async () => {
  const db = makeDb([msg(ORG_A, C1, "l1", 1)]);
  const t0 = Date.now();
  const first = await S.claimForAiDispatch(db, ORG_A, "l1", t0);
  assert.ok(first);
  assert.equal(await S.claimForAiDispatch(db, ORG_A, "l1", t0 + 1000), null);
  assert.equal(await S.claimForAiDispatch(db, ORG_A, "l1", t0 + LEASE - 1), null, "still inside the lease");
  assert.equal((await metaOf(db, "l1")).ai_dispatch_claim_token, first.token);
});

test("21. an expired claim can be reclaimed, and the previous owner can no longer write to it", async () => {
  const db = makeDb([msg(ORG_A, C1, "l2", 1)]);
  const t0 = Date.now();
  const dead = await S.claimForAiDispatch(db, ORG_A, "l2", t0);
  const fresh = await S.claimForAiDispatch(db, ORG_A, "l2", t0 + LEASE + 1);
  assert.ok(fresh);
  assert.notEqual(fresh.token, dead.token);
  await S.releaseClaim(db, ORG_A, "l2", dead); // stale owner: no-op
  assert.equal((await metaOf(db, "l2")).ai_dispatch_claim_token, fresh.token);
  assert.equal(await S.linkClaimExecution(db, ORG_A, "l2", dead, "exec-x"), false);
  assert.equal(await S.linkClaimExecution(db, ORG_A, "l2", fresh, "exec-y"), true);
});

test("22. two workers racing to reclaim an expired claim -> exactly one winner", async () => {
  const db = makeDb([msg(ORG_A, C1, "l3", 1)]);
  const t0 = Date.now();
  await S.claimForAiDispatch(db, ORG_A, "l3", t0);
  const results = await Promise.all([1, 2, 3, 4].map(() => S.claimForAiDispatch(db, ORG_A, "l3", t0 + LEASE + 1)));
  assert.equal(results.filter(Boolean).length, 1);
});

test("23. hard-kill simulation: claim persists, lease expires, retry proceeds; one eventual approval", async () => {
  const db = makeDb([msg(ORG_A, C1, "k1", 1)]);
  const orch = makeOrchestrator();
  const t0 = Date.now();
  await S.claimForAiDispatch(db, ORG_A, "k1", t0); // worker died right after claiming
  // Redelivery during the lease: no-op.
  const early = await run(db, orch, ORG_A, C1, "k1", { now: () => t0 + 60_000 });
  assert.equal(early.claimed, false);
  assert.equal(orch.calls.length, 0);
  // Retry after the lease expired: runs.
  const late = await run(db, orch, ORG_A, C1, "k1", { now: () => t0 + LEASE + 1000 });
  assert.equal(late.proposeResult.status, "awaiting_approval");
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
  // And it is terminal afterwards.
  const again = await run(db, orch, ORG_A, C1, "k1", { now: () => t0 + 10 * LEASE });
  assert.equal(again.claimed, false);
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
});

test("24. a completed message is never reprocessed, even long after the lease time", async () => {
  const db = makeDb([msg(ORG_A, C1, "c1", 1)]);
  const orch = makeOrchestrator();
  await run(db, orch, ORG_A, C1, "c1");
  assert.ok((await metaOf(db, "c1")).ai_dispatch_completed_at);
  const r = await run(db, orch, ORG_A, C1, "c1", { now: () => Date.now() + 3 * LEASE });
  assert.equal(r.claimed, false);
  assert.equal(orch.calls.length, 1);
  // A run whose model call failed is also terminal (no retry loop on model errors).
  const db2 = makeDb([msg(ORG_A, C1, "c2", 1)]);
  await run(db2, makeOrchestrator({ fail: true }), ORG_A, C1, "c2");
  assert.ok((await metaOf(db2, "c2")).ai_dispatch_completed_at);
});

test("25. an older message with an expired claim is not reclaimed once a newer watermark exists", async () => {
  const db = makeDb([msg(ORG_A, C1, "h1", 1), msg(ORG_A, C1, "h2", 2)]);
  const orch = makeOrchestrator();
  const t0 = Date.now();
  const dead = await S.claimForAiDispatch(db, ORG_A, "h1", t0);
  const r = await run(db, orch, ORG_A, C1, "h1", { now: () => t0 + LEASE + 1000 });
  assert.equal(r.coalesced, true);
  assert.equal(orch.calls.length, 0);
  assert.equal((await metaOf(db, "h1")).ai_dispatch_claim_token, dead.token, "claim untouched");
  // The newest message still runs, with the whole burst.
  await run(db, orch, ORG_A, C1, "h2", { now: () => t0 + LEASE + 1000 });
  assert.equal(orch.calls.length, 1);
  assert.equal(orch.calls[0], "h1\nh2");
  assert.equal((await pending(db)).length, 1);
});

test("26. a normal thrown orchestrator failure releases the claim immediately (no lease wait)", async () => {
  const db = makeDb([msg(ORG_A, C1, "e1", 1)]);
  const orch = makeOrchestrator({ throwOnce: true });
  await assert.rejects(run(db, orch, ORG_A, C1, "e1"), /simulated orchestrator crash/);
  assert.equal(await metaOf(db, "e1"), null);
  await run(db, orch, ORG_A, C1, "e1"); // immediate retry, well inside the lease
  assert.equal(orch.calls.length, 2);
  assert.equal((await pending(db)).length, 1);
});

test("27. a duplicate invocation while a run is in flight produces one AI run", async () => {
  const db = makeDb([msg(ORG_A, C1, "i1", 1)]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const orch = makeOrchestrator({ onRun: async () => void (await gate) });
  const first = run(db, orch, ORG_A, C1, "i1");
  await new Promise((r) => setTimeout(r, 20)); // first is now inside orchestrate, lease active
  const dup = await run(db, orch, ORG_A, C1, "i1");
  assert.equal(dup.claimed, false);
  release();
  await first;
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
});

test("28. a worker whose lease was taken over stands down (no duplicate proposal); a later retry converges on one approval", async () => {
  const db = makeDb([msg(ORG_A, C1, "j1", 1)]);
  const t0 = Date.now();
  const takeoverAt = t0 + LEASE + 5000;
  let taken: any = null;
  const orchA = makeOrchestrator({
    onRun: async (d) => {
      // While A is stuck in the model call its lease expires and worker B reclaims the message.
      taken = await S.claimForAiDispatch(d, ORG_A, "j1", takeoverAt);
    },
  });
  const a = await run(db, orchA, ORG_A, C1, "j1", { now: () => t0 });
  assert.ok(taken, "B reclaimed the expired lease");
  assert.equal(a.leaseLost, true);
  assert.equal(a.proposeResult, undefined, "A proposed nothing");
  assert.equal((await pending(db)).length, 0);
  assert.equal((await metaOf(db, "j1")).ai_dispatch_claim_token, taken.token, "B's claim was not clobbered by A");
  // B also dies; a later retry converges on exactly one approval.
  await run(db, makeOrchestrator(), ORG_A, C1, "j1", { now: () => takeoverAt + LEASE + 1000 });
  assert.equal((await pending(db)).length, 1);
});

test("29. claims written before the lease existed (no lease field) are terminal, never reclaimed", async () => {
  const db = makeDb([{ ...msg(ORG_A, C1, "old1", 1), meta: { ai_dispatch_claimed_at: at(1), execution_id: "x" } }]);
  assert.equal(await S.claimForAiDispatch(db, ORG_A, "old1", Date.now() + 10 * LEASE), null);
});

test("30. lease reclaim keeps the one-current-pending convergence", async () => {
  const db = makeDb([msg(ORG_A, C1, "u1", 1)]);
  const orch = makeOrchestrator();
  const t0 = Date.now();
  await S.claimForAiDispatch(db, ORG_A, "u1", t0);
  await run(db, orch, ORG_A, C1, "u1", { now: () => t0 + LEASE + 1000 });
  await db.from("sms_meta_messages").insert(msg(ORG_A, C1, "u2", 500));
  await run(db, orch, ORG_A, C1, "u2");
  const pend = await pending(db);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].metadata.inbound_message_id, "u2");
  assert.equal((await approvals(db, "cancelled")).length, 1);
});
