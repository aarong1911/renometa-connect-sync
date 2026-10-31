// tests/netlify-functions/change-order-send-gmail.test.ts
//
// Run:  node --test tests/netlify-functions/change-order-send-gmail.test.ts
//
// Change Orders sent from the contractor's connected Gmail account. Drives
// the REAL change-order-send.ts handler plus the customer-facing
// change-order-data.ts / change-order-action.ts handlers (bundled with
// esbuild) against the in-memory Supabase fake, so a test can "open" the
// emailed link exactly as the customer would.
//
// The SQL RPCs are not run. The RPC handlers below are stand-ins that
// mirror the behavior this flow depends on:
//   send_project_change_order (20260815): sendable statuses, ready_to_send
//     -> sent, snapshot, revoke-then-insert of access tokens with a UNIQUE
//     token_hash, the "resent" audit row, future-expiry check.
//   prepare_/activate_project_change_order_send (20261030): pending row
//     only on prepare; activation is idempotent, checks expiry/status/
//     content, runs the send logic with the pending hash, supersedes older
//     pending links.
//   approve_project_change_order: token must be live, status sent/viewed.
// Global fetch is support/gmail-stub.ts: no network, no email sent.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.CONNECT_APP_URL = "https://connect.test";
const { gmailStub, gmailIntegration, installFetchStub } = await import("./support/gmail-stub.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "change-order-send-gmail-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
after(installFetchStub());

const noisy = ["log", "warn", "error", "info"] as const;
const saved = noisy.map((k) => (console as any)[k]);
const logged: string[] = [];
noisy.forEach((k) => ((console as any)[k] = (...args: unknown[]) => logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: {
    "co-send": path.join(repoRoot, "netlify/functions/change-order-send.ts"),
    "co-data": path.join(repoRoot, "netlify/functions/change-order-data.ts"),
    "co-action": path.join(repoRoot, "netlify/functions/change-order-action.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [{
    name: "fake-supabase",
    setup(build: any) {
      build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "supabase", namespace: "fake" }));
      build.onLoad({ filter: /^supabase$/, namespace: "fake" }, () => ({
        loader: "js",
        contents: `
          export function createClient() {
            return {
              auth: { getUser: async () => ({ data: { user: { id: globalThis.__TEST_USER_ID } }, error: null }) },
              from: (t) => globalThis.__TEST_DB.from(t),
              rpc: (n, a) => globalThis.__TEST_DB.rpc(n, a),
            };
          }`,
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const CO_SEND: any = await import(pathToFileURL(path.join(outDir, "co-send.mjs")).href);
const CO_DATA: any = await import(pathToFileURL(path.join(outDir, "co-data.mjs")).href);
const CO_ACTION: any = await import(pathToFileURL(path.join(outDir, "co-action.mjs")).href);
const bundleSource = readFileSync(path.join(outDir, "co-send.mjs"), "utf8");
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "99999999-9999-4999-8999-999999999999";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const OTHER_CO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
const OLD_TOKEN = "f".repeat(64);
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const SENDABLE = ["ready_to_send", "sent", "viewed"];

function changeOrder(over: Record<string, unknown> = {}) {
  return {
    id: CO, org_id: ORG, project_id: PROJECT, status: "ready_to_send", approval_due_at: null, version: 1,
    change_order_number: "CO-001", title: "Add pantry", first_viewed_at: null, metadata: {}, ...over,
  };
}

/** Every call to the send logic (link-only RPC or via activation), with how many emails Gmail had accepted by then. */
let sendLogicCalls: Array<{ args: any; mailboxAtCall: number }> = [];
let prepareCalls: any[] = [];
let failPrepare = 0;
let failActivate = 0;
let commitThenFailActivate = 0;
/** Next N claim writes moving to this state fail (simulated DB outage on that UPDATE). */
let failClaimState: { state: string; count: number } | null = null;
/** What calculate_change_order_totals reports now (edit the Change Order by changing it). */
let currentTotal = 1250;
/** Customer-facing line items (stand-in for project_change_order_items). */
let currentItems: Array<{ name: string; description: string; quantity: number; unitPrice: number }> = [];
/** Stand-in for change_order_terms_fingerprint(): every approval-relevant field, hashed. */
function termsFingerprint(row: any): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: row.title, description: row.description ?? null, customerMessage: row.customer_message ?? null,
    approvalDueAt: row.approval_due_at ?? null, version: row.version, total: currentTotal, items: currentItems,
  })).digest("hex");
}
let pendingSeq = 0;

function setDb(overrides: Record<string, any[]> = {}, opts: { role?: string } = {}) {
  let db: any;

  // send_project_change_order (20260815), as far as this flow depends on it.
  async function sendLogic(args: { p_change_order_id: string; p_org_id: string; p_actor_user_id: string; p_token_hash: string; p_expires_at: string }) {
    sendLogicCalls.push({ args, mailboxAtCall: gmailStub.mailbox.length });
    const row = db.__dumpTable("project_change_orders").find((r: any) => r.id === args.p_change_order_id && r.org_id === args.p_org_id);
    if (!row) return { data: null, error: { message: "Change Order not found in the specified organization" } };
    if (!SENDABLE.includes(row.status)) return { data: null, error: { message: `Cannot send a Change Order in "${row.status}" status` } };
    if (!(Date.parse(args.p_expires_at) > Date.now())) return { data: null, error: { message: "Token expiry must be in the future" } };
    if (db.__dumpTable("project_change_order_access_tokens").some((t: any) => t.token_hash === args.p_token_hash)) {
      return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
    }
    const isFirstSend = row.status === "ready_to_send";
    if (isFirstSend) {
      await db.from("project_change_orders").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
      await db.from("project_change_order_versions").insert({
        id: crypto.randomUUID(), change_order_id: row.id, version: row.version,
        snapshot: { changeOrderNumber: row.change_order_number, version: row.version, title: row.title, items: [], totalAmount: currentTotal, project: { id: PROJECT, name: "Kitchen" } },
      });
    } else {
      await db.from("project_change_order_approvals").insert({ id: crypto.randomUUID(), change_order_id: row.id, action: "resent", actor_user_id: args.p_actor_user_id });
    }
    await db.from("project_change_order_access_tokens").update({ revoked_at: new Date().toISOString() }).eq("change_order_id", row.id).is("revoked_at", null);
    await db.from("project_change_order_access_tokens").insert({
      id: crypto.randomUUID(), org_id: args.p_org_id, project_id: row.project_id, change_order_id: row.id, version: row.version,
      token_hash: args.p_token_hash, expires_at: args.p_expires_at, revoked_at: null, recipient_email: null,
    });
    return { data: { status: "sent", isFirstSend, version: row.version, changeOrderNumber: row.change_order_number, title: row.title, totalAmount: currentTotal }, error: null };
  }

  db = createFakeSupabaseClient(
    {
      profiles: [{ id: USER, organization_id: ORG, first_name: "Owen", last_name: "Owner" }],
      org_memberships: [{ org_id: ORG, member_id: USER, role: opts.role ?? "owner" }],
      member_permissions: [],
      organizations: [{ id: ORG, name: "Acme Remodeling", public_name: null }],
      projects: [{ id: PROJECT, org_id: ORG, client_id: CONTACT }],
      contacts: [{ id: CONTACT, org_id: ORG, full_name: "Jane Homeowner", email: "jane@example.com" }],
      project_change_orders: [changeOrder(), changeOrder({ id: OTHER_CO, org_id: OTHER_ORG })],
      project_change_order_access_tokens: [],
      project_change_order_pending_sends: [],
      project_change_order_versions: [],
      project_change_order_approvals: [],
      gmail_messages: [],
      integrations: [gmailIntegration(ORG)],
      ...overrides,
    },
    {
      send_project_change_order: sendLogic,
      prepare_project_change_order_send: async (args: any) => {
        prepareCalls.push(args);
        if (failPrepare > 0) { failPrepare -= 1; return { data: null, error: { message: "Could not record the approval link" } }; }
        const row = db.__dumpTable("project_change_orders").find((r: any) => r.id === args.p_change_order_id && r.org_id === args.p_org_id);
        if (!row) return { data: null, error: { message: "Change Order not found in the specified organization" } };
        if (!SENDABLE.includes(row.status)) return { data: null, error: { message: `Cannot send a Change Order in "${row.status}" status` } };
        await db.from("project_change_order_pending_sends").insert({
          id: crypto.randomUUID(), seq: ++pendingSeq, org_id: args.p_org_id, project_id: row.project_id, change_order_id: row.id, version: row.version,
          token_hash: args.p_token_hash, expires_at: args.p_expires_at, terms_fingerprint: termsFingerprint(row), expected_total_amount: currentTotal,
          created_by: args.p_actor_user_id, activated_at: null, discarded_at: null,
        });
        return { data: { version: row.version, changeOrderNumber: row.change_order_number, title: row.title, totalAmount: currentTotal, isFirstSend: row.status === "ready_to_send" }, error: null };
      },
      activate_project_change_order_send: async (args: any) => {
        if (failActivate > 0) { failActivate -= 1; return { data: null, error: { message: "connection reset" } }; }
        const pending = db.__dumpTable("project_change_order_pending_sends").find((p: any) => p.token_hash === args.p_token_hash);
        if (!pending) return { data: { status: "not_pending" }, error: null };
        if (pending.activated_at) return { data: { status: "already_active" }, error: null };
        if (pending.discarded_at) return { data: { status: "discarded" }, error: null };
        if (!(Date.parse(pending.expires_at) > Date.now())) return { data: { status: "expired" }, error: null };
        const discard = () => db.from("project_change_order_pending_sends").update({ discarded_at: new Date().toISOString() }).eq("id", pending.id);
        const row = db.__dumpTable("project_change_orders").find((r: any) => r.id === pending.change_order_id);
        if (!SENDABLE.includes(row.status)) { await discard(); return { data: { status: "not_sendable" }, error: null }; }
        if (row.version !== pending.version || termsFingerprint(row) !== pending.terms_fingerprint) {
          await discard();
          return { data: { status: "changed" }, error: null };
        }
        const sent = await sendLogic({
          p_change_order_id: row.id, p_org_id: pending.org_id, p_actor_user_id: pending.created_by,
          p_token_hash: pending.token_hash, p_expires_at: pending.expires_at,
        });
        if (sent.error) return sent;
        await db.from("project_change_order_pending_sends").update({ activated_at: new Date().toISOString() }).eq("id", pending.id);
        for (const older of db.__dumpTable("project_change_order_pending_sends")) {
          if (older.change_order_id === row.id && older.id !== pending.id && !older.activated_at && !older.discarded_at && older.seq < pending.seq) {
            await db.from("project_change_order_pending_sends").update({ discarded_at: new Date().toISOString() }).eq("id", older.id);
          }
        }
        if (commitThenFailActivate > 0) { commitThenFailActivate -= 1; return { data: null, error: { message: "socket hang up" } }; }
        return { data: { status: "activated", result: sent.data }, error: null };
      },
      approve_project_change_order: async (args: any) => {
        const token = db.__dumpTable("project_change_order_access_tokens").find((t: any) => t.token_hash === sha256(args.p_token));
        if (!token) return { data: null, error: { message: "Approval link is invalid" } };
        if (token.revoked_at) return { data: null, error: { message: "Approval link has been revoked" } };
        const row = db.__dumpTable("project_change_orders").find((r: any) => r.id === token.change_order_id);
        if (!["sent", "viewed"].includes(row.status)) return { data: null, error: { message: "This Change Order is no longer awaiting approval" } };
        await db.from("project_change_orders").update({ status: "approved" }).eq("id", row.id);
        await db.from("project_change_order_approvals").insert({ id: crypto.randomUUID(), change_order_id: row.id, action: "approved", actor_name: args.p_name });
        return { data: { status: "approved" }, error: null };
      },
    },
  );

  // Optionally fail the claim UPDATE that moves to a given state.
  (globalThis as any).__TEST_DB = {
    from(table: string) {
      const q = db.from(table);
      if (table === "project_change_orders") {
        const update = q.update.bind(q);
        q.update = (payload: any) => {
          if (failClaimState && failClaimState.count > 0 && payload?.metadata?.email_send_state === failClaimState.state) {
            failClaimState.count -= 1;
            const failing: any = new Proxy({}, {
              get: (_t, prop) => (prop === "then"
                ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "forced failure" } })
                : () => failing),
            });
            return failing;
          }
          return update(payload);
        };
      }
      return q;
    },
    rpc: (n: string, a: any) => db.rpc(n, a),
  };
  (globalThis as any).__TEST_USER_ID = USER;
  gmailStub.reset();
  sendLogicCalls = [];
  prepareCalls = [];
  failPrepare = 0;
  failActivate = 0;
  commitThenFailActivate = 0;
  failClaimState = null;
  currentTotal = 1250;
  currentItems = [
    { name: "Shelving", description: "Pine shelving", quantity: 2, unitPrice: 500 },
    { name: "Install", description: "Labor", quantity: 1, unitPrice: 250 },
  ];
  return db;
}

async function send(changeOrderId = CO, extra: Record<string, unknown> = {}) {
  const res = await CO_SEND.handler({ httpMethod: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ changeOrderId, ...extra }) });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
/** The customer opening the approval page for this token. */
async function openLink(token: string) {
  const res = await CO_DATA.handler({ httpMethod: "GET", headers: {}, queryStringParameters: { token } });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
async function approveLink(token: string) {
  const res = await CO_ACTION.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ token, action: "approve", payload: { name: "Jane Homeowner" } }) });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}

const coRow = (db: any, id = CO) => db.__dumpTable("project_change_orders").find((r: any) => r.id === id);
const tokensFor = (db: any, id = CO) => db.__dumpTable("project_change_order_access_tokens").filter((t: any) => t.change_order_id === id);
const pendingFor = (db: any, token: string) => db.__dumpTable("project_change_order_pending_sends").find((p: any) => p.token_hash === sha256(token));
const sendCalls = () => gmailStub.calls.filter((c) => c.url.endsWith("/messages/send")).length;

function emailText(mime: string): string {
  const textB64 = mime.split("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0];
  return Buffer.from(textB64.replace(/\r\n/g, ""), "base64").toString("utf8");
}
/** The approval token inside an emailed message (what the customer would click). */
function emailedToken(mime: string): string {
  const match = /\/change-order\/([0-9a-f]{64})/.exec(emailText(mime));
  assert.ok(match, "approval link in the email body");
  return match[1];
}
/** Is this token a live access token right now (what approve/reject require)? */
function linkIsLive(db: any, token: string): boolean {
  const row = db.__dumpTable("project_change_order_access_tokens").find((t: any) => t.token_hash === sha256(token));
  return Boolean(row && !row.revoked_at && Date.parse(row.expires_at) > Date.now());
}

async function ageClaim(db: any, ms: number, patch: Record<string, unknown> = {}) {
  const row = coRow(db);
  const metadata = { ...row.metadata, email_send_claimed_at: new Date(Date.now() - ms).toISOString(), ...patch };
  await db.from("project_change_orders").update({ metadata }).eq("id", row.id);
}

function assertUntouched(db: any, status = "ready_to_send") {
  assert.equal(sendLogicCalls.length, 0, "the send logic never ran");
  assert.equal(coRow(db).status, status, "Change Order keeps its status");
  assert.equal(tokensFor(db).filter((t: any) => t.token_hash !== sha256(OLD_TOKEN)).length, 0, "no new approval link went live");
  assert.equal(db.__dumpTable("project_change_order_approvals").length, 0, "no audit row");
}

// ── Delivery lifecycle ──────────────────────────────────────────────────

test("A1 — link prepared first, Gmail accepts, then the SAME link is activated: status sent, link live", async () => {
  const db = setDb();
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recorded, true);
  assert.equal(r.body.emailDelivered, true);
  assert.equal(r.body.isFirstSend, true);
  assert.equal(r.body.fromEmail, "owner@acmeremodeling.com");

  const [mime] = gmailStub.sentMime;
  assert.match(mime, /^From: "Owen Owner" <owner@acmeremodeling\.com>\r\n/m);
  assert.match(mime, /^To: jane@example\.com\r\n/m);
  assert.match(mime, /^Subject: Change Order CO-001 from Acme Remodeling\r\n/m);
  assert.match(emailText(mime), /\$1250\.00/, "total from the prepare RPC");
  const token = emailedToken(mime);
  assert.equal(r.body.approvalUrl, `https://connect.test/change-order/${token}`);

  assert.equal(prepareCalls.length, 1);
  assert.equal(prepareCalls[0].p_token_hash, sha256(token));
  assert.equal(prepareCalls[0].p_org_id, ORG);
  assert.equal(prepareCalls[0].p_actor_user_id, USER);
  assert.equal(sendLogicCalls.length, 1);
  assert.equal(sendLogicCalls[0].mailboxAtCall, 1, "Gmail had accepted the email before the Change Order was marked sent");
  assert.ok(pendingFor(db, token).activated_at);
  assert.ok(linkIsLive(db, token));

  const row = coRow(db);
  assert.equal(row.status, "sent");
  assert.equal(row.metadata.email_send_state, "sent");
  assert.equal(row.metadata.email_gmail_message_id, r.body.gmailMessageId);
  assert.equal(row.metadata.email_token_hash, sha256(token), "only the hash is stored");
  assert.ok(!JSON.stringify(db.__dumpTable("project_change_order_pending_sends")).includes(token), "the plaintext token is never stored");
  const [history] = db.__dumpTable("gmail_messages");
  assert.equal(history.id, r.body.gmailMessageId);
  assert.deepEqual(history.to_emails, ["jane@example.com"]);
});

test("A2 — preparing the link does not mark the Change Order sent or make a live token (state at the moment Gmail is called)", async () => {
  const db = setDb();
  let observed: any = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).endsWith("/messages/send")) {
      const pending = db.__dumpTable("project_change_order_pending_sends");
      observed = { status: coRow(db).status, liveTokens: tokensFor(db).length, pending: pending.length, activated: pending[0]?.activated_at ?? null };
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    assert.equal((await send()).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(observed, { status: "ready_to_send", liveTokens: 0, pending: 1, activated: null });
});

test("A3 — Gmail rejects: link discarded (never usable), nothing marked sent, claim released, retry works", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 400, body: { error: { code: 400, message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } }];
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "email_provider_rejected");
  assert.equal(r.body.emailDelivered, false);
  assert.equal(r.body.changeOrderStatus, "ready_to_send");
  assert.doesNotMatch(JSON.stringify(r.body), /Invalid To header/);
  assertUntouched(db);
  const rejectedToken = emailedToken(gmailStub.calls.filter((c) => c.url.endsWith("/messages/send")).map((c) => Buffer.from(JSON.parse(c.body).raw, "base64url").toString("utf8"))[0]);
  assert.ok(pendingFor(db, rejectedToken).discarded_at, "rejected link can never go live");
  assert.equal((await openLink(rejectedToken)).status, 410);
  assert.equal(coRow(db).status, "ready_to_send");

  const retry = await send();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(coRow(db).status, "sent");
});

test("A4 — prepare fails: nothing emailed, nothing changed", async () => {
  const db = setDb();
  failPrepare = 1;
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(sendCalls(), 0);
  assertUntouched(db);
  assert.equal(coRow(db).metadata.email_send_state, "failed");
});

test("A5 — Gmail accepted, activation FAILED: the customer's link still works — opening it completes the send; the contractor's next Send doesn't re-email", async () => {
  const db = setDb();
  failActivate = 1;
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recorded, false);
  assert.equal(r.body.code, "email_sent_not_recorded");
  assert.match(r.body.warning, /still works/);
  assert.equal(coRow(db).status, "ready_to_send", "no false sent state");
  const token = emailedToken(gmailStub.sentMime[0]);

  const page = await openLink(token);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.changeOrder.title, "Add pantry");
  assert.equal(page.body.changeOrder.totalAmount, 1250);
  assert.ok(linkIsLive(db, token));
  assert.equal(coRow(db).status, "viewed", "sent by activation, then viewed");

  const recovered = await send();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.recorded, true);
  assert.equal(recovered.body.recoveredEarlierSend, true);
  assert.equal(sendCalls(), 1, "no second email");
  assert.equal(sendLogicCalls.length, 1, "activated exactly once");
  assert.equal(coRow(db).metadata.email_send_state, "sent");
});

test("A6 — Gmail accepted, activation failed, the contractor clicks Send before the customer opens it: link activated from the stored hash, no second email", async () => {
  const db = setDb();
  failActivate = 1;
  await send();
  const token = emailedToken(gmailStub.sentMime[0]);
  const recovered = await send();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.approvalUrl, null);
  assert.equal(sendCalls(), 1);
  assert.ok(linkIsLive(db, token));
  assert.equal(coRow(db).status, "sent");
  assert.equal((await openLink(token)).status, 200);
});

test("A7 — activation committed but its response was lost: the retry is idempotent (no second send logic run, which would revoke the link)", async () => {
  const db = setDb();
  commitThenFailActivate = 1;
  const r = await send();
  assert.equal(r.body.recorded, false);
  const token = emailedToken(gmailStub.sentMime[0]);
  assert.ok(linkIsLive(db, token));
  const recovered = await send();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(sendLogicCalls.length, 1);
  assert.ok(linkIsLive(db, token));
  assert.equal(sendCalls(), 1);
});

test("A8 — partial DB failure (Gmail ids AND activation both fail to save): link still works for the customer, and no duplicate email afterwards", async () => {
  const db = setDb();
  failClaimState = { state: "sent_unrecorded", count: 1 };
  failActivate = 1;
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(coRow(db).metadata.email_send_state, "sending", "the Gmail ids never landed");
  const token = emailedToken(gmailStub.sentMime[0]);
  assert.equal((await openLink(token)).status, 200, "customer link works regardless");

  const early = await send();
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "email_send_in_progress");

  await ageClaim(db, 11 * 60 * 1000);
  const later = await send();
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.gmailMessageId, gmailStub.mailbox[0].id, "found in Sent mail");
  assert.equal(sendCalls(), 1, "no duplicate");
  assert.equal(sendLogicCalls.length, 1);
  assert.equal(coRow(db).metadata.email_send_state, "sent");
});

test("A9 — recovery after the emailed link expired: refused with guidance, claim released for a fresh send", async () => {
  const db = setDb();
  failActivate = 1;
  await send();
  const token = emailedToken(gmailStub.sentMime[0]);
  await db.from("project_change_order_pending_sends").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("token_hash", sha256(token));
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_recovery_expired");
  assert.equal(coRow(db).status, "ready_to_send");
  assert.equal(coRow(db).metadata.email_send_state, "failed");
  assert.equal((await openLink(token)).status, 410);
});

test("A10 — edited while its link was pending: the stale link is refused (never shows different terms) and the contractor is told to resend", async () => {
  const db = setDb();
  failActivate = 1;
  await send();
  const token = emailedToken(gmailStub.sentMime[0]);
  currentTotal = 1900;
  const page = await openLink(token);
  assert.equal(page.status, 410);
  assert.match(page.body.error, /no longer active/);
  assert.equal(coRow(db).status, "ready_to_send");
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_recovery_link_invalid");
  assert.equal(sendLogicCalls.length, 0);
});

test("A11 — edits that keep the total unchanged still invalidate a pending link (item description; quantity/rate rebalanced)", async () => {
  for (const edit of [
    () => { currentItems[0].description = "Oak shelving"; },
    () => { currentItems[0].quantity = 1; currentItems[0].unitPrice = 1000; }, // 1 x 1000 + 250 = same 1250
  ]) {
    const db = setDb();
    failActivate = 1;
    await send();
    const token = emailedToken(gmailStub.sentMime[0]);
    edit();
    assert.equal(currentTotal, 1250, "total unchanged");
    const page = await openLink(token);
    assert.equal(page.status, 410, "the customer never sees terms other than the emailed ones");
    assert.equal(coRow(db).status, "ready_to_send");
    assert.equal((await approveLink(token)).status, 409, "and cannot approve them");
    const r = await send();
    assert.equal(r.body.code, "email_recovery_link_invalid");
    assert.equal(sendLogicCalls.length, 0);
  }
});

// ── Ambiguous delivery ──────────────────────────────────────────────────

test("B1 — 5xx and NOT delivered: pending link kept, never auto-resent; resend only on informed confirmation; the newer link supersedes the old one", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 500, body: {} }];
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "email_delivery_unknown");
  assertUntouched(db);
  const firstHash = coRow(db).metadata.email_token_hash;
  assert.equal(coRow(db).metadata.email_send_state, "delivery_unknown");

  const early = await send(CO, { confirmResend: true });
  assert.equal(early.status, 409);
  assert.equal(early.body.canConfirmResend, false, "too early even with confirmation (indexing lag)");

  await ageClaim(db, 3 * 60 * 1000);
  const asked = await send();
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "email_delivery_unconfirmed");
  assert.equal(asked.body.sentFolderChecked, true);
  assert.equal(asked.body.canConfirmResend, true);
  assert.equal(sendCalls(), 1, "a Sent-folder miss alone never resends");

  const confirmed = await send(CO, { confirmResend: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(sendCalls(), 2);
  assert.equal(sendLogicCalls.length, 1);
  assert.notEqual(sendLogicCalls[0].args.p_token_hash, firstHash);
  const first = db.__dumpTable("project_change_order_pending_sends").find((p: any) => p.token_hash === firstHash);
  assert.ok(first.discarded_at, "the older pending link was superseded");
});

test("B2 — 5xx but Gmail DID deliver: the customer's link works even before anyone reconciles; the contractor's retry finds it and never re-emails", async () => {
  const db = setDb();
  gmailStub.config.send = [{ accept: true, network: true }];
  await send();
  assertUntouched(db);
  const token = emailedToken(gmailStub.mailbox[0].mime);
  assert.equal((await openLink(token)).status, 200);
  assert.equal(coRow(db).status, "viewed");

  const retry = await send();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.recoveredEarlierSend, true);
  assert.equal(sendCalls(), 1);
  assert.equal(sendLogicCalls.length, 1);
});

test("B3 — delayed Gmail indexing: delivered but not yet searchable -> no resend however often the user retries; recorded once indexed", async () => {
  const db = setDb();
  gmailStub.config.indexNewMessages = false;
  gmailStub.config.send = [{ accept: true, network: true }];
  await send();
  for (const age of [0, 3 * 60 * 1000]) {
    if (age) await ageClaim(db, age);
    assert.equal((await send()).body.code, "email_delivery_unconfirmed");
  }
  assert.equal(sendCalls(), 1);
  assert.equal(coRow(db).status, "ready_to_send");

  gmailStub.mailbox[0].indexed = true;
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sendCalls(), 1);
  assert.equal(coRow(db).status, "sent");
  assert.ok(linkIsLive(db, emailedToken(gmailStub.mailbox[0].mime)));
});

// ── Concurrency ─────────────────────────────────────────────────────────

test("C1 — concurrent sends: one email, one activation", async () => {
  const db = setDb();
  const [a, b] = await Promise.all([send(), send()]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.code, "email_send_in_progress");
  assert.equal(prepareCalls.length, 1);
  assert.equal(sendLogicCalls.length, 1);
  assert.equal(sendCalls(), 1);
  assert.equal(coRow(db).status, "sent");
  assert.equal((await send()).body.code, "email_recently_sent");
});

test("C2 — concurrent recovery retries + the customer opening the link: activated exactly once", async () => {
  const db = setDb();
  failActivate = 1;
  await send();
  const token = emailedToken(gmailStub.sentMime[0]);
  const [a, b, page] = await Promise.all([send(), send(), openLink(token)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(page.status, 200);
  assert.equal(sendLogicCalls.length, 1);
  assert.equal(tokensFor(db).length, 1);
  assert.equal(sendCalls(), 1);
});

// ── Existing links and approvals ────────────────────────────────────────

test("E1 — a pre-existing approval link (no pending row) works exactly as before: view and approve", async () => {
  const db = setDb({
    project_change_orders: [changeOrder({ status: "sent" })],
    project_change_order_versions: [{ id: "v1", change_order_id: CO, version: 1, snapshot: { changeOrderNumber: "CO-001", version: 1, title: "Add pantry", items: [], totalAmount: 1250 } }],
    project_change_order_access_tokens: [{
      id: "tok-old", org_id: ORG, project_id: PROJECT, change_order_id: CO, version: 1,
      token_hash: sha256(OLD_TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null,
    }],
  });
  const page = await openLink(OLD_TOKEN);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.changeOrder.status, "viewed");
  const approved = await approveLink(OLD_TOKEN);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(coRow(db).status, "approved");
  assert.equal(sendLogicCalls.length, 0, "no activation side effects for existing links");
});

test("E2 — Gmail rejects a RESEND: the customer's existing link keeps working and can still be approved", async () => {
  const db = setDb({
    project_change_orders: [changeOrder({ status: "sent" })],
    project_change_order_versions: [{ id: "v1", change_order_id: CO, version: 1, snapshot: { changeOrderNumber: "CO-001", version: 1, title: "Add pantry", items: [], totalAmount: 1250 } }],
    project_change_order_access_tokens: [{
      id: "tok-old", org_id: ORG, project_id: PROJECT, change_order_id: CO, version: 1,
      token_hash: sha256(OLD_TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null,
    }],
  });
  gmailStub.config.send = [{ status: 403, body: { error: { code: 403, errors: [{ reason: "forbidden" }] } } }];
  assert.equal((await send()).status, 502);
  assertUntouched(db, "sent");
  assert.ok(linkIsLive(db, OLD_TOKEN));
  assert.equal((await approveLink(OLD_TOKEN)).status, 200);
});

test("E3 — a successful resend supersedes the old link exactly as before (revoked, 'resent' audit row)", async () => {
  const db = setDb({
    project_change_orders: [changeOrder({ status: "sent" })],
    project_change_order_versions: [{ id: "v1", change_order_id: CO, version: 1, snapshot: { changeOrderNumber: "CO-001", version: 1, title: "Add pantry", items: [], totalAmount: 1250 } }],
    project_change_order_access_tokens: [{
      id: "tok-old", org_id: ORG, project_id: PROJECT, change_order_id: CO, version: 1,
      token_hash: sha256(OLD_TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null,
    }],
  });
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.isFirstSend, false);
  assert.ok(!linkIsLive(db, OLD_TOKEN));
  assert.ok(linkIsLive(db, emailedToken(gmailStub.sentMime[0])));
  assert.equal(db.__dumpTable("project_change_order_approvals").filter((a: any) => a.action === "resent").length, 1);
});

test("E4 — approving straight from a still-pending link activates it first, then approves", async () => {
  const db = setDb();
  failActivate = 1;
  await send();
  const token = emailedToken(gmailStub.sentMime[0]);
  const approved = await approveLink(token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(coRow(db).status, "approved");
  assert.equal(sendLogicCalls.length, 1);
});

// ── Connection, authorization, tenancy ──────────────────────────────────

test("G1 — no Gmail connection: owner gets Connect; a non-owner is told to ask the organization owner; nothing prepared or sent", async () => {
  let db = setDb({ integrations: [] });
  let r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_not_connected");
  assert.deepEqual(r.body.action, { type: "connect_email", path: "/settings/integrations" });
  assertUntouched(db);

  db = setDb({ integrations: [] }, { role: "project_manager" });
  r = await send();
  assert.deepEqual(r.body.action, { type: "contact_owner" });
  assert.equal(r.body.ownerActionRequired, true);
  assertUntouched(db);
  assert.equal(prepareCalls.length, 0);
  assert.equal(sendCalls(), 0);
});

test("G2 — revoked / missing send scope: reconnect error before anything is written", async () => {
  let db = setDb({ integrations: [gmailIntegration(ORG, { token_expires_at: new Date(Date.now() - 60000).toISOString() })] });
  gmailStub.config.refresh = { status: 400, body: { error: "invalid_grant" } };
  assert.equal((await send()).body.code, "email_reconnect_required");
  assertUntouched(db);

  db = setDb({}, { role: "office_manager" });
  gmailStub.config.scope = "https://www.googleapis.com/auth/gmail.readonly";
  const r = await send();
  assert.equal(r.body.code, "email_send_scope_missing");
  assert.deepEqual(r.body.action, { type: "contact_owner" });
  assertUntouched(db);
  assert.equal(prepareCalls.length, 0);
});

test("G3 — authorization unchanged: change_orders edit is required (sales, accountant, estimator refused; project manager allowed; overrides honored)", async () => {
  for (const role of ["sales", "accountant", "estimator"]) {
    const db = setDb({}, { role });
    assert.equal((await send()).status, 403, role);
    assertUntouched(db);
  }
  setDb({}, { role: "project_manager" });
  assert.equal((await send()).status, 200);
  setDb({ member_permissions: [{ org_id: ORG, member_id: USER, feature: "change_orders", action: "edit", granted: true }] }, { role: "accountant" });
  assert.equal((await send()).status, 200, "an owner-granted override still works");
  const db = setDb({ member_permissions: [{ org_id: ORG, member_id: USER, feature: "change_orders", action: "edit", granted: false }] }, { role: "admin" });
  assert.equal((await send()).status, 403);
  assertUntouched(db);
});

test("G4 — tenant isolation: another org's Change Order is not found; another org's Gmail or contact is never used", async () => {
  let db = setDb({ integrations: [gmailIntegration(ORG), gmailIntegration(OTHER_ORG)] });
  assert.equal((await send(OTHER_CO)).status, 404);
  assert.equal(prepareCalls.length, 0);
  assert.equal(coRow(db, OTHER_CO).status, "ready_to_send");
  assert.equal(sendCalls(), 0);

  db = setDb({ integrations: [gmailIntegration(OTHER_ORG)] });
  assert.equal((await send()).body.code, "email_not_connected");
  assertUntouched(db);

  db = setDb({ contacts: [{ id: CONTACT, org_id: OTHER_ORG, full_name: "Someone Else", email: "else@example.com" }] });
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.recipientEmail, null, "link-only: the other org's contact is not the recipient");
  assert.equal(sendCalls(), 0);
});

test("G5 — no customer email on file: link-only send exactly as before (direct RPC, no pending link), Gmail not required", async () => {
  const db = setDb({ contacts: [{ id: CONTACT, org_id: ORG, full_name: "Jane Homeowner", email: null }], integrations: [] });
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.emailDelivered, false);
  assert.equal(r.body.recipientEmail, null);
  assert.equal(prepareCalls.length, 0);
  assert.equal(sendLogicCalls.length, 1);
  assert.equal(gmailStub.calls.filter((c) => c.url.includes("google")).length, 0);
  assert.equal(coRow(db).status, "sent");
  assert.ok(linkIsLive(db, r.body.approvalUrl.split("/").pop()));
});

test("G6 — a Change Order that can't be sent is never emailed (bad status, past approval deadline)", async () => {
  let db = setDb({ project_change_orders: [changeOrder({ status: "cancelled" })] });
  assert.equal((await send()).status, 409);
  assertUntouched(db, "cancelled");
  assert.equal(sendCalls(), 0);

  db = setDb({ project_change_orders: [changeOrder({ approval_due_at: new Date(Date.now() - 86400000).toISOString() })] });
  const r = await send();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /deadline/);
  assertUntouched(db);
  assert.equal(sendCalls(), 0);
});

test("16 — no SES path exists for contractor Change Orders", () => {
  assert.doesNotMatch(bundleSource, /client-sesv2|SendEmailCommand|SESv2Client/);
  assert.doesNotMatch(bundleSource, /info@renometa\.com|support@renometa\.com/);
});

test("logging: tokens and the customer's address never reach the logs", () => {
  const all = logged.join("\n");
  for (const secret of ["live-access-token", "refreshed-access-token", "refresh-token-1", "test-only-client-secret", "jane@example.com", OLD_TOKEN]) {
    assert.ok(!all.includes(secret), `"${secret}" leaked into logs`);
  }
  assert.doesNotMatch(all, /change-order\/[0-9a-f]{64}/, "no approval link in logs");
  assert.doesNotMatch(all, /[0-9a-f]{64}/, "no token or token hash in logs");
});
