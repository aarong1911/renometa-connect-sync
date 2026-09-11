-- AI-H1.1 — organization-level appointment SMS reminder settings
--
-- NOT YET APPLIED. Proposed migration only — review before running.
--
-- Product requirement: appointment confirmation/reminder behavior is a
-- platform-wide appointment feature, not a Voice Agent feature, and SMS
-- reminder timing must be configurable per organization rather than a
-- hardcoded universal "1 hour before".
--
-- Storage: `organizations` already uses flat typed columns for every other
-- org-level operational setting (timezone, crm_goals, service_areas,
-- primary_color, etc.) — no existing JSON settings-blob convention fits an
-- appointment-reminder toggle + numeric offset, so this follows that same
-- flat-column convention rather than inventing a new settings shape.
--
-- Default for EXISTING organizations is OFF (appointment_sms_reminder_enabled
-- = false) so no organization is surprised by new outbound SMS the first
-- time this ships. appointment_sms_reminder_minutes_before defaults to 60
-- (1 hour before) so that once an organization opts in, the value already
-- matches product's stated default without an extra step.
--
-- Code in netlify/functions/appointment-reminder-sms.ts, netlify/functions/
-- lib/appointment-post-booking.ts, src/routes/settings.appointments.tsx, and
-- src/routes/automation.call-logs.tsx all read these columns with a runtime
-- fallback (Postgres error code 42703, "column does not exist") that treats
-- reminders as disabled when the columns are absent, so nothing breaks
-- before this migration is applied — but no organization can actually turn
-- reminders on until it is.

alter table public.organizations
  add column if not exists appointment_sms_reminder_enabled boolean not null default false,
  add column if not exists appointment_sms_reminder_minutes_before integer not null default 60;

comment on column public.organizations.appointment_sms_reminder_enabled is
  'Org-level toggle: whether RenoMeta sends an automated SMS reminder before scheduled appointments, regardless of how the appointment was created (Voice Agent, Calendar, workflow, etc). Defaults to false for existing orgs.';

comment on column public.organizations.appointment_sms_reminder_minutes_before is
  'Minutes before appointments.scheduled_at to send the SMS reminder (e.g. 60 = 1 hour before, 1440 = 24 hours before). Only used when appointment_sms_reminder_enabled is true. Applies to all future unsent reminders immediately when changed — not baked into individual appointments at creation time.';
