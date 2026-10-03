// netlify/functions/lib/twilio-sms-inbound.test.ts
//
// Run:  node --test netlify/functions/lib/twilio-sms-inbound.test.ts
//
// AI-3I. Covers sections B-F of the task's test matrix (section A, request
// verification, is covered separately in twilio-signature.test.ts since
// that logic is pure and dependency-free):
//   B. org resolution (unique match / no match / ambiguous / missing creds)
//   C. persistence/idempotency (inserted once, Twilio retry does not
//      duplicate the message or dispatch AI twice)
//   D. lead routing (known contact + open lead -> dispatch; no contact ->
//      no AI; contact but no open lead -> no AI; channel=sms;
//      MessageSid used as externalMessageId)
//   E. Level behavior is NOT re-tested here (lead-qualification-dispatch.test.ts
//      already covers Level 1 recommendation vs. Level 2 approval
//      end-to-end) — this file proves this NEW webhook reaches that
//      EXISTING dispatcher with the correct source/channel/payload shape,
//      via the injected dispatchLeadQualificationBackground fake.
//   F. safety: org scope preserved, no cross-org contact/lead match, no
//      real network call anywhere in this file (global fetch is a
//      throwing stub).
//
// No live Supabase, no live Twilio, no live Anthropic.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Guarantee no test in this file can ever make a real network call.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("real network access is forbidden in this test file");
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "twilio-sms-inbound-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "twilio-sms-inbound.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  alias: { "@": path.join(repoRoot, "src") },
  external: ["@supabase/supabase-js"],
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const { createFakeSupabaseClient }: any = await import(pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => console[k]);
noisy.forEach((k) => (console[k] = () => {}));
after(() => noisy.forEach((k, i) => (console[k] = saved[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LEAD_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const ORG_A_PHONE = "+17545818861"; // the "To" number
const TEST_LEAD_CONTACT_PHONE = "+17547048148"; // the "From" number (matches CONTACT_1)
const UNMATCHED_PHONE = "+19995551234";

function makeDb(overrides: Record<string, any[]> = {}) {
  return createFakeSupabaseClient(
    {
      organizations: [
        { id: ORG_A, integration_settings: { twilio: { phoneNumber: ORG_A_PHONE, authToken: "org-a-token" } } },
        { id: ORG_B, integration_settings: { twilio: { phoneNumber: "+19998887777", authToken: "org-b-token" } } },
      ],
      contacts: [{ id: CONTACT_1, org_id: ORG_A, phone: TEST_LEAD_CONTACT_PHONE }],
      leads: [{ id: LEAD_1, org_id: ORG_A, contact_id: CONTACT_1, status: "new", created_at: "2026-01-01T00:00:00Z" }],
      sms_meta_messages: [],
      ...overrides,
    },
    {},
    { uniqueConstraints: { sms_meta_messages: [["org_id", "provider_message_id"]] } },
  );
}

function fakeDispatch() {
  const calls: any[] = [];
  const fn = async (payload: any) => { calls.push(payload); return true; };
  return { fn, calls };
}

const FULL_URL = "https://deploy-preview-15--renoconnect.netlify.app/.netlify/functions/ai-twilio-sms-inbound";

function rawBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// ── B. Org resolution ────────────────────────────────────────────────────

test("B. the receiving number resolves exactly one org", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const r = await S.processTwilioInboundSms(
    { rawBody: rawBody({ From: TEST_LEAD_CONTACT_PHONE, To: ORG_A_PHONE, Body: "hi", MessageSid: "SM1" }), signatureHeader: "irrelevant-until-resolved", fullUrl: FULL_URL },
    { supabase: db, dispatchLeadQualificationBackground: dispatch.fn },
  );
  // Signature will fail here (not a real one) — proves org resolution ran
  // FIRST and got far enough to attempt a signature check against ORG_A's
  // own token, not that nothing happened.
  assert.equal(r.outcome, "invalid_signature");
  assert.equal((r as any).orgId, ORG_A);
});

test("B. no org matches the receiving number -> safe no-op (org_not_found), never a signature check", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const r = await S.processTwilioInboundSms(
    { rawBody: rawBody({ From: TEST_LEAD_CONTACT_PHONE, To: "+10005551111", Body: "hi", MessageSid: "SM1" }), signatureHeader: undefined, fullUrl: FULL_URL },
    { supabase: db, dispatchLeadQualificationBackground: dispatch.fn },
  );
  assert.equal(r.outcome, "org_not_found");
  assert.equal(dispatch.calls.length, 0);
});

test("B. ambiguous: more than one org configured with the same receiving number -> fail closed", async () => {
  const db = makeDb({
    organizations: [
      { id: ORG_A, integration_settings: { twilio: { phoneNumber: ORG_A_PHONE, authToken: "org-a-token" } } },
      { id: ORG_B, integration_settings: { twilio: { phoneNumber: ORG_A_PHONE, authToken: "org-b-token" } } },
    ],
  });
  const dispatch = fakeDispatch();
  const r = await S.processTwilioInboundSms(
    { rawBody: rawBody({ From: TEST_LEAD_CONTACT_PHONE, To: ORG_A_PHONE, Body: "hi", MessageSid: "SM1" }), signatureHeader: undefined, fullUrl: FULL_URL },
    { supabase: db, dispatchLeadQualificationBackground: dispatch.fn },
  );
  assert.equal(r.outcome, "org_ambiguous");
  assert.equal(dispatch.calls.length, 0);
});

test("B. org matched but missing Twilio authToken -> fail closed (missing_credentials)", async () => {
  const db = makeDb({
    organizations: [{ id: ORG_A, integration_settings: { twilio: { phoneNumber: ORG_A_PHONE } } }],
  });
  const dispatch = fakeDispatch();
  const r = await S.processTwilioInboundSms(
    { rawBody: rawBody({ From: TEST_LEAD_CONTACT_PHONE, To: ORG_A_PHONE, Body: "hi", MessageSid: "SM1" }), signatureHeader: undefined, fullUrl: FULL_URL },
    { supabase: db, dispatchLeadQualificationBackground: dispatch.fn },
  );
  assert.equal(r.outcome, "org_missing_credentials");
  assert.equal((r as any).orgId, ORG_A);
  assert.equal(dispatch.calls.length, 0);
});

// ── Signature verification integration (reuses twilio-signature.ts) ────

import { createHmac } from "node:crypto";
function computeRealSignature(authToken: string, fullUrl: string, params: URLSearchParams): string {
  const sortedKeys = Array.from(new Set(params.keys())).sort();
  let data = fullUrl;
  for (const key of sortedKeys) data += key + (params.get(key) ?? "");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function validRequestFor(orgPhone: string, from: string, body: string, messageSid: string, authToken: string) {
  const fields = { From: from, To: orgPhone, Body: body, MessageSid: messageSid };
  const raw = rawBody(fields);
  const sig = computeRealSignature(authToken, FULL_URL, new URLSearchParams(raw));
  return { rawBody: raw, signatureHeader: sig, fullUrl: FULL_URL };
}

test("A (integration). a valid Twilio signature for the resolved org is accepted and processing continues", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hello", "SM_valid_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "dispatched");
});

test("A (integration). an invalid signature for the resolved org is rejected, message never persisted", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hello", "SM_invalid_1", "WRONG-TOKEN");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "invalid_signature");
  assert.equal(dispatch.calls.length, 0);
  const { data: rows } = await db.from("sms_meta_messages").select("id").eq("provider_message_id", "SM_invalid_1").maybeSingle();
  assert.equal(rows, null, "an unverified request must never be persisted");
});

// ── C. Persistence / idempotency ────────────────────────────────────────

test("C. the inbound SMS is persisted exactly once", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hello there", "SM_persist_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "dispatched");
  const { data: row } = await db.from("sms_meta_messages").select("id, body, channel, direction, from_address, provider_message_id").eq("provider_message_id", "SM_persist_1").maybeSingle();
  assert.ok(row);
  assert.equal(row.body, "hello there");
  assert.equal(row.channel, "sms");
  assert.equal(row.direction, "in");
  assert.equal(row.from_address, TEST_LEAD_CONTACT_PHONE);
});

test("C. a Twilio retry of the SAME delivery (identical MessageSid) does not duplicate the message or dispatch AI a second time", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "retry me", "SM_retry_1", "org-a-token");

  const first = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(first.outcome, "dispatched");
  assert.equal(dispatch.calls.length, 1);

  const second = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(second.outcome, "duplicate_delivery");
  assert.equal(dispatch.calls.length, 1, "no second AI dispatch for the retried delivery");

  const { data: rows } = await db.from("sms_meta_messages").select("id").eq("provider_message_id", "SM_retry_1").eq("org_id", ORG_A);
  assert.equal((rows ?? []).length, 1, "only one row for this MessageSid");
});

// ── D. Lead/contact routing ──────────────────────────────────────────────

test("D. known contact + open lead -> dispatched with source inbound_lead_message, channel sms, correct ids, MessageSid as externalMessageId", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "I have a question", "SM_route_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "dispatched");
  assert.equal(r.orgId, ORG_A);
  assert.equal(r.contactId, CONTACT_1);
  assert.equal(r.leadId, LEAD_1);

  assert.equal(dispatch.calls.length, 1);
  const payload = dispatch.calls[0];
  assert.equal(payload.orgId, ORG_A);
  assert.equal(payload.leadId, LEAD_1);
  assert.equal(payload.contactId, CONTACT_1);
  assert.equal(payload.source, "inbound_lead_message");
  assert.equal(payload.inboundEvent.channel, "sms");
  assert.equal(payload.inboundEvent.externalMessageId, "SM_route_1", "Twilio MessageSid must be used as externalMessageId");
  assert.equal(payload.inboundEvent.text, "I have a question");
  assert.equal(payload.inboundEvent.candidate.direction, "in");
  assert.equal(payload.inboundEvent.candidate.syncOrigin, "live");
  assert.ok(typeof payload.inboundEvent.messageRowId === "string" && payload.inboundEvent.messageRowId.length > 0, "messageRowId must be the persisted row's own id");
});

test("D. no contact matches the sender -> message persisted, no AI dispatch, still a safe response", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, UNMATCHED_PHONE, "hello?", "SM_unmatched_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "no_contact");
  assert.equal(dispatch.calls.length, 0);
  const { data: row } = await db.from("sms_meta_messages").select("id, contact_id").eq("provider_message_id", "SM_unmatched_1").maybeSingle();
  assert.ok(row, "message must still be persisted for a human/future match");
  assert.equal(row.contact_id, null);
});

test("D. contact matched but no open lead (all leads converted/lost) -> no AI dispatch", async () => {
  const db = makeDb({
    leads: [{ id: LEAD_1, org_id: ORG_A, contact_id: CONTACT_1, status: "converted", created_at: "2026-01-01T00:00:00Z" }],
  });
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hi again", "SM_noopen_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "no_open_lead");
  assert.equal(r.contactId, CONTACT_1);
  assert.equal(dispatch.calls.length, 0);
});

test("D. contact matched, no lead at all for that contact -> no AI dispatch", async () => {
  const db = makeDb({ leads: [] });
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hi", "SM_nolead_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "no_open_lead");
  assert.equal(dispatch.calls.length, 0);
});

// ── F. Safety ─────────────────────────────────────────────────────────────

test("F. org scope is preserved: a contact with a matching phone in a DIFFERENT org is never matched", async () => {
  const OTHER_ORG_CONTACT = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const db = makeDb({
    contacts: [
      { id: CONTACT_1, org_id: ORG_A, phone: TEST_LEAD_CONTACT_PHONE },
      { id: OTHER_ORG_CONTACT, org_id: ORG_B, phone: TEST_LEAD_CONTACT_PHONE },
    ],
  });
  const dispatch = fakeDispatch();
  const req = validRequestFor(ORG_A_PHONE, TEST_LEAD_CONTACT_PHONE, "hi", "SM_scope_1", "org-a-token");
  const r = await S.processTwilioInboundSms(req, { supabase: db, dispatchLeadQualificationBackground: dispatch.fn });
  assert.equal(r.outcome, "dispatched");
  assert.equal(r.contactId, CONTACT_1, "must resolve ORG_A's own contact, never ORG_B's, even with an identical phone number");
  assert.equal(dispatch.calls[0].orgId, ORG_A);
});

test("F. a malformed/non-Twilio payload (missing MessageSid) is ignored safely, before any DB access", async () => {
  const db = makeDb();
  const dispatch = fakeDispatch();
  const r = await S.processTwilioInboundSms(
    { rawBody: rawBody({ From: TEST_LEAD_CONTACT_PHONE, To: ORG_A_PHONE, Body: "hi" }), signatureHeader: undefined, fullUrl: FULL_URL },
    { supabase: db, dispatchLeadQualificationBackground: dispatch.fn },
  );
  assert.equal(r.outcome, "ignored_non_twilio_payload");
  assert.equal(dispatch.calls.length, 0);
});

test("F. no real network call is ever made by this module under test (global fetch is a throwing stub for this whole file)", () => {
  assert.throws(() => (globalThis.fetch as any)());
});

// ── D/E (AI-3J): the trusted request origin comes ONLY from
// reconstructRequestUrl(event), never from Twilio form/body data ─────────
//
// processTwilioInboundSms() (this file's own core) never receives or
// computes an "origin" at all — by design. The dispatch function it calls
// is injected as a FULLY BOUND closure by the real handler
// (ai-twilio-sms-inbound.ts), which derives the origin from `fullUrl`
// (itself `reconstructRequestUrl(event)` — the same trusted value
// signature verification already depends on) BEFORE calling this core at
// all. The tests above already prove this structurally: every test in
// this file passes a FIXED `fullUrl` (FULL_URL) into the core regardless
// of what From/To/Body values are in the request — an attacker who puts
// an origin-shaped string in the SMS Body, or spoofs a different From/To,
// has no path to influence it, because the core doesn't accept an origin
// parameter from the payload at all. These two tests make that contract
// explicit via a source check on the real handler file — the smallest
// reliable way to pin "derives origin from reconstructRequestUrl(event),
// never from form data" without duplicating a full handler-level
// integration harness (mocking the Supabase client's OWN internal fetch
// calls inside the same global fetch mock as the dispatch call would add
// a lot of fragile test-only wiring for no additional real coverage over
// what the core's own tests above already establish).

import { readFileSync } from "node:fs";
const handlerSource = readFileSync(path.join(here, "..", "ai-twilio-sms-inbound.ts"), "utf8");

test("E. the Twilio handler derives its dispatch origin from reconstructRequestUrl(event), not from any Twilio form field", () => {
  assert.ok(handlerSource.includes('const fullUrl = reconstructRequestUrl(event as any);'), "fullUrl must come from reconstructRequestUrl(event)");
  assert.ok(/const requestOrigin = new URL\(fullUrl\)\.origin;/.test(handlerSource), "requestOrigin must be derived from fullUrl, not from event.body/From/To/Body");
});

test("D. the derived origin is passed as dispatchLeadQualificationBackground's baseUrl, and the body (event.body) is never referenced anywhere near that derivation", () => {
  assert.ok(handlerSource.includes("dispatchLeadQualificationBackground(payload, { baseUrl: requestOrigin })"), "the bound dispatch closure must pass requestOrigin as baseUrl");
  // The only use of event.body in this file is the one, early, raw-form
  // parse handed to the core (`rawBody: event.body`) — never re-read to
  // compute requestOrigin.
  const originLine = handlerSource.split("\n").find((l) => l.includes("const requestOrigin ="));
  assert.ok(originLine && !originLine.includes("event.body"), "requestOrigin must never be derived from event.body");
});
