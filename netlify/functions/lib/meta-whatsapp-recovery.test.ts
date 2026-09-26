// netlify/functions/lib/meta-whatsapp-recovery.test.ts
//
// Run:  node --test netlify/functions/lib/meta-whatsapp-recovery.test.ts
// (same conventions as meta-whatsapp-coalesce.test.ts: Node native TypeScript
//  stripping + node:test, code under test bundled with esbuild via vite.)
//
// SAFETY: in-memory fake Supabase only. No production Supabase, Meta/WhatsApp,
// Twilio or Anthropic: the AI orchestrator is an injected fake, the "dispatch"
// of the recovery sweep is an in-process function (never a real fetch), and
// global fetch throws.
//
// Covers the lost-dispatch recovery sweep (lib/meta-whatsapp-recovery.ts):
// orphaned newest message recovered; completed / actively leased / older /
// outbound / non-WhatsApp / too young / too old ignored; expired claim
// eligible; per-contact and per-org isolation; failed redispatch stays
// recoverable; repeat and overlapping sweeps never duplicate AI work.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("Network access is not allowed in meta-whatsapp-recovery.test.ts");
}) as typeof fetch;

const req = createRequire(import.meta.url);
const esbuild = createRequire(req.resolve("vite/package.json"))("esbuild");
const outDir = mkdtempSync(path.join(tmpdir(), "wa-recovery-"));
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

const NOW = Date.now(); // the consent check inside executeStep uses the real clock
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();
const MIN = 60;
const LEASE = 5 * 60 * 1000;

type MsgOpts = { direction?: string; channel?: string; meta?: any; contact?: string | null; provider?: string | null };
function msg(org: string, contact: string, id: string, ageSec: number, o: MsgOpts = {}) {
  return {
    id,
    org_id: org,
    contact_id: o.contact === undefined ? contact : o.contact,
    channel: o.channel ?? "whatsapp",
    direction: o.direction ?? "in",
    body: `secret body of ${id}`,
    from_address: "+15550001111",
    created_at: ago(ageSec),
    meta: o.meta ?? null,
    provider_message_id: o.provider === undefined ? `pm-${id}` : o.provider,
  };
}

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

/** Recording dispatch that never touches the network. */
function recorder(ok = true) {
  const calls: any[] = [];
  return { calls, dispatch: async (p: any) => (calls.push(p), ok) };
}
const sweep = (db: any, dispatch: any) => S.runWhatsAppDispatchRecovery(db, { dispatch, now: () => NOW });

let seq = 0;
function makeOrchestrator() {
  const calls: string[] = [];
  const fn = async (a: any) => {
    calls.push(a.event.content.text);
    const executionId = `exec-${++seq}`;
    await a.supabase.from("agent_executions").insert({ id: executionId, org_id: a.trustedContext.orgId, status: "awaiting_approval" });
    return { status: "completed", executionId, responseText: "draft reply" };
  };
  return { calls, fn };
}
/** Dispatch that runs the REAL background processor in-process (what the HTTP hop would do). */
function inProcessDispatch(db: any, orch: { fn: any }) {
  return async (p: any) => {
    await S.processWhatsAppBackground(p, { supabase: db, orchestrate: orch.fn, debounceMs: 5, sleep: async () => {}, now: () => NOW });
    return true;
  };
}
const pending = async (db: any) => (await db.from("agent_approval_requests").select("*").eq("status", "pending")).data as any[];
const metaOf = async (db: any, id: string) => (await db.from("sms_meta_messages").select("meta").eq("id", id).maybeSingle()).data.meta;

// ─────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────
test("R1. an orphaned newest inbound message is redispatched with the original payload", async () => {
  const db = makeDb([msg(ORG_A, C1, "o1", 120)]);
  const r = recorder();
  const sum = await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], { orgId: ORG_A, contactId: C1, phone: "+15550001111", body: "secret body of o1", providerMessageId: "pm-o1", inboundMessageId: "o1" });
  assert.equal(sum.dispatched, 1);
});

test("R2. a completed message is ignored, including long after its lease time", async () => {
  const db = makeDb([msg(ORG_A, C1, "c1", 120, { meta: { ai_dispatch_claimed_at: ago(200), ai_dispatch_completed_at: ago(100), ai_dispatch_claim_token: "t" } })]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R3. a message with an ACTIVE claim lease is ignored", async () => {
  const db = makeDb([msg(ORG_A, C1, "a1", 120)]);
  await S.claimForAiDispatch(db, ORG_A, "a1", NOW - 10_000);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R4. an expired/abandoned claim (lease over, not completed) is eligible", async () => {
  const db = makeDb([msg(ORG_A, C1, "e1", 900)]);
  await S.claimForAiDispatch(db, ORG_A, "e1", NOW - LEASE - 5000);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.deepEqual(r.calls.map((c) => c.inboundMessageId), ["e1"]);
});

test("R5. only the newest inbound of a conversation is redispatched (older orphans never get their own run)", async () => {
  const db = makeDb([msg(ORG_A, C1, "n1", 300), msg(ORG_A, C1, "n2", 200), msg(ORG_A, C1, "n3", 100)]);
  const r = recorder();
  const sum = await sweep(db, r.dispatch);
  assert.deepEqual(r.calls.map((c) => c.inboundMessageId), ["n3"]);
  assert.equal(sum.candidates, 1);
});

test("R5b. an older orphan is not resurrected when the NEWER message was processed normally", async () => {
  const done = { ai_dispatch_claimed_at: ago(90), ai_dispatch_completed_at: ago(80), ai_dispatch_claim_token: "t" };
  const db = makeDb([msg(ORG_A, C1, "p1", 300), msg(ORG_A, C1, "p2", 100, { meta: done })]);
  const r = recorder();
  const sum = await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
  assert.equal(sum.skippedNotNewest, 1);
});

test("R5c. an orphan already answered by a newer outbound message is ignored", async () => {
  const db = makeDb([msg(ORG_A, C1, "q1", 300), msg(ORG_A, C1, "q2", 100, { direction: "out" })]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R6. two contacts in one org recover independently", async () => {
  const db = makeDb([msg(ORG_A, C1, "x1", 120), msg(ORG_A, C2, "x2", 100)]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.deepEqual(r.calls.map((c) => c.contactId).sort(), [C1, C2]);
});

test("R7. two orgs are isolated: each message is dispatched under its own org, and a contact from another org is never used", async () => {
  const db = makeDb([msg(ORG_A, C1, "y1", 120), msg(ORG_B, C3, "y2", 110), msg(ORG_B, C1, "y3", 100)]); // y3: org B message pointing at org A's contact
  const r = recorder();
  const sum = await sweep(db, r.dispatch);
  const byMsg = Object.fromEntries(r.calls.map((c) => [c.inboundMessageId, c.orgId]));
  assert.deepEqual(byMsg, { y1: ORG_A, y2: ORG_B });
  assert.equal(sum.skippedContact, 1);
});

test("R8. outbound WhatsApp messages are ignored", async () => {
  const db = makeDb([msg(ORG_A, C1, "out1", 120, { direction: "out" })]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R9. other channels (sms / messenger / instagram) are ignored", async () => {
  const db = makeDb([msg(ORG_A, C1, "s1", 120, { channel: "sms" }), msg(ORG_A, C2, "s2", 120, { channel: "messenger" }), msg(ORG_A, C1, "s3", 130, { channel: "instagram" })]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R10. a message younger than the minimum age is ignored; just past it is eligible", async () => {
  const young = makeDb([msg(ORG_A, C1, "m1", 20)]);
  const r1 = recorder();
  await sweep(young, r1.dispatch);
  assert.equal(r1.calls.length, 0);
  const ok = makeDb([msg(ORG_A, C1, "m2", S.RECOVERY_MIN_AGE_MS / 1000 + 1)]);
  const r2 = recorder();
  await sweep(ok, r2.dispatch);
  assert.equal(r2.calls.length, 1);
});

test("R11. a message older than the maximum recovery age is ignored; just inside it is eligible", async () => {
  const old = makeDb([msg(ORG_A, C1, "z1", 61 * MIN)]);
  const r1 = recorder();
  await sweep(old, r1.dispatch);
  assert.equal(r1.calls.length, 0);
  const ok = makeDb([msg(ORG_A, C1, "z2", 59 * MIN)]);
  const r2 = recorder();
  await sweep(ok, r2.dispatch);
  assert.equal(r2.calls.length, 1);
  assert.equal(S.RECOVERY_MAX_AGE_MS, 60 * MIN * 1000);
});

test("R11b. rows without a contact or provider message id are not dispatched", async () => {
  const db = makeDb([msg(ORG_A, C1, "b1", 120, { contact: null }), msg(ORG_A, C2, "b2", 120, { provider: null })]);
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, 0);
});

test("R11c. one sweep re-dispatches at most RECOVERY_DISPATCH_LIMIT messages, oldest first", async () => {
  const contacts = Array.from({ length: 30 }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`);
  const db = makeDb(contacts.map((c, i) => msg(ORG_A, c, `L${i}`, 3000 - i)));
  for (const c of contacts) await db.from("contacts").insert({ id: c, org_id: ORG_A });
  const r = recorder();
  await sweep(db, r.dispatch);
  assert.equal(r.calls.length, S.RECOVERY_DISPATCH_LIMIT);
  assert.equal(r.calls[0].inboundMessageId, "L0", "oldest (closest to aging out) first");
});

// ─────────────────────────────────────────────
// Failure, idempotency, overlap
// ─────────────────────────────────────────────
test("R12. a failed redispatch marks nothing complete and leaves the message eligible", async () => {
  const db = makeDb([msg(ORG_A, C1, "f1", 120)]);
  const bad = recorder(false);
  const sum = await sweep(db, bad.dispatch);
  assert.equal(sum.dispatchFailed, 1);
  assert.equal(sum.dispatched, 0);
  assert.equal(await metaOf(db, "f1"), null);
  const good = recorder();
  await sweep(db, good.dispatch);
  assert.equal(good.calls.length, 1, "the next sweep retries it");
});

test("R13. repeat sweeps are idempotent: one AI run and one approval, later sweeps find nothing", async () => {
  const db = makeDb([msg(ORG_A, C1, "i1", 120)]);
  const orch = makeOrchestrator();
  const dispatch = inProcessDispatch(db, orch);
  const first = await sweep(db, dispatch);
  assert.equal(first.dispatched, 1);
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
  const second = await sweep(db, dispatch);
  const third = await sweep(db, dispatch);
  assert.equal(second.candidates + third.candidates, 0, "completed message is no longer a candidate");
  assert.equal(orch.calls.length, 1);
  assert.equal((await pending(db)).length, 1);
});

test("R14. overlapping sweeps (and a duplicate primary dispatch) create no duplicate AI work", async () => {
  const db = makeDb([msg(ORG_A, C1, "v1", 120), msg(ORG_A, C2, "v2", 110)]);
  const orch = makeOrchestrator();
  const dispatch = inProcessDispatch(db, orch);
  await Promise.all([sweep(db, dispatch), sweep(db, dispatch), sweep(db, dispatch), dispatch({ orgId: ORG_A, contactId: C1, phone: "+15550001111", body: "x", providerMessageId: "pm-v1", inboundMessageId: "v1" })]);
  assert.equal(orch.calls.length, 2, "one AI run per conversation");
  const pend = await pending(db);
  assert.equal(pend.length, 2);
  assert.deepEqual(pend.map((p: any) => p.target_entity_id).sort(), [C1, C2]);
});

test("R14b. recovery of a burst with a lost dispatch runs the AI once, over the whole burst, keeping one pending approval", async () => {
  // v-a's dispatch was lost, v-b's ran normally but its worker died after claiming (abandoned lease).
  const db = makeDb([msg(ORG_A, C1, "w-a", 400), msg(ORG_A, C1, "w-b", 300)]);
  await S.claimForAiDispatch(db, ORG_A, "w-b", NOW - LEASE - 5000);
  const orch = makeOrchestrator();
  await sweep(db, inProcessDispatch(db, orch));
  assert.equal(orch.calls.length, 1);
  assert.equal(orch.calls[0], "secret body of w-a\nsecret body of w-b");
  const pend = await pending(db);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].metadata.inbound_message_id, "w-b");
});

test("R15. the sweep never writes to messages or approvals itself", async () => {
  const rows = [msg(ORG_A, C1, "r1", 120)];
  const db = makeDb(rows);
  const before = JSON.stringify((await db.from("sms_meta_messages").select("*")).data);
  await sweep(db, recorder().dispatch);
  assert.equal(JSON.stringify((await db.from("sms_meta_messages").select("*")).data), before);
  assert.equal((await db.from("agent_approval_requests").select("*")).data.length, 0);
});


// ─────────────────────────────────────────────
// Auth gate (Netlify scheduled-function contract)
// ─────────────────────────────────────────────
const SCHEDULED_BODY = JSON.stringify({ next_run: "2026-09-26T12:02:00.000Z" });

test("R16a. a User-Agent alone is NOT authority (not even the old Clockwork value)", () => {
  const ok = S.isAuthorizedSweepRequest;
  assert.equal(ok({ "user-agent": "Netlify Clockwork" }, null, "s3"), false);
  assert.equal(ok({ "User-Agent": "Netlify Clockwork" }, "{}", "s3"), false);
  assert.equal(ok({ "user-agent": "curl/8" }, "not json", "s3"), false);
});

test("R16b. the scheduled-invocation shape ({ next_run: ISO }) is accepted", () => {
  const ok = S.isAuthorizedSweepRequest;
  assert.equal(ok({}, SCHEDULED_BODY, "s3"), true);
  assert.equal(ok({}, SCHEDULED_BODY, undefined), true);
  assert.equal(ok({ "user-agent": "anything" }, SCHEDULED_BODY, "s3"), true);
});

test("R16c. anything else is rejected: no body, empty/garbage body, wrong next_run type, wrong or empty secret", () => {
  const ok = S.isAuthorizedSweepRequest;
  assert.equal(ok({}, null, "s3"), false);
  assert.equal(ok({}, "", "s3"), false);
  assert.equal(ok({}, "{}", "s3"), false);
  assert.equal(ok({}, "not json", "s3"), false);
  assert.equal(ok({}, JSON.stringify({ next_run: 12345 }), "s3"), false);
  assert.equal(ok({}, JSON.stringify({ next_run: "garbage" }), "s3"), false);
  assert.equal(ok({ "x-internal-secret": "nope" }, null, "s3"), false);
  assert.equal(ok({ "x-internal-secret": "" }, null, ""), false);
  assert.equal(ok({ "x-internal-secret": "s3" }, null, undefined), false);
});

test("R16d. the internal secret (manual/local run) is accepted, header name case-insensitive", () => {
  const ok = S.isAuthorizedSweepRequest;
  assert.equal(ok({ "x-internal-secret": "s3" }, null, "s3"), true);
  assert.equal(ok({ "X-Internal-Secret": "s3" }, "", "s3"), true);
  assert.equal(ok({ "x-internal-secret": "s3x" }, null, "s3"), false, "different length");
});

test("R16e. the real handler answers 403 before any DB or network work unless the scheduled shape or secret is present", async () => {
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  process.env.AI_WHATSAPP_INTERNAL_DISPATCH_SECRET = "s3";
  const handlerDir = mkdtempSync(path.join(tmpdir(), "wa-recovery-handler-"));
  after(() => rmSync(handlerDir, { recursive: true, force: true }));
  await esbuild.build({
    entryPoints: [path.join(here, "../whatsapp-dispatch-recovery.ts")],
    outfile: path.join(handlerDir, "handler.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    alias: { "@": path.join(repoRoot, "src") },
    external: ["nodemailer"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const { handler }: any = await import(pathToFileURL(path.join(handlerDir, "handler.mjs")).href);
  const call = (headers: any, body: any) => handler({ httpMethod: "POST", headers, body }, {});
  assert.equal((await call({ "user-agent": "Netlify Clockwork" }, null)).statusCode, 403);
  assert.equal((await call({}, "{}")).statusCode, 403);
  assert.equal((await call({ "x-internal-secret": "wrong" }, null)).statusCode, 403);
  // Authorised shapes get past the gate (network is blocked here, so the sweep itself finds nothing) — never 403.
  assert.notEqual((await call({}, SCHEDULED_BODY)).statusCode, 403);
  assert.notEqual((await call({ "x-internal-secret": "s3" }, null)).statusCode, 403);
});

// ─────────────────────────────────────────────
// 30 s scheduled-function budget: bounded work, timeouts, deadline
// ─────────────────────────────────────────────
async function seeded(n: number) {
  const contacts = Array.from({ length: n }, (_, i) => `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`);
  const db = makeDb(contacts.map((c, i) => msg(ORG_A, c, `B${i}`, 3000 - i)));
  for (const c of contacts) await db.from("contacts").insert({ id: c, org_id: ORG_A });
  return db;
}

test("R17. the sweep stays bounded: scan cap, dispatch cap, parallelism cap", async () => {
  const db = await seeded(120);
  let inFlight = 0;
  let maxInFlight = 0;
  let total = 0;
  const dispatch = async () => {
    total++;
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return true;
  };
  const sum = await sweep(db, dispatch);
  assert.equal(total, S.RECOVERY_DISPATCH_LIMIT);
  assert.ok(maxInFlight <= S.RECOVERY_CONCURRENCY && maxInFlight > 1, `parallelism ${maxInFlight}`);
  assert.equal(sum.dispatched, S.RECOVERY_DISPATCH_LIMIT);
  assert.ok(sum.scanned <= S.RECOVERY_SCAN_LIMIT);
  // Worst case on the all-timeouts path: a wave may start just before the soft
  // deadline and is then capped by one dispatch timeout — inside Netlify's 30 s.
  assert.ok(S.RECOVERY_DEADLINE_MS + S.RECOVERY_DISPATCH_TIMEOUT_MS < 30_000);
});

test("R18. a hung or throwing dispatch is cut off by the timeout, counted as failed, and stays recoverable", async () => {
  const db = makeDb([msg(ORG_A, C1, "t1", 120), msg(ORG_A, C2, "t2", 110)]);
  const dispatch = async (p: any) => {
    if (p.inboundMessageId === "t1") return new Promise<boolean>(() => {}); // never resolves
    throw new Error("connection reset");
  };
  const started = Date.now();
  const sum = await S.runWhatsAppDispatchRecovery(db, { dispatch, now: () => NOW, dispatchTimeoutMs: 30 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(sum.dispatchFailed, 2);
  assert.equal(sum.dispatched, 0);
  assert.equal(await metaOf(db, "t1"), null);
  assert.equal(await metaOf(db, "t2"), null);
  const again = recorder();
  await sweep(db, again.dispatch);
  assert.deepEqual(again.calls.map((c) => c.inboundMessageId).sort(), ["t1", "t2"]);
});

test("R19. the soft deadline stops new waves; untouched messages stay recoverable for the next sweep", async () => {
  const db = await seeded(20);
  let t = 0;
  const clock = () => t;
  const first = recorder();
  const dispatch = async (p: any) => {
    first.calls.push(p);
    t += 10_000; // every wave "takes" 10 s of wall time
    return true;
  };
  const sum = await S.runWhatsAppDispatchRecovery(db, { dispatch, now: () => NOW, clock });
  assert.equal(sum.deadlineHit, true);
  assert.ok(first.calls.length >= 1 && first.calls.length < 20, "stopped early, not everything dispatched");
  const rest = recorder();
  await sweep(db, rest.dispatch);
  assert.equal(rest.calls.length, 20, "nothing was marked done, so all remain recoverable");
});
