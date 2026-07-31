-- Phase 10.3 — Calendar and Appointments Completion.
--
-- Extends the existing, already-live public.appointments table in place
-- (7 real rows today — used by src/routes/calendar.tsx, Command Center,
-- Contact related records, the Inbox appointment context panel, and the
-- Voice AI/Vapi post-call booking pipeline in netlify/functions/vapi-webhook.ts
-- and netlify/functions/lib/post-call-automation.ts). Does NOT touch, rename,
-- repurpose, or drop public.calendar_events (0 rows, unused by any frontend
-- code, belongs to an incomplete crew/project field-dispatch feature that is
-- explicitly out of scope for this pass).
--
-- Additive only. Does not modify 20260803_generic_crm_task_linkage.sql,
-- 20260804_remove_legacy_tasks_rls_policies.sql, 20260805_task_system_completion.sql,
-- or 20260806_fix_task_status_lifecycle.sql. Every DDL statement below is
-- guarded (IF NOT EXISTS / IF EXISTS / pg_constraint checks) so re-running
-- this file against a database where it already applied cleanly is a no-op.
--
-- Preserves the two existing Voice AI / Vapi writers exactly as-is: they
-- insert only a subset of columns (org_id, contact_name, service,
-- scheduled_at, duration_min, status, source: 'Voice AI', gcal_event_id,
-- voice_call_id, ...) — every new column added here is nullable with a safe
-- default, so those existing partial INSERTs continue to work unchanged.
--
-- Legacy data note: appointments.source has no pre-existing check
-- constraint, and all 7 live rows use the literal string 'Voice AI' (with a
-- capital V and a space) written directly by vapi-webhook.ts /
-- post-call-automation.ts — NOT the new canonical lowercase 'ai_voice'
-- value. The constraint added below explicitly grandfathers 'Voice AI' and
-- 'Manual' (the value src/components/calendar/new-booking-dialog.tsx used
-- to write before this migration) alongside the new canonical vocabulary,
-- rather than rejecting real historical rows.

begin;

-- ── new columns on public.appointments ──────────────────────────────────
alter table public.appointments
  add column if not exists title text null,
  add column if not exists appointment_type text null,
  add column if not exists assigned_to uuid null,
  add column if not exists entity_type text null,
  add column if not exists entity_id uuid null,
  add column if not exists ends_at timestamptz null,
  add column if not exists time_zone text null,
  add column if not exists meeting_url text null,
  add column if not exists reminder_minutes integer[] null,
  add column if not exists completed_at timestamptz null,
  add column if not exists cancelled_at timestamptz null,
  add column if not exists cancelled_by uuid null,
  add column if not exists cancellation_reason text null,
  add column if not exists google_calendar_id text null,
  add column if not exists google_event_etag text null,
  add column if not exists google_sync_status text null,
  add column if not exists google_synced_at timestamptz null,
  add column if not exists google_last_error text null,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.appointments.title is
  'Phase 10.3 — display title. Backfilled from `service` for pre-existing rows; new rows should always set this directly. Falls back to `service` in the UI when null.';
comment on column public.appointments.appointment_type is
  'Phase 10.3 — one of consultation|estimate|site_visit|service|follow_up|internal|other. Nullable — the UI treats null as "consultation" (the create-form default) rather than requiring a backfill guess for old rows.';
comment on column public.appointments.assigned_to is
  'Phase 10.3 — real team member (org_memberships.member_id / profiles.id) this appointment is assigned to. Null = unassigned. Same-org membership enforced by validate_appointment_assignee().';
comment on column public.appointments.entity_type is
  'Phase 10.3 — generic CRM relationship. Supported: lead|contact|company|deal|project. Null = unlinked. For entity_type=''contact'', entity_id is kept synchronized with the pre-existing contact_id column — contact_id remains the authoritative FK (ON DELETE SET NULL); entity_id/entity_type exist so Contact is representable through the same generic picker as Lead/Company/Deal/Project.';
comment on column public.appointments.entity_id is
  'Phase 10.3 — paired with entity_type. Existence and same-org membership enforced by validate_appointment_entity_link(), not a normal FK (Postgres cannot FK one column against multiple target tables).';
comment on column public.appointments.ends_at is
  'Phase 10.3 — explicit end timestamp. Backfilled from scheduled_at + duration_min for pre-existing rows. New rows should set this directly; duration_min is kept in sync for backward-compatible reads.';
comment on column public.appointments.time_zone is
  'Phase 10.3 — IANA timezone the appointment was scheduled in (e.g. America/New_York). Backfilled from the owning organization''s organizations.timezone. Never a bare numeric offset.';
comment on column public.appointments.google_calendar_id is
  'Phase 10.3 — target Google Calendar ID for sync. gcal_event_id (pre-existing) remains the authoritative synced-event ID; this is additional Google metadata, not a competing event-id source.';
comment on column public.appointments.google_sync_status is
  'Phase 10.3 — pending|synced|failed|disconnected|not_enabled. Null = sync never attempted for this appointment (e.g. created before Google Calendar was connected, or the org has no gcal integration).';

-- ── backfill (pre-existing rows only; every new column stays nullable) ──
update public.appointments
set title = service
where title is null and service is not null;

update public.appointments
set ends_at = scheduled_at + make_interval(mins => coalesce(duration_min, 60))
where ends_at is null;

update public.appointments a
set time_zone = o.timezone
from public.organizations o
where a.org_id = o.id
  and a.time_zone is null
  and o.timezone is not null;

update public.appointments
set time_zone = 'America/New_York'
where time_zone is null;

update public.appointments
set entity_type = 'contact', entity_id = contact_id
where entity_type is null and contact_id is not null;

-- ── assigned_to / cancelled_by foreign keys ──────────────────────────────
-- Mirrors tasks.assigned_to's real FK to profiles(id) (ON DELETE SET NULL)
-- so the same PostgREST embed pattern (profiles!appointments_assigned_to_fkey)
-- used by tasks-store.ts works for appointments-store.ts. Same-org
-- membership is enforced separately by validate_appointment_assignee()
-- below — the FK alone only proves the profile exists, not that it belongs
-- to this appointment's org.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_assigned_to_fkey' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_assigned_to_fkey
      foreign key (assigned_to) references public.profiles(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_cancelled_by_fkey' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_cancelled_by_fkey
      foreign key (cancelled_by) references public.profiles(id) on delete set null;
  end if;
end $$;

-- ── status check: widen to add in_progress ──────────────────────────────
-- Preserves every existing valid value (scheduled/confirmed/completed/
-- cancelled/no_show) — this only widens the allowed set, never narrows it.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'appointments_status_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments drop constraint appointments_status_check;
  end if;

  alter table public.appointments
    add constraint appointments_status_check
    check (status in ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'));
end $$;

-- ── appointment_type check ───────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_appointment_type_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_appointment_type_check
      check (appointment_type is null or appointment_type in (
        'consultation', 'estimate', 'site_visit', 'service', 'follow_up', 'internal', 'other'
      ));
  end if;
end $$;

-- ── source check ──────────────────────────────────────────────────────────
-- Grandfathers the two literal values already written by live code
-- ('Voice AI' from vapi-webhook.ts/post-call-automation.ts, 'Manual' from
-- the pre-Phase-10.3 new-booking-dialog.tsx) alongside the new canonical
-- lowercase vocabulary. Existing rows are never rejected.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_source_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_source_check
      check (source is null or source in (
        'manual', 'lead', 'contact', 'company', 'deal', 'project', 'inbox',
        'ai_chat', 'ai_voice', 'workflow', 'google_calendar', 'api',
        'Voice AI', 'Manual'
      ));
  end if;
end $$;

-- ── entity_type check ─────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_entity_type_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_entity_type_check
      check (entity_type is null or entity_type in ('lead', 'contact', 'company', 'deal', 'project'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_entity_link_paired_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_entity_link_paired_check
      check ((entity_type is null) = (entity_id is null));
  end if;
end $$;

-- ── google_sync_status check ─────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_google_sync_status_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_google_sync_status_check
      check (google_sync_status is null or google_sync_status in (
        'pending', 'synced', 'failed', 'disconnected', 'not_enabled'
      ));
  end if;
end $$;

-- ── time-range check ──────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_ends_after_start_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_ends_after_start_check
      check (ends_at is null or ends_at > scheduled_at);
  end if;
end $$;

-- ── lifecycle-timestamp mutual-exclusion check ───────────────────────────
-- completed_at and cancelled_at can never both be populated — an
-- appointment cannot be simultaneously completed and cancelled. Does not
-- otherwise force completed_at/cancelled_at to match `status` at the
-- constraint level (that pairing is enforced by application code /
-- getAppointmentStatusPatch(), matching the task-status precedent, so a
-- pre-existing row with a stale combination is never rejected outright).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_completed_cancelled_exclusive_check' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_completed_cancelled_exclusive_check
      check (completed_at is null or cancelled_at is null);
  end if;
end $$;

-- ── indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_appointments_org_scheduled on public.appointments (org_id, scheduled_at);
create index if not exists idx_appointments_org_status_scheduled on public.appointments (org_id, status, scheduled_at);
create index if not exists idx_appointments_org_assigned_scheduled on public.appointments (org_id, assigned_to, scheduled_at);
create index if not exists idx_appointments_org_entity on public.appointments (org_id, entity_type, entity_id) where entity_type is not null;
create index if not exists idx_appointments_org_created on public.appointments (org_id, created_at desc);

-- Partial unique index: prevents two local rows from claiming the same
-- Google event, but only once an event id actually exists.
create unique index if not exists uq_appointments_org_gcal_event
  on public.appointments (org_id, gcal_event_id)
  where gcal_event_id is not null;

-- ── appointment_activities ───────────────────────────────────────────────
create table if not exists public.appointment_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  actor_id uuid null,
  activity_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.appointment_activities is
  'Phase 10.3 — real appointment activity history. Written ONLY by log_appointment_activity() (a trigger on appointments) — never directly by application code. appointment_id ON DELETE CASCADE: deleting an appointment deletes its own history.';
comment on column public.appointment_activities.actor_id is
  'auth.uid() at the time of the change, or null for a service-role-originated write (Voice AI/workflow/agentic) that has no session. UI renders a null actor as "System"/"Automated".';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointment_activities_type_check' and conrelid = 'public.appointment_activities'::regclass
  ) then
    alter table public.appointment_activities
      add constraint appointment_activities_type_check
      check (activity_type in (
        'created', 'rescheduled', 'assigned', 'unassigned', 'confirmed', 'started',
        'completed', 'reopened', 'cancelled', 'restored', 'marked_no_show',
        'relationship_changed', 'location_changed', 'reminder_changed',
        'google_synced', 'google_sync_failed'
      ));
  end if;
end $$;

create index if not exists idx_appointment_activities_org_appt_created
  on public.appointment_activities (org_id, appointment_id, created_at desc);
create index if not exists idx_appointment_activities_appt_created
  on public.appointment_activities (appointment_id, created_at desc);
create index if not exists idx_appointment_activities_org_created
  on public.appointment_activities (org_id, created_at desc);

alter table public.appointment_activities enable row level security;

drop policy if exists appointment_activities_org_scoped_select on public.appointment_activities;
create policy appointment_activities_org_scoped_select on public.appointment_activities
  for select
  using (
    org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy for `authenticated` — rows are written
-- exclusively by log_appointment_activity() (SECURITY DEFINER below).

-- ── activity-generating trigger ──────────────────────────────────────────
create or replace function public.log_appointment_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
begin
  v_actor := auth.uid();

  if tg_op = 'INSERT' then
    insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'created', 'Appointment created', '{}'::jsonb);
    return new;
  end if;

  -- tg_op = 'UPDATE' — only meaningful, specific events; never a generic
  -- "updated" catch-all when a more specific event already fired.
  if old.scheduled_at is distinct from new.scheduled_at
     or old.ends_at is distinct from new.ends_at
     or old.duration_min is distinct from new.duration_min then
    insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'rescheduled', 'Appointment rescheduled',
      jsonb_build_object(
        'previousScheduledAt', old.scheduled_at, 'scheduledAt', new.scheduled_at,
        'previousEndsAt', old.ends_at, 'endsAt', new.ends_at
      ));
  end if;

  if old.assigned_to is distinct from new.assigned_to then
    if new.assigned_to is null then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'unassigned', 'Appointment unassigned',
        jsonb_build_object('previousAssignedTo', old.assigned_to));
    else
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'assigned', 'Appointment assigned',
        jsonb_build_object('previousAssignedTo', old.assigned_to, 'assignedTo', new.assigned_to));
    end if;
  end if;

  if old.status is distinct from new.status then
    if new.status = 'confirmed' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'confirmed', 'Appointment confirmed',
        jsonb_build_object('previousStatus', old.status));
    elsif new.status = 'in_progress' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'started', 'Appointment started',
        jsonb_build_object('previousStatus', old.status));
    elsif new.status = 'completed' and old.status is distinct from 'completed' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'completed', 'Appointment completed',
        jsonb_build_object('previousStatus', old.status));
    elsif old.status = 'completed' and new.status not in ('completed', 'cancelled') then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'reopened', 'Appointment reopened',
        jsonb_build_object('previousStatus', old.status, 'status', new.status));
    elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'cancelled', 'Appointment cancelled',
        jsonb_build_object('previousStatus', old.status));
    elsif old.status = 'cancelled' and new.status not in ('cancelled', 'completed') then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'restored', 'Appointment restored',
        jsonb_build_object('previousStatus', old.status, 'status', new.status));
    elsif new.status = 'no_show' and old.status is distinct from 'no_show' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'marked_no_show', 'Appointment marked no-show',
        jsonb_build_object('previousStatus', old.status));
    end if;
  end if;

  if old.entity_type is distinct from new.entity_type or old.entity_id is distinct from new.entity_id then
    insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'relationship_changed', 'Related record changed',
      jsonb_build_object(
        'previousEntityType', old.entity_type, 'previousEntityId', old.entity_id,
        'entityType', new.entity_type, 'entityId', new.entity_id
      ));
  end if;

  if old.address is distinct from new.address then
    insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'location_changed', 'Location changed',
      jsonb_build_object('previousAddress', old.address, 'address', new.address));
  end if;

  if old.reminder_minutes is distinct from new.reminder_minutes then
    insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'reminder_changed', 'Reminders changed',
      jsonb_build_object('previousReminderMinutes', old.reminder_minutes, 'reminderMinutes', new.reminder_minutes));
  end if;

  if old.google_sync_status is distinct from new.google_sync_status then
    if new.google_sync_status = 'synced' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'google_synced', 'Synced to Google Calendar',
        jsonb_build_object('gcalEventId', new.gcal_event_id));
    elsif new.google_sync_status = 'failed' then
      insert into public.appointment_activities (org_id, appointment_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'google_sync_failed', 'Google Calendar sync failed',
        jsonb_build_object('error', new.google_last_error));
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.log_appointment_activity() from public;

comment on function public.log_appointment_activity() is
  'Phase 10.3 — AFTER INSERT/UPDATE ON appointments. Writes exactly one appointment_activities row per meaningful state change. SECURITY DEFINER: authenticated users have no direct INSERT policy on appointment_activities.';

drop trigger if exists appointments_log_activity on public.appointments;
create trigger appointments_log_activity
  after insert or update on public.appointments
  for each row
  execute function public.log_appointment_activity();

-- ── assignee same-org validation ─────────────────────────────────────────
create or replace function public.validate_appointment_assignee()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'appointments.org_id is required when assigned_to is set';
  end if;

  if not exists (
    select 1 from public.org_memberships
    where member_id = new.assigned_to and org_id = new.org_id
    union
    select 1 from public.profiles
    where id = new.assigned_to and organization_id = new.org_id
  ) then
    raise exception 'Assignee is not a member of this organization';
  end if;

  return new;
end;
$$;

comment on function public.validate_appointment_assignee() is
  'Phase 10.3 — enforces that appointments.assigned_to belongs to appointments.org_id. SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access to org_memberships/profiles.';

drop trigger if exists appointments_validate_assignee on public.appointments;
create trigger appointments_validate_assignee
  before insert or update of assigned_to, org_id on public.appointments
  for each row
  execute function public.validate_appointment_assignee();

-- ── entity relationship same-org validation ──────────────────────────────
create or replace function public.validate_appointment_entity_link()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.entity_type is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'appointments.org_id is required when entity_type is set';
  end if;

  if new.entity_type = 'lead' then
    if not exists (select 1 from public.leads where id = new.entity_id and org_id = new.org_id) then
      raise exception 'Linked lead not found in this organization';
    end if;
  elsif new.entity_type = 'contact' then
    if not exists (select 1 from public.contacts where id = new.entity_id and org_id = new.org_id) then
      raise exception 'Linked contact not found in this organization';
    end if;
  elsif new.entity_type = 'company' then
    if not exists (select 1 from public.companies where id = new.entity_id and org_id = new.org_id) then
      raise exception 'Linked company not found in this organization';
    end if;
  elsif new.entity_type = 'deal' then
    if not exists (select 1 from public.deals where id = new.entity_id and org_id = new.org_id) then
      raise exception 'Linked deal not found in this organization';
    end if;
  elsif new.entity_type = 'project' then
    if not exists (select 1 from public.projects where id = new.entity_id and org_id = new.org_id) then
      raise exception 'Linked project not found in this organization';
    end if;
  else
    raise exception 'Unsupported appointment entity_type: %', new.entity_type;
  end if;

  return new;
end;
$$;

comment on function public.validate_appointment_entity_link() is
  'Phase 10.3 — enforces same-org existence for appointments.entity_type/entity_id (lead|contact|company|deal|project). SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access.';

drop trigger if exists appointments_validate_entity_link on public.appointments;
create trigger appointments_validate_entity_link
  before insert or update of entity_type, entity_id, org_id on public.appointments
  for each row
  execute function public.validate_appointment_entity_link();

commit;
