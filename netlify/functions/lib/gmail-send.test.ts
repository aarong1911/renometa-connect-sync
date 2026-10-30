// netlify/functions/lib/gmail-send.test.ts
//
// Run:  node --test netlify/functions/lib/gmail-send.test.ts
// Native TS type-stripping, in-memory Supabase fake, and an injected fetch
// stub for every Google endpoint — no network, no real Gmail, no email sent.

import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.ENCRYPTION_KEY = "test-only-encryption-key";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-123.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-only-client-secret";

const {
  buildMimeMessage, classifyGmailSendFailure, findSentGmailMessage, GmailSendError, GMAIL_SEND_URL, hasSendScope,
  isValidRecipientEmail, resolveGmailSender, sendGmailMessage,
} = await import("./gmail-send.ts");
const { decryptBytea, encryptToBytea } = await import("./gmail-token-crypto.ts");
const {
  acquireEmailSendClaim, updateEmailSendClaim, releaseEmailSendClaim, takeOverEmailSendClaim, reconcileUnconfirmedSend,
  CLAIM_KEYS, SENDING_STALE_MS,
} = await import("./email-send-claim.ts");
const { buildGmailApiSentRow } = await import("./gmail-sent-reconcile.ts");
const { createFakeSupabaseClient }: any = await import(new URL("./test-support/fake-supabase-client.mjs", import.meta.url).href);

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const logged: string[] = [];
const noisy = ["log", "warn", "error", "info"] as const;
const savedConsole = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = (...args: unknown[]) => logged.push(JSON.stringify(args))));
after(() => noisy.forEach((k, i) => ((console as any)[k] = savedConsole[i])));

const future = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60 * 1000).toISOString();

function integration(over: Record<string, unknown> = {}) {
  return {
    id: "int-1", org_id: ORG, provider: "gmail", status: "connected",
    access_token_encrypted: encryptToBytea("live-access-token"),
    refresh_token_encrypted: encryptToBytea("refresh-token-1"),
    token_expires_at: future(), provider_account_email: "owner@acmeremodeling.com",
    ...over,
  };
}

type Call = { url: string; init?: RequestInit };
function fakeGoogle(opts: { scope?: string; aud?: string; refresh?: { status: number; body: unknown }; tokeninfoInvalidFor?: string[]; send?: { status: number; body: unknown; headers?: Record<string, string> } | "throw" } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("tokeninfo")) {
      const token = new URLSearchParams(String(init?.body)).get("access_token") ?? "";
      if (opts.tokeninfoInvalidFor?.includes(token)) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 });
      return new Response(JSON.stringify({ scope: opts.scope ?? SEND_SCOPE, aud: opts.aud ?? process.env.GOOGLE_OAUTH_CLIENT_ID }), { status: 200 });
    }
    if (url.includes("oauth2.googleapis.com/token")) {
      const r = opts.refresh ?? { status: 200, body: { access_token: "refreshed-access-token", expires_in: 3599 } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    if (url === GMAIL_SEND_URL) {
      if (opts.send === "throw") throw new TypeError("network down");
      const s = opts.send ?? { status: 200, body: { id: "gm-msg-1", threadId: "gm-thr-1", labelIds: ["SENT"] } };
      return new Response(JSON.stringify(s.body), { status: s.status, headers: s.headers });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}

const db = (rows: unknown[] = [integration()], extra: Record<string, unknown[]> = {}) => createFakeSupabaseClient({ integrations: rows, ...extra });

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof GmailSendError, `expected GmailSendError, got ${e}`);
    assert.equal(e.code, code);
    return true;
  });
}

const decodePart = (mime: string, contentType: string) => {
  const idx = mime.indexOf(`Content-Type: ${contentType}`);
  assert.ok(idx >= 0, `part ${contentType} present`);
  const body = mime.slice(idx).split("\r\n\r\n")[1].split("\r\n--")[0];
  return Buffer.from(body.replace(/\r\n/g, ""), "base64");
};

// ── MIME ────────────────────────────────────────────────────────────────

const baseEmail = {
  fromName: "Owen Owner", fromEmail: "owner@acmeremodeling.com", to: "jane@example.com",
  subject: "Proposal EST-000001 from Acme & Sons", html: "<p>Hi Jane &amp; family</p>", text: "Hi Jane & family",
};

test("MIME: From is the connected account with the user's display name; To/Subject/Message-ID set; html+text parts", () => {
  const { mime, messageId } = buildMimeMessage(baseEmail);
  assert.match(mime, /^From: "Owen Owner" <owner@acmeremodeling\.com>\r\n/m);
  assert.match(mime, /^To: jane@example\.com\r\n/m);
  assert.match(mime, /^Subject: Proposal EST-000001 from Acme & Sons\r\n/m, "subject is plain text, not HTML-escaped");
  assert.match(mime, new RegExp(`^Message-ID: ${messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n`, "m"));
  assert.match(messageId, /^<[0-9a-f-]{36}@acmeremodeling\.com>$/);
  assert.doesNotMatch(mime, /renometa\.com/i, "no RenoMeta sender identity anywhere");
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.doesNotMatch(mime, /multipart\/mixed/);
  assert.equal(decodePart(mime, "text/plain").toString("utf8"), "Hi Jane & family");
  assert.equal(decodePart(mime, "text/html").toString("utf8"), "<p>Hi Jane &amp; family</p>");
});

test("MIME: PDF attachment is a multipart/mixed application/pdf part whose bytes round-trip exactly", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300, 7), Buffer.from("\n%%EOF")]);
  const { mime } = buildMimeMessage({ ...baseEmail, attachments: [{ filename: "Proposal EST-000001.pdf", contentType: "application/pdf", content: pdf }] });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(mime, /Content-Type: application\/pdf; name="Proposal EST-000001\.pdf"\r\nContent-Disposition: attachment; filename="Proposal EST-000001\.pdf"\r\nContent-Transfer-Encoding: base64/);
  assert.ok(decodePart(mime, "application/pdf").equals(pdf), "attachment bytes intact");
  for (const line of mime.split("\r\n")) assert.ok(line.length <= 998, "RFC 5322 line limit");
  assert.equal(decodePart(mime, "text/plain").toString("utf8"), "Hi Jane & family", "body still present alongside the attachment");
});

test("MIME: header injection is neutralised and non-ASCII headers are RFC 2047 encoded", () => {
  const { mime } = buildMimeMessage({ ...baseEmail, fromName: 'Zoë "Boss"\r\nBcc: evil@x.com', subject: "Devis № 7\r\nBcc: evil@x.com" });
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/m);
  assert.match(mime, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <owner@acmeremodeling\.com>\r\n/m);
  assert.throws(() => buildMimeMessage({ ...baseEmail, to: "jane@example.com\r\nBcc: evil@x.com" }));
  assert.equal(isValidRecipientEmail("jane@example.com"), true);
  assert.equal(isValidRecipientEmail("jane@example.com, other@example.com"), false, "a single recipient only");
  assert.equal(isValidRecipientEmail("not-an-email"), false);
});

test("MIME: with no stored account email, From is omitted so Gmail applies the account's own address", () => {
  const { mime } = buildMimeMessage({ ...baseEmail, fromEmail: null });
  assert.doesNotMatch(mime, /^From:/m);
});

// ── sender resolution ───────────────────────────────────────────────────

test("sender: connected, unexpired token with gmail.send -> resolved without refreshing", async () => {
  const g = fakeGoogle();
  const sender = await resolveGmailSender(db() as any, ORG, g.fetchImpl as any);
  assert.equal(sender.accessToken, "live-access-token");
  assert.equal(sender.accountEmail, "owner@acmeremodeling.com");
  assert.equal(sender.orgId, ORG);
  assert.deepEqual(g.calls.map((c) => new URL(c.url).pathname), ["/tokeninfo"]);
  assert.equal(g.calls[0].init?.method, "POST", "token goes in a POST body, not the URL");
});

test("sender: no Gmail connection -> email_not_connected with a Connect action", async () => {
  await assert.rejects(resolveGmailSender(db([]) as any, ORG, fakeGoogle().fetchImpl as any), (e: any) => {
    assert.equal(e.code, "email_not_connected");
    assert.equal(e.httpStatus, 409);
    assert.deepEqual(e.toResponseBody().action, { type: "connect_email", path: "/settings/integrations" });
    return true;
  });
  await expectCode(resolveGmailSender(db([integration({ status: "disconnected", access_token_encrypted: null, refresh_token_encrypted: null })]) as any, ORG, fakeGoogle().fetchImpl as any), "email_not_connected");
});

test("sender: cross-tenant — another org's connected Gmail is never used", async () => {
  const g = fakeGoogle();
  await expectCode(resolveGmailSender(db([integration({ org_id: OTHER_ORG })]) as any, ORG, g.fetchImpl as any), "email_not_connected");
  assert.equal(g.calls.length, 0, "no token of another tenant is ever presented to Google");
});

test("sender: expired token is refreshed via the refresh_token grant and the new token is stored encrypted", async () => {
  const d = db([integration({ token_expires_at: past() })]);
  const g = fakeGoogle();
  const sender = await resolveGmailSender(d as any, ORG, g.fetchImpl as any);
  assert.equal(sender.accessToken, "refreshed-access-token");
  const refreshCall = g.calls.find((c) => c.url.includes("/token"))!;
  const form = new URLSearchParams(String(refreshCall.init?.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "refresh-token-1");
  const row = d.__dumpTable("integrations")[0];
  assert.equal(decryptBytea(row.access_token_encrypted), "refreshed-access-token");
  assert.ok(Date.parse(row.token_expires_at) > Date.now());
});

test("sender: revoked authorization (refresh -> invalid_grant) -> email_reconnect_required", async () => {
  const g = fakeGoogle({ refresh: { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } });
  await assert.rejects(resolveGmailSender(db([integration({ token_expires_at: past() })]) as any, ORG, g.fetchImpl as any), (e: any) => {
    assert.equal(e.code, "email_reconnect_required");
    assert.deepEqual(e.toResponseBody().action, { type: "reconnect_email", path: "/settings/integrations" });
    return true;
  });
});

test("sender: expired with no refresh token, or a non-connected status -> email_reconnect_required", async () => {
  await expectCode(resolveGmailSender(db([integration({ token_expires_at: past(), refresh_token_encrypted: null })]) as any, ORG, fakeGoogle().fetchImpl as any), "email_reconnect_required");
  await expectCode(resolveGmailSender(db([integration({ status: "error" })]) as any, ORG, fakeGoogle().fetchImpl as any), "email_reconnect_required");
});

test("sender: a token Google says is invalid is refreshed once, then re-checked", async () => {
  const g = fakeGoogle({ tokeninfoInvalidFor: ["live-access-token"] });
  const sender = await resolveGmailSender(db() as any, ORG, g.fetchImpl as any);
  assert.equal(sender.accessToken, "refreshed-access-token");
  assert.deepEqual(g.calls.map((c) => new URL(c.url).pathname), ["/tokeninfo", "/token", "/tokeninfo"]);
});

test("sender: missing gmail.send scope -> email_send_scope_missing (reconnect action)", async () => {
  await assert.rejects(resolveGmailSender(db() as any, ORG, fakeGoogle({ scope: READONLY_SCOPE }).fetchImpl as any), (e: any) => {
    assert.equal(e.code, "email_send_scope_missing");
    assert.equal(e.toResponseBody().action.type, "reconnect_email");
    return true;
  });
  assert.equal(hasSendScope(["https://mail.google.com/"]), true);
  assert.equal(hasSendScope([READONLY_SCOPE]), false);
});

test("sender: a token issued to a different OAuth client is refused", async () => {
  await expectCode(resolveGmailSender(db() as any, ORG, fakeGoogle({ aud: "someone-else.apps.googleusercontent.com" }).fetchImpl as any), "email_reconnect_required");
});

// ── send + error classification ─────────────────────────────────────────

const sender = { integrationId: "int-1", orgId: ORG, accessToken: "live-access-token", accountEmail: "owner@acmeremodeling.com" };

test("send: posts base64url MIME to users.messages.send with the account's bearer token; returns Gmail ids", async () => {
  const g = fakeGoogle();
  const r = await sendGmailMessage(sender, { ...baseEmail, fromEmail: "spoofed@renometa.com" }, g.fetchImpl as any);
  assert.equal(r.gmailMessageId, "gm-msg-1");
  assert.equal(r.gmailThreadId, "gm-thr-1");
  const call = g.calls[0];
  assert.equal(call.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal((call.init?.headers as Record<string, string>).Authorization, "Bearer live-access-token");
  const mime = Buffer.from(JSON.parse(String(call.init?.body)).raw, "base64url").toString("utf8");
  assert.match(mime, /^From: "Owen Owner" <owner@acmeremodeling\.com>\r\n/m, "From is always the connected account, whatever the caller passes");
  assert.match(mime, new RegExp(`^Message-ID: ${r.rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
});

test("send: provider rejection (400) -> email_provider_rejected, definitely not sent", async () => {
  await assert.rejects(sendGmailMessage(sender, baseEmail, fakeGoogle({ send: { status: 400, body: { error: { code: 400, message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } } }).fetchImpl as any), (e: any) => {
    assert.equal(e.code, "email_provider_rejected");
    assert.equal(e.maybeSent, false);
    assert.doesNotMatch(JSON.stringify(e.toResponseBody()), /Invalid To header/, "Google's raw text never reaches the browser");
    return true;
  });
});

test("send: rate limit (429 / 403 rateLimitExceeded) -> email_rate_limited with retryAfterSeconds, no automatic retry", async () => {
  const g = fakeGoogle({ send: { status: 429, body: { error: { code: 429 } }, headers: { "retry-after": "30" } } });
  await assert.rejects(sendGmailMessage(sender, baseEmail, g.fetchImpl as any), (e: any) => {
    assert.equal(e.code, "email_rate_limited");
    assert.equal(e.retryAfterSeconds, 30);
    return true;
  });
  assert.equal(g.calls.length, 1, "exactly one send attempt");
  assert.equal(classifyGmailSendFailure(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, null).code, "email_rate_limited");
});

test("send: 403 insufficient scope -> email_send_scope_missing; 401 -> email_reconnect_required", () => {
  assert.equal(classifyGmailSendFailure(403, { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, null).code, "email_send_scope_missing");
  assert.equal(classifyGmailSendFailure(401, {}, null).code, "email_reconnect_required");
});

test("send: 5xx, network failure, or a 2xx without an id -> email_delivery_unknown (maybeSent, never retried)", async () => {
  for (const send of [{ status: 500, body: {} }, { status: 503, body: {} }, "throw" as const, { status: 200, body: {} }]) {
    const g = fakeGoogle({ send });
    await assert.rejects(sendGmailMessage(sender, baseEmail, g.fetchImpl as any), (e: any) => {
      assert.equal(e.code, "email_delivery_unknown");
      assert.equal(e.maybeSent, true);
      return true;
    });
    assert.equal(g.calls.length, 1);
  }
});

test("logging: no access/refresh token or client secret is ever logged", () => {
  const all = logged.join("\n");
  for (const secret of ["live-access-token", "refreshed-access-token", "refresh-token-1", "test-only-client-secret", "jane@example.com"]) {
    assert.ok(!all.includes(secret), `"${secret}" leaked into logs`);
  }
});

// ── duplicate-send claim ────────────────────────────────────────────────

const EST = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const claimDb = (metadata: Record<string, unknown> = {}) => createFakeSupabaseClient({ estimates: [{ id: EST, org_id: ORG, metadata }] });
const claimInput = { id: EST, orgId: ORG, userId: "user-1", version: 1 };

test("claim: two concurrent sends of the same document -> exactly one claim", async () => {
  const d = claimDb();
  const [a, b] = await Promise.all([acquireEmailSendClaim(d as any, "estimates", claimInput), acquireEmailSendClaim(d as any, "estimates", claimInput)]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  const refused = (a.ok ? b : a) as any;
  assert.equal(refused.code, "email_send_in_progress");
});

test("claim: in-progress blocks; stale or failed claims are reclaimable; recent 'sent' blocks; other metadata preserved", async () => {
  const d = claimDb({ keep: "me" });
  const first = await acquireEmailSendClaim(d as any, "estimates", claimInput);
  assert.equal(first.ok, true);
  assert.equal(((await acquireEmailSendClaim(d as any, "estimates", claimInput)) as any).code, "email_send_in_progress");

  await releaseEmailSendClaim(d as any, "estimates", { id: EST, orgId: ORG, claimId: (first as any).claimId });
  const second = await acquireEmailSendClaim(d as any, "estimates", claimInput);
  assert.equal(second.ok, true, "a failed (nothing-sent) claim can be retried at once");

  const done = await updateEmailSendClaim(d as any, "estimates", { id: EST, orgId: ORG, claimId: (second as any).claimId }, { state: "sent", gmailMessageId: "gm-1", sentAt: new Date().toISOString() }, { status: "sent" });
  assert.equal(done.ok, true);
  const row = d.__dumpTable("estimates")[0];
  assert.equal(row.status, "sent");
  assert.equal(row.metadata.keep, "me");
  assert.equal(row.metadata[CLAIM_KEYS.gmailMessageId], "gm-1");
  assert.equal(((await acquireEmailSendClaim(d as any, "estimates", claimInput)) as any).code, "email_recently_sent");

  const staleAt = new Date(Date.now() - SENDING_STALE_MS - 1000).toISOString();
  const stale = claimDb({ [CLAIM_KEYS.id]: "old", [CLAIM_KEYS.state]: "sending", [CLAIM_KEYS.claimedAt]: staleAt, [CLAIM_KEYS.version]: 1 });
  const unconfirmed = (await acquireEmailSendClaim(stale as any, "estimates", claimInput)) as any;
  assert.equal(unconfirmed.code, "email_delivery_unconfirmed", "a crashed send is reconciled, never assumed unsent");
  assert.equal(unconfirmed.claimId, "old");
  const otherVersion = claimDb({ [CLAIM_KEYS.id]: "old", [CLAIM_KEYS.state]: "sending", [CLAIM_KEYS.claimedAt]: staleAt, [CLAIM_KEYS.version]: 0 });
  assert.equal((await acquireEmailSendClaim(otherVersion as any, "estimates", claimInput)).ok, true, "a new version isn't held by an old one");
});

test("claim: delivery_unknown returns the claim (and change-order token hash) for reconciliation", async () => {
  const d = claimDb({ [CLAIM_KEYS.id]: "c2", [CLAIM_KEYS.state]: "delivery_unknown", [CLAIM_KEYS.version]: 1, [CLAIM_KEYS.claimedAt]: new Date().toISOString(), [CLAIM_KEYS.tokenHash]: "h".repeat(64), [CLAIM_KEYS.tokenExpiresAt]: future() });
  const r = (await acquireEmailSendClaim(d as any, "estimates", claimInput)) as any;
  assert.equal(r.code, "email_delivery_unconfirmed");
  assert.equal(r.claimId, "c2");
  assert.equal(r.tokenHash, "h".repeat(64));
});

test("claim: takeover is compare-and-set — of two concurrent recoveries exactly one wins", async () => {
  const d = claimDb({ [CLAIM_KEYS.id]: "c3", [CLAIM_KEYS.state]: "sent_unrecorded" });
  const ref = { id: EST, orgId: ORG, claimId: "c3", userId: "user-1" };
  const [a, b] = await Promise.all([
    takeOverEmailSendClaim(d as any, "estimates", ref, { state: "sent_unrecorded" }),
    takeOverEmailSendClaim(d as any, "estimates", ref, { state: "sent_unrecorded" }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(d.__dumpTable("estimates")[0].metadata[CLAIM_KEYS.id], a ?? b);
});

// ── Sent-mail reconciliation ────────────────────────────────────────────

const SENDER = { integrationId: "int-1", orgId: ORG, accessToken: "live-access-token", accountEmail: "owner@acmeremodeling.com" };
function fakeSent(messages: Array<{ id: string; sendId: string | null }>, opts: { listStatus?: number; nextPageToken?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer live-access-token");
    assert.equal(init?.method ?? "GET", "GET", "reconciliation never sends");
    if (url.includes("/messages?")) {
      if (opts.listStatus && opts.listStatus !== 200) return new Response("{}", { status: opts.listStatus });
      return new Response(JSON.stringify({ messages: messages.map((m) => ({ id: m.id, threadId: `t-${m.id}` })), nextPageToken: opts.nextPageToken }), { status: 200 });
    }
    const id = decodeURIComponent(url.split("/messages/")[1].split("?")[0]);
    const m = messages.find((x) => x.id === id)!;
    return new Response(JSON.stringify({ id, threadId: `t-${id}`, payload: { headers: m.sendId ? [{ name: "x-renometa-send-id", value: m.sendId }] : [] } }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test("reconcile: finds the message whose X-RenoMeta-Send-Id matches, searching only Sent mail around the claim time", async () => {
  const claimedAt = new Date("2026-10-30T12:00:00Z");
  const g = fakeSent([{ id: "a", sendId: "other" }, { id: "b", sendId: null }, { id: "c", sendId: "claim-1" }]);
  const r = await findSentGmailMessage(SENDER, { sendId: "claim-1", claimedAt }, g.fetchImpl as any);
  assert.deepEqual(r, { status: "found", gmailMessageId: "c", gmailThreadId: "t-c" });
  const q = decodeURIComponent(new URL(g.calls[0]).searchParams.get("q")!);
  const at = claimedAt.getTime() / 1000;
  assert.equal(q, `in:sent after:${at - 300} before:${at + 1200}`);
});

test("reconcile: not found only when the whole window was searched; list errors or a truncated page are 'unavailable'", async () => {
  const claimedAt = new Date();
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "x", claimedAt }, fakeSent([{ id: "a", sendId: "y" }]).fetchImpl as any), { status: "not_found" });
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "x", claimedAt }, fakeSent([], { listStatus: 403 }).fetchImpl as any), { status: "unavailable" });
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "x", claimedAt }, fakeSent([{ id: "a", sendId: "y" }], { nextPageToken: "p2" }).fetchImpl as any), { status: "unavailable" });
  const throwing = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "x", claimedAt }, throwing as any), { status: "unavailable" });
});

test("reconcile: pagination is followed to a later-page match; more pages than the cap is 'unavailable', never 'not_found'", async () => {
  const claimedAt = new Date();
  const pages = [[{ id: "a", sendId: "x1" }], [{ id: "b", sendId: null }], [{ id: "c", sendId: "target" }]];
  const urls: string[] = [];
  const paged = async (url: string) => {
    urls.push(url);
    if (url.includes("/messages?")) {
      const n = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      return new Response(JSON.stringify({ messages: pages[n].map((m) => ({ id: m.id })), nextPageToken: n + 1 < pages.length ? String(n + 1) : undefined }), { status: 200 });
    }
    const id = url.split("/messages/")[1].split("?")[0];
    const m = pages.flat().find((x) => x.id === id)!;
    return new Response(JSON.stringify({ payload: { headers: m.sendId ? [{ name: "X-RenoMeta-Send-Id", value: m.sendId }] : [] } }), { status: 200 });
  };
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "target", claimedAt }, paged as any), { status: "found", gmailMessageId: "c", gmailThreadId: null });
  assert.ok(urls.some((u) => u.includes("pageToken=2")));
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "missing", claimedAt }, paged as any), { status: "not_found" }, "every page read");

  let listCalls = 0;
  const endless = async (url: string) => {
    if (url.includes("/messages?")) { listCalls += 1; return new Response(JSON.stringify({ messages: [], nextPageToken: "more" }), { status: 200 }); }
    return new Response("{}", { status: 200 });
  };
  assert.deepEqual(await findSentGmailMessage(SENDER, { sendId: "x", claimedAt }, endless as any), { status: "unavailable" });
  assert.equal(listCalls, 5, "bounded");
});

test("reconcile: a Sent-folder miss never authorizes a resend — only a settled outcome plus explicit confirmation does", async () => {
  const sendId = "c9";
  const settledAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const base = { [CLAIM_KEYS.id]: sendId, [CLAIM_KEYS.state]: "delivery_unknown", [CLAIM_KEYS.version]: 1, [CLAIM_KEYS.claimedAt]: settledAt };
  const refusal = { ok: false as const, code: "email_delivery_unconfirmed" as const, claimId: sendId, sendId, claimedAt: settledAt, tokenHash: null, tokenExpiresAt: null };
  const empty = fakeSent([]);

  let d = claimDb(base);
  let out = await reconcileUnconfirmedSend(d as any, "estimates", { id: EST, orgId: ORG, userId: "u", refusal, sender: SENDER, fetchImpl: empty.fetchImpl as any });
  assert.deepEqual(out, { kind: "unconfirmed", canConfirmResend: true, sentFolderChecked: true });
  assert.equal(d.__dumpTable("estimates")[0].metadata[CLAIM_KEYS.state], "delivery_unknown", "claim untouched");

  const fresh = new Date().toISOString();
  d = claimDb({ ...base, [CLAIM_KEYS.claimedAt]: fresh });
  out = await reconcileUnconfirmedSend(d as any, "estimates", { id: EST, orgId: ORG, userId: "u", refusal: { ...refusal, claimedAt: fresh }, sender: SENDER, confirmResend: true, fetchImpl: empty.fetchImpl as any });
  assert.deepEqual(out, { kind: "unconfirmed", canConfirmResend: false, sentFolderChecked: true }, "too early, even when confirmed");

  d = claimDb(base);
  out = await reconcileUnconfirmedSend(d as any, "estimates", { id: EST, orgId: ORG, userId: "u", refusal, sender: SENDER, confirmResend: true, fetchImpl: empty.fetchImpl as any });
  assert.equal(out.kind, "not_sent");
  assert.equal(d.__dumpTable("estimates")[0].metadata[CLAIM_KEYS.state], "sending");

  d = claimDb(base);
  out = await reconcileUnconfirmedSend(d as any, "estimates", { id: EST, orgId: ORG, userId: "u", refusal, sender: SENDER, confirmResend: true, fetchImpl: fakeSent([{ id: "m1", sendId }]).fetchImpl as any });
  assert.equal(out.kind, "delivered", "a match wins even over a resend confirmation");
  assert.equal(d.__dumpTable("estimates")[0].metadata[CLAIM_KEYS.gmailMessageId], "m1");
});

test("MIME: X-RenoMeta-Send-Id is written, and can't carry header injection", () => {
  const { mime } = buildMimeMessage({ fromName: null, fromEmail: "owner@acmeremodeling.com", to: "jane@example.com", subject: "S", html: "<p>h</p>", text: "t", sendId: "abc-123\r\nBcc: x@evil.com" });
  assert.match(mime, /^X-RenoMeta-Send-Id: abc-123Bccxevilcom\r$/m);
  assert.doesNotMatch(mime, /^Bcc:/m);
});

test("errors: non-owners get 'ask your organization owner' guidance instead of a Settings action", () => {
  for (const code of ["email_not_connected", "email_reconnect_required", "email_send_scope_missing"] as const) {
    const err = new GmailSendError(code, "owner message", { httpStatus: 409 });
    const owner = err.toResponseBody({ canManageIntegrations: true });
    assert.equal(owner.error, "owner message");
    assert.equal((owner.action as any).path, "/settings/integrations");
    const member = err.toResponseBody({ canManageIntegrations: false });
    assert.deepEqual(member.action, { type: "contact_owner" });
    assert.equal(member.ownerActionRequired, true);
    assert.match(String(member.error), /organization owner/);
  }
  const rejected = new GmailSendError("email_provider_rejected", "rejected", { httpStatus: 502 });
  assert.deepEqual(rejected.toResponseBody({ canManageIntegrations: false }), { error: "rejected", code: "email_provider_rejected" });
});

test("claim: a stolen/expired claim can no longer finalize", async () => {
  const d = claimDb();
  const mine = (await acquireEmailSendClaim(d as any, "estimates", claimInput)) as any;
  await d.from("estimates").update({ metadata: { [CLAIM_KEYS.id]: "someone-else", [CLAIM_KEYS.state]: "sending" } }).eq("id", EST);
  const r = await updateEmailSendClaim(d as any, "estimates", { id: EST, orgId: ORG, claimId: mine.claimId }, { state: "sent" }, { status: "sent" });
  assert.equal(r.ok, false);
  assert.notEqual(d.__dumpTable("estimates")[0].status, "sent");
});

test("claim: sent_unrecorded returns the stored Gmail ids instead of allowing a second email", async () => {
  const d = claimDb({ [CLAIM_KEYS.id]: "c1", [CLAIM_KEYS.state]: "sent_unrecorded", [CLAIM_KEYS.version]: 1, [CLAIM_KEYS.gmailMessageId]: "gm-9", [CLAIM_KEYS.gmailThreadId]: "th-9" });
  const r = (await acquireEmailSendClaim(d as any, "estimates", claimInput)) as any;
  assert.equal(r.code, "email_sent_unrecorded");
  assert.equal(r.claimId, "c1");
  assert.equal(r.gmailMessageId, "gm-9");
});

test("history row: keyed by the real Gmail id/thread exactly as gmail-sync upserts it", () => {
  const row = buildGmailApiSentRow({ orgId: ORG, gmailMessageId: "gm-1", gmailThreadId: "th-1", rfcMessageId: "<abc@acme.com>", fromEmail: "owner@acmeremodeling.com", to: "jane@example.com", subject: "S", body: "B" });
  assert.equal(row.id, "gm-1");
  assert.equal(row.thread_id, "th-1");
  assert.deepEqual(row.labels, ["SENT"]);
  assert.equal(row.direction, "out");
  assert.equal(row.rfc_message_id, "<abc@acme.com>");
});
