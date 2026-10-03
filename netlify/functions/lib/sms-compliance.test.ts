// netlify/functions/lib/sms-compliance.test.ts
//
// Run:  node --test netlify/functions/lib/sms-compliance.test.ts
//
// AI-3K. Pure classification + the authoritative consent-model writes
// (marketing_contact_preferences.sms_status) + the deterministic HELP
// reply. No live Supabase, no live Twilio — global fetch is a throwing
// stub for this whole file.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "sms-compliance-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "sms-compliance.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js"],
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);

const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => console[k]);
noisy.forEach((k) => (console[k] = () => {}));
after(() => noisy.forEach((k, i) => (console[k] = saved[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

// ── classifySmsComplianceMessage — pure classification ──────────────────

test("STOP-family keywords are recognized case-insensitively and with surrounding whitespace", () => {
  for (const body of ["STOP", "stop", " STOP ", "Stop", "sToP", "  stop  "]) {
    assert.equal(S.classifySmsComplianceMessage(body), "stop", JSON.stringify(body));
  }
  for (const body of ["STOPALL", "unsubscribe", "Cancel", "END", "quit", " QUIT "]) {
    assert.equal(S.classifySmsComplianceMessage(body), "stop", JSON.stringify(body));
  }
});

test("an ordinary message containing 'stop' as a substring is NOT classified as a compliance command", () => {
  assert.equal(S.classifySmsComplianceMessage("please stop texting me at work, my cell is better"), null);
  assert.equal(S.classifySmsComplianceMessage("I want to stop by your office tomorrow"), null);
});

test("START-family keywords (START/UNSTOP only, not bare YES) are recognized case-insensitively/whitespace-tolerant", () => {
  for (const body of ["START", "start", " Start ", "UNSTOP", "unstop", " UnStop "]) {
    assert.equal(S.classifySmsComplianceMessage(body), "start", JSON.stringify(body));
  }
  assert.equal(S.classifySmsComplianceMessage("yes"), null, "a bare 'yes' must never be treated as a compliance command — plausible ordinary conversational reply");
});

test("HELP-family keywords (HELP/INFO) are recognized case-insensitively/whitespace-tolerant", () => {
  for (const body of ["HELP", "help", " Help ", "INFO", "info", " Info "]) {
    assert.equal(S.classifySmsComplianceMessage(body), "help", JSON.stringify(body));
  }
});

test("an ordinary conversational message classifies as null", () => {
  assert.equal(S.classifySmsComplianceMessage("Hi, I'm interested in remodeling my kitchen."), null);
  assert.equal(S.classifySmsComplianceMessage(""), null);
});

test("isStopKeyword is equivalent to classifySmsComplianceMessage === 'stop'", () => {
  assert.equal(S.isStopKeyword("STOP"), true);
  assert.equal(S.isStopKeyword("START"), false);
  assert.equal(S.isStopKeyword("hello"), false);
});

// ── AI-3L: classifyOptOutType / resolveSmsComplianceIntent ──────────────

test("classifyOptOutType recognizes STOP/START/HELP case-insensitively, null/unrecognized -> null", () => {
  assert.equal(S.classifyOptOutType("STOP"), "stop");
  assert.equal(S.classifyOptOutType("stop"), "stop");
  assert.equal(S.classifyOptOutType("Start"), "start");
  assert.equal(S.classifyOptOutType("HELP"), "help");
  assert.equal(S.classifyOptOutType(null), null);
  assert.equal(S.classifyOptOutType(undefined), null);
  assert.equal(S.classifyOptOutType(""), null);
  assert.equal(S.classifyOptOutType("something-else"), null);
});

test("resolveSmsComplianceIntent: OptOutType (provider-authoritative) wins over body text, even when they disagree", () => {
  assert.equal(S.resolveSmsComplianceIntent("this is definitely not a stop keyword", "STOP"), "stop");
  assert.equal(S.resolveSmsComplianceIntent("STOP", "HELP"), "help");
});

test("resolveSmsComplianceIntent: falls back to body classification when OptOutType is absent", () => {
  assert.equal(S.resolveSmsComplianceIntent("STOP", null), "stop");
  assert.equal(S.resolveSmsComplianceIntent("hello", null), null);
});

// ── processStopKeyword / processStartKeyword — authoritative consent writes ──

function makeDb(prefs: any[] = []) {
  return createFakeSupabaseClient({
    marketing_contact_preferences: prefs,
  }, {}, {});
}

test("processStopKeyword sets sms_status to 'opted_out' for the contact", async () => {
  const db = makeDb();
  await S.processStopKeyword(db, ORG_A, CONTACT_1);
  const { data } = await db.from("marketing_contact_preferences").select("sms_status").eq("contact_id", CONTACT_1).maybeSingle();
  assert.equal(data.sms_status, "opted_out");
});

test("processStartKeyword restores 'opted_out' -> 'eligible'", async () => {
  const db = makeDb([{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "opted_out" }]);
  await S.processStartKeyword(db, ORG_A, CONTACT_1);
  const { data } = await db.from("marketing_contact_preferences").select("sms_status").eq("contact_id", CONTACT_1).maybeSingle();
  assert.equal(data.sms_status, "eligible");
});

test("processStartKeyword sets 'unknown'/no-row -> 'eligible'", async () => {
  const db = makeDb();
  await S.processStartKeyword(db, ORG_A, CONTACT_1);
  const { data } = await db.from("marketing_contact_preferences").select("sms_status").eq("contact_id", CONTACT_1).maybeSingle();
  assert.equal(data.sms_status, "eligible");
});

test("processStartKeyword never clears 'suppressed' — a text message cannot itself prove deliverability", async () => {
  const db = makeDb([{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "suppressed" }]);
  await S.processStartKeyword(db, ORG_A, CONTACT_1);
  const { data } = await db.from("marketing_contact_preferences").select("sms_status").eq("contact_id", CONTACT_1).maybeSingle();
  assert.equal(data.sms_status, "suppressed");
});

// ── HELP deterministic reply ──────────────────────────────────────────────

function makeHelpDb(overrides: Record<string, any[]> = {}) {
  return createFakeSupabaseClient({
    organizations: [{ id: ORG_A, ai_center_settings: { smsCompliance: { helpReply: "Reply STOP to opt out, call (555) 555-0100 for help." } }, integration_settings: { twilio: { accountSid: "ACxxx", authToken: "tok", phoneNumber: "+17545818861" } } }],
    marketing_contact_preferences: [],
    sms_meta_messages: [{ id: "msg-1", org_id: ORG_A, meta: null }],
    ...overrides,
  }, {}, {});
}

test("HELP sends the org's configured deterministic reply with no model call, via sendTwilioSms", async () => {
  const db = makeHelpDb();
  let captured: any;
  globalThis.fetch = (async (url: any, init: any) => { captured = { url: String(url), init }; return new Response(JSON.stringify({ sid: "SM_help_reply_1" }), { status: 201 }); }) as typeof fetch;
  await S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1);
  assert.ok(captured, "expected a Twilio send attempt");
  assert.ok(captured.init.body.includes("Reply+STOP"), "expected the configured helpReply text in the outbound body");
});

test("HELP sends no reply when no helpReply is configured (safe default, not a bug)", async () => {
  const db = createFakeSupabaseClient({
    organizations: [{ id: ORG_A, ai_center_settings: {}, integration_settings: { twilio: { accountSid: "ACxxx", authToken: "tok", phoneNumber: "+17545818861" } } }],
    marketing_contact_preferences: [],
    sms_meta_messages: [{ id: "msg-1", org_id: ORG_A, meta: null }],
  }, {}, {});
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must never be called"); }) as typeof fetch;
  await S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1);
  assert.equal(fetchCalled, false);
});

test("HELP reply is blocked for a suppressed contact (transport safety, not consent)", async () => {
  const db = makeHelpDb({ marketing_contact_preferences: [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: "suppressed" }] });
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error("must never be called"); }) as typeof fetch;
  await S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1);
  assert.equal(fetchCalled, false);
});

test("HELP reply is NOT blocked for 'opted_out' or 'unknown' — compliance/support reply, not a marketing send", async () => {
  for (const status of ["opted_out", "unknown"]) {
    const db = makeHelpDb({ marketing_contact_preferences: status === "unknown" ? [] : [{ org_id: ORG_A, contact_id: CONTACT_1, sms_status: status }] });
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }); }) as typeof fetch;
    await S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1);
    assert.equal(fetchCalled, true, status);
  }
});

test("HELP reply is claimed exactly once — a duplicate invocation for the same inbound row does not double-send", async () => {
  const db = makeHelpDb();
  let sendCount = 0;
  globalThis.fetch = (async () => { sendCount++; return new Response(JSON.stringify({ sid: `SM_${sendCount}` }), { status: 201 }); }) as typeof fetch;
  await Promise.all([
    S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1),
    S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+17547048148", CONTACT_1),
  ]);
  assert.equal(sendCount, 1, "exactly one HELP reply send, never two, for the same inbound row");
});

test("HELP can still reply to an unmatched sender (no CRM contact) — a compliance reply isn't gated by CRM identity", async () => {
  const db = makeHelpDb();
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }); }) as typeof fetch;
  await S.sendHelpReplyIfConfigured(db, ORG_A, "msg-1", "+19995551234", null);
  assert.equal(fetchCalled, true);
});
