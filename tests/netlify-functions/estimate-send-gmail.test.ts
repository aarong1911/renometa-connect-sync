// tests/netlify-functions/estimate-send-gmail.test.ts
//
// Run:  node --test tests/netlify-functions/estimate-send-gmail.test.ts
//
// Contractor-owned Gmail sending for proposals. Drives the REAL
// netlify/functions/estimate-send.ts handler (bundled with esbuild) with
// `@supabase/supabase-js` aliased to the in-memory fake client and global
// fetch replaced by support/gmail-stub.ts — Google/Gmail responses are
// canned, nothing reaches the network, and no email is sent.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.CONNECT_APP_URL = "https://connect.test";
const { gmailStub, gmailIntegration, installFetchStub, expiredAt } = await import("./support/gmail-stub.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "estimate-send-gmail-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
after(installFetchStub());

const noisy = ["log", "warn", "error", "info"] as const;
const saved = noisy.map((k) => (console as any)[k]);
const logged: string[] = [];
noisy.forEach((k) => ((console as any)[k] = (...args: unknown[]) => logged.push(JSON.stringify(args))));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: {
    send: path.join(repoRoot, "netlify/functions/estimate-send.ts"),
    "proposal-data": path.join(repoRoot, "netlify/functions/proposal-data.ts"),
    "proposal-action": path.join(repoRoot, "netlify/functions/proposal-action.ts"),
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
            };
          }`,
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const SEND: any = await import(pathToFileURL(path.join(outDir, "send.mjs")).href);
const PROPOSAL_DATA: any = await import(pathToFileURL(path.join(outDir, "proposal-data.mjs")).href);
const PROPOSAL_ACTION: any = await import(pathToFileURL(path.join(outDir, "proposal-action.mjs")).href);
const bundleSource = readFileSync(path.join(outDir, "send.mjs"), "utf8");
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "99999999-9999-4999-8999-999999999999";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const OTHER_EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";

function estimate(over: Record<string, unknown> = {}) {
  return {
    id: EST, org_id: ORG, status: "draft", number: "EST-000001", title: "Kitchen", version_number: 1, public_token: null,
    client_id: CONTACT, project_id: PROJECT, tax_rate: 0, discount_type: null, discount_value: 0, deposit_type: null, deposit_value: 0,
    subtotal: 0, total: 0, client_total: 0, metadata: {}, ...over,
  };
}

let failSentUpdates = 0;
function setDb(overrides: Record<string, any[]> = {}, opts: { role?: string } = {}) {
  const db = createFakeSupabaseClient({
    profiles: [{ id: USER, organization_id: ORG, first_name: "Owen", last_name: "Owner" }],
    org_memberships: [{ org_id: ORG, member_id: USER, role: opts.role ?? "owner" }],
    member_permissions: [],
    organizations: [{ id: ORG, name: "Acme Remodeling", public_name: null }],
    contacts: [{ id: CONTACT, org_id: ORG, full_name: "Jane Homeowner", email: "jane@example.com" }],
    estimates: [estimate()],
    estimate_items: [{ id: "i1", estimate_id: EST, quantity: 2, unit_price: 100, taxable: true, optional: false, selected_by_customer: true, is_heading: false, discount_type: null, discount_value: 0, metadata: {}, position: 0 }],
    estimate_activities: [], deals: [], gmail_messages: [],
    integrations: [gmailIntegration(ORG)],
    ...overrides,
  });
  // Wrap the fake so a test can force the "mark as sent" UPDATE (the one that
  // carries `status`) to fail after Gmail has already accepted the email.
  (globalThis as any).__TEST_DB = {
    from(table: string) {
      const q = db.from(table);
      if (table === "estimates" && failSentUpdates > 0) {
        const update = q.update.bind(q);
        q.update = (payload: Record<string, unknown>) => {
          if ("status" in payload && failSentUpdates > 0) {
            failSentUpdates -= 1;
            const failing: any = new Proxy({}, {
              get: (_t, prop) => (prop === "then"
                ? (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: "forced failure", code: "XX000" } })
                : () => failing),
            });
            return failing;
          }
          return update(payload);
        };
      }
      return q;
    },
  };
  (globalThis as any).__TEST_USER_ID = USER;
  gmailStub.reset();
  failSentUpdates = 0;
  return db;
}

async function send(estimateId = EST, extra: Record<string, unknown> = {}) {
  const res = await SEND.handler({ httpMethod: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ estimateId, ...extra }) });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
const estimateRow = (db: any, id = EST) => db.__dumpTable("estimates").find((e: any) => e.id === id);
const sendCalls = () => gmailStub.calls.filter((c) => c.url.endsWith("/messages/send")).length;

/** Move the current claim's timestamp into the past (as if minutes had passed). */
async function ageClaim(db: any, ms: number, patch: Record<string, unknown> = {}) {
  const row = estimateRow(db);
  const metadata = { ...row.metadata, email_send_claimed_at: new Date(Date.now() - ms).toISOString(), ...patch };
  await db.from("estimates").update({ metadata }).eq("id", row.id);
}

function assertUnsentAndUntouched(db: any) {
  const e = estimateRow(db);
  assert.equal(e.status, "draft", "estimate keeps its send state");
  assert.equal(e.sent_at, undefined);
  assert.equal(e.public_token, null, "no proposal token minted");
  assert.equal(gmailStub.sentMime.length, 0, "no email sent");
  assert.equal(db.__dumpTable("estimate_activities").length, 0);
  assert.equal(db.__dumpTable("gmail_messages").length, 0);
  assert.equal(gmailStub.workflowCalls.length, 0);
}

// 1, 2, 4, 5 ─────────────────────────────────────────────────────────────

test("1/2/4/5 — sent through the org's Gmail: correct sender, ids persisted, recorded on the right org/contact/project", async () => {
  const db = setDb();
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.recorded, true);
  assert.equal(r.body.fromEmail, "owner@acmeremodeling.com");
  assert.match(r.body.gmailMessageId, /^gm-msg-/);
  assert.match(r.body.gmailThreadId, /^gm-thr-/);

  // Exactly one Gmail send, from the connected account.
  assert.equal(gmailStub.sentMime.length, 1);
  const mime = gmailStub.sentMime[0];
  assert.match(mime, /^From: "Owen Owner" <owner@acmeremodeling\.com>\r\n/m);
  assert.match(mime, /^To: jane@example\.com\r\n/m);
  assert.match(mime, /^Subject: Proposal EST-000001 from Acme Remodeling\r\n/m);
  const sendCall = gmailStub.calls.find((c) => c.url.includes("messages/send"))!;
  assert.equal(sendCall.method, "POST");

  // The same professional content: proposal link in the HTML body.
  const htmlB64 = mime.split("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0];
  const html = Buffer.from(htmlB64.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(html, /Your proposal is ready/);
  assert.ok(html.includes(r.body.proposalUrl), "proposal link in the email");

  // Estimate state + Gmail ids.
  const e = estimateRow(db);
  assert.equal(e.status, "sent");
  assert.ok(e.sent_at);
  assert.equal(e.total, 200);
  assert.equal(e.metadata.email_send_state, "sent");
  assert.equal(e.metadata.email_gmail_message_id, r.body.gmailMessageId);
  assert.equal(e.metadata.email_gmail_thread_id, r.body.gmailThreadId);

  // Timeline activity on the correct org/contact/project.
  const [activity] = db.__dumpTable("estimate_activities");
  assert.equal(activity.org_id, ORG);
  assert.equal(activity.activity_type, "sent");
  assert.equal(activity.metadata.provider, "gmail");
  assert.equal(activity.metadata.gmail_message_id, r.body.gmailMessageId);
  assert.equal(activity.metadata.gmail_thread_id, r.body.gmailThreadId);
  assert.equal(activity.metadata.contact_id, CONTACT);
  assert.equal(activity.metadata.project_id, PROJECT);
  assert.equal(activity.metadata.from_email, "owner@acmeremodeling.com");

  // Outbound email in the contact's email history, keyed by the real Gmail ids.
  const [history] = db.__dumpTable("gmail_messages");
  assert.equal(history.org_id, ORG);
  assert.equal(history.id, r.body.gmailMessageId);
  assert.equal(history.thread_id, r.body.gmailThreadId);
  assert.deepEqual(history.to_emails, ["jane@example.com"]);
  assert.equal(history.from_email, "owner@acmeremodeling.com");
  assert.deepEqual(history.labels, ["SENT"]);
  assert.equal(r.body.historyRecorded, true);

  assert.equal(gmailStub.workflowCalls.length, 1, "estimate_sent workflow still fires");
});

// 6, 7, 8 ────────────────────────────────────────────────────────────────

test("6 — no Gmail connection: structured email_not_connected + Connect action; estimate untouched; no SES/renometa fallback", async () => {
  const db = setDb({ integrations: [] });
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_not_connected");
  assert.deepEqual(r.body.action, { type: "connect_email", path: "/settings/integrations" });
  assertUnsentAndUntouched(db);
  assert.ok(!gmailStub.calls.some((c) => /amazonaws|ses/i.test(c.url)));
});

test("7 — expired + revoked authorization: email_reconnect_required with a Reconnect action; nothing sent", async () => {
  const db = setDb({ integrations: [gmailIntegration(ORG, { token_expires_at: expiredAt() })] });
  gmailStub.config.refresh = { status: 400, body: { error: "invalid_grant" } };
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_reconnect_required");
  assert.deepEqual(r.body.action, { type: "reconnect_email", path: "/settings/integrations" });
  assertUnsentAndUntouched(db);
});

test("7b — an expired but refreshable token is renewed and the send succeeds", async () => {
  const db = setDb({ integrations: [gmailIntegration(ORG, { token_expires_at: expiredAt() })] });
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sendCall = gmailStub.calls.find((c) => c.url.includes("messages/send"))!;
  assert.ok(sendCall);
  assert.ok(gmailStub.calls.some((c) => c.url.endsWith("/token")), "refresh_token grant used");
  assert.equal(estimateRow(db).status, "sent");
});

test("8 — connection without the gmail.send scope: email_send_scope_missing; nothing sent", async () => {
  const db = setDb();
  gmailStub.config.scope = "https://www.googleapis.com/auth/gmail.readonly";
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_send_scope_missing");
  assert.equal(r.body.action.type, "reconnect_email");
  assertUnsentAndUntouched(db);
});

// 9, 10 ──────────────────────────────────────────────────────────────────

test("9 — cross-tenant: another org's Gmail is never used, and another org's estimate is not found", async () => {
  let db = setDb({ integrations: [gmailIntegration(OTHER_ORG)] });
  const r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_not_connected");
  assertUnsentAndUntouched(db);
  assert.equal(gmailStub.calls.filter((c) => c.url.includes("google")).length, 0, "the other tenant's token was never presented to Google");

  db = setDb({ estimates: [estimate(), estimate({ id: OTHER_EST, org_id: OTHER_ORG })], integrations: [gmailIntegration(ORG), gmailIntegration(OTHER_ORG)] });
  const other = await send(OTHER_EST);
  assert.equal(other.status, 404);
  assert.equal(gmailStub.sentMime.length, 0);
  assert.equal(estimateRow(db, OTHER_EST).status, "draft");
});

test("10 — authorization keeps the pre-Gmail boundary: every role with estimates access (accountants included) may send; external roles and explicit denials may not", async () => {
  for (const role of ["owner", "admin", "office_manager", "estimator", "sales", "project_manager", "accountant"]) {
    const db = setDb({}, { role });
    const r = await send();
    assert.equal(r.status, 200, `${role}: ${JSON.stringify(r.body)}`);
    assert.equal(estimateRow(db).status, "sent", role);
  }
  for (const role of ["viewer", "field_worker"]) {
    const db = setDb({}, { role });
    const r = await send();
    assert.equal(r.status, 403, role);
    assert.equal(r.body.code, "forbidden");
    assertUnsentAndUntouched(db);
  }
  // No membership in the org at all.
  let db = setDb({ org_memberships: [] });
  assert.equal((await send()).status, 403);
  assertUnsentAndUntouched(db);

  // An owner's explicit estimates "edit" override decides, either way.
  for (const role of ["estimator", "accountant"]) {
    db = setDb({ member_permissions: [{ org_id: ORG, member_id: USER, feature: "estimates", action: "edit", granted: false }] }, { role });
    assert.equal((await send()).status, 403, `explicit edit=false blocks ${role}`);
    assertUnsentAndUntouched(db);
  }
  db = setDb({ member_permissions: [{ org_id: ORG, member_id: USER, feature: "estimates", action: "view", granted: false }] }, { role: "accountant" });
  assert.equal((await send()).status, 403, "no estimates access at all");
  db = setDb({ member_permissions: [{ org_id: OTHER_ORG, member_id: USER, feature: "estimates", action: "edit", granted: false }] }, { role: "accountant" });
  assert.equal((await send()).status, 200, "another org's override is ignored");
});

test("10b — Gmail not connected, non-owner: told to ask the organization owner (no Settings button); owner gets Connect/Reconnect", async () => {
  let db = setDb({ integrations: [] }, { role: "estimator" });
  let r = await send();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_not_connected");
  assert.deepEqual(r.body.action, { type: "contact_owner" });
  assert.equal(r.body.ownerActionRequired, true);
  assert.match(r.body.error, /organization owner to connect Gmail/);
  assertUnsentAndUntouched(db);

  db = setDb({ integrations: [gmailIntegration(ORG, { status: "error" })] }, { role: "accountant" });
  r = await send();
  assert.equal(r.body.code, "email_reconnect_required");
  assert.deepEqual(r.body.action, { type: "contact_owner" });
  assert.match(r.body.error, /organization owner to reconnect Gmail/);
  assertUnsentAndUntouched(db);

  db = setDb({ integrations: [gmailIntegration(ORG, { status: "error" })] });
  r = await send();
  assert.deepEqual(r.body.action, { type: "reconnect_email", path: "/settings/integrations" });
  assert.equal(r.body.ownerActionRequired, undefined);
});

// 11 ─────────────────────────────────────────────────────────────────────

test("11 — pricing gate still runs before any Gmail call", async () => {
  const db = setDb({ estimate_items: [{ id: "i1", estimate_id: EST, quantity: 1, unit_price: 0, is_heading: false, metadata: { price_pending: true }, position: 0 }] });
  const r = await send();
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "estimate_unpriced");
  assert.equal(gmailStub.calls.length, 0, "no Google call at all");
  assertUnsentAndUntouched(db);
});

// 12 ─────────────────────────────────────────────────────────────────────

test("12 — duplicate submission: two concurrent sends email the customer exactly once", async () => {
  const db = setDb();
  const [a, b] = await Promise.all([send(), send()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const refused = a.status === 409 ? a : b;
  assert.equal(refused.body.code, "email_send_in_progress");
  assert.equal(gmailStub.sentMime.length, 1);
  assert.equal(db.__dumpTable("estimate_activities").length, 1);

  // An immediate re-click after success is also refused.
  const again = await send();
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "email_recently_sent");
  assert.equal(gmailStub.sentMime.length, 1);
});

// 13 ─────────────────────────────────────────────────────────────────────

test("13 — Gmail rejects: not marked sent, safe error (no provider text), claim released so a retry works", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 400, body: { error: { code: 400, message: "Invalid To header: jane@example.com", errors: [{ reason: "invalidArgument" }] } } }];
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "email_provider_rejected");
  assert.doesNotMatch(JSON.stringify(r.body), /Invalid To header/);
  const e = estimateRow(db);
  assert.equal(e.status, "draft");
  assert.equal(e.sent_at, undefined);
  assert.equal(db.__dumpTable("estimate_activities").length, 0);
  assert.equal(db.__dumpTable("gmail_messages").length, 0);

  const retry = await send();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(estimateRow(db).status, "sent");
});

test("13b — Gmail 5xx, message NOT in Sent mail: never resent automatically — only after the outcome settles AND the user explicitly confirms", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 500, body: {} }];
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "email_delivery_unknown");
  assert.equal(r.body.maybeSent, true);
  assert.equal(estimateRow(db).status, "draft");
  assert.equal(estimateRow(db).metadata.email_send_state, "delivery_unknown");

  // Immediately: Sent search can lag, so "not found" isn't trusted yet — and
  // even an explicit confirmation is refused this early.
  for (const extra of [{}, { confirmResend: true }]) {
    const early = await send(EST, extra);
    assert.equal(early.status, 409);
    assert.equal(early.body.code, "email_delivery_unconfirmed");
    assert.equal(early.body.canConfirmResend, false);
  }
  assert.equal(sendCalls(), 1, "never re-sent automatically");

  // Settled, searched the whole window, nothing found — still NOT treated as
  // proof: the user is asked, nothing is sent.
  await ageClaim(db, 3 * 60 * 1000);
  const asked = await send();
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "email_delivery_unconfirmed");
  assert.equal(asked.body.canConfirmResend, true);
  assert.equal(asked.body.sentFolderChecked, true);
  assert.match(asked.body.error, /isn't certain/);
  assert.equal(sendCalls(), 1, "a search miss alone never triggers a resend");
  assert.equal(estimateRow(db).status, "draft");

  const confirmed = await send(EST, { confirmResend: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(sendCalls(), 2, "resent only on the user's informed confirmation");
  assert.equal(estimateRow(db).status, "sent");
  assert.equal(db.__dumpTable("estimate_activities").length, 1);
});

test("13g — delayed Gmail indexing: an accepted-but-not-yet-searchable message is never resent; once indexed it is recorded without re-emailing", async () => {
  const db = setDb();
  gmailStub.config.indexNewMessages = false;
  gmailStub.config.send = [{ accept: true, network: true }];
  await send();
  assert.equal(gmailStub.mailbox.length, 1, "Gmail did accept it");

  for (const age of [0, 3 * 60 * 1000]) {
    if (age) await ageClaim(db, age);
    const r = await send();
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "email_delivery_unconfirmed");
  }
  assert.equal(sendCalls(), 1, "no automatic duplicate while the index lags");

  gmailStub.mailbox[0].indexed = true;
  const later = await send();
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(later.body.gmailMessageId, gmailStub.mailbox[0].id);
  assert.equal(sendCalls(), 1);
  assert.equal(estimateRow(db).status, "sent");
});

test("13h — Sent search follows pagination; a match on a later page is found; an over-long result set is inconclusive", async () => {
  let db = setDb();
  gmailStub.config.send = [{ accept: true, network: true }];
  await send();
  // Bury the real message behind other sent mail, three results per page.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `other-${i}`, threadId: `t-${i}`, sendId: null, mime: "", indexed: true }));
  gmailStub.mailbox.unshift(...filler(7));
  gmailStub.config.searchPageSize = 3;
  const found = await send();
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(sendCalls(), 1);
  assert.ok(gmailStub.calls.some((c) => c.url.includes("pageToken=6")), "read past the first pages");

  db = setDb();
  gmailStub.config.send = [{ status: 500, body: {} }];
  await send();
  gmailStub.mailbox.push(...filler(600));
  gmailStub.config.searchPageSize = 100;
  await ageClaim(db, 3 * 60 * 1000);
  const truncated = await send();
  assert.equal(truncated.status, 409);
  assert.equal(truncated.body.sentFolderChecked, false, "too many pages: reported as not checked, not as 'not found'");
  assert.equal(truncated.body.canConfirmResend, true);
  assert.equal(sendCalls(), 1);
});

test("13d — Gmail accepted but the response was lost: the retry finds it in Sent mail and records it without emailing again", async () => {
  const db = setDb();
  gmailStub.config.send = [{ accept: true, network: true }];
  const r = await send();
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "email_delivery_unknown");
  assert.equal(estimateRow(db).status, "draft", "not assumed sent");
  const [delivered] = gmailStub.mailbox;
  assert.equal(delivered.sendId, estimateRow(db).metadata.email_send_claim_id, "X-RenoMeta-Send-Id carries the claim id");

  const retry = await send();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.recorded, true);
  assert.equal(retry.body.gmailMessageId, delivered.id);
  assert.equal(sendCalls(), 1, "the customer got exactly one email");
  const e = estimateRow(db);
  assert.equal(e.status, "sent");
  assert.equal(e.metadata.email_gmail_message_id, delivered.id);
  const [activity] = db.__dumpTable("estimate_activities");
  assert.equal(activity.metadata.gmail_message_id, delivered.id);
  assert.equal(activity.metadata.recorded_after_retry, true);
});

test("13e — Sent-mail search unavailable: no resend until the user explicitly confirms (and only once the outcome has settled)", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 503, body: {} }];
  await send();
  gmailStub.config.searchStatus = 403;
  await ageClaim(db, 3 * 60 * 1000);

  const asked = await send();
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "email_delivery_unconfirmed");
  assert.equal(asked.body.canConfirmResend, true);
  assert.match(asked.body.error, /Sent folder/);
  assert.equal(sendCalls(), 1);

  const confirmed = await send(EST, { confirmResend: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(sendCalls(), 2);
  assert.equal(estimateRow(db).status, "sent");
});

test("13f — a send that crashed mid-flight (stale sending claim) is reconciled against Sent mail, never blindly resent", async () => {
  const db = setDb();
  gmailStub.config.send = [{ accept: true, network: true }];
  await send();
  // Simulate the function dying before it could record anything.
  await ageClaim(db, 11 * 60 * 1000, { email_send_state: "sending" });
  const retry = await send();
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(sendCalls(), 1);
  assert.equal(estimateRow(db).status, "sent");
});

test("13c — Gmail rate limit: 429 with retryAfterSeconds, nothing sent, retry allowed", async () => {
  const db = setDb();
  gmailStub.config.send = [{ status: 429, body: { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } } }];
  const r = await send();
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "email_rate_limited");
  assert.equal(typeof r.body.retryAfterSeconds, "number");
  assert.equal(estimateRow(db).status, "draft");
  assert.equal((await send()).status, 200);
});

// 14 ─────────────────────────────────────────────────────────────────────

test("14 — Gmail accepts but the estimate update fails: success reported, no automatic resend, next Send records without re-emailing", async () => {
  const db = setDb();
  failSentUpdates = 1;
  const r = await send();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.recorded, false);
  assert.equal(r.body.code, "email_sent_not_recorded");
  assert.match(r.body.warning, /will not get a second email/);
  assert.equal(gmailStub.sentMime.length, 1);
  const firstMessageId = r.body.gmailMessageId;
  let e = estimateRow(db);
  assert.equal(e.status, "draft", "the failed update really did not land");
  assert.equal(e.metadata.email_send_state, "sent_unrecorded");
  assert.equal(e.metadata.email_gmail_message_id, firstMessageId);
  assert.equal(db.__dumpTable("estimate_activities").length, 0);

  const recovered = await send();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.recorded, true);
  assert.equal(recovered.body.gmailMessageId, firstMessageId);
  assert.equal(gmailStub.sentMime.length, 1, "the customer was NOT emailed a second time");
  e = estimateRow(db);
  assert.equal(e.status, "sent");
  assert.equal(e.metadata.email_send_state, "sent");
  const [activity] = db.__dumpTable("estimate_activities");
  assert.equal(activity.metadata.gmail_message_id, firstMessageId);
  assert.equal(activity.metadata.recorded_after_retry, true);
});

// ── Proposal-link availability after Gmail success + persistence failure ─

async function openProposal(token: string) {
  const res = await PROPOSAL_DATA.handler({ httpMethod: "GET", headers: {}, queryStringParameters: { token } });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
async function approveProposal(token: string) {
  const res = await PROPOSAL_ACTION.handler({
    httpMethod: "POST", headers: {},
    body: JSON.stringify({ token, action: "approve", payload: { customerName: "Jane Homeowner", customerEmail: "jane@example.com", acceptedTerms: true, signature: "Jane" } }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body ?? "{}") };
}
const googleCalls = () => gmailStub.calls.filter((c) => c.url.includes("googleapis.com")).length;

test("P1 — Gmail accepted, marking sent failed: the customer's link works (Gmail-confirmed), the send is completed once, and nothing is re-emailed", async () => {
  const db = setDb();
  failSentUpdates = 1;
  const r = await send();
  assert.equal(r.body.recorded, false);
  assert.equal(estimateRow(db).status, "draft");
  const token = estimateRow(db).public_token;

  const page = await openProposal(token);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.estimate.title, "Kitchen");
  assert.equal(page.body.estimate.status, "viewed");
  assert.equal(JSON.stringify(page.body).includes("email_send"), false, "claim metadata never reaches the customer");
  const e = estimateRow(db);
  assert.equal(e.status, "viewed", "sent by the recovery, then viewed");
  assert.ok(e.sent_at);
  assert.equal(e.metadata.email_send_state, "sent");
  const sentActivities = db.__dumpTable("estimate_activities").filter((a: any) => a.activity_type === "sent");
  assert.equal(sentActivities.length, 1);
  assert.equal(sentActivities[0].metadata.gmail_message_id, r.body.gmailMessageId);
  assert.equal(sentActivities[0].metadata.recorded_via, "customer_view");
  assert.equal(sentActivities[0].actor_id, USER, "attributed to the user who sent it");
  assert.ok(gmailStub.calls.some((c) => c.url.includes(`/messages/${r.body.gmailMessageId}?format=metadata`)), "Gmail was asked to confirm the delivery");
  assert.equal(sendCalls(), 1, "no second email");

  // The contractor's retry now sees a finished send.
  const retry = await send();
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "email_recently_sent");
  assert.equal(sendCalls(), 1);
  assert.equal((await openProposal(token)).status, 200, "later views are ordinary");
});

test("P2 — approving straight from a recovered link works; the approval is recorded on a properly sent estimate", async () => {
  const db = setDb();
  failSentUpdates = 1;
  await send();
  const approved = await approveProposal(estimateRow(db).public_token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(estimateRow(db).status, "approved");
  assert.equal(db.__dumpTable("estimate_activities").filter((a: any) => a.activity_type === "sent").length, 1);
  assert.equal(sendCalls(), 1);
});

test("P3 — both writes failed (claim stuck 'sending', no Gmail id saved): Sent-mail search confirms delivery and the link still works", async () => {
  const db = setDb();
  failSentUpdates = 1;
  const r = await send();
  const row = estimateRow(db);
  const { email_gmail_message_id: _id, email_gmail_thread_id: _thr, ...rest } = row.metadata;
  await db.from("estimates").update({ metadata: { ...rest, email_send_state: "sending" } }).eq("id", row.id);

  const page = await openProposal(row.public_token);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(estimateRow(db).metadata.email_gmail_message_id, r.body.gmailMessageId, "found via X-RenoMeta-Send-Id");
  assert.equal(sendCalls(), 1);
});

test("P4 — unsent drafts are never exposed: no claim, a failed (rejected) send, or an un-sent claim -> 404, and Gmail isn't even asked", async () => {
  let db = setDb({ estimates: [estimate({ public_token: "a".repeat(64) })] });
  assert.equal((await openProposal("a".repeat(64))).status, 404);
  assert.equal(googleCalls(), 0);

  db = setDb();
  gmailStub.config.send = [{ status: 400, body: { error: { code: 400, errors: [{ reason: "invalidArgument" }] } } }];
  await send();
  const token = estimateRow(db).public_token;
  assert.ok(token, "a token was minted before the rejected send");
  gmailStub.calls.length = 0;
  assert.equal((await openProposal(token)).status, 404);
  assert.equal(googleCalls(), 0, "a failed claim is not even looked up");
  assert.equal(estimateRow(db).status, "draft");
  assert.equal((await approveProposal(token)).status, 409, "and it can't be approved");
});

test("P5 — spoofed claim metadata is not evidence: a stored Gmail id Gmail doesn't confirm (missing, or without this send's header) -> 404", async () => {
  // Claim says sent_unrecorded with an id that doesn't exist in the mailbox.
  const fake = { email_send_claim_id: "c-1", email_send_id: "c-1", email_send_state: "sent_unrecorded", email_send_version: 1, email_gmail_message_id: "gm-not-real", email_send_claimed_at: new Date().toISOString() };
  let db = setDb({ estimates: [estimate({ public_token: "b".repeat(64), metadata: fake })] });
  assert.equal((await openProposal("b".repeat(64))).status, 404);
  assert.equal(estimateRow(db).status, "draft");

  // A real Sent message, but its X-RenoMeta-Send-Id belongs to a different send.
  db = setDb({ estimates: [estimate({ public_token: "c".repeat(64), metadata: { ...fake, email_gmail_message_id: "gm-other" } })] });
  gmailStub.mailbox.push({ id: "gm-other", threadId: "t", sendId: "some-other-send", mime: "", indexed: true });
  assert.equal((await openProposal("c".repeat(64))).status, 404);
  assert.equal(estimateRow(db).status, "draft");

  // Claim for a different estimate version.
  db = setDb({ estimates: [estimate({ public_token: "d".repeat(64), version_number: 2, metadata: fake })] });
  gmailStub.mailbox.push({ id: "gm-not-real", threadId: "t", sendId: "c-1", mime: "", indexed: true });
  assert.equal((await openProposal("d".repeat(64))).status, 404);
  assert.equal(db.__dumpTable("estimate_activities").length, 0);
});

test("P6 — no usable Gmail connection at view time: no evidence, so still 404 (the contractor's Send retry remains the way to finish)", async () => {
  const db = setDb();
  failSentUpdates = 1;
  await send();
  await db.from("integrations").update({ status: "disconnected" }).eq("org_id", ORG);
  assert.equal((await openProposal(estimateRow(db).public_token)).status, 404);
  assert.equal(estimateRow(db).status, "draft");
});

test("P7 — customer view racing the contractor's retry: recorded exactly once, no second email", async () => {
  const db = setDb();
  failSentUpdates = 1;
  await send();
  const token = estimateRow(db).public_token;
  const [page, retry] = await Promise.all([openProposal(token), send()]);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.ok([200, 409].includes(retry.status), JSON.stringify(retry.body));
  assert.equal(db.__dumpTable("estimate_activities").filter((a: any) => a.activity_type === "sent").length, 1);
  assert.equal(sendCalls(), 1);
  assert.notEqual(estimateRow(db).status, "draft");
});

test("P8 — another org's integration can never confirm a delivery", async () => {
  const OTHER_TOKEN = "e".repeat(64);
  const fake = { email_send_claim_id: "c-9", email_send_id: "c-9", email_send_state: "sent_unrecorded", email_send_version: 1, email_gmail_message_id: "gm-x", email_send_claimed_at: new Date().toISOString() };
  const db = setDb({ estimates: [estimate({ public_token: OTHER_TOKEN, metadata: fake })], integrations: [gmailIntegration(OTHER_ORG)] });
  gmailStub.mailbox.push({ id: "gm-x", threadId: "t", sendId: "c-9", mime: "", indexed: true });
  assert.equal((await openProposal(OTHER_TOKEN)).status, 404);
  assert.equal(estimateRow(db).status, "draft");
});

test("14b — concurrent recovery retries record the earlier delivery exactly once", async () => {
  const db = setDb();
  failSentUpdates = 1;
  await send();
  const [a, b] = await Promise.all([send(), send()]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.code, "email_send_in_progress");
  assert.equal(sendCalls(), 1);
  assert.equal(db.__dumpTable("estimate_activities").length, 1);
  assert.equal(estimateRow(db).status, "sent");
});

// 16 ─────────────────────────────────────────────────────────────────────

test("16 — no SES path exists for contractor proposals", () => {
  assert.doesNotMatch(bundleSource, /client-sesv2|SendEmailCommand|SESv2Client/);
  assert.doesNotMatch(bundleSource, /info@renometa\.com|support@renometa\.com/);
});

test("logging: tokens, client secret and the customer's address never reach the logs", () => {
  const all = logged.join("\n");
  for (const secret of ["live-access-token", "refreshed-access-token", "refresh-token-1", "test-only-client-secret", "jane@example.com"]) {
    assert.ok(!all.includes(secret), `"${secret}" leaked into logs`);
  }
});
