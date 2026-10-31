// tests/netlify-functions/send-inbox-message-email.test.ts
//
// Run:  node --test tests/netlify-functions/send-inbox-message-email.test.ts
//
// Conversations email replies through the org's connected Gmail account, the
// legacy SMTP path, and provider selection between them. Drives the REAL
// netlify/functions/send-inbox-message.ts handler (bundled with esbuild):
// `@supabase/supabase-js` is the in-memory fake client, `nodemailer` is an
// in-memory recorder, and global fetch is support/gmail-stub.ts — nothing
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
const { gmailStub, gmailIntegration, installFetchStub, expiredAt, GMAIL_SEND_URL } = await import("./support/gmail-stub.ts");
const { encryptToBytea } = await import("../../netlify/functions/lib/gmail-token-crypto.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "send-inbox-message-email-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
after(installFetchStub());

const noisy = ["log", "warn", "error", "info"] as const;
const saved = noisy.map((k) => (console as any)[k]);
const logged: string[] = [];
noisy.forEach((k) => ((console as any)[k] = (...args: unknown[]) => logged.push(JSON.stringify(args))));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: { send: path.join(repoRoot, "netlify/functions/send-inbox-message.ts") },
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
const SEND: any = await import(pathToFileURL(path.join(outDir, "send.mjs")).href);
const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OWNER = "99999999-9999-4999-8999-999999999991";
const SALES = "99999999-9999-4999-8999-999999999992";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999993";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const THREAD = "18f0c0ffee000001";
const CUSTOMER_MSG_ID = "<CAF=customer-1@mail.gmail.com>";
(globalThis as any).__USERS = { "t-owner": OWNER, "t-sales": SALES, "t-other": OTHER_OWNER };

// nodemailer recorder
const smtp = { transports: [] as unknown[], sent: [] as any[], fail: null as Error | null };
(globalThis as any).__SMTP = {
  createTransport(opts: unknown) {
    smtp.transports.push(opts);
    return {
      async sendMail(message: any) {
        if (smtp.fail) throw smtp.fail;
        smtp.sent.push(message);
        return { messageId: `<smtp-${smtp.sent.length}@smtp.gmail.com>` };
      },
    };
  },
};

const smtpOrgSettings = (orgId: string, email = "office@acme-smtp.test") => ({
  id: orgId,
  integration_settings: { gmail: { email, configured: true } },
});
const smtpSecret = (orgId: string) => ({
  id: `sec-${orgId.slice(0, 4)}`, organization_id: orgId, provider: "gmail", secret_type: "smtp_app_password",
  encrypted_value: encryptToBytea("abcd efgh ijkl mnop"),
});
const threadRows = (orgId: string) => [
  { id: "gm-in-1", org_id: orgId, thread_id: THREAD, internal_date: "2026-10-30T10:00:00.000Z", subject: "Kitchen remodel", labels: ["INBOX"], rfc_message_id: CUSTOMER_MSG_ID, references_header: "<first@acme.test>" },
  { id: "gm-out-0", org_id: orgId, thread_id: THREAD, internal_date: "2026-10-29T10:00:00.000Z", subject: "Kitchen remodel", labels: ["SENT"], rfc_message_id: "<first@acme.test>", references_header: null },
];

type Setup = { gmail?: Record<string, unknown> | null; smtp?: boolean; failGmailInsert?: boolean; extraTables?: Record<string, unknown[]> };
let db: any;
function setup(opts: Setup = {}) {
  db = createFakeSupabaseClient({
    profiles: [
      { id: OWNER, organization_id: ORG, role: "owner" },
      { id: SALES, organization_id: ORG, role: "member" },
      { id: OTHER_OWNER, organization_id: OTHER_ORG, role: "owner" },
    ],
    org_memberships: [
      { member_id: OWNER, org_id: ORG, role: "owner" },
      { member_id: SALES, org_id: ORG, role: "sales" },
      { member_id: OTHER_OWNER, org_id: OTHER_ORG, role: "owner" },
    ],
    integrations: opts.gmail === null ? [] : [gmailIntegration(ORG, opts.gmail ?? {})],
    organizations: opts.smtp ? [smtpOrgSettings(ORG)] : [{ id: ORG, integration_settings: {} }],
    organization_integration_secrets: opts.smtp ? [smtpSecret(ORG)] : [],
    gmail_messages: threadRows(ORG),
    ...(opts.extraTables ?? {}),
  });
  (globalThis as any).__TEST_DB = opts.failGmailInsert
    ? { from: (t: string) => (t === "gmail_messages" ? failingInsert(db.from(t)) : db.from(t)) }
    : db;
}
function failingInsert(builder: any) {
  builder.insert = () => Promise.resolve({ error: { code: "57014", message: "statement timeout" } });
  return builder;
}

beforeEach(() => {
  gmailStub.reset();
  smtp.transports.length = 0;
  smtp.sent.length = 0;
  smtp.fail = null;
  logged.length = 0;
});

const send = (body: Record<string, unknown>, token = "t-owner") =>
  SEND.handler({ httpMethod: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const reply = (extra: Record<string, unknown> = {}) =>
  send({ channel: "email", to: "customer@example.com", body: "Thanks — Tuesday works.", from_name: "Acme Remodeling", contact_id: CONTACT, email_thread_id: THREAD, ...extra });
const gmailSends = () => gmailStub.calls.filter((c) => c.url === GMAIL_SEND_URL);
const header = (mime: string, name: string) => new RegExp(`^${name}: (.*)\\r?$`, "m").exec(mime)?.[1] ?? null;

// ── Gmail API path ───────────────────────────────────────────────────────

test("Gmail-connected org: a reply goes out through the Gmail API in the same thread with full threading headers", async () => {
  setup({ smtp: true }); // SMTP also configured — the Google connection still wins
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.emailProvider, "gmail");
  assert.equal(body.persisted, true);
  assert.equal(body.smtpMessageId, undefined);

  assert.equal(gmailSends().length, 1);
  assert.equal(smtp.transports.length, 0, "SMTP never used");
  assert.equal(JSON.parse(gmailSends()[0].body).threadId, THREAD, "filed into the existing Gmail thread");
  const mime = gmailStub.sentMime[0];
  assert.equal(header(mime, "From"), '"Acme Remodeling" <owner@acmeremodeling.com>');
  assert.equal(header(mime, "To"), "customer@example.com");
  assert.equal(header(mime, "Subject"), "Re: Kitchen remodel", "subject matches the thread so Gmail threads it");
  assert.equal(header(mime, "In-Reply-To"), CUSTOMER_MSG_ID);
  assert.equal(header(mime, "References"), `<first@acme.test> ${CUSTOMER_MSG_ID}`);
  assert.match(mime, /^Content-Type: text\/plain; charset=UTF-8\r?$/m);
  assert.equal(body.rfcMessageId, header(mime, "Message-ID"));

  const row = db.__dumpTable("gmail_messages").find((r: any) => r.id === gmailStub.mailbox[0].id);
  assert.ok(row, "sent row persisted under the real Gmail id");
  assert.equal(row.org_id, ORG);
  assert.equal(row.thread_id, gmailStub.mailbox[0].threadId);
  assert.equal(row.in_reply_to, CUSTOMER_MSG_ID);
  assert.equal(row.direction, "out");
  assert.deepEqual(row.labels, ["SENT"]);
  assert.equal(row.body_text, "Thanks — Tuesday works.");
});

test("Gmail: an explicit subject is kept; a brand-new email starts a new thread", async () => {
  setup();
  const res = await send({ channel: "email", to: "new@example.com", body: "Hello", subject: "Estimate question", contact_id: CONTACT });
  assert.equal(res.statusCode, 200, res.body);
  const sendBody = JSON.parse(gmailSends()[0].body);
  assert.equal(sendBody.threadId, undefined);
  const mime = gmailStub.sentMime[0];
  assert.equal(header(mime, "Subject"), "Estimate question");
  assert.equal(header(mime, "In-Reply-To"), null);
});

test("Gmail: a temporary smtp-thread id is never sent to Gmail as a thread id", async () => {
  setup();
  await db.from("gmail_messages").insert({ id: "smtp:x@y", org_id: ORG, thread_id: "smtp-thread:x@y", internal_date: "2026-10-30T00:00:00Z", labels: ["SENT"], rfc_message_id: "<x@y>", subject: "Hi" });
  const res = await reply({ email_thread_id: "smtp-thread:x@y" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(gmailSends()[0].body).threadId, undefined);
  assert.equal(header(gmailStub.sentMime[0], "In-Reply-To"), "<x@y>", "still a standards-threaded reply");
});

test("Gmail: a thread Gmail refuses (e.g. from another account) is retried ONCE as a new thread — one message delivered", async () => {
  setup();
  gmailStub.reset({ send: [{ status: 404, body: { error: { code: 404, errors: [{ reason: "notFound" }] } } }] });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(gmailSends().length, 2);
  assert.equal(JSON.parse(gmailSends()[0].body).threadId, THREAD);
  assert.equal(JSON.parse(gmailSends()[1].body).threadId, undefined);
  assert.equal(gmailStub.mailbox.length, 1, "only the second attempt was accepted");
});

test("Gmail ambiguous result that IS in Sent mail: treated as sent, never resent, never SMTP", async () => {
  setup({ smtp: true });
  gmailStub.reset({ send: [{ status: 503, accept: true }] });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).persisted, true);
  assert.equal(gmailSends().length, 1);
  assert.equal(gmailStub.mailbox.length, 1);
  assert.equal(smtp.transports.length, 0);
  assert.ok(db.__dumpTable("gmail_messages").some((r: any) => r.id === gmailStub.mailbox[0].id));
});

test("Gmail ambiguous result NOT yet findable: reported as maybe-sent, no SMTP fallback, no second send, nothing persisted", async () => {
  setup({ smtp: true });
  gmailStub.reset({ send: [{ network: true, accept: true }], indexNewMessages: false });
  const before = db.__dumpTable("gmail_messages").length;
  const res = await reply();
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "email_delivery_unknown");
  assert.equal(body.maybeSent, true);
  assert.match(body.error, /Sent folder/);
  assert.equal(gmailSends().length, 1);
  assert.equal(smtp.transports.length, 0, "never falls back to SMTP after an ambiguous Gmail send");
  assert.equal(db.__dumpTable("gmail_messages").length, before);
});

test("Gmail definite rejection: clear error, no SMTP fallback", async () => {
  setup({ smtp: true });
  gmailStub.reset({ send: [{ status: 400, body: { error: { code: 400, errors: [{ reason: "invalidArgument" }] } } }] });
  const res = await send({ channel: "email", to: "customer@example.com", body: "x", contact_id: CONTACT });
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).code, "email_provider_rejected");
  assert.equal(smtp.transports.length, 0);
});

test("Gmail accepted but saving history failed: still ok (never an error that invites a resend)", async () => {
  setup({ failGmailInsert: true });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.persisted, false);
  assert.match(body.warning, /was sent/);
  assert.equal(gmailSends().length, 1);
});

test("Gmail: an invalid recipient is refused before anything is sent", async () => {
  setup();
  const res = await send({ channel: "email", to: "not-an-address", body: "x", contact_id: CONTACT });
  assert.equal(res.statusCode, 422);
  assert.equal(gmailSends().length, 0);
});

// ── provider selection / legacy SMTP ─────────────────────────────────────

test("SMTP-only org: unchanged legacy behavior (threading headers, smtp: row, smtpMessageId), Gmail never called", async () => {
  setup({ gmail: null, smtp: true });
  const res = await reply({ subject: "Re: Kitchen remodel" });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.emailProvider, "smtp");
  assert.equal(body.smtpMessageId, "<smtp-1@smtp.gmail.com>");
  assert.equal(body.notice, undefined);
  assert.equal(gmailStub.calls.length, 0);
  assert.deepEqual((smtp.transports[0] as any).auth, { user: "office@acme-smtp.test", pass: "abcdefghijklmnop" });
  assert.equal(smtp.sent[0].from, "Acme Remodeling <office@acme-smtp.test>");
  assert.equal(smtp.sent[0].inReplyTo, CUSTOMER_MSG_ID);
  assert.ok(db.__dumpTable("gmail_messages").some((r: any) => r.id === "smtp:smtp-1@smtp.gmail.com" && r.org_id === ORG));
  assert.ok(!logged.join("\n").includes("abcdefghijklmnop"), "App Password never logged");
});

test("disconnected Google row + SMTP: SMTP, with no reconnect nag", async () => {
  setup({ gmail: { status: "disconnected", access_token_encrypted: null, refresh_token_encrypted: null }, smtp: true });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).emailProvider, "smtp");
  assert.equal(JSON.parse(res.body).notice, undefined);
});

test("revoked Google connection + SMTP: falls back BEFORE sending, and says to reconnect", async () => {
  setup({ gmail: { token_expires_at: expiredAt() }, smtp: true });
  gmailStub.reset({ refresh: { status: 400, body: { error: "invalid_grant" } } });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.emailProvider, "smtp");
  assert.match(body.notice, /reconnected/);
  assert.equal(gmailSends().length, 0);
  assert.equal(smtp.sent.length, 1);
});

test("revoked Google connection, no SMTP: reconnect guidance — owner gets the link, other roles are told to ask the owner", async () => {
  setup({ gmail: { token_expires_at: expiredAt() } });
  gmailStub.reset({ refresh: { status: 400, body: { error: "invalid_grant" } } });
  const owner = JSON.parse((await reply()).body);
  assert.equal(owner.code, "email_reconnect_required");
  assert.deepEqual(owner.action, { type: "reconnect_email", path: "/settings/integrations" });
  const salesRes = await send({ channel: "email", to: "customer@example.com", body: "x", contact_id: CONTACT }, "t-sales");
  assert.equal(salesRes.statusCode, 409);
  const salesBody = JSON.parse(salesRes.body);
  assert.deepEqual(salesBody.action, { type: "contact_owner" });
  assert.match(salesBody.error, /organization owner/);
  assert.equal(gmailSends().length, 0);
  assert.equal(smtp.transports.length, 0);
});

test("neither Google nor SMTP: connection-required message, nothing sent", async () => {
  setup({ gmail: null });
  const res = await reply();
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "email_not_connected");
  assert.match(body.error, /Connect your Google account/);
});

test("Google connection without the send permission + no SMTP: scope guidance", async () => {
  setup();
  gmailStub.reset({ scope: "https://www.googleapis.com/auth/gmail.readonly" });
  const res = await reply();
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).code, "email_send_scope_missing");
});

// ── incomplete Google identity (connected row with NULL provider_account_email) ──

test("NULL account email + SMTP configured: Gmail still sends, as the address Gmail reports — never the SMTP address", async () => {
  setup({ gmail: { provider_account_email: null }, smtp: true });
  gmailStub.reset({ profileEmail: "owner@renometa-real.test" });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).emailProvider, "gmail");
  assert.equal(smtp.transports.length, 0);
  const mime = gmailStub.sentMime[0];
  assert.equal(header(mime, "From"), '"Acme Remodeling" <owner@renometa-real.test>');
  assert.doesNotMatch(mime, /acme-smtp\.test/, "the SMTP sender identity is never used on a Gmail send");
  // Recorded once, only into the empty column; tokens untouched.
  const row = db.__dumpTable("integrations")[0];
  assert.equal(row.provider_account_email, "owner@renometa-real.test");
  assert.equal(row.status, "connected");
  const sentRow = db.__dumpTable("gmail_messages").find((r: any) => r.id === gmailStub.mailbox[0].id);
  assert.equal(sentRow.from_email, '"Acme Remodeling" <owner@renometa-real.test>');
});

test("NULL account email and Gmail can't report it: sends with no From header (Gmail uses the authorized mailbox), no SMTP identity, column stays NULL", async () => {
  setup({ gmail: { provider_account_email: null }, smtp: true });
  const res = await reply();
  assert.equal(res.statusCode, 200, res.body);
  const mime = gmailStub.sentMime[0];
  assert.equal(header(mime, "From"), null);
  assert.doesNotMatch(mime, /acme-smtp\.test/);
  assert.equal(db.__dumpTable("integrations")[0].provider_account_email, null);
  assert.equal(db.__dumpTable("gmail_messages").find((r: any) => r.id === gmailStub.mailbox[0].id).from_email, null);
});

test("a stored account email is never overwritten or re-looked-up", async () => {
  setup();
  gmailStub.reset({ profileEmail: "someone-else@example.test" });
  await reply();
  assert.equal(db.__dumpTable("integrations")[0].provider_account_email, "owner@acmeremodeling.com");
  assert.ok(!gmailStub.calls.some((c) => c.url.endsWith("/users/me/profile")));
  assert.match(gmailStub.sentMime[0], /^From: "Acme Remodeling" <owner@acmeremodeling\.com>\r?$/m);
});

// ── tenant isolation ─────────────────────────────────────────────────────

test("multi-tenant: another org's Gmail account and thread are never used", async () => {
  setup({ gmail: null, smtp: true });
  // Org B has a live Google connection and owns a thread with the same id.
  await db.from("integrations").insert({ ...gmailIntegration(OTHER_ORG), id: "int-other" });
  await db.from("gmail_messages").insert({ id: "other-1", org_id: OTHER_ORG, thread_id: "other-thread", internal_date: "2026-10-30T00:00:00Z", labels: ["INBOX"], rfc_message_id: "<secret@other.test>", subject: "Private" });
  const res = await reply({ email_thread_id: "other-thread" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).emailProvider, "smtp", "Org A has no Google connection of its own");
  assert.equal(gmailStub.calls.length, 0, "Org B's token never touched");
  assert.equal(smtp.sent[0].inReplyTo, undefined, "Org B's thread headers never leak into Org A's reply");
  const row = db.__dumpTable("gmail_messages").find((r: any) => r.id.startsWith("smtp:"));
  assert.equal(row.org_id, ORG);
});

test("multi-tenant: a Gmail reply's sent row belongs to the sender's org only", async () => {
  setup();
  await db.from("integrations").insert({ ...gmailIntegration(OTHER_ORG), id: "int-other", provider_account_email: "other@other.test" });
  const res = await send({ channel: "email", to: "c@example.com", body: "x", contact_id: CONTACT }, "t-other");
  assert.equal(res.statusCode, 200, res.body);
  assert.match(gmailStub.sentMime[0], /^From: other@other\.test\r?$/m);
  const rows = db.__dumpTable("gmail_messages").filter((r: any) => r.id === gmailStub.mailbox[0].id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].org_id, OTHER_ORG);
});

test("never logs the message body, recipient or tokens on the Gmail path", async () => {
  setup();
  gmailStub.reset({ send: [{ status: 503 }] });
  await reply();
  const text = logged.join("\n");
  for (const secret of ["Tuesday works", "customer@example.com", "live-access-token", "refresh-token-1"]) {
    assert.ok(!text.includes(secret), `log leaked ${secret}`);
  }
});
