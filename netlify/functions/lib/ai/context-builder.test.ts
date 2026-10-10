// netlify/functions/lib/ai/context-builder.test.ts
//
// Run:  node --test netlify/functions/lib/ai/context-builder.test.ts
//
// Lead-Qualification-to-Scheduling handoff phase. context-builder.ts had
// NO test file at all before this pass. Covers specifically the new
// `schedulingOfferActive` field and its 24-hour TTL — resolveSchedulingOfferActive()
// is the exact 24-hour boundary math router.test.ts's own TTL test
// deliberately deferred to this file. No live Supabase/network — uses the
// existing fake-supabase-client.mjs, same convention as every other
// netlify/functions/lib/*.test.ts file.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "context-builder-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "context-builder.ts")],
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
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOW = new Date("2027-03-16T18:00:00.000Z");

function makeDb(conversationStateRow: Record<string, unknown> | null) {
  return createFakeSupabaseClient({
    organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: "America/New_York" }],
    contacts: [{ id: CONTACT_1, org_id: ORG_A, full_name: "Jane Homeowner", email: null, phone: "+15550001111" }],
    conversation_states: conversationStateRow ? [conversationStateRow] : [],
    sms_meta_messages: [],
  }, {}, {});
}

test("an offer written 1 hour ago (well within 24h) -> schedulingOfferActive: true", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.equal(context.conversation?.schedulingOfferActive, true);
});

test("exactly at the 24-hour boundary -> still active (<=24h, inclusive)", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 24 * 3600_000).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.equal(context.conversation?.schedulingOfferActive, true);
});

test("1ms past the 24-hour boundary -> stale, schedulingOfferActive is NOT true", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 24 * 3600_000 - 1).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
});

test("no row at all -> schedulingOfferActive is not set, no conversation object forced into existence just for this field", async () => {
  const db = makeDb(null);
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
});

test("no contactId at all -> never attempts the read, never active", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
});

test("an unsupported channel for scheduling offers (email) never resolves active, even with a matching row for a different channel", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "email", contactId: CONTACT_1, now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
});

test("a malformed stored offer shape (readOfferedSlots()'s own fail-safe) resolves to 'none', never throws, and buildAIContext() still returns normally", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ label: "Tuesday" }], // no start/end/timeZone — malformed
    scheduling_offered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
  assert.ok(context.organization); // the rest of the context still built normally
});

test("a genuine query failure on conversation_states fails SAFE (schedulingOfferActive false/absent), never fatal to the whole buildAIContext() call — unlike every other section of this file", async () => {
  const inner = makeDb(null);
  const failingChain: any = {
    eq: () => failingChain,
    maybeSingle: async () => ({ data: null, error: { message: "simulated failure" } }),
    then: (resolve: any) => resolve({ data: null, error: { message: "simulated failure" } }),
  };
  const db = { ...inner, from: (t: string) => (t === "conversation_states" ? { select: () => failingChain } : inner.from(t)) };
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.ok(!context.conversation?.schedulingOfferActive);
  assert.ok(context.organization, "the rest of the context must still build successfully despite this one failure");
  assert.ok(context.contact, "contact resolution is independent of the scheduling-offer read and must be unaffected");
});

test("an active offer still coexists with real recentMessages — the new field is attached to, not instead of, the existing conversation summary", async () => {
  const db = makeDb({
    org_id: ORG_A, contact_id: CONTACT_1, channel: "sms",
    scheduling_offered_slots: [{ start: "2027-03-17T19:00:00.000Z", end: "2027-03-17T20:00:00.000Z", timeZone: "America/New_York" }],
    scheduling_offered_at: new Date(NOW.getTime() - 3600_000).toISOString(),
  });
  await db.from("sms_meta_messages").insert({ org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", direction: "in", body: "Hi there", created_at: NOW.toISOString() });
  const context = await S.buildAIContext({ supabase: db, orgId: ORG_A, channel: "sms", contactId: CONTACT_1, now: NOW });
  assert.equal(context.conversation?.schedulingOfferActive, true);
  assert.equal(context.conversation?.recentMessages?.length, 1);
});
