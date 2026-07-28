-- Phase 10.1 — Generic CRM task linkage.
--
-- `tasks` today is project-scoped only (`project_id`, org resolved
-- transitively via `projects.org_id` — confirmed live, no org_id column
-- of its own; see src/lib/tasks-store.ts and src/routes/index.tsx's
-- "tasks has no org_id column of its own" comment). Leads and deals have
-- no project until (and unless) a deal is later turned into a project, so
-- there is currently no way to attach a real task to either — Phase 9.6's
-- create_follow_up_task works around this by writing a tagged note
-- instead of a task (see action-registry.ts header).
--
-- This migration adds one generic, nullable entity-link pair
-- (entity_type/entity_id) plus a real org_id column so a task can be
-- created for a lead or deal without requiring a project. It is
-- deliberately additive: existing project-linked and fully-unlinked task
-- rows are untouched and remain valid with entity_type/entity_id staying
-- null.
--
-- Polymorphic FK note: Postgres cannot enforce a single foreign key
-- against multiple target tables (leads OR deals). Same-org existence is
-- instead enforced by a BEFORE INSERT/UPDATE trigger
-- (validate_task_entity_link) that runs as the invoking user (not
-- SECURITY DEFINER) and relies on RLS + an explicit org_id match — no
-- elevated privilege is needed since the acting user already has
-- SELECT access to their own org's leads/deals.
--
-- Production-safety closure pass (same day): org_id is now enforced
-- NOT NULL after backfill (guarded — raises loudly rather than guessing
-- an org for an unresolved row), and two narrowly-scoped BEFORE DELETE
-- triggers (clear_task_links_for_deleted_lead/deal) clear a task's
-- entity_type/entity_id when its linked lead/deal is deleted, so no task
-- is ever left pointing at a row that no longer exists. This migration
-- remains additive and safely re-runnable — every DDL statement below is
-- guarded (IF NOT EXISTS / IF EXISTS / pg_constraint checks) so running it
-- again against a database where it already applied cleanly is a no-op.

begin;

-- ── org_id ────────────────────────────────────────────────────────────────
-- Added as a real, directly-queryable column (tasks previously had none)
-- so entity-linked tasks with no project can still be scoped by org
-- without relying on a `projects` join. Backfilled from the existing
-- project relationship for all current rows; stays nullable at the column
-- level since a small number of legacy rows could theoretically have a
-- project_id whose project has since been deleted (no historical FK
-- cascade guarantee here) — the app must always supply org_id explicitly
-- going forward (enforced by the validation trigger whenever an entity
-- link is present, and by application code on every write).
alter table public.tasks
  add column if not exists org_id uuid references public.organizations(id);

update public.tasks t
set org_id = p.org_id
from public.projects p
where t.project_id = p.id
  and t.org_id is null;

comment on column public.tasks.org_id is
  'Organization scope. Backfilled from projects.org_id for pre-existing rows (Phase 10.1); must be supplied directly on every new insert since project_id is now optional. NOT NULL — see the guarded check below.';

-- ── enforce org_id NOT NULL ──────────────────────────────────────────────
-- The backfill above only resolves rows whose project_id still points at
-- a real project. A row whose project was deleted with no historical FK
-- cascade guarantee (or any other row that somehow predates project_id
-- being required) would be left with org_id still null — do not guess an
-- organization for it and do not silently leave org_id nullable. Fail
-- loudly instead so it can be triaged with the remediation query below
-- before this migration is re-run.
do $$
begin
  if exists (select 1 from public.tasks where org_id is null) then
    raise exception
      'Cannot enforce tasks.org_id NOT NULL: one or more tasks could not be assigned to an organization. Run: select id, project_id, title, created_at from public.tasks where org_id is null; — then set org_id manually (e.g. from created_by''s profile/org_memberships, or by reassigning/deleting the orphaned row per product judgment) and re-run this migration.';
  end if;
end $$;

alter table public.tasks
  alter column org_id set not null;

-- ── project_id becomes optional ─────────────────────────────────────────
-- A lead- or deal-linked task has no project. Existing project-linked
-- rows and their behavior are unaffected — this only removes the
-- not-null requirement so a task can exist with project_id null and an
-- entity link instead.
alter table public.tasks
  alter column project_id drop not null;

-- ── generic entity link ──────────────────────────────────────────────────
alter table public.tasks
  add column if not exists entity_type text null,
  add column if not exists entity_id uuid null;

comment on column public.tasks.entity_type is
  'Generic CRM entity link (Phase 10.1). Supported values: lead, deal. Null = no linked entity (project-only or fully unlinked task). Extend the check constraint below, not a new column, when adding contact/account/project/estimate/appointment/invoice/conversation support.';
comment on column public.tasks.entity_id is
  'Paired with entity_type — the linked row''s id in the corresponding table. Existence and same-org membership are enforced by validate_task_entity_link(), not a normal foreign key (Postgres cannot FK one column against multiple target tables).';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_entity_type_check' and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_entity_type_check
      check (entity_type is null or entity_type in ('lead', 'deal'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_entity_link_paired_check' and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_entity_link_paired_check
      check ((entity_type is null) = (entity_id is null));
  end if;
end $$;

-- ── validation trigger ───────────────────────────────────────────────────
-- SECURITY INVOKER (default — no SECURITY DEFINER needed): runs as the
-- acting user, whose own RLS-scoped SELECT access to leads/deals is
-- sufficient to prove same-org existence via an explicit org_id match.
-- Rejects an entity link to a missing row or a cross-org row with a
-- clear, generic error (no private row data is exposed in the message).
create or replace function public.validate_task_entity_link()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.entity_type is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'tasks.org_id is required when entity_type is set';
  end if;

  if new.entity_type = 'lead' then
    if not exists (
      select 1 from public.leads
      where id = new.entity_id and org_id = new.org_id
    ) then
      raise exception 'Linked lead not found in this organization';
    end if;
  elsif new.entity_type = 'deal' then
    if not exists (
      select 1 from public.deals
      where id = new.entity_id and org_id = new.org_id
    ) then
      raise exception 'Linked deal not found in this organization';
    end if;
  else
    raise exception 'Unsupported task entity_type: %', new.entity_type;
  end if;

  return new;
end;
$$;

comment on function public.validate_task_entity_link() is
  'Phase 10.1 — enforces same-org existence for tasks.entity_type/entity_id (lead/deal today). SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access, not elevated privilege.';

drop trigger if exists tasks_validate_entity_link on public.tasks;
create trigger tasks_validate_entity_link
  before insert or update of entity_type, entity_id, org_id on public.tasks
  for each row
  execute function public.validate_task_entity_link();

-- ── entity-delete cleanup ─────────────────────────────────────────────────
-- validate_task_entity_link() only runs on INSERT/UPDATE of tasks — it
-- does nothing to stop a Lead or Deal delete from leaving a stale
-- entity_type/entity_id pointing at a row that no longer exists. These
-- BEFORE DELETE triggers clear (never delete) the linked tasks' entity
-- fields one statement before the parent row disappears, so the task
-- itself, its org_id, title, status, due date, assignee, and creator all
-- survive untouched — only the now-invalid link is cleared.
--
-- SECURITY DEFINER is used here (narrowly) rather than INVOKER: the
-- deleting user's session may not itself hold an UPDATE-eligible session
-- for every task row scoped to the SAME org as the lead/deal being
-- deleted (e.g. a task assigned to a different member, or a delete
-- performed through a path where the acting role's own RLS grant doesn't
-- happen to cover every task row in that org) — an INVOKER trigger could
-- then silently skip clearing some links depending on the caller's exact
-- RLS grant, which is worse than doing the cleanup deterministically.
-- Both functions:
--   - use ONLY OLD.id / OLD.org_id (never a client-supplied org id)
--   - update strictly WHERE org_id = OLD.org_id AND entity_type = '...'
--     AND entity_id = OLD.id — never a cross-org row
--   - pin search_path explicitly (avoids search_path hijacking)
--   - do nothing but this one bounded UPDATE — not a general-purpose
--     callable task-mutation function
--   - are revoked from PUBLIC and not directly callable by any client
--     role; they only ever run as trigger functions on a lead/deal delete
--     the caller was already independently authorized (via leads/deals'
--     own RLS delete policy) to perform.
create or replace function public.clear_task_links_for_deleted_lead()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tasks
  set entity_type = null,
      entity_id = null
  where org_id = old.org_id
    and entity_type = 'lead'
    and entity_id = old.id;

  return old;
end;
$$;

revoke all on function public.clear_task_links_for_deleted_lead() from public;

comment on function public.clear_task_links_for_deleted_lead() is
  'Phase 10.1 — BEFORE DELETE ON leads. Clears (never deletes) tasks.entity_type/entity_id for tasks linked to the lead being deleted, scoped strictly to OLD.org_id/OLD.id. SECURITY DEFINER: see migration header for why INVOKER was not sufficient here; revoked from PUBLIC, not independently callable.';

create or replace function public.clear_task_links_for_deleted_deal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tasks
  set entity_type = null,
      entity_id = null
  where org_id = old.org_id
    and entity_type = 'deal'
    and entity_id = old.id;

  return old;
end;
$$;

revoke all on function public.clear_task_links_for_deleted_deal() from public;

comment on function public.clear_task_links_for_deleted_deal() is
  'Phase 10.1 — BEFORE DELETE ON deals. Clears (never deletes) tasks.entity_type/entity_id for tasks linked to the deal being deleted, scoped strictly to OLD.org_id/OLD.id. SECURITY DEFINER: see migration header for why INVOKER was not sufficient here; revoked from PUBLIC, not independently callable.';

drop trigger if exists leads_clear_task_links on public.leads;
create trigger leads_clear_task_links
  before delete on public.leads
  for each row
  execute function public.clear_task_links_for_deleted_lead();

drop trigger if exists deals_clear_task_links on public.deals;
create trigger deals_clear_task_links
  before delete on public.deals
  for each row
  execute function public.clear_task_links_for_deleted_deal();

-- ── indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_tasks_org_id on public.tasks (org_id);

create index if not exists idx_tasks_entity_lookup
  on public.tasks (org_id, entity_type, entity_id)
  where entity_type is not null;

create index if not exists idx_tasks_entity_open
  on public.tasks (entity_type, entity_id)
  where entity_type is not null and status is distinct from 'done';

create index if not exists idx_tasks_assigned_to on public.tasks (assigned_to);
create index if not exists idx_tasks_due_date on public.tasks (due_date);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Additive only: this does not touch or drop any pre-existing policy
-- (unverified live — see report). RLS policies are permissive/OR'd in
-- Postgres, so adding a correctly org-scoped policy here can only grant
-- access consistent with the new org_id column; it can never make an
-- existing, more restrictive policy more permissive than it already was.
alter table public.tasks enable row level security;

drop policy if exists tasks_org_scoped_select on public.tasks;
create policy tasks_org_scoped_select on public.tasks
  for select
  using (
    org_id is not null and org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists tasks_org_scoped_insert on public.tasks;
create policy tasks_org_scoped_insert on public.tasks
  for insert
  with check (
    org_id is not null and org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists tasks_org_scoped_update on public.tasks;
create policy tasks_org_scoped_update on public.tasks
  for update
  using (
    org_id is not null and org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  )
  with check (
    org_id is not null and org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

drop policy if exists tasks_org_scoped_delete on public.tasks;
create policy tasks_org_scoped_delete on public.tasks
  for delete
  using (
    org_id is not null and org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

commit;
