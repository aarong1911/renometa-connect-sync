// tests/netlify-functions/marketing-campaign-gmail.test.ts
//
// Run:  node --test tests/netlify-functions/marketing-campaign-gmail.test.ts
//
// Email campaigns through the org's connected Gmail account: provider
// selection, per-recipient tracking, suppression at send time, one-click
// unsubscribe, rate-limit backoff with bounded retries, ambiguous-result
// handling, the per-org daily cap, and legacy SMTP. Drives the REAL
// marketing-campaign-process-queue.ts / marketing-campaign-send.ts /
// marketing-unsubscribe.ts handlers (bundled with esbuild) against the
// in-memory fake Supabase client, an in-memory nodemailer and
// support/gmail-stub.ts. A handful of fake recipients per test — nothing
// reaches the network and no email is sent.

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.URL = "https://connect.test";
const { gmailStub, gmailIntegration, installFetchStub, expiredAt, GMAIL_SEND_URL } = await import("./support/gmail-stub.ts");
const { encryptToBytea } = await import("../../netlify/functions/lib/gmail-token-crypto.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "marketing-campaign-gmail-"));
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
    queue: path.join(repoRoot, "netlify/functions/marketing-campaign-process-queue.ts"),
    enqueue: path.join(repoRoot, "netlify/functions/marketing-campaign-send.ts"),
    unsubscribe: path.join(repoRoot, "netlify/functions/marketing-unsubscribe.ts"),
  },
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", logLevel: "error",
  plugins: [{
    name: "fakes",
    setup(build: any) {
      build.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "supabase", namespace: "fake" }));
      build.onResolve({ filter: /^nodemailer$/ }, () => ({ path: "nodemailer", namespace: "fake" }));
      build.onLoad({ filter: /^supabase$/, namespace: "fake" }, () => ({
        loader: "js",
        contents: `
          export function createClient() {
            return {
              auth: { getUser: async (t) => ({ data: { user: globalThis.__USERS[t] ? { id: globalThis.__USERS[t] } : null }, error: null }) },
              from: (t) => globalThis.__TEST_DB.from(t),
            };
          }`,
      }));
      build.onLoad({ filter: /^nodemailer$/, namespace: "fake" }, () => ({
        loader: "js",
        contents: `export default { createTransport: (opts) => globalThis.__SMTP.createTransport(opts) };`,
      }));
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const QUEUE: any = await import(pathToFileURL(path.join(outDir, "queue.mjs")).href);
const ENQUEUE: any = await import(pathToFileURL(path.join(outDir, "enqueue.mjs")).href);
const UNSUB: any = await import(pathToFileURL(path.join(outDir, "unsubscribe.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "99999999-9999-4999-8999-999999999991";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CAMPAIGN_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
(globalThis as any).__USERS = { "t-owner": OWNER };

const smtp = { sent: [] as any[] };
(globalThis as any).__SMTP = {
  createTransport: (opts: any) => ({
    async sendMail(message: any) {
      smtp.sent.push({ ...message, auth: opts.auth });
      return { messageId: `<smtp-${smtp.sent.length}@smtp.gmail.com>` };
    },
  }),
};

const contactId = (n: number, org = ORG) => `${org.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recipientId = (n: number, campaign = CAMPAIGN) => `${campaign.slice(0, 8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;

function recipient(n: number, over: Record<string, unknown> = {}, campaign = CAMPAIGN, org = ORG) {
  return {
    id: recipientId(n, campaign), org_id: org, campaign_id: campaign, contact_id: contactId(n, org),
    destination: `customer${n}@example.com`, contact_name: `Pat Customer${n}`, status: "queued",
    attempt_count: 0, claimed_at: null, claimed_by: null, created_at: `2026-10-31T00:00:0${n}.000Z`, ...over,
  };
}
function campaignRow(over: Record<string, unknown> = {}) {
  return { id: CAMPAIGN, org_id: ORG, campaign_type: "email", subject: "Fall special for {{first_name}}", content: "Hi {{first_name}}, 10% off gutters.", status: "queued", ...over };
}

type Setup = { gmail?: Record<string, unknown> | null; smtp?: boolean; recipients?: unknown[]; campaigns?: unknown[]; extra?: Record<string, unknown[]> };
let db: any;
function setup(opts: Setup = {}) {
  db = createFakeSupabaseClient({
    profiles: [{ id: OWNER, organization_id: ORG, role: "owner" }],
    org_memberships: [{ member_id: OWNER, org_id: ORG, role: "owner" }],
    integrations: opts.gmail === null ? [] : [gmailIntegration(ORG, opts.gmail ?? {})],
    organizations: [
      { id: ORG, name: "Acme Remodeling", integration_settings: opts.smtp ? { gmail: { email: "office@acme-smtp.test", configured: true } } : {} },
      { id: ORG_B, name: "Beta Builders", integration_settings: {} },
    ],
    organization_integration_secrets: opts.smtp
      ? [{ id: "sec", organization_id: ORG, provider: "gmail", secret_type: "smtp_app_password", encrypted_value: encryptToBytea("abcdefghijklmnop") }]
      : [],
    campaigns: opts.campaigns ?? [campaignRow()],
    campaign_recipients: opts.recipients ?? [recipient(1), recipient(2), recipient(3)],
    marketing_contact_preferences: [],
    marketing_unsubscribe_tokens: [],
    ...(opts.extra ?? {}),
  });
  (globalThis as any).__TEST_DB = db;
}

beforeEach(() => {
  gmailStub.reset();
  smtp.sent.length = 0;
  logged.length = 0;
  delete process.env.GMAIL_CAMPAIGN_DAILY_CAP;
});

const runWorker = () => QUEUE.handler({});
const rec = (n: number, campaign = CAMPAIGN) => db.__dumpTable("campaign_recipients").find((r: any) => r.id === recipientId(n, campaign));
const campaignStatus = (id = CAMPAIGN) => db.__dumpTable("campaigns").find((c: any) => c.id === id).status;
const gmailSends = () => gmailStub.calls.filter((c) => c.url === GMAIL_SEND_URL);
const header = (mime: string, name: string) => new RegExp(`^${name}: (.*)\\r?$`, "m").exec(mime)?.[1] ?? null;

// ── Gmail API sending ────────────────────────────────────────────────────

test("Gmail-connected org: each recipient gets exactly one personalised Gmail API email with one-click unsubscribe; campaign completes", async () => {
  setup();
  await runWorker();
  assert.equal(gmailSends().length, 3);
  assert.equal(smtp.sent.length, 0);
  const tokens = db.__dumpTable("marketing_unsubscribe_tokens");
  assert.equal(tokens.length, 3);
  for (let n = 1; n <= 3; n += 1) {
    const r = rec(n);
    assert.equal(r.status, "sent");
    assert.equal(r.attempt_count, 1);
    const message = gmailStub.mailbox.find((m) => m.sendId === recipientId(n))!;
    assert.ok(message, "X-RenoMeta-Send-Id is the recipient id");
    assert.equal(r.provider_message_id, message.id);
    assert.equal(header(message.mime, "To"), `customer${n}@example.com`);
    assert.equal(header(message.mime, "Subject"), `Fall special for Pat`);
    assert.equal(header(message.mime, "From"), '"Acme Remodeling" <owner@acmeremodeling.com>');
    const token = tokens.find((t: any) => t.contact_id === contactId(n)).token;
    assert.equal(header(message.mime, "List-Unsubscribe"), `<https://connect.test/.netlify/functions/marketing-unsubscribe?token=${token}>`);
    assert.equal(header(message.mime, "List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
    const text = Buffer.from(message.mime.split("\r\n\r\n").slice(1).join("").replace(/\s/g, ""), "base64").toString("utf8");
    assert.match(text, /Hi Pat, 10% off gutters\.[\s\S]*Unsubscribe: https:\/\/connect\.test/);
  }
  const c = db.__dumpTable("campaigns")[0];
  assert.equal(c.status, "completed");
  assert.equal(c.recipients_sent, 3);
  assert.equal(c.recipients_failed, 0);
});

test("a second worker run never re-sends a recipient that was already sent", async () => {
  setup();
  await runWorker();
  await runWorker();
  assert.equal(gmailSends().length, 3);
});

test("send-time suppression: a contact who unsubscribed after queueing is excluded, not emailed", async () => {
  setup({ extra: { marketing_contact_preferences: [{ org_id: ORG, contact_id: contactId(2), email_unsubscribed: true }] } });
  await runWorker();
  assert.equal(rec(2).status, "excluded");
  assert.match(rec(2).excluded_reason, /Unsubscribed/);
  assert.equal(gmailSends().length, 2);
  assert.ok(!gmailStub.sentMime.some((m) => m.includes("customer2@example.com")));
});

test("suppression is org-scoped: another org's opt-out for the same address doesn't block this org", async () => {
  setup({ extra: { marketing_contact_preferences: [{ org_id: ORG_B, contact_id: contactId(1), email_suppressed: true }] } });
  await runWorker();
  assert.equal(rec(1).status, "sent");
});

test("one-click unsubscribe: a POST carrying only the URL token unsubscribes (RFC 8058)", async () => {
  setup();
  await runWorker();
  const token = db.__dumpTable("marketing_unsubscribe_tokens")[0];
  const res = await UNSUB.handler({
    httpMethod: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    queryStringParameters: { token: token.token },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(res.statusCode, 200);
  const pref = db.__dumpTable("marketing_contact_preferences").find((p: any) => p.contact_id === token.contact_id);
  assert.equal(pref.email_unsubscribed, true);
  assert.equal(pref.org_id, ORG);
  // A GET still never mutates.
  const getRes = await UNSUB.handler({ httpMethod: "GET", headers: {}, queryStringParameters: { token: db.__dumpTable("marketing_unsubscribe_tokens")[1].token }, body: null });
  assert.equal(getRes.statusCode, 200);
  assert.equal(db.__dumpTable("marketing_contact_preferences").length, 1);
});

// ── retries, backoff, ambiguity ──────────────────────────────────────────

test("Gmail rate limit: that recipient and the rest of the batch go back to the queue with backoff — nothing failed, nothing sent twice", async () => {
  setup();
  gmailStub.reset({ send: [{}, { status: 429, body: { error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } } }] });
  const t0 = Date.now();
  await runWorker();
  assert.equal(rec(1).status, "sent");
  const r2 = rec(2);
  assert.equal(r2.status, "queued");
  assert.equal(r2.attempt_count, 1);
  assert.ok(Date.parse(r2.claimed_at) >= t0 + 5 * 60_000 - 1000, "backs off at least 5 minutes");
  assert.match(r2.failure_reason, /^Retrying:/);
  const r3 = rec(3);
  assert.equal(r3.status, "queued");
  assert.equal(r3.attempt_count, 0, "never attempted — not counted");
  assert.equal(gmailSends().length, 2, "stopped at the rate limit");
  assert.equal(campaignStatus(), "sending", "not finalized while retries are pending");

  // Still in backoff: an immediate run claims nothing.
  await runWorker();
  assert.equal(gmailSends().length, 2);

  // Backoff elapsed: the queued recipients go out once each.
  for (const n of [2, 3]) await db.from("campaign_recipients").update({ claimed_at: new Date(t0 - 1000).toISOString() }).eq("id", recipientId(n));
  await runWorker();
  assert.equal(rec(2).status, "sent");
  assert.equal(rec(2).attempt_count, 2);
  assert.equal(rec(3).status, "sent");
  assert.equal(gmailStub.mailbox.filter((m) => m.sendId === recipientId(2)).length, 1);
  assert.equal(campaignStatus(), "completed");
});

test("bounded retries: the final allowed attempt failing on a rate limit is terminal and explicit", async () => {
  setup({ recipients: [recipient(1, { attempt_count: 4 })] });
  gmailStub.reset({ send: [{ status: 429 }] });
  await runWorker();
  const r = rec(1);
  assert.equal(r.status, "failed");
  assert.equal(r.attempt_count, 5);
  assert.match(r.failure_reason, /Gave up after 5 attempts — not sent/);
  assert.equal(campaignStatus(), "completed");
});

test("ambiguous Gmail result found in Sent mail counts as sent; one that isn't fails closed and is never retried", async () => {
  setup({ recipients: [recipient(1), recipient(2)] });
  gmailStub.reset({ send: [{ status: 503, accept: true }, { network: true, accept: true }] });
  // Make only the first accepted message searchable (index lag for the second).
  const realPush = gmailStub.mailbox.push.bind(gmailStub.mailbox);
  let accepted = 0;
  gmailStub.mailbox.push = (m: any) => { accepted += 1; return realPush({ ...m, indexed: accepted === 1 }); };
  try {
    await runWorker();
  } finally {
    gmailStub.mailbox.push = realPush;
  }
  assert.equal(rec(1).status, "sent");
  assert.equal(rec(1).provider_message_id, gmailStub.mailbox[0].id);
  assert.equal(rec(2).status, "failed");
  assert.match(rec(2).failure_reason, /Ambiguous outcome .* not auto-retried/);
  await runWorker();
  assert.equal(gmailSends().length, 2, "the ambiguous recipient is never sent again automatically");
});

test("stale 'sending' rows from a crashed run are still failed closed, never re-sent", async () => {
  setup({ recipients: [recipient(1, { status: "sending", claimed_at: new Date(Date.now() - 60 * 60_000).toISOString() })] });
  await runWorker();
  assert.equal(rec(1).status, "failed");
  assert.equal(gmailSends().length, 0);
});

test("Google connection revoked and no SMTP: campaign pauses before claiming anyone; recipients stay queued", async () => {
  setup({ gmail: { token_expires_at: expiredAt() } });
  gmailStub.reset({ refresh: { status: 400, body: { error: "invalid_grant" } } });
  await runWorker();
  assert.equal(campaignStatus(), "paused");
  assert.equal(db.__dumpTable("campaigns")[0].paused_from_status, "queued");
  for (const n of [1, 2, 3]) assert.equal(rec(n).status, "queued");
  assert.equal(gmailSends().length, 0);
});

test("Google access revoked mid-batch: unsent recipients are requeued untouched and the campaign pauses", async () => {
  setup();
  gmailStub.reset({ send: [{}, { status: 401 }] });
  await runWorker();
  assert.equal(rec(1).status, "sent");
  for (const n of [2, 3]) {
    assert.equal(rec(n).status, "queued");
    assert.equal(rec(n).attempt_count, 0);
  }
  assert.equal(campaignStatus(), "paused");
  assert.equal(db.__dumpTable("campaigns")[0].paused_from_status, "sending");
});

test("daily cap: only the remaining allowance is claimed; the rest waits without failing", async () => {
  process.env.GMAIL_CAMPAIGN_DAILY_CAP = "3";
  setup({
    campaigns: [campaignRow(), campaignRow({ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc9", status: "completed" })],
    recipients: [
      recipient(1), recipient(2), recipient(3),
      // Two campaign emails already sent today by this org.
      recipient(7, { status: "sent", sent_at: new Date(Date.now() - 3600_000).toISOString() }, "cccccccc-cccc-4ccc-8ccc-ccccccccccc9"),
      recipient(8, { status: "sent", sent_at: new Date(Date.now() - 3600_000).toISOString() }, "cccccccc-cccc-4ccc-8ccc-ccccccccccc9"),
    ],
  });
  await runWorker();
  assert.equal(gmailSends().length, 1);
  assert.equal(rec(1).status, "sent");
  assert.equal(rec(2).status, "queued");
  assert.equal(rec(2).attempt_count, 0);
  assert.equal(rec(3).status, "queued");
  assert.equal(campaignStatus(), "sending");
});

// ── legacy SMTP and isolation ────────────────────────────────────────────

test("SMTP-only org: campaigns still send over SMTP exactly as before, Gmail never called", async () => {
  setup({ gmail: null, smtp: true });
  await runWorker();
  assert.equal(smtp.sent.length, 3);
  assert.equal(gmailStub.calls.length, 0);
  assert.deepEqual(smtp.sent[0].auth, { user: "office@acme-smtp.test", pass: "abcdefghijklmnop" });
  assert.equal(smtp.sent[0].from, "RenoMeta Connect <office@acme-smtp.test>");
  assert.equal(rec(1).status, "sent");
  assert.equal(rec(1).provider_message_id, "<smtp-1@smtp.gmail.com>");
});

test("multi-tenant: each org's campaign sends from its own Google account only", async () => {
  setup({
    campaigns: [campaignRow(), campaignRow({ id: CAMPAIGN_B, org_id: ORG_B })],
    recipients: [recipient(1), recipient(1, {}, CAMPAIGN_B, ORG_B)],
    extra: {},
  });
  await db.from("integrations").insert({ ...gmailIntegration(ORG_B), id: "int-b", provider_account_email: "office@betabuilders.test" });
  await runWorker();
  assert.notEqual(recipientId(1), recipientId(1, CAMPAIGN_B));
  assert.equal(gmailStub.mailbox.length, 2);
  const fromA = gmailStub.mailbox.find((m) => m.sendId === recipientId(1))!;
  const fromB = gmailStub.mailbox.find((m) => m.sendId === recipientId(1, CAMPAIGN_B))!;
  assert.match(header(fromA.mime, "From")!, /owner@acmeremodeling\.com/);
  assert.match(header(fromB.mime, "From")!, /"Beta Builders" <office@betabuilders\.test>/);
  const tokens = db.__dumpTable("marketing_unsubscribe_tokens");
  assert.ok(tokens.every((t: any) => (t.campaign_id === CAMPAIGN ? t.org_id === ORG : t.org_id === ORG_B)));
});

test("never logs recipient addresses, message bodies or tokens", async () => {
  setup();
  gmailStub.reset({ send: [{ status: 503 }, { status: 400 }, { status: 429 }] });
  await runWorker();
  const text = logged.join("\n");
  for (const secret of ["customer1@example.com", "10% off gutters", "live-access-token", "refresh-token-1"]) {
    assert.ok(!text.includes(secret), `log leaked ${secret}`);
  }
});

// ── enqueue preflight ────────────────────────────────────────────────────

const enqueue = () =>
  ENQUEUE.handler({ httpMethod: "POST", headers: { authorization: "Bearer t-owner" }, body: JSON.stringify({ campaignId: CAMPAIGN, mode: "now" }) });
const contacts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: contactId(i + 1), org_id: ORG, full_name: `Pat Customer${i + 1}`, email: `customer${i + 1}@example.com`, phone: null, source: null, labels: [], created_at: "2026-10-01T00:00:00Z" }));

test("enqueue: a Google-connected org with no App Password can now queue an email campaign", async () => {
  setup({ campaigns: [campaignRow({ status: "draft", target_audience: null })], recipients: [], extra: { contacts: contacts(2) } });
  const res = await enqueue();
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.recipientsQueued, 2);
  assert.equal(body.notice, undefined);
  assert.equal(gmailSends().length, 0, "queuing never sends");
});

test("enqueue: a campaign larger than the Gmail daily allowance says how long it will take", async () => {
  process.env.GMAIL_CAMPAIGN_DAILY_CAP = "2";
  setup({ campaigns: [campaignRow({ status: "draft", target_audience: null })], recipients: [], extra: { contacts: contacts(5) } });
  const body = JSON.parse((await enqueue()).body);
  assert.match(body.notice, /at most 2 campaign emails a day .* about 3 days/);
});

test("enqueue: no Google connection and no SMTP is refused with connect guidance", async () => {
  setup({ gmail: null, campaigns: [campaignRow({ status: "draft", target_audience: null })], recipients: [], extra: { contacts: contacts(1) } });
  const res = await enqueue();
  assert.equal(res.statusCode, 422);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "email_not_connected");
  assert.deepEqual(body.action, { type: "connect_email", path: "/settings/integrations" });
  assert.equal(db.__dumpTable("campaign_recipients").length, 0);
});
