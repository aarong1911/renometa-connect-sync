-- 20260911_voice_call_scheduling_state.sql
--
-- Voice scheduling subsystem — authoritative per-call scheduling state.
--
-- Apply manually in the Supabase SQL Editor.
--
-- This migration supersedes the earlier narrow voice_call_booking_state
-- implementation used during Voice booking debugging.
--
-- It is safe whether public.voice_call_booking_state currently exists or not:
--   * if it exists     -> DROP TABLE IF EXISTS removes it
--   * if it does not   -> the DROP is a no-op
--
-- The rebuilt Voice scheduling subsystem uses one server-owned state row
-- per Vapi call. The LLM handles conversation only; the server owns:
--
--   * CRM linkage
--   * selected appointment slot
--   * availability state
--   * booking vs reschedule mode
--   * idempotency
--   * resulting appointment linkage
--
-- Transcript text is never used as transactional scheduling state.
--
-- This migration does NOT modify:
--
--   public.appointments
--   public.contacts
--   public.leads
--   public.organizations
--   public.voice_calls
--
-- It only removes the old temporary scheduling-state table and creates the
-- rebuilt authoritative scheduling-state table.

begin;

-- ============================================================================
-- REMOVE OLD TEMPORARY BOOKING STATE
-- ============================================================================

drop table if exists public.voice_call_booking_state;

-- ============================================================================
-- AUTHORITATIVE VOICE CALL SCHEDULING STATE
-- ============================================================================

create table public.voice_call_scheduling_state (
  -- Vapi call identifier. Available on every tool-call webhook for the call.
  vapi_call_id text not null,

  -- Tenant boundary.
  org_id uuid not null
    references public.organizations(id)
    on delete cascade,

  -- --------------------------------------------------------------------------
  -- CRM LINKAGE
  -- --------------------------------------------------------------------------
  --
  -- Prefer stable database IDs over duplicating customer PII in this
  -- short-lived table.
  --
  -- save_lead should populate these when available.
  -- book/reschedule may resolve them as a fallback if necessary.

  contact_id uuid
    references public.contacts(id)
    on delete set null,

  lead_id uuid
    references public.leads(id)
    on delete set null,

  -- --------------------------------------------------------------------------
  -- SCHEDULING ACTION
  -- --------------------------------------------------------------------------

  action_type text not null default 'book'
    check (
      action_type in (
        'book',
        'reschedule'
      )
    ),

  -- --------------------------------------------------------------------------
  -- LATEST REQUESTED / CONFIRMED SLOT
  -- --------------------------------------------------------------------------
  --
  -- These represent the newest slot processed by check_availability.
  --
  -- Each newer successful check replaces the older slot for the same call.

  selected_date text,
  selected_time text,
  selected_timezone text,

  -- Absolute resolved instant calculated during check_availability.
  --
  -- book_appointment / reschedule_appointment should reuse this value rather
  -- than reparsing the caller's date/time again.
  selected_slot_at timestamptz,

  -- Most recent availability result for this call.
  --
  -- available:
  --   selected_slot_at may be used for booking/rescheduling.
  --
  -- unavailable:
  --   selected_slot_at should be null and the caller must select another slot.
  --
  -- null:
  --   no specific usable slot has been checked yet.
  availability_status text
    check (
      availability_status in (
        'available',
        'unavailable'
      )
    ),

  slot_checked_at timestamptz,

  -- --------------------------------------------------------------------------
  -- RESCHEDULE LINKAGE
  -- --------------------------------------------------------------------------
  --
  -- Existing appointment being moved.
  --
  -- Must be resolved from real CRM/customer appointment data.
  -- Never fabricate an appointment ID from conversational text.

  existing_appointment_id uuid
    references public.appointments(id)
    on delete set null,

  -- --------------------------------------------------------------------------
  -- IDEMPOTENCY / TRANSACTION STATE
  -- --------------------------------------------------------------------------
  --
  -- consumed_at is claimed atomically by book_appointment using a conditional
  -- update:
  --
  --   ... WHERE consumed_at IS NULL
  --
  -- This ensures only one concurrent invocation proceeds to the appointment
  -- INSERT.
  --
  -- A failed INSERT should release the claim by setting consumed_at back to
  -- null.
  --
  -- resulting_appointment_id is written only after the appointment write
  -- succeeds.

  consumed_at timestamptz,

  resulting_appointment_id uuid
    references public.appointments(id)
    on delete set null,

  -- --------------------------------------------------------------------------
  -- TIMESTAMPS
  -- --------------------------------------------------------------------------

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One authoritative scheduling-state row per Vapi call per organization.
  primary key (
    vapi_call_id,
    org_id
  )
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

comment on table public.voice_call_scheduling_state is
  'Authoritative short-lived scheduling state for RenoMeta Voice calls. '
  'One row per Vapi call and organization. Written synchronously by Voice '
  'scheduling tools and deleted after end-of-call processing. The server, '
  'not the LLM transcript, owns booking and reschedule transaction state.';

comment on column public.voice_call_scheduling_state.vapi_call_id is
  'Vapi call ID used to correlate save_lead, check_availability, book_appointment, and reschedule_appointment during the same call.';

comment on column public.voice_call_scheduling_state.action_type is
  'Current scheduling transaction type: book or reschedule.';

comment on column public.voice_call_scheduling_state.selected_date is
  'Latest caller-requested date received by check_availability.';

comment on column public.voice_call_scheduling_state.selected_time is
  'Latest caller-requested time received by check_availability.';

comment on column public.voice_call_scheduling_state.selected_timezone is
  'Organization timezone used when resolving the requested slot.';

comment on column public.voice_call_scheduling_state.selected_slot_at is
  'Absolute timestamp resolved during check_availability and reused by booking/reschedule so parsing cannot drift between tool calls.';

comment on column public.voice_call_scheduling_state.availability_status is
  'Result of the latest specific availability check: available or unavailable.';

comment on column public.voice_call_scheduling_state.slot_checked_at is
  'Timestamp of the availability check used to enforce freshness/TTL before committing a booking or reschedule.';

comment on column public.voice_call_scheduling_state.existing_appointment_id is
  'Existing appointment being moved during a reschedule transaction.';

comment on column public.voice_call_scheduling_state.consumed_at is
  'Atomic transaction claim used to prevent duplicate appointment creation when book_appointment is invoked repeatedly or concurrently.';

comment on column public.voice_call_scheduling_state.resulting_appointment_id is
  'Appointment produced or successfully resolved by the scheduling transaction. Written only after the database operation succeeds.';

-- ============================================================================
-- INDEXES
-- ============================================================================

create index idx_voice_call_scheduling_state_org
  on public.voice_call_scheduling_state (org_id);

create index idx_voice_call_scheduling_state_contact
  on public.voice_call_scheduling_state (contact_id)
  where contact_id is not null;

create index idx_voice_call_scheduling_state_lead
  on public.voice_call_scheduling_state (lead_id)
  where lead_id is not null;

create index idx_voice_call_scheduling_state_existing_appointment
  on public.voice_call_scheduling_state (existing_appointment_id)
  where existing_appointment_id is not null;

-- ============================================================================
-- SECURITY
-- ============================================================================
--
-- This table is server/service-role only.
--
-- RLS is enabled with no client policies.
-- Supabase service-role requests bypass RLS.

alter table public.voice_call_scheduling_state
  enable row level security;

commit;

-- ============================================================================
-- OPTIONAL DATABASE HARDENING
-- ============================================================================
--
-- The scheduling engine already prevents duplicate Voice appointments using
-- the per-call atomic claim above.
--
-- The optional partial unique index below provides an additional database-level
-- guarantee that one voice_call_id cannot create multiple appointments.
--
-- DO NOT run the CREATE INDEX until the duplicate check returns zero rows.
--
-- 1. Check existing data:
--
-- select
--   voice_call_id,
--   count(*)
-- from public.appointments
-- where voice_call_id is not null
-- group by voice_call_id
-- having count(*) > 1;
--
-- Expected:
--   zero rows
--
-- 2. If zero rows, optionally run:
--
-- create unique index concurrently if not exists
--   uq_appointments_one_per_voice_call
--   on public.appointments (voice_call_id)
--   where voice_call_id is not null;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
--
-- Run these after applying the migration.
--
-- ----------------------------------------------------------------------------
-- 1. New table exists
-- ----------------------------------------------------------------------------
--
-- select to_regclass('public.voice_call_scheduling_state');
--
-- Expected:
--   public.voice_call_scheduling_state
--
-- ----------------------------------------------------------------------------
-- 2. Old table is gone
-- ----------------------------------------------------------------------------
--
-- select to_regclass('public.voice_call_booking_state');
--
-- Expected:
--   null
--
-- ----------------------------------------------------------------------------
-- 3. Verify columns
-- ----------------------------------------------------------------------------
--
-- select
--   column_name,
--   data_type,
--   is_nullable,
--   column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name = 'voice_call_scheduling_state'
-- order by ordinal_position;
--
-- ----------------------------------------------------------------------------
-- 4. Verify RLS
-- ----------------------------------------------------------------------------
--
-- select
--   relrowsecurity
-- from pg_class
-- where oid = 'public.voice_call_scheduling_state'::regclass;
--
-- Expected:
--   true
--
-- ----------------------------------------------------------------------------
-- 5. Verify no client policies
-- ----------------------------------------------------------------------------
--
-- select
--   count(*)
-- from pg_policies
-- where schemaname = 'public'
--   and tablename = 'voice_call_scheduling_state';
--
-- Expected:
--   0
--
-- ----------------------------------------------------------------------------
-- 6. Verify constraints
-- ----------------------------------------------------------------------------
--
-- select
--   conname,
--   contype,
--   pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.voice_call_scheduling_state'::regclass
-- order by contype, conname;
--
-- Expected:
--   primary key
--   organization FK
--   contact FK
--   lead FK
--   appointment FKs
--   action_type check
--   availability_status check
--
-- ----------------------------------------------------------------------------
-- 7. Verify indexes
-- ----------------------------------------------------------------------------
--
-- select
--   indexname,
--   indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename = 'voice_call_scheduling_state'
-- order by indexname;