-- Fix 1: Drop the stale category check constraint and re-add with correct values
alter table workflows drop constraint if exists workflows_category_check;
alter table workflows drop constraint if exists workflows_status_check;

alter table workflows
  add constraint workflows_status_check
    check (status in ('active', 'paused', 'draft')),
  add constraint workflows_category_check
    check (category in ('Sales', 'Operations', 'Finance', 'Marketing', 'Client Care'));

-- Fix 2: Rename "trigger" column to "trigger_event" (trigger is a reserved keyword)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'workflows' and column_name = 'trigger'
  ) then
    alter table workflows rename column "trigger" to trigger_event;
  end if;
end $$;

-- Ensure trigger_event column exists (if it was never added)
alter table workflows
  add column if not exists trigger_event text not null default '';
