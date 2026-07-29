-- Phase 10.2 — Task System Completion.
--
-- Additive only. Does not modify or rewrite 20260803_generic_crm_task_linkage.sql
-- or 20260804_remove_legacy_tasks_rls_policies.sql, does not drop/recreate
-- `tasks`, and makes no destructive data changes. Every DDL statement is
-- guarded so re-running this file against a database where it already
-- applied cleanly is a no-op.
--
-- Adds:
--   1. `task_activities` — real task activity history (created, completed,
--      reopened, assigned/unassigned, due_date_changed, priority_changed,
--      relationship_changed), populated by ONE trigger on `tasks` (never
--      also written from application code, to avoid duplicate events).
--   2. `validate_task_assignee()` — a same-org trigger for tasks.assigned_to,
--      mirroring the same org_memberships/profiles membership semantics
--      already used by tasks' own RLS policies (20260803/20260804).
--
-- Actor identity note: the activity trigger uses auth.uid() when available
-- (every browser-originated mutation — the large majority of task writes).
-- Service-role-originated writes (workflow engine, legacy/agentic task
-- writers) have no JWT session and therefore no auth.uid() — their
-- activity rows are honestly recorded with actor_id = null rather than
-- guessing or trusting a client-supplied actor id. The UI should display a
-- null actor as "System" / "Automated", not blank or a guessed name.

begin;

-- ── task_activities ───────────────────────────────────────────────────────
create table if not exists public.task_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid null,
  activity_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.task_activities is
  'Phase 10.2 — real task activity history. Written ONLY by log_task_activity() (a trigger on tasks) — never directly by application code, to guarantee exactly one event per state change. task_id ON DELETE CASCADE: deleting a task deletes its own activity rows (chosen delete behavior — task history does not need to outlive the task it describes; agent execution/idempotency history is a separate table and is unaffected).';
comment on column public.task_activities.activity_type is
  'created | completed | reopened | assigned | unassigned | due_date_changed | priority_changed | relationship_changed. Stable, UI-resolvable — see summary for the deterministic human-readable label and metadata for structured before/after values (never bake unstable display names into metadata as the only source of truth).';
comment on column public.task_activities.actor_id is
  'auth.uid() at the time of the change, or null for a service-role-originated write (workflow/agentic) that has no session. Never trust a client-supplied actor id.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'task_activities_activity_type_check' and conrelid = 'public.task_activities'::regclass
  ) then
    alter table public.task_activities
      add constraint task_activities_activity_type_check
      check (activity_type in (
        'created', 'completed', 'reopened', 'assigned', 'unassigned',
        'due_date_changed', 'priority_changed', 'relationship_changed'
      ));
  end if;
end $$;

-- ── indexes ───────────────────────────────────────────────────────────────
create index if not exists idx_task_activities_org_task_created
  on public.task_activities (org_id, task_id, created_at desc);

create index if not exists idx_task_activities_task_created
  on public.task_activities (task_id, created_at desc);

create index if not exists idx_task_activities_org_created
  on public.task_activities (org_id, created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Read-only for authenticated users, org-scoped. No INSERT/UPDATE/DELETE
-- policy is created for `authenticated` — rows are written exclusively by
-- log_task_activity() (SECURITY DEFINER, runs as the table owner, which
-- bypasses RLS by design; see below) or by a service-role client, both of
-- which are outside RLS already. Anonymous users match no policy at all.
alter table public.task_activities enable row level security;

drop policy if exists task_activities_org_scoped_select on public.task_activities;
create policy task_activities_org_scoped_select on public.task_activities
  for select
  using (
    org_id in (
      select org_id from public.org_memberships where member_id = auth.uid()
      union
      select organization_id from public.profiles where id = auth.uid()
    )
  );

-- ── activity-generating trigger ──────────────────────────────────────────
-- SECURITY DEFINER (deliberate, narrow): authenticated users intentionally
-- have no INSERT policy on task_activities (see RLS above), so a
-- SECURITY INVOKER trigger could never actually write a row for a
-- browser-originated task change. This function does nothing but insert
-- one deterministic, structured row per meaningful state change — it is
-- not a general-purpose callable mutation, is revoked from PUBLIC, and
-- only ever runs as a trigger on a tasks write the caller was already
-- independently authorized (via tasks' own RLS) to perform.
create or replace function public.log_task_activity()
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
    insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'created', 'Task created', '{}'::jsonb);
    return new;
  end if;

  -- tg_op = 'UPDATE' — only meaningful, specific events; never a generic
  -- "updated" catch-all when a more specific event already fired.
  if old.status is distinct from new.status then
    if new.status = 'done' and old.status is distinct from 'done' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'completed', 'Task completed',
        jsonb_build_object('previousStatus', old.status));
    elsif old.status = 'done' and new.status is distinct from 'done' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'reopened', 'Task reopened',
        jsonb_build_object('previousStatus', old.status, 'status', new.status));
    end if;
  end if;

  if old.assigned_to is distinct from new.assigned_to then
    if new.assigned_to is null then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'unassigned', 'Task unassigned',
        jsonb_build_object('previousAssignedTo', old.assigned_to));
    else
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'assigned', 'Task assigned',
        jsonb_build_object('previousAssignedTo', old.assigned_to, 'assignedTo', new.assigned_to));
    end if;
  end if;

  if old.due_date is distinct from new.due_date then
    insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'due_date_changed', 'Due date changed',
      jsonb_build_object('previousDueDate', old.due_date, 'dueDate', new.due_date));
  end if;

  if old.priority is distinct from new.priority then
    insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'priority_changed', 'Priority changed',
      jsonb_build_object('previousPriority', old.priority, 'priority', new.priority));
  end if;

  if old.entity_type is distinct from new.entity_type or old.entity_id is distinct from new.entity_id then
    insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
    values (new.org_id, new.id, v_actor, 'relationship_changed', 'Related record changed',
      jsonb_build_object(
        'previousEntityType', old.entity_type, 'previousEntityId', old.entity_id,
        'entityType', new.entity_type, 'entityId', new.entity_id
      ));
  end if;

  return new;
end;
$$;

revoke all on function public.log_task_activity() from public;

comment on function public.log_task_activity() is
  'Phase 10.2 — AFTER INSERT/UPDATE ON tasks. Writes exactly one task_activities row per meaningful state change (never a generic catch-all). SECURITY DEFINER: authenticated users have no direct INSERT policy on task_activities; see migration header for why. Not independently callable.';

drop trigger if exists tasks_log_activity on public.tasks;
create trigger tasks_log_activity
  after insert or update on public.tasks
  for each row
  execute function public.log_task_activity();

-- ── assignee same-org validation ─────────────────────────────────────────
-- Mirrors validate_task_entity_link()'s same-org pattern (20260803): a
-- plain SECURITY INVOKER read is sufficient, since the acting user already
-- has SELECT access to their own org's org_memberships/profiles (the same
-- access the Team page itself already depends on to list colleagues).
create or replace function public.validate_task_assignee()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to is null then
    return new;
  end if;

  if new.org_id is null then
    raise exception 'tasks.org_id is required when assigned_to is set';
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

comment on function public.validate_task_assignee() is
  'Phase 10.2 — enforces that tasks.assigned_to belongs to tasks.org_id. SECURITY INVOKER: relies on the acting user''s own RLS-scoped read access to org_memberships/profiles, the same access the Team page already depends on.';

drop trigger if exists tasks_validate_assignee on public.tasks;
create trigger tasks_validate_assignee
  before insert or update of assigned_to, org_id on public.tasks
  for each row
  execute function public.validate_task_assignee();

commit;
