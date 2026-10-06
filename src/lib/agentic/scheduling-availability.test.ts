// src/lib/agentic/scheduling-availability.test.ts
//
// Run:  node --test src/lib/agentic/scheduling-availability.test.ts
//
// Scheduling foundation — Phase 1. No live Supabase, no network (this
// module makes none; nothing to stub). Covers the AVAILABILITY test
// matrix: free slot, overlap, adjacency, cancelled-never-blocks, invalid
// timezone, DB-failure-fails-closed, business-hours boundary, assignee
// conflict, org isolation.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "scheduling-availability-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "scheduling-availability.ts")],
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
const MEMBER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const MEMBER_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const TZ = "America/New_York";

// A Tuesday, chosen arbitrarily, far enough in the future that "in the
// past" never trips during a slow CI run.
const FUTURE_DATE = "2027-03-16";
// 14:00 local (America/New_York) on that day -> fixed, known UTC instant.
function localInstant(hour: number, minute = 0): string {
  // America/New_York is UTC-4 (EDT) in March. Date.UTC itself normalizes
  // an hour >= 24 by rolling into the next day, so this stays correct for
  // a late-local-hour input (e.g. 23 local + 4 = 27 -> 03:00 the next day).
  return new Date(Date.UTC(2027, 2, 16, hour + 4, minute, 0)).toISOString();
}

function makeDb(appointments: any[] = []) {
  return createFakeSupabaseClient({
    organizations: [
      { id: ORG_A, timezone: TZ },
      { id: ORG_B, timezone: TZ },
    ],
    appointments,
  }, {}, {});
}

/** A chainable stub that resolves to a Supabase-shaped error for ANY
 * select/eq/neq/gte/lt chain on the `appointments` table — used to prove
 * the FAIL CLOSED behavior without depending on the fake client's own
 * (non-error-injecting) query builder internals. */
function makeDbWithAppointmentsQueryFailure() {
  const inner = makeDb();
  const failingChain: any = {
    eq: () => failingChain,
    neq: () => failingChain,
    gte: () => failingChain,
    lt: () => failingChain,
    then: (resolve: any) => resolve({ data: null, error: { message: "simulated query failure" } }),
  };
  return {
    ...inner,
    from: (table: string) => {
      if (table !== "appointments") return inner.from(table);
      return { select: () => failingChain };
    },
  };
}

test("free slot: available when nothing overlaps", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "available");
});

test("overlapping appointment: conflicts", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10, 30), end: localInstant(11, 30), timeZone: TZ,
  });
  assert.equal(r.status, "conflict");
  assert.equal(r.conflictingAppointmentId, "appt-1");
});

test("adjacent appointment (back-to-back, no overlap) does not conflict", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(11), end: localInstant(12), timeZone: TZ,
  });
  assert.equal(r.status, "available", "existing.end === requested.start must never be treated as overlapping");
});

test("a cancelled appointment never blocks a slot", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "cancelled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "available");
});

test("invalid timezone fails closed (availability_check_failed), never 'available'", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: "Not/ARealZone",
  });
  assert.equal(r.status, "availability_check_failed");
});

test("a DB query failure fails CLOSED — never assumed available", async () => {
  const db = makeDbWithAppointmentsQueryFailure();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "availability_check_failed", "a query failure must NEVER produce 'available'");
});

test("business-hours boundary: a slot ending exactly at 19:00 local is in-bounds; one minute later is not", async () => {
  const db = makeDb();
  const inBounds = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(18), end: localInstant(19), timeZone: TZ,
  });
  assert.equal(inBounds.status, "available");

  const outOfBounds = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(18, 1), end: localInstant(19, 1), timeZone: TZ,
  });
  assert.equal(outOfBounds.status, "outside_business_hours");
});

test("business-hours boundary: a slot starting before 08:00 local is out of bounds", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(7, 30), end: localInstant(8, 30), timeZone: TZ,
  });
  assert.equal(r.status, "outside_business_hours");
});

test("business-hours boundary: a slot starting exactly at 08:00 local (the opening instant) is in-bounds", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(8), end: localInstant(9), timeZone: TZ,
  });
  assert.equal(r.status, "available", "08:00 is the opening instant itself and must be bookable, not rejected as 'before opening'");
});

test("business-hours boundary: a slot that ENDS after 19:00 local is out of bounds, even though it STARTS within business hours", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(18, 30), end: localInstant(19, 30), timeZone: TZ,
  });
  assert.equal(r.status, "outside_business_hours", "a start within [08:00,19:00) does not excuse an end past 19:00 — duration must be included in the boundary check, not just the start instant");
});

// ── assignee conflict — all 5 combinations, per the code-review-corrected
// findConflict() rule: two rows conflict UNLESS BOTH sides name a
// specific, DIFFERENT assignee. See scheduling-availability.ts's own
// doc comment on findConflict() for the full table and rationale; these
// tests are the direct verification of that exact table, replacing an
// earlier, incomplete 2-combination version that predated the fix.

test("assignee conflict 1/5 — assigned A vs requested A: CONFLICT (same specific person)", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: MEMBER_1, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ, assignedTo: MEMBER_1,
  });
  assert.equal(r.status, "conflict");
});

test("assignee conflict 2/5 — assigned A vs requested B: free (two different, specific people — provably different resources)", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: MEMBER_1, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ, assignedTo: MEMBER_2,
  });
  assert.equal(r.status, "available", "a different, specifically-named assignee's overlapping appointment must not block");
});

test("assignee conflict 3/5 — unassigned existing vs requested B: CONFLICT (the exact hole this code-review pass fixed)", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ, assignedTo: MEMBER_2,
  });
  assert.equal(r.status, "conflict", "an unassigned existing appointment is a generic org-wide commitment and must block a new named-assignee request — this was the real gap found in review");
});

test("assignee conflict 4/5 — assigned A existing vs unassigned requested: CONFLICT (unchanged — already correct before this pass)", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: MEMBER_1, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "conflict");
});

test("assignee conflict 5/5 — unassigned existing vs unassigned requested: CONFLICT (org-wide shared-resource model, unchanged)", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "conflict");
});

test("org isolation: an appointment in a DIFFERENT org never blocks this org's slot", async () => {
  const db = makeDb([{ id: "appt-other-org", org_id: ORG_B, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(10), end: localInstant(11), timeZone: TZ,
  });
  assert.equal(r.status, "available");
});

test("a slot entirely in the past is rejected", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: "2020-01-01T10:00:00.000Z", end: "2020-01-01T11:00:00.000Z", timeZone: TZ,
    now: new Date("2027-01-01T00:00:00.000Z"),
  });
  assert.equal(r.status, "in_past");
});

test("an inverted/invalid range (start >= end) is rejected", async () => {
  const db = makeDb();
  const r = await S.validateSlotAvailability({ supabase: db }, {
    orgId: ORG_A, start: localInstant(11), end: localInstant(10), timeZone: TZ,
  });
  assert.equal(r.status, "invalid_range");
});

// ── resolveOrgTimezone — fail closed, never UTC fallback ────────────────

test("resolveOrgTimezone resolves a real, valid IANA timezone", async () => {
  const db = makeDb();
  const r = await S.resolveOrgTimezone({ supabase: db }, ORG_A);
  assert.deepEqual(r, { status: "resolved", timeZone: TZ });
});

test("resolveOrgTimezone fails closed for a missing org, null timezone, and an invalid timezone string — never UTC", async () => {
  const dbMissing = makeDb();
  assert.equal((await S.resolveOrgTimezone({ supabase: dbMissing }, "99999999-9999-4999-8999-999999999999")).status, "org_not_found");

  const dbNull = createFakeSupabaseClient({ organizations: [{ id: ORG_A, timezone: null }] }, {}, {});
  assert.equal((await S.resolveOrgTimezone({ supabase: dbNull }, ORG_A)).status, "invalid_timezone");

  const dbBad = createFakeSupabaseClient({ organizations: [{ id: ORG_A, timezone: "Not/ARealZone" }] }, {}, {});
  assert.equal((await S.resolveOrgTimezone({ supabase: dbBad }, ORG_A)).status, "invalid_timezone");
});

// ── getAvailableSlots ─────────────────────────────────────────────────────

test("getAvailableSlots returns candidate slots excluding an existing conflict, and never includes a slot outside business hours", async () => {
  const db = makeDb([{ id: "appt-1", org_id: ORG_A, scheduled_at: localInstant(10), ends_at: localInstant(11), duration_min: 60, assigned_to: null, status: "scheduled" }]);
  const r = await S.getAvailableSlots({ supabase: db }, {
    orgId: ORG_A, date: FUTURE_DATE, durationMinutes: 60, timeZone: TZ, slotIntervalMinutes: 60,
  });
  assert.equal(r.status, "ok");
  const starts = r.slots.map((s: any) => s.start);
  assert.ok(!starts.includes(localInstant(10)), "the conflicting 10:00 slot must be excluded");
  assert.ok(starts.includes(localInstant(9)), "9:00 must still be offered");
  assert.ok(starts.includes(localInstant(18)), "the last bookable hour (18:00-19:00) must still be offered");
  assert.ok(!starts.some((s: string) => s === localInstant(19)), "19:00 would end at 20:00 — outside business hours — must never be offered");
});

test("getAvailableSlots fails closed on a DB error — status is availability_check_failed, not an empty success", async () => {
  const db = makeDbWithAppointmentsQueryFailure();
  const r = await S.getAvailableSlots({ supabase: db }, { orgId: ORG_A, date: FUTURE_DATE, durationMinutes: 60, timeZone: TZ });
  assert.equal(r.status, "availability_check_failed");
});

test("getAvailableSlots rejects a malformed date or invalid timezone before ever querying", async () => {
  const db = makeDb();
  assert.equal((await S.getAvailableSlots({ supabase: db }, { orgId: ORG_A, date: "not-a-date", durationMinutes: 60, timeZone: TZ })).status, "availability_check_failed");
  assert.equal((await S.getAvailableSlots({ supabase: db }, { orgId: ORG_A, date: FUTURE_DATE, durationMinutes: 60, timeZone: "Nope/Nope" })).status, "availability_check_failed");
});

// ── isValidTimeZone / isWithinBusinessHours — pure helpers ──────────────

test("isValidTimeZone accepts real IANA zones, rejects garbage/empty/null", () => {
  assert.equal(S.isValidTimeZone("America/New_York"), true);
  assert.equal(S.isValidTimeZone("UTC"), true);
  assert.equal(S.isValidTimeZone("Not/ARealZone"), false);
  assert.equal(S.isValidTimeZone(""), false);
  assert.equal(S.isValidTimeZone(null), false);
  assert.equal(S.isValidTimeZone(undefined), false);
});

test("isWithinBusinessHours rejects a slot that crosses midnight even if both endpoints are individually in-range", () => {
  const start = new Date(localInstant(23));
  const end = new Date(new Date(localInstant(23)).getTime() + 2 * 3600_000); // 1am next day local
  assert.equal(S.isWithinBusinessHours(start, end, TZ), false);
});
