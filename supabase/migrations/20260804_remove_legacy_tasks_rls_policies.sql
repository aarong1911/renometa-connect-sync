begin;

-- Confirm all replacement organization-scoped policies exist before
-- removing the older broad authenticated-user policies.
do $$
declare
  missing_policies text[];
begin
  select array_agg(required_policy)
  into missing_policies
  from (
    values
      ('tasks_org_scoped_select'),
      ('tasks_org_scoped_insert'),
      ('tasks_org_scoped_update'),
      ('tasks_org_scoped_delete')
  ) as required(required_policy)
  where not exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'tasks'
      and p.policyname = required.required_policy
  );

  if missing_policies is not null then
    raise exception
      'Cannot remove legacy tasks policies safely. Missing organization-scoped policies: %',
      array_to_string(missing_policies, ', ');
  end if;
end
$$;

drop policy if exists "Users can view tasks" on public.tasks;
drop policy if exists "Users can create tasks" on public.tasks;
drop policy if exists "Users can update tasks" on public.tasks;
drop policy if exists "Users can delete tasks" on public.tasks;

commit;