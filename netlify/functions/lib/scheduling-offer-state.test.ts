// netlify/functions/lib/scheduling-offer-state.test.ts
//
// Run:  node --test netlify/functions/lib/scheduling-offer-state.test.ts
//
// Scheduling foundation — Phase 2. STATE test matrix: offered slots
// persist, slot data is canonical/structured (never label-only), a stale
// offer does not bypass revalidation (proven structurally — this module
// has no "reserve" concept at all), and other conversation_states fields
// (is_archived/is_starred) remain untouched by a write here.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "scheduling-offer-state-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "scheduling-offer-state.ts")],
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
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONTACT_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function makeDb(rows: any[] = []) {
  return createFakeSupabaseClient(
    { conversation_states: rows },
    {},
    { uniqueConstraints: { conversation_states: [["org_id", "contact_id", "channel"]] } },
  );
}

const SLOT_A = { start: "2027-03-16T14:00:00.000Z", end: "2027-03-16T15:00:00.000Z", timeZone: "America/New_York" };
const SLOT_B = { start: "2027-03-16T16:00:00.000Z", end: "2027-03-16T17:00:00.000Z", timeZone: "America/New_York", assignedTo: "member-1" };

test("offered slots persist and can be read back exactly", async () => {
  const db = makeDb();
  const write = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A, SLOT_B] });
  assert.equal(write.ok, true);

  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "found");
  assert.deepEqual(read.slots, [SLOT_A, SLOT_B]);
  assert.ok(read.offeredAt);
});

test("slot data is canonical/structured — every persisted slot carries start/end/timeZone, never a label-only string", async () => {
  const db = makeDb();
  const rejected = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: ["Tuesday at 2pm" as any] });
  assert.equal(rejected.ok, false, "a human-readable label with no structured fields must be rejected");

  const alsoRejected = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [{ start: "x" } as any] });
  assert.equal(alsoRejected.ok, false, "a slot missing end/timeZone must be rejected");
});

test("a second offer overwrites the first (upsert on org_id, contact_id, channel) — the conversation only ever has ONE current outstanding offer", async () => {
  const db = makeDb();
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_B] });
  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.deepEqual(read.slots, [SLOT_B]);
});

test("reading when no offer exists returns 'none', never a fabricated empty-but-found result", async () => {
  const db = makeDb();
  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "none");
});

test("clearOfferedSlots removes the offer — a stale offer does not linger once resolved", async () => {
  const db = makeDb();
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  await S.clearOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "none");
});

test("org/contact/channel scoping: the same contact in a different org gets an independent offer", async () => {
  const db = makeDb();
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  const readOtherOrg = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_B, contactId: CONTACT_1, channel: "sms" });
  assert.equal(readOtherOrg.status, "none");
});

test("different channels for the same contact get independent offers", async () => {
  const db = makeDb();
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  const whatsapp = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "whatsapp" });
  assert.equal(whatsapp.status, "none");
});

test("unsupported channel (email) is rejected at write time — email conversations use a different identity path", () => {
  return S.writeOfferedSlots({ supabase: makeDb() }, { orgId: ORG_A, contactId: CONTACT_1, channel: "email" as any, slots: [SLOT_A] }).then((r: any) => {
    assert.equal(r.ok, false);
  });
});

test("a write to scheduling_offered_slots never touches an existing row's is_archived/is_starred fields", async () => {
  const existing = { id: "row-1", org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", is_archived: true, is_starred: true, scheduling_offered_slots: null, scheduling_offered_at: null };
  const db = makeDb([existing]);
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  const { data: row } = await db.from("conversation_states").select("is_archived, is_starred, scheduling_offered_slots").eq("org_id", ORG_A).eq("contact_id", CONTACT_1).eq("channel", "sms").maybeSingle();
  assert.equal(row.is_archived, true, "archive state must survive a scheduling-offer write untouched");
  assert.equal(row.is_starred, true, "star state must survive a scheduling-offer write untouched");
  assert.deepEqual(row.scheduling_offered_slots, [SLOT_A]);
});

test("writeOfferedSlots rejects an empty slots array and missing orgId/contactId", async () => {
  const db = makeDb();
  assert.equal((await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [] })).ok, false);
  assert.equal((await S.writeOfferedSlots({ supabase: db }, { orgId: "", contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] })).ok, false);
});

test("a stale offer is never itself proof of availability — this module exposes no 'reserve'/'lock' concept at all (structural check)", () => {
  // There is deliberately no exported function here that marks a slot
  // reserved/claimed/locked — only write/read/clear of the OFFER record
  // itself. Any caller that wants to actually book one of these offered
  // slots MUST go through scheduling-availability.ts's
  // validateSlotAvailability() first (see that module's own tests) — this
  // test pins the absence, not a behavior.
  assert.equal(typeof S.reserveSlot, "undefined");
  assert.equal(typeof S.claimSlot, "undefined");
  assert.equal(typeof S.lockSlot, "undefined");
});
