/**
 * appointment-reminder-sms.ts
 * Netlify Scheduled Function — sends exactly one SMS reminder before a
 * scheduled/confirmed appointment (AI-H1.1 platform correction).
 *
 * Source-agnostic: scans ALL organizations with SMS reminders enabled and
 * ALL their eligible appointments regardless of how the appointment was
 * created (Voice Agent, Calendar, workflow, etc.) — there is no
 * `source = 'Voice AI'` filter anywhere in this file.
 *
 * Timing is per-organization and dynamic, not a fixed "1 hour":
 *   reminder_at = appointments.scheduled_at - organizations.appointment_sms_reminder_minutes_before
 * Runs every 5 minutes (see netlify.toml) and, for each org, selects
 * appointments whose reminder_at falls within a window centered on "now"
 * and sized to the 5-minute cadence (+/- 2.5 minutes) — wide enough that no
 * appointment is skipped between two runs, narrow enough that nothing
 * sends more than ~2.5 minutes off the configured offset. If an org
 * changes its setting before an appointment's reminder has been sent, the
 * NEW setting is what gets used — the offset is never baked into the
 * appointment at creation time, it's recomputed from current settings on
 * every scan.
 *
 * Idempotency (no schema change — reuses the existing appointments.metadata
 * jsonb column):
 *   - "claim" step: UPDATE ... SET metadata.sms_reminder_claimed_at = now()
 *     WHERE metadata->>sms_reminder_claimed_at IS NULL
 *       AND metadata->>sms_reminder_sent_at IS NULL
 *     A single atomic UPDATE evaluated against the row's current state at
 *     execution time — if two runs (or a Netlify retry) race on the same
 *     appointment, only one UPDATE's WHERE clause matches, so only one can
 *     ever win the claim. Mirrors the claim-before-send pattern in
 *     marketing-campaign-process-queue.ts, adapted to a jsonb column
 *     instead of a dedicated status column since appointments has no
 *     queue table.
 *   - On successful send: metadata.sms_reminder_sent_at is set — no future
 *     run will ever re-select this appointment.
 *   - On failed send: the claim is released so the next run retries.
 *   - A claim older than 10 minutes with no sent_at is treated as an
 *     abandoned attempt and is eligible to be reclaimed.
 *
 * Org settings (organizations.appointment_sms_reminder_enabled /
 * appointment_sms_reminder_minutes_before) are proposed in
 * supabase/migrations/20260908_appointment_sms_reminder_settings.sql, NOT
 * yet applied. If those columns don't exist yet, the org-settings query
 * below fails with Postgres 42703 and this worker safely does nothing
 * (equivalent to every org having reminders disabled) rather than erroring
 * — consistent with "reminders default OFF" being the safe behavior before
 * the migration lands.
 *
 * Message provider: reuses the existing plain Twilio REST send pattern
 * already used for transactional SMS elsewhere (run-agent.ts,
 * portal-action.ts) — not the marketing-campaign queue's sender, which
 * requires campaign/consent bookkeeping that doesn't apply to a
 * transactional appointment reminder.
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER
 */

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CLAIM_STALE_MS = 10 * 60 * 1000; // 10 minutes — an abandoned claim is reclaimable
const DUE_WINDOW_MS = 2.5 * 60 * 1000; // half the 5-minute cron cadence, centered on the exact due instant

function log(msg: string, fields?: Record<string, unknown>) {
  console.log(`[appointment-reminder-sms] ${msg}`, fields ? JSON.stringify(fields) : '');
}

function logError(msg: string, fields?: Record<string, unknown>) {
  console.error(`[appointment-reminder-sms] ${msg}`, fields ? JSON.stringify(fields) : '');
}

async function sendSms(to: string, body: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !auth || !from) {
    logError('Twilio not configured');
    return false;
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 160) }).toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      let providerCode: unknown;
      try { providerCode = JSON.parse(text)?.code; } catch { /* non-JSON error body */ }
      logError('Twilio send failed', { status: res.status, providerCode });
      return false;
    }
    return true;
  } catch (err) {
    logError('Twilio send threw', { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

type OrgReminderSettings = {
  id: string;
  name: string | null;
  timezone: string | null;
  appointment_sms_reminder_minutes_before: number;
};

type AppointmentRow = {
  id: string;
  org_id: string;
  service: string | null;
  scheduled_at: string;
  time_zone: string | null;
  contact_phone: string | null;
  metadata: Record<string, unknown> | null;
};

async function processAppointment(appt: AppointmentRow, org: OrgReminderSettings, counts: { sent: number; skippedClaimed: number; failed: number }) {
  const phone = appt.contact_phone?.trim();
  if (!phone) return;

  const metadata = { ...(appt.metadata ?? {}) };
  const claimedAt = metadata.sms_reminder_claimed_at as string | undefined;

  if (claimedAt) {
    const isStale = Date.now() - new Date(claimedAt).getTime() >= CLAIM_STALE_MS;
    if (!isStale) {
      counts.skippedClaimed++;
      return;
    }
    // Abandoned claim (e.g. a prior invocation crashed mid-send) — release
    // it first, but only if it still matches exactly what we just read
    // (optimistic check), so we never clobber a fresh claim made by
    // another run in the meantime.
    const { data: released } = await supabase
      .from('appointments')
      .update({ metadata: { ...metadata, sms_reminder_claimed_at: null } })
      .eq('id', appt.id)
      .filter('metadata->>sms_reminder_claimed_at', 'eq', claimedAt)
      .filter('metadata->>sms_reminder_sent_at', 'is', null)
      .select('id');
    if (!released || released.length === 0) {
      counts.skippedClaimed++;
      return;
    }
  }

  // Atomic claim — only succeeds if no other run has claimed or sent this
  // reminder since the (possible) release above.
  const { data: claimedRows, error: claimErr } = await supabase
    .from('appointments')
    .update({ metadata: { ...metadata, sms_reminder_claimed_at: new Date().toISOString() } })
    .eq('id', appt.id)
    .filter('metadata->>sms_reminder_claimed_at', 'is', null)
    .filter('metadata->>sms_reminder_sent_at', 'is', null)
    .select('id');

  if (claimErr) {
    logError('claim update failed', { appointmentId: appt.id, code: claimErr.code });
    return;
  }
  if (!claimedRows || claimedRows.length === 0) {
    counts.skippedClaimed++;
    return;
  }

  const timezone = appt.time_zone || org.timezone || 'UTC';
  const orgName = org.name || 'RenoMeta';

  const timeLabel = new Date(appt.scheduled_at).toLocaleString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone,
  });
  const minutesBefore = org.appointment_sms_reminder_minutes_before;
  const leadTimeLabel = minutesBefore >= 60 && minutesBefore % 60 === 0
    ? `${minutesBefore / 60} hour${minutesBefore === 60 ? '' : 's'}`
    : `${minutesBefore} minutes`;

  const body = `Reminder: your ${appt.service || 'appointment'} with ${orgName} is in about ${leadTimeLabel}, at ${timeLabel}. See you soon!`;

  const ok = await sendSms(phone, body);

  if (ok) {
    await supabase
      .from('appointments')
      .update({
        metadata: {
          ...metadata,
          sms_reminder_claimed_at: new Date().toISOString(),
          sms_reminder_sent_at: new Date().toISOString(),
          sms_reminder_minutes_before_used: minutesBefore,
        },
      })
      .eq('id', appt.id);
    counts.sent++;
    log('reminder sent', { appointmentId: appt.id, orgId: appt.org_id, minutesBefore });
  } else {
    // Release the claim so a later run retries — never leave a failed send
    // permanently marked as claimed with no sent_at.
    await supabase
      .from('appointments')
      .update({ metadata: { ...metadata, sms_reminder_claimed_at: null } })
      .eq('id', appt.id);
    counts.failed++;
    logError('reminder send failed, claim released for retry', { appointmentId: appt.id, orgId: appt.org_id });
  }
}

export const handler: Handler = async () => {
  // Org settings drive eligibility and timing — not a filter on how the
  // appointment was created. If the settings columns don't exist yet
  // (migration not applied), this fails with 42703 and the worker safely
  // does nothing, equivalent to every org having reminders disabled.
  const { data: orgs, error: orgsErr } = await supabase
    .from('organizations')
    .select('id, name, timezone, appointment_sms_reminder_minutes_before')
    .eq('appointment_sms_reminder_enabled', true);

  if (orgsErr) {
    if (orgsErr.code === '42703') {
      log('reminder settings columns not present yet — no-op until migration is applied');
      return { statusCode: 200, body: 'ok' };
    }
    logError('failed to load organizations', { code: orgsErr.code });
    return { statusCode: 500, body: 'error' };
  }

  if (!orgs || orgs.length === 0) {
    return { statusCode: 200, body: 'ok' };
  }

  const counts = { sent: 0, skippedClaimed: 0, failed: 0 };
  const now = Date.now();

  for (const org of orgs as OrgReminderSettings[]) {
    const minutesBefore = org.appointment_sms_reminder_minutes_before ?? 60;
    const reminderInstant = now + minutesBefore * 60 * 1000;
    const windowStart = new Date(reminderInstant - DUE_WINDOW_MS).toISOString();
    const windowEnd = new Date(reminderInstant + DUE_WINDOW_MS).toISOString();

    const { data: candidates, error } = await supabase
      .from('appointments')
      .select('id, org_id, service, scheduled_at, time_zone, contact_phone, metadata')
      .eq('org_id', org.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', windowStart)
      .lte('scheduled_at', windowEnd)
      .not('contact_phone', 'is', null)
      .filter('metadata->>sms_reminder_sent_at', 'is', null);

    if (error) {
      logError('failed to load candidate appointments', { orgId: org.id, code: error.code });
      continue;
    }

    for (const appt of (candidates ?? []) as AppointmentRow[]) {
      await processAppointment(appt, org, counts);
    }
  }

  log('run complete', { orgsScanned: orgs.length, ...counts });
  return { statusCode: 200, body: 'ok' };
};
