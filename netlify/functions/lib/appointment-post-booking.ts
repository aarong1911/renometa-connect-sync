// netlify/functions/lib/appointment-post-booking.ts
//
// AI-H1.1 platform correction — the ONE shared post-booking lifecycle for
// EVERY appointment creation source (Voice Agent, Calendar/manual, CRM
// entity panels via the browser, Workflows, and any future server writer).
// Previously this logic (confirmation email + owner/assignee notification)
// lived only inside netlify/functions/vapi-webhook.ts, which made it a
// Voice-Agent-only behavior — that was a product bug. This module is now
// the single place that logic lives; every creation path calls it instead
// of hand-rolling its own copy.
//
// Deliberately does NOT trust caller-supplied email/phone/name — it loads
// the appointment (and everything it needs) fresh from the DB by
// appointmentId + orgId, the same "authoritative, not caller-provided"
// contract netlify/lib/appointments.ts already uses for validation.
//
// Idempotency: appointments.metadata (no schema change) —
//   confirmation_email_sent_at (new, timestamp) — also recognizes the
//     legacy `confirmation_email_sent: true` boolean written by the first
//     AI-H1.1 pass (Voice-only) so an appointment booked before this
//     refactor never gets a duplicate confirmation email.
//   owner_notified / owner_notified_at, estimator_notified — unchanged
//     from the original Voice-only implementation.
//
// Does NOT handle the SMS reminder itself — that is evaluated continuously
// by the separate appointment-reminder-sms.ts scheduled worker based on
// org settings and appointment eligibility, not at booking time.

import type { SupabaseClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

export type PostBookingParams = {
  appointmentId: string;
  orgId: string;
};

function log(tag: string, msg: string, fields?: Record<string, unknown>) {
  console.log(`[appointment-post-booking][${tag}] ${msg}`, fields ? JSON.stringify(fields) : '');
}

function logError(tag: string, msg: string, fields?: Record<string, unknown>) {
  console.error(`[appointment-post-booking][${tag}] ${msg}`, fields ? JSON.stringify(fields) : '');
}

export async function runAppointmentPostBookingLifecycle(
  supabase: SupabaseClient,
  params: PostBookingParams,
): Promise<void> {
  const { appointmentId, orgId } = params;
  const startedAt = Date.now();
  log('start', 'lifecycle started', { appointmentId });

  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .select('id, org_id, service, address, scheduled_at, time_zone, contact_name, contact_email, assigned_to, metadata')
    .eq('id', appointmentId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (apptErr || !appt) {
    logError('load', 'could not load appointment', { appointmentId, orgId });
    return;
  }

  const metadata: Record<string, unknown> = { ...(appt.metadata as Record<string, unknown> | null ?? {}) };
  let metadataChanged = false;

  const alreadyEmailed = !!metadata.confirmation_email_sent_at || metadata.confirmation_email_sent === true;

  if (appt.contact_email && !alreadyEmailed) {
    try {
      const { data: org } = await supabase.from('organizations').select('name, timezone').eq('id', orgId).maybeSingle();
      const orgName = org?.name || 'RenoMeta';
      const timezone = appt.time_zone || org?.timezone || 'UTC';

      const scheduledDate = new Date(appt.scheduled_at as string);
      const dateLabel = scheduledDate.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone,
      });

      const emailStartedAt = Date.now();
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        // Bounded connection/greeting timeouts (nodemailer defaults are
        // otherwise effectively unbounded) so a slow/unreachable SMTP
        // server can never leave a socket open indefinitely — this
        // function already runs fire-and-forget from every caller, but a
        // hung socket is still worth capping defensively.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });

      await transporter.sendMail({
        from: `"${orgName}" <${process.env.SMTP_USER}>`,
        to: appt.contact_email as string,
        subject: `Appointment Confirmed — ${orgName}`,
        text: [
          `Hi ${appt.contact_name || 'there'},`,
          '',
          `Your ${appt.service || 'appointment'} with ${orgName} is confirmed for ${dateLabel}.`,
          appt.address ? `Location: ${appt.address}` : null,
          '',
          'We look forward to seeing you.',
          orgName,
        ].filter((l) => l !== null).join('\n'),
      });

      // Explicitly close the connection rather than leaving it to garbage
      // collection/idle-timeout — this is the operation most likely to
      // leave a lingering open socket behind.
      transporter.close();

      metadata.confirmation_email_sent_at = new Date().toISOString();
      metadataChanged = true;
      log('email', 'confirmation email sent', { appointmentId, durationMs: Date.now() - emailStartedAt });
    } catch (err) {
      logError('email', 'confirmation email failed', { appointmentId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!metadata.owner_notified) {
    try {
      const { data: ownerProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('organization_id', orgId)
        .maybeSingle();

      const assignedTo = appt.assigned_to as string | null;

      if (ownerProfile?.id) {
        await supabase.from('notifications').insert({
          profile_id: ownerProfile.id,
          org_id: orgId,
          type: 'appointment_booked',
          title: 'New appointment booked',
          message: assignedTo
            ? `${appt.service || 'Appointment'} scheduled — an estimator is assigned.`
            : `${appt.service || 'Appointment'} scheduled — no estimator assigned yet.`,
        });
        metadata.owner_notified = true;
        metadata.owner_notified_at = new Date().toISOString();
        metadataChanged = true;
      }

      // Real assignment only — never invent an assignee. Most creation
      // paths leave a new appointment unassigned; this only fires when one
      // is genuinely set (e.g. created directly from Calendar with an
      // assignee chosen).
      if (assignedTo) {
        await supabase.from('notifications').insert({
          profile_id: assignedTo,
          org_id: orgId,
          type: 'appointment_assigned',
          title: 'New appointment assigned to you',
          message: `${appt.service || 'Appointment'} scheduled.`,
        });
        metadata.estimator_notified = true;
        metadataChanged = true;
      }
    } catch (err) {
      logError('notify', 'notification create failed', { appointmentId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (metadataChanged) {
    const { error: metaErr } = await supabase.from('appointments').update({ metadata }).eq('id', appointmentId);
    if (metaErr) logError('persist', 'failed to persist metadata flags', { appointmentId });
  }

  log('done', 'lifecycle finished', { appointmentId, durationMs: Date.now() - startedAt });
}
