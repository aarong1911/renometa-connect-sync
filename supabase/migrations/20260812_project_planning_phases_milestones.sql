-- supabase/migrations/20260812_project_planning_phases_milestones.sql
--
-- Phase 13.2 — Project Planning foundation: structured phases, milestones,
-- and Task dependencies. Additive, guarded, non-destructive. Does not
-- touch any applied migration or existing table beyond two new nullable
-- columns on `tasks` (phase_id, milestone_id). Deploy manually via the
-- Supabase SQL Editor — do not run `supabase db push`.
--
-- Scope note (see the Phase 13.2 report for the full reasoning): this
-- migration covers the structural core — project_phases,
-- project_milestones, task_dependencies, and the two new tasks columns.
-- Project Plan Templates (built-in + organization-owned, with apply/merge/
-- replace behavior), the Timeline UI, and the schedule-health engine are
-- intentionally deferred to a follow-up phase rather than bundled into one
-- unreviewable migration — they can be added additively on top of this
-- foundation without altering anything created here.
--
-- Existing-column reuse (per the audit): tasks already has start_date,
-- due_date, completed_at, and a `dependencies uuid[]` column. This
-- migration does NOT duplicate start_date/due_date as "planned" dates —
-- they already serve that purpose — and does not use the existing
-- `dependencies` array (confirmed unused by any application code), in
-- favor of a normalized task_dependencies table that can carry
-- dependency_type/lag_days and support real cycle detection. The old
-- array column is left in place, untouched, for a future cleanup pass.

begin;

-- ── project_phases ───────────────────────────────────────────────────────
create table if not exists public.project_phases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text null,
  position integer not null default 0,
  status text not null default 'not_started',
  planned_start_date date null,
  planned_end_date date null,
  actual_start_date date null,
  actual_end_date date null,
  completion_percentage integer null,
  color text null,
  is_customer_visible boolean not null default false,
  is_field_visible boolean not null default true,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_phases is
  'Phase 13.2 — structured Project phases (Estimating, Contracting, Demolition, etc). One Project can have many phases, ordered by position. completion_percentage is a manual override; when the phase has Tasks the UI derives progress from completed/total active Tasks instead (see getPhaseDisplayProgress in src/lib/project-planning.ts).';
comment on column public.project_phases.completion_percentage is
  'Manual progress override, 0-100, null = derive from Tasks when the phase has any. Mirrors the null-vs-explicit-value model already used by projects.completion_percentage (Phase 13.4).';
comment on column public.project_phases.is_customer_visible is
  'Portal-ready metadata only — the Portal app does not read this yet (Phase 13.2 explicitly defers Portal integration). Defaults false so nothing is customer-facing by accident.';
comment on column public.project_phases.is_field_visible is
  'Field-ready metadata only — the Field app does not read this yet. Defaults true since phases are operational/internal by default, unlike is_customer_visible.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_phases_status_check') then
    alter table public.project_phases
      add constraint project_phases_status_check
      check (status in ('not_started', 'in_progress', 'completed', 'on_hold', 'skipped'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_phases_name_check') then
    alter table public.project_phases
      add constraint project_phases_name_check
      check (char_length(btrim(name)) > 0 and char_length(name) <= 160);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_phases_completion_check') then
    alter table public.project_phases
      add constraint project_phases_completion_check
      check (completion_percentage is null or (completion_percentage >= 0 and completion_percentage <= 100));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_phases_dates_check') then
    alter table public.project_phases
      add constraint project_phases_dates_check
      check (
        (planned_start_date is null or planned_end_date is null or planned_end_date >= planned_start_date)
        and (actual_start_date is null or actual_end_date is null or actual_end_date >= actual_start_date)
      );
  end if;
end $$;

create index if not exists idx_project_phases_project_position
  on public.project_phases (project_id, position);
create index if not exists idx_project_phases_org
  on public.project_phases (org_id);

create or replace function public.set_project_phases_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_phases_set_updated_at on public.project_phases;
create trigger project_phases_set_updated_at
  before update on public.project_phases
  for each row execute function public.set_project_phases_updated_at();

alter table public.project_phases enable row level security;

drop policy if exists project_phases_select on public.project_phases;
create policy project_phases_select on public.project_phases for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_phases_insert on public.project_phases;
create policy project_phases_insert on public.project_phases for insert to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_phases_update on public.project_phases;
create policy project_phases_update on public.project_phases for update to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_phases_delete on public.project_phases;
create policy project_phases_delete on public.project_phases for delete to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- ── project_milestones ───────────────────────────────────────────────────
create table if not exists public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  phase_id uuid null references public.project_phases(id) on delete set null,
  name text not null,
  description text null,
  status text not null default 'pending',
  planned_date date null,
  completed_at timestamptz null,
  position integer not null default 0,
  is_customer_visible boolean not null default false,
  is_field_visible boolean not null default true,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_milestones is
  'Phase 13.2 — Project milestones (Contract Signed, Permit Approved, Final Walkthrough, etc). May belong to a phase or be Project-level (phase_id null).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_milestones_status_check') then
    alter table public.project_milestones
      add constraint project_milestones_status_check
      check (status in ('pending', 'achieved', 'missed', 'cancelled'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_milestones_name_check') then
    alter table public.project_milestones
      add constraint project_milestones_name_check
      check (char_length(btrim(name)) > 0 and char_length(name) <= 160);
  end if;
end $$;

-- Phase, when set, must belong to the same Project — prevents a milestone
-- from silently pointing at another Project's phase.
create or replace function public.validate_project_milestone_phase()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.phase_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.project_phases
    where id = new.phase_id and project_id = new.project_id
  ) then
    raise exception 'Milestone phase_id must belong to the same Project';
  end if;

  return new;
end;
$$;

drop trigger if exists project_milestones_validate_phase on public.project_milestones;
create trigger project_milestones_validate_phase
  before insert or update of phase_id, project_id on public.project_milestones
  for each row execute function public.validate_project_milestone_phase();

create index if not exists idx_project_milestones_project_position
  on public.project_milestones (project_id, position);
create index if not exists idx_project_milestones_phase
  on public.project_milestones (phase_id);
create index if not exists idx_project_milestones_org
  on public.project_milestones (org_id);

create or replace function public.set_project_milestones_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_milestones_set_updated_at on public.project_milestones;
create trigger project_milestones_set_updated_at
  before update on public.project_milestones
  for each row execute function public.set_project_milestones_updated_at();

alter table public.project_milestones enable row level security;

drop policy if exists project_milestones_select on public.project_milestones;
create policy project_milestones_select on public.project_milestones for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_milestones_insert on public.project_milestones;
create policy project_milestones_insert on public.project_milestones for insert to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_milestones_update on public.project_milestones;
create policy project_milestones_update on public.project_milestones for update to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists project_milestones_delete on public.project_milestones;
create policy project_milestones_delete on public.project_milestones for delete to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- ── tasks: phase_id / milestone_id ───────────────────────────────────────
-- planned dates deliberately reuse tasks.start_date/due_date (already
-- exist, confirmed via audit) rather than adding planned_start_date/
-- planned_end_date duplicates.
alter table public.tasks add column if not exists phase_id uuid null references public.project_phases(id) on delete set null;
alter table public.tasks add column if not exists milestone_id uuid null references public.project_milestones(id) on delete set null;

comment on column public.tasks.phase_id is
  'Phase 13.2 — optional Project phase this Task belongs to. Nullable: pre-existing Tasks and Tasks unrelated to a structured plan are unaffected.';
comment on column public.tasks.milestone_id is
  'Phase 13.2 — optional milestone this Task is linked to (completing it may be used to mark the milestone achieved from the UI; no automatic trigger is created here, kept as an explicit user/workflow action).';

-- Phase/milestone, when set, must belong to the same Project as the Task.
create or replace function public.validate_task_phase_milestone()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.phase_id is not null and not exists (
    select 1 from public.project_phases where id = new.phase_id and project_id = new.project_id
  ) then
    raise exception 'Task phase_id must belong to the same Project';
  end if;

  if new.milestone_id is not null and not exists (
    select 1 from public.project_milestones where id = new.milestone_id and project_id = new.project_id
  ) then
    raise exception 'Task milestone_id must belong to the same Project';
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_validate_phase_milestone on public.tasks;
create trigger tasks_validate_phase_milestone
  before insert or update of phase_id, milestone_id, project_id on public.tasks
  for each row execute function public.validate_task_phase_milestone();

create index if not exists idx_tasks_phase on public.tasks (phase_id);
create index if not exists idx_tasks_milestone on public.tasks (milestone_id);

-- ── task_dependencies ────────────────────────────────────────────────────
create table if not exists public.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  predecessor_task_id uuid not null references public.tasks(id) on delete cascade,
  successor_task_id uuid not null references public.tasks(id) on delete cascade,
  dependency_type text not null default 'finish_to_start',
  lag_days integer not null default 0,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.task_dependencies is
  'Phase 13.2 — Task sequencing. finish_to_start only for this phase (successor cannot start/be treated unblocked until predecessor is complete). Cycle protection is enforced in validate_task_dependency() below at INSERT/UPDATE time, not only in the UI.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_dependencies_type_check') then
    alter table public.task_dependencies
      add constraint task_dependencies_type_check
      check (dependency_type in ('finish_to_start'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_dependencies_no_self_check') then
    alter table public.task_dependencies
      add constraint task_dependencies_no_self_check
      check (predecessor_task_id <> successor_task_id);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_dependencies_lag_check') then
    alter table public.task_dependencies
      add constraint task_dependencies_lag_check
      check (lag_days >= 0);
  end if;
end $$;

create unique index if not exists idx_task_dependencies_unique_pair
  on public.task_dependencies (predecessor_task_id, successor_task_id);
create index if not exists idx_task_dependencies_project
  on public.task_dependencies (project_id);
create index if not exists idx_task_dependencies_successor
  on public.task_dependencies (successor_task_id);
create index if not exists idx_task_dependencies_predecessor
  on public.task_dependencies (predecessor_task_id);

-- Server-side validation: both Tasks belong to the same org+Project as the
-- dependency row, and adding this edge does not create a cycle. Walks the
-- successor's existing dependency graph looking for a path back to the
-- proposed predecessor — this is the "would this new edge close a loop"
-- check, done with a bounded recursive CTE (bounded by depth 1000, which
-- is far beyond any realistic Task plan and only exists to guarantee
-- termination against a pathological/corrupted graph).
create or replace function public.validate_task_dependency()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pred_project uuid;
  v_succ_project uuid;
  v_pred_org uuid;
  v_succ_org uuid;
  v_cycle boolean;
begin
  select project_id, org_id into v_pred_project, v_pred_org from public.tasks where id = new.predecessor_task_id;
  select project_id, org_id into v_succ_project, v_succ_org from public.tasks where id = new.successor_task_id;

  if v_pred_project is null or v_succ_project is null then
    raise exception 'Both Tasks in a dependency must exist';
  end if;

  if v_pred_project <> v_succ_project or v_pred_project <> new.project_id then
    raise exception 'Dependency Tasks must belong to the same Project as the dependency row';
  end if;

  if v_pred_org <> v_succ_org or v_pred_org <> new.org_id then
    raise exception 'Dependency Tasks must belong to the same organization';
  end if;

  -- Would predecessor_task_id become reachable FROM successor_task_id
  -- through existing edges once this new edge is added? If so, it's a cycle.
  with recursive reachable(task_id, depth) as (
    select successor_task_id, 1
    from public.task_dependencies
    where predecessor_task_id = new.successor_task_id
    union all
    select d.successor_task_id, r.depth + 1
    from public.task_dependencies d
    join reachable r on d.predecessor_task_id = r.task_id
    where r.depth < 1000
  )
  select exists (select 1 from reachable where task_id = new.predecessor_task_id) into v_cycle;

  if v_cycle then
    raise exception 'This dependency would create a circular task sequence.';
  end if;

  return new;
end;
$$;

drop trigger if exists task_dependencies_validate on public.task_dependencies;
create trigger task_dependencies_validate
  before insert or update on public.task_dependencies
  for each row execute function public.validate_task_dependency();

alter table public.task_dependencies enable row level security;

drop policy if exists task_dependencies_select on public.task_dependencies;
create policy task_dependencies_select on public.task_dependencies for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists task_dependencies_insert on public.task_dependencies;
create policy task_dependencies_insert on public.task_dependencies for insert to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists task_dependencies_delete on public.task_dependencies;
create policy task_dependencies_delete on public.task_dependencies for delete to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

commit;

-- ── Verification (run after applying) ────────────────────────────────────
-- select table_name from information_schema.tables
--   where table_schema='public' and table_name in
--   ('project_phases','project_milestones','task_dependencies');
--
-- select column_name from information_schema.columns
--   where table_name='tasks' and column_name in ('phase_id','milestone_id');
--
-- select conname from pg_constraint
--   where conname in (
--     'project_phases_status_check','project_milestones_status_check',
--     'task_dependencies_type_check','task_dependencies_no_self_check'
--   );
--
-- -- Cycle-protection smoke test (run in a transaction you roll back):
-- -- begin;
-- --   insert into task_dependencies (org_id, project_id, predecessor_task_id, successor_task_id)
-- --     values ('<org>', '<project>', '<task A>', '<task B>');
-- --   insert into task_dependencies (org_id, project_id, predecessor_task_id, successor_task_id)
-- --     values ('<org>', '<project>', '<task B>', '<task A>'); -- expect: circular task sequence error
-- -- rollback;
