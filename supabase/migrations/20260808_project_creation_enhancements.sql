-- Phase — Project Creation Enhancements.
--
-- Adds the columns the New Project modal needs that genuinely don't exist
-- yet, confirmed via a live schema check first (public.projects today has:
-- id, org_id, estimate_id, name, client_id (NOT NULL, -> contacts.id),
-- status, start_date, end_date, budget_total (NOT NULL numeric), deal_id,
-- description, actual_cost, completion_percentage, address, created_by,
-- original_estimate_total, slug — no project_type, priority, owner_id,
-- budget_range, or lead_id). `description` already exists and is reused
-- directly for Description/Scope — no new column for that. An Account/
-- Company relationship is deliberately NOT duplicated onto projects: it is
-- already resolvable transitively via client_id -> contacts.company_id
-- (the same pattern accounts_.$accountSlug.tsx already uses), so adding a
-- second, competing company_id here would create two disagreeing sources
-- of truth for the same relationship.
--
-- Additive only. Does not modify any prior migration. Every statement is
-- guarded (IF NOT EXISTS / IF EXISTS / pg_constraint checks) so re-running
-- this file against a database where it already applied cleanly is a
-- no-op. Not run automatically — see the deployment instructions in the
-- accompanying report.

begin;

-- ── new columns ──────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists project_type text null,
  add column if not exists custom_project_type text null,
  add column if not exists priority text null default 'normal',
  add column if not exists owner_id uuid null,
  add column if not exists budget_range text null,
  add column if not exists lead_id uuid null;

comment on column public.projects.project_type is
  'Canonical renovation category (kitchen_remodel|bathroom_remodel|full_home_remodel|home_addition|roofing|flooring|painting|hvac|plumbing|electrical|landscaping|commercial_renovation|new_construction|repair_maintenance|other). Null = not set (pre-existing rows).';
comment on column public.projects.custom_project_type is
  'Free-text label the user provided when project_type = ''other''. Never used as a stand-in for the canonical value elsewhere.';
comment on column public.projects.priority is
  'low|normal|high|urgent. Defaults to ''normal'' for new rows; pre-existing rows are backfilled to ''normal'' below rather than left null, since priority always has a sensible display default and NULL would need special-casing everywhere it is rendered.';
comment on column public.projects.owner_id is
  'Real profile/user UUID the project is assigned to (references profiles.id, mirrors tasks.assigned_to''s pattern). Null = unassigned. Same-org membership enforced by validate_project_owner() below.';
comment on column public.projects.budget_range is
  'Canonical customer-facing budget bracket (not_specified|under_10k|10k_25k|25k_50k|50k_100k|100k_250k|250k_500k|500k_plus|custom). budget_total (pre-existing, NOT NULL, already used by pipeline-value math) remains the authoritative numeric figure — see the app-layer midpoint mapping documented in src/lib/project-status.ts. Null = pre-existing row written before this existed.';
comment on column public.projects.lead_id is
  'Originating lead when this project was created from a Lead conversion (references leads.id). Null for every other source. Mirrors deal_id''s existing pattern.';

-- ── backfill ──────────────────────────────────────────────────────────────
update public.projects set priority = 'normal' where priority is null;

alter table public.projects
  alter column priority set not null;

-- ── foreign keys ──────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_owner_id_fkey' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_owner_id_fkey
      foreign key (owner_id) references public.profiles(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_lead_id_fkey' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_lead_id_fkey
      foreign key (lead_id) references public.leads(id) on delete set null;
  end if;
end $$;

-- ── check constraints ─────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_project_type_check' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_project_type_check
      check (project_type is null or project_type in (
        'kitchen_remodel', 'bathroom_remodel', 'full_home_remodel', 'home_addition',
        'roofing', 'flooring', 'painting', 'hvac', 'plumbing', 'electrical',
        'landscaping', 'commercial_renovation', 'new_construction', 'repair_maintenance', 'other'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_priority_check' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_budget_range_check' and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_budget_range_check
      check (budget_range is null or budget_range in (
        'not_specified', 'under_10k', '10k_25k', '25k_50k', '50k_100k',
        '100k_250k', '250k_500k', '500k_plus', 'custom'
      ));
  end if;
end $$;

-- ── same-org owner validation (mirrors validate_task_assignee) ───────────
create or replace function public.validate_project_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.owner_id is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'projects.org_id is required when owner_id is set';
  end if;

  if not exists (
    select 1 from public.org_memberships
    where member_id = new.owner_id and org_id = new.org_id
    union
    select 1 from public.profiles
    where id = new.owner_id and organization_id = new.org_id
  ) then
    raise exception 'Project owner is not a member of this organization';
  end if;

  return new;
end;
$$;

comment on function public.validate_project_owner() is
  'Enforces that projects.owner_id belongs to projects.org_id. SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access to org_memberships/profiles.';

drop trigger if exists projects_validate_owner on public.projects;
create trigger projects_validate_owner
  before insert or update of owner_id, org_id on public.projects
  for each row
  execute function public.validate_project_owner();

-- ── same-org lead validation ──────────────────────────────────────────────
create or replace function public.validate_project_lead()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lead_id is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'projects.org_id is required when lead_id is set';
  end if;

  if not exists (
    select 1 from public.leads where id = new.lead_id and org_id = new.org_id
  ) then
    raise exception 'Linked lead not found in this organization';
  end if;

  return new;
end;
$$;

comment on function public.validate_project_lead() is
  'Enforces that projects.lead_id belongs to projects.org_id. SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access to leads.';

drop trigger if exists projects_validate_lead on public.projects;
create trigger projects_validate_lead
  before insert or update of lead_id, org_id on public.projects
  for each row
  execute function public.validate_project_lead();

-- ── indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_projects_owner_id on public.projects (owner_id);
create index if not exists idx_projects_lead_id on public.projects (lead_id) where lead_id is not null;

commit;
