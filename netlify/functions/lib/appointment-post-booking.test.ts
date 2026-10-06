// netlify/functions/lib/appointment-post-booking.test.ts
//
// Run:  node --test netlify/functions/lib/appointment-post-booking.test.ts
//
// Scheduling foundation — code-review pass, Section 12. This module
// (runAppointmentPostBookingLifecycle) previously had no test coverage of
// its own idempotency claims — those claims (confirmation_email_sent_at /
// owner_notified guards) were confirmed correct only by reading the code,
// not by a test proving a RETRY cannot duplicate the email/notifications.
// Added here specifically to close that gap.
//
// No real network: nodemailer is swapped for an in-memory fake via a
// process-wide module resolution hook (module.register(), see
// fake-nodemailer-loader.mjs) rather than esbuild's own `alias` option —
// `alias` INLINES the aliased file into the bundle, which would give the
// bundled subject-under-test its own private copy of fake-nodemailer.mjs's
// module state, disconnected from the copy this file imports directly to
// make assertions on. The loader hook keeps both resolving to the exact
// same module instance. nodemailer itself is marked `external` so the
// bundle keeps a plain `import nodemailer from "nodemailer"` specifier for
// the hook to intercept, instead of also inlining the REAL package.

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createRequire, register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const outDir = mkdtempSync(path.join(tmpdir(), "appointment-post-booking-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const fakeNodemailerPath = path.join(here, "test-support", "fake-nodemailer.mjs");
register(pathToFileURL(path.join(here, "test-support", "fake-nodemailer-loader.mjs")));

const esbuild = createRequire(createRequire(import.meta.url).resolve("vite/package.json"))("esbuild");
await esbuild.build({
  entryPoints: [path.join(here, "appointment-post-booking.ts")],
  outfile: path.join(outDir, "subject.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  external: ["@supabase/supabase-js", "nodemailer"],
});
const S: any = await import(pathToFileURL(path.join(outDir, "subject.mjs")).href);
const fakeMailer: any = await import(pathToFileURL(fakeNodemailerPath).href);

const { createFakeSupabaseClient }: any = await import(
  pathToFileURL(path.join(repoRoot, "netlify/functions/lib/test-support/fake-supabase-client.mjs")).href
);

const noisy = ["log", "warn", "error"] as const;
const saved = noisy.map((k) => (console as any)[k]);
noisy.forEach((k) => ((console as any)[k] = () => {}));
after(() => noisy.forEach((k, i) => ((console as any)[k] = saved[i])));

beforeEach(() => fakeMailer.__reset());

const ORG_A = "11111111-1111-4111-8111-111111111111";
const APPT_1 = "33333333-3333-4333-8333-333333333331";
const OWNER_PROFILE = "44444444-4444-4444-8444-444444444441";
const ASSIGNEE_PROFILE = "55555555-5555-4555-8555-555555555551";

function makeDb(appointment: Record<string, unknown>) {
  return createFakeSupabaseClient({
    organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: "America/New_York" }],
    appointments: [appointment],
    profiles: [{ id: OWNER_PROFILE, organization_id: ORG_A }],
    notifications: [],
  }, {}, {});
}

test("first run: sends exactly one confirmation email, creates owner notification, and persists both idempotency flags", async () => {
  const db = makeDb({
    id: APPT_1, org_id: ORG_A, service: "Kitchen remodel consultation", address: "123 Main St",
    scheduled_at: "2027-03-16T14:00:00.000Z", time_zone: "America/New_York",
    contact_name: "Jane Homeowner", contact_email: "jane@example.com", assigned_to: null, metadata: {},
  });

  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });

  assert.equal(fakeMailer.sentMessages.length, 1, "exactly one confirmation email must be sent");
  assert.equal(fakeMailer.sentMessages[0].to, "jane@example.com");

  const { data: notifications } = await db.from("notifications").select("*");
  assert.equal(notifications.length, 1, "exactly one owner notification created (no assignee was set)");
  assert.equal(notifications[0].profile_id, OWNER_PROFILE);

  const { data: row } = await db.from("appointments").select("*").eq("id", APPT_1).maybeSingle();
  assert.ok(row.metadata.confirmation_email_sent_at, "confirmation_email_sent_at must be persisted");
  assert.equal(row.metadata.owner_notified, true);
});

test("retry (lifecycle invoked a second time for the SAME appointment) sends NO second email and creates NO second owner notification", async () => {
  const db = makeDb({
    id: APPT_1, org_id: ORG_A, service: "Kitchen remodel consultation", address: "123 Main St",
    scheduled_at: "2027-03-16T14:00:00.000Z", time_zone: "America/New_York",
    contact_name: "Jane Homeowner", contact_email: "jane@example.com", assigned_to: null, metadata: {},
  });

  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });
  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });

  assert.equal(fakeMailer.sentMessages.length, 1, "a retry must never send a second confirmation email — this is the exact scenario a duplicate agent-approve-action.ts replay would trigger");
  const { data: notifications } = await db.from("notifications").select("*");
  assert.equal(notifications.length, 1, "a retry must never create a second owner notification");
});

test("a legacy row with the OLD boolean flag (confirmation_email_sent: true, pre-dating this refactor) is also treated as already-emailed — never a duplicate send", async () => {
  const db = makeDb({
    id: APPT_1, org_id: ORG_A, service: "Kitchen remodel consultation", address: "123 Main St",
    scheduled_at: "2027-03-16T14:00:00.000Z", time_zone: "America/New_York",
    contact_name: "Jane Homeowner", contact_email: "jane@example.com", assigned_to: null,
    metadata: { confirmation_email_sent: true },
  });

  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });

  assert.equal(fakeMailer.sentMessages.length, 0, "the legacy boolean flag must be honored exactly like the new timestamp flag");
});

test("no contact_email on the appointment: no email attempted, but the owner notification still fires", async () => {
  const db = makeDb({
    id: APPT_1, org_id: ORG_A, service: "Kitchen remodel consultation", address: null,
    scheduled_at: "2027-03-16T14:00:00.000Z", time_zone: "America/New_York",
    contact_name: "Jane Homeowner", contact_email: null, assigned_to: null, metadata: {},
  });

  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });

  assert.equal(fakeMailer.sentMessages.length, 0);
  const { data: notifications } = await db.from("notifications").select("*");
  assert.equal(notifications.length, 1);
});

test("a real assignee gets its own notification in addition to the owner's, and a retry does not duplicate either", async () => {
  const db = createFakeSupabaseClient({
    organizations: [{ id: ORG_A, name: "Acme Remodeling", timezone: "America/New_York" }],
    appointments: [{
      id: APPT_1, org_id: ORG_A, service: "Site visit", address: null,
      scheduled_at: "2027-03-16T14:00:00.000Z", time_zone: "America/New_York",
      contact_name: "Jane Homeowner", contact_email: null, assigned_to: ASSIGNEE_PROFILE, metadata: {},
    }],
    profiles: [{ id: OWNER_PROFILE, organization_id: ORG_A }],
    notifications: [],
  }, {}, {});

  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });
  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: APPT_1, orgId: ORG_A });

  const { data: notifications } = await db.from("notifications").select("*");
  assert.equal(notifications.length, 2, "exactly one owner + one assignee notification, even after a retry");
  assert.ok(notifications.some((n: any) => n.profile_id === OWNER_PROFILE && n.type === "appointment_booked"));
  assert.ok(notifications.some((n: any) => n.profile_id === ASSIGNEE_PROFILE && n.type === "appointment_assigned"));
});

test("an unknown/missing appointment id: the lifecycle returns cleanly, sends no email, with no exception thrown", async () => {
  const db = makeDb({
    id: APPT_1, org_id: ORG_A, service: "x", scheduled_at: "2027-03-16T14:00:00.000Z",
    time_zone: "America/New_York", contact_name: "Jane", contact_email: "jane@example.com", assigned_to: null, metadata: {},
  });
  await S.runAppointmentPostBookingLifecycle(db, { appointmentId: "99999999-9999-4999-8999-999999999999", orgId: ORG_A });
  assert.equal(fakeMailer.sentMessages.length, 0);
});
