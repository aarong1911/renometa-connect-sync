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

// ── LIVE VALIDATION FIX (PR #17): UPDATE-then-INSERT, never a partial-
// index-incompatible upsert ──────────────────────────────────────────────
//
// conversation_states_org_contact_channel_uq is a PARTIAL unique index
// (`WHERE contact_id IS NOT NULL AND channel <> 'email'`) in the real
// database — confirmed from a live execution where a real get_availability
// succeeded but the matching conversation_states row never existed
// afterward. PostgREST's upsert `onConflict` option cannot correctly
// target a partial index (it has no way to express the WHERE predicate),
// so the old single `.upsert(..., {onConflict: "org_id,contact_id,channel"})`
// silently failed to persist in production even though the repo's own
// fake Supabase client (not partial-index-aware) let every pre-existing
// test above pass regardless — exactly the kind of fake-DB leniency that
// masked a real bug. These tests exercise the actual UPDATE/INSERT call
// sequence directly (via a spying wrapper around the fake client) rather
// than only asserting the end *state*, so a regression back to a single
// upsert call would fail these even if the fake client still happened to
// produce the right end result.

/** Wraps a fake Supabase client so `.update("conversation_states", ...)`
 * and `.insert("conversation_states", ...)` calls are individually
 * counted and (optionally) have their underlying DB method intercepted —
 * used to prove the EXACT call sequence (not just the end state) this
 * fix requires: UPDATE first, INSERT only when UPDATE found nothing,
 * and at most one retry. */
function spyOnConversationStatesWrites(db: any) {
  const calls: { op: "update" | "insert"; row: any }[] = [];
  const originalFrom = db.from.bind(db);
  const wrapped = {
    ...db,
    from: (table: string) => {
      const builder = originalFrom(table);
      if (table !== "conversation_states") return builder;
      const originalUpdate = builder.update.bind(builder);
      builder.update = (row: any) => {
        calls.push({ op: "update", row });
        return originalUpdate(row);
      };
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => {
        calls.push({ op: "insert", row });
        return originalInsert(row);
      };
      return builder;
    },
  };
  return { db: wrapped, calls };
}

test("1. existing row: UPDATE succeeds, no INSERT is ever attempted", async () => {
  const existing = { id: "row-1", org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", is_archived: false, is_starred: false, scheduling_offered_slots: null, scheduling_offered_at: null };
  const { db, calls } = spyOnConversationStatesWrites(makeDb([existing]));
  const result = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.op), ["update"], "exactly one UPDATE and zero INSERTs for an existing row");
});

test("2. absent row: UPDATE matches zero rows, then a real INSERT creates the row", async () => {
  const { db, calls } = spyOnConversationStatesWrites(makeDb([]));
  const result = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.op), ["update", "insert"], "UPDATE (matches nothing) then exactly one INSERT");

  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "found");
  assert.deepEqual(read.slots, [SLOT_A]);
});

test("3. concurrent-create race: UPDATE matches zero, INSERT returns a real 23505 unique violation, and the UPDATE is retried exactly once and succeeds", async () => {
  const inner = makeDb([]);
  let insertAttempts = 0;
  const db = {
    ...inner,
    from: (table: string) => {
      const builder = inner.from(table);
      if (table !== "conversation_states") return builder;
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          // Simulates a genuinely concurrent writer having already
          // inserted this exact row between our UPDATE and our INSERT —
          // the real partial unique index's own 23505, not a hypothetical.
          // The concurrent insert is actually materialized into the store
          // (awaited) before reporting the conflict, so the retried
          // UPDATE below has a real row to find.
          return (async () => {
            await originalInsert({ org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", scheduling_offered_slots: null, scheduling_offered_at: null });
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          })();
        }
        return originalInsert(row);
      };
      return builder;
    },
  };
  const { db: spiedDb, calls } = spyOnConversationStatesWrites(db);
  const result = await S.writeOfferedSlots({ supabase: spiedDb }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.op), ["update", "insert", "update"], "UPDATE, lost INSERT race, exactly one retried UPDATE — never a second INSERT attempt");

  const read = await S.readOfferedSlots({ supabase: spiedDb }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "found");
  assert.deepEqual(read.slots, [SLOT_A], "the retried UPDATE must have written OUR intended slots, not left the concurrently-inserted row's own (null) state");
});

test("4. a non-23505 INSERT error returns ok:false and never loops/retries", async () => {
  const inner = makeDb([]);
  let insertAttempts = 0;
  const db = {
    ...inner,
    from: (table: string) => {
      const builder = inner.from(table);
      if (table !== "conversation_states") return builder;
      builder.insert = (_row: any) => {
        insertAttempts += 1;
        return { then: (resolve: any) => resolve({ data: null, error: { code: "23502", message: "null value in column violates not-null constraint" } }) };
      };
      return builder;
    },
  };
  const result = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not-null constraint/);
  assert.equal(insertAttempts, 1, "a non-23505 INSERT error must never be retried");
});

test("5. an UPDATE failure returns ok:false immediately — no INSERT is ever attempted", async () => {
  const inner = makeDb([]);
  let insertAttempts = 0;
  const db = {
    ...inner,
    from: (table: string) => {
      const builder = inner.from(table);
      if (table !== "conversation_states") return builder;
      const failingChain: any = {
        eq: () => failingChain,
        select: () => failingChain,
        maybeSingle: async () => ({ data: null, error: { message: "simulated update failure" } }),
      };
      builder.update = (_row: any) => failingChain;
      const originalInsert = builder.insert.bind(builder);
      builder.insert = (row: any) => { insertAttempts += 1; return originalInsert(row); };
      return builder;
    },
  };
  const result = await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /simulated update failure/);
  assert.equal(insertAttempts, 0, "an UPDATE failure must never fall through to an INSERT attempt");
});

test("6. the exact slots and timestamp are stored correctly via the new write path (both the fresh-INSERT and the existing-UPDATE path)", async () => {
  const now = new Date("2027-03-16T12:00:00.000Z");

  const dbInsertPath = makeDb([]);
  await S.writeOfferedSlots({ supabase: dbInsertPath }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A, SLOT_B], now });
  const readInsertPath = await S.readOfferedSlots({ supabase: dbInsertPath }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(readInsertPath.status, "found");
  assert.deepEqual(readInsertPath.slots, [SLOT_A, SLOT_B]);
  assert.equal(readInsertPath.offeredAt, now.toISOString());

  const existing = { id: "row-1", org_id: ORG_A, contact_id: CONTACT_1, channel: "sms", scheduling_offered_slots: null, scheduling_offered_at: null };
  const dbUpdatePath = makeDb([existing]);
  const laterNow = new Date("2027-03-16T13:00:00.000Z");
  await S.writeOfferedSlots({ supabase: dbUpdatePath }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_B], now: laterNow });
  const readUpdatePath = await S.readOfferedSlots({ supabase: dbUpdatePath }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(readUpdatePath.status, "found");
  assert.deepEqual(readUpdatePath.slots, [SLOT_B]);
  assert.equal(readUpdatePath.offeredAt, laterNow.toISOString());
});

test("7. clearOfferedSlots() remains unchanged and idempotent — calling it twice (or on a row that was never written) is a harmless no-op", async () => {
  const db = makeDb([]);
  const first = await S.clearOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(first.ok, true);
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  const second = await S.clearOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  const third = await S.clearOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  const read = await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal(read.status, "none");
});

test("8. readOfferedSlots() still correctly reads back the row produced by the new write path, in every status case", async () => {
  const db = makeDb([]);
  assert.equal((await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" })).status, "none");
  await S.writeOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms", slots: [SLOT_A] });
  assert.equal((await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" })).status, "found");
  await S.clearOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" });
  assert.equal((await S.readOfferedSlots({ supabase: db }, { orgId: ORG_A, contactId: CONTACT_1, channel: "sms" })).status, "none");
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
