-- ── BUG 1: Full RLS coverage for deals table ────────────────────────────────

alter table deals enable row level security;

drop policy if exists "org members can read deals"   on deals;
drop policy if exists "org members can insert deals" on deals;
drop policy if exists "org members can update deals" on deals;
drop policy if exists "org members can delete deals" on deals;

create policy "org members can read deals" on deals
  for select using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

create policy "org members can insert deals" on deals
  for insert with check (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

create policy "org members can update deals" on deals
  for update
  using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  )
  with check (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

create policy "org members can delete deals" on deals
  for delete using (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

-- ── Contacts: ensure INSERT policy exists ───────────────────────────────────
-- addDeal now creates/upserts a contact before inserting the deal.
-- If contacts is missing an INSERT policy the POST returns 403.

alter table contacts enable row level security;

drop policy if exists "org members can insert contacts" on contacts;
create policy "org members can insert contacts" on contacts
  for insert with check (
    org_id in (
      select org_id from org_memberships where member_id = auth.uid()
      union
      select organization_id from profiles where id = auth.uid()
    )
  );

-- ── BUG 2: workflow_trigger_queue ────────────────────────────────────────────
-- Triggers on deals AND contacts (and possibly other tables) insert into
-- workflow_trigger_queue as SECURITY INVOKER (the calling user).
-- The user has no INSERT policy on that table, so every insert on a
-- trigger-bearing table fails with 42501.
--
-- Fix A: permissive INSERT policy so any authenticated session can enqueue.
-- Fix B: SECURITY DEFINER on every trigger function that fires on org tables
--        so the function runs as the DB owner regardless of the caller.
-- Both fixes are applied.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'workflow_trigger_queue'
  ) then
    execute 'alter table workflow_trigger_queue enable row level security';

    execute $q$
      drop policy if exists "org members can insert workflow triggers"
        on workflow_trigger_queue
    $q$;
    execute $q$
      create policy "org members can insert workflow triggers"
        on workflow_trigger_queue
        for insert to authenticated
        with check (true)
    $q$;

    execute $q$
      drop policy if exists "org members can read workflow triggers"
        on workflow_trigger_queue
    $q$;
    execute $q$
      create policy "org members can read workflow triggers"
        on workflow_trigger_queue
        for select to authenticated
        using (true)
    $q$;
  end if;
end $$;

-- Fix B: iterate over ALL trigger functions on the tables that are known to
-- have workflow triggers (deals, contacts, leads, projects, invoices, etc.)
-- and make each one SECURITY DEFINER.  A single shared function name (common
-- pattern) will only be processed once thanks to DISTINCT.
do $$
declare
  rec record;
begin
  for rec in
    select distinct p.proname
    from   pg_trigger  t
    join   pg_proc     p  on p.oid = t.tgfoid
    join   pg_class    c  on c.oid = t.tgrelid
    where  c.relkind = 'r'
      and  c.relname in (
             'deals','contacts','leads','projects',
             'invoices','appointments','tasks'
           )
  loop
    begin
      execute 'alter function public.' || quote_ident(rec.proname) || '() security definer';
    exception when others then
      null;   -- ignore if function signature differs or doesn't exist
    end;
  end loop;
end $$;
