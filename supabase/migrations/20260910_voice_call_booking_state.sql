-- AI-H1.3 — Voice booking deterministic fallback state
--
-- NOT YET APPLIED. Proposed migration only — review before running.
--
-- Vapi's assistant model has been observed calling book_appointment with
-- args = {} even after the caller explicitly confirms a specific date/time
-- that check_availability already validated as free — this happens despite
-- the deployed tool schema requiring date+time and the deployed system
-- prompt explicitly instructing the model never to omit them. This table
-- is a server-side, defense-in-depth fallback: the one exact slot a live
-- call's check_availability most recently confirmed as bookable, so
-- book_appointment can safely complete the booking even when the model's
-- arguments are missing — WITHOUT ever guessing from transcript text.
--
-- Keyed by Vapi's own call id (not the internal voice_calls.id) because
-- that id is available synchronously in every tool-call webhook payload
-- from the first event onward, whereas the voice_calls row is written by
-- a separate call-started handler whose completion relative to the first
-- tool call is not guaranteed (see the existing "skipping voice_call_tools
-- — call row not found yet" race already logged elsewhere in
-- vapi-webhook.ts). This table is intentionally NOT voice_call_tools:
-- voice_call_tools is a fire-and-forget audit trail of tool invocations,
-- not a synchronously-written source of truth, so it cannot be used as
-- live state for a booking decision.
--
-- One row per live call: a later successful check_availability for the
-- same vapi_call_id overwrites the previous row (upsert on the primary
-- key), so a caller correction ("actually, today at 3pm instead") always
-- makes the newest confirmed slot the only one on record.
--
-- No customer PII is stored here — only the org, the call id (an opaque
-- Vapi identifier, not a phone number), and the confirmed date/time/tz.

create table if not exists public.voice_call_booking_state (
  vapi_call_id text primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,

  -- Raw natural-language date/time exactly as check_availability received
  -- them (e.g. "today", "2pm") — deliberately NOT re-parsed/normalized here.
  -- book_appointment's fallback path feeds these same raw strings through
  -- the identical buildScheduledAt()/getOrgTimezone() pipeline a normal
  -- tool call would use, so a fallback booking resolves to the exact same
  -- scheduled_at a correctly-argued tool call would have produced.
  checked_date text not null,
  checked_time text not null,
  checked_timezone text not null,

  -- Always 'available' today — the column exists (rather than a boolean)
  -- so a future check_availability failure/decline path could overwrite
  -- this row with a non-available status if that's ever useful, without
  -- another migration.
  availability_status text not null default 'available',
  checked_at timestamptz not null default now(),

  -- Idempotency: once a book_appointment call (direct args or fallback)
  -- successfully creates an appointment for this call, this is set
  -- synchronously in the same request so a second book_appointment
  -- invocation for the same live call (a model retry) never creates a
  -- second appointment.
  appointment_id uuid references public.appointments(id) on delete set null,
  consumed_at timestamptz,

  updated_at timestamptz not null default now()
);

comment on table public.voice_call_booking_state is
  'Live, per-call server-side fallback state for Voice Agent bookings. One row per in-progress Vapi call, keyed by Vapi''s own call id. Written synchronously only when check_availability confirms a bookable slot; consumed (see consumed_at/appointment_id) once book_appointment successfully books it. Rows are deleted at end-of-call (see handleEndOfCallReport in vapi-webhook.ts) — this is short-lived live-call state, not a historical record. voice_call_tools remains the audit trail; this table is never read for reporting.';

create index if not exists idx_voice_call_booking_state_org_id
  on public.voice_call_booking_state (org_id);

-- Service-role only: every read/write comes from vapi-webhook.ts using the
-- Supabase service-role key. No client (browser or portal) ever needs to
-- see this table, so RLS is enabled with no policies — the service role
-- bypasses RLS as usual, and every other caller is denied by default.
alter table public.voice_call_booking_state enable row level security;
