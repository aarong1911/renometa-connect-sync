-- Phase 10.2 closure — fix task status lifecycle.
--
-- Root cause: the live tasks_status_check constraint only allows
-- ('not_started','in_progress','on_hold','completed','cancelled'), but the
-- application (and the 20260805 log_task_activity() trigger) used an
-- older app-level vocabulary ('todo'/'review'/'done') that never matched
-- it — toDbStatus("done") returned the literal string "done", which the
-- constraint rejects, so every "Mark complete" click failed with Postgres
-- error 23514. The application layer has been corrected to use the
-- canonical DB values directly (see src/lib/task-status.ts,
-- src/lib/tasks-store.ts, netlify/lib/tasks.ts) — this migration fixes the
-- one piece of that bug that lives in the database: log_task_activity()
-- itself compared against 'done' instead of 'completed', so even once the
-- app sent the right value, the activity trigger would never have fired a
-- correct completed/reopened event.
--
-- Additive only. Does not modify 20260803_generic_crm_task_linkage.sql,
-- 20260804_remove_legacy_tasks_rls_policies.sql, or
-- 20260805_task_system_completion.sql. Existing task_activities rows are
-- untouched. Safely re-runnable (CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS before CREATE, guarded constraint drop/re-add).

begin;

-- ── expand task_activities.activity_type ────────────────────────────────
-- Cancel/Restore are now exposed as first-class UI actions (Part 9), so
-- their lifecycle events need to be representable. Existing rows are
-- unaffected — this only widens the allowed set.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'task_activities_activity_type_check' and conrelid = 'public.task_activities'::regclass
  ) then
    alter table public.task_activities drop constraint task_activities_activity_type_check;
  end if;

  alter table public.task_activities
    add constraint task_activities_activity_type_check
    check (activity_type in (
      'created', 'completed', 'reopened', 'assigned', 'unassigned',
      'due_date_changed', 'priority_changed', 'relationship_changed',
      'cancelled', 'restored'
    ));
end $$;

-- ── corrected activity trigger function ──────────────────────────────────
-- Same shape as 20260805's log_task_activity(), with two fixes:
--   1. compares against the real 'completed' value, not 'done'.
--   2. a transition into/out of 'cancelled' now emits its own
--      cancelled/restored event instead of being silently absorbed into
--      the completed/reopened branch (which it never should have matched
--      anyway, since 'cancelled' !== 'done'/'completed').
-- Lifecycle is otherwise unchanged: not_started<->in_progress<->on_hold
-- transitions emit no completed/reopened/cancelled/restored event at all.
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
    if new.status = 'completed' and old.status is distinct from 'completed' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'completed', 'Task completed',
        jsonb_build_object('previousStatus', old.status));
    elsif old.status = 'completed' and new.status is distinct from 'completed' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'reopened', 'Task reopened',
        jsonb_build_object('previousStatus', old.status, 'status', new.status));
    elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'cancelled', 'Task cancelled',
        jsonb_build_object('previousStatus', old.status));
    elsif old.status = 'cancelled' and new.status is distinct from 'cancelled' then
      insert into public.task_activities (org_id, task_id, actor_id, activity_type, summary, metadata)
      values (new.org_id, new.id, v_actor, 'restored', 'Task restored',
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
  'Phase 10.2 closure — fixed to compare against the real ''completed'' status value (was ''done''). Writes exactly one task_activities row per meaningful state change. SECURITY DEFINER: authenticated users have no direct INSERT policy on task_activities.';

-- Trigger definition itself is unchanged (same name/timing/function
-- reference as 20260805) — re-declared only so this file is a complete,
-- standalone, re-runnable unit.
drop trigger if exists tasks_log_activity on public.tasks;
create trigger tasks_log_activity
  after insert or update on public.tasks
  for each row
  execute function public.log_task_activity();

commit;
