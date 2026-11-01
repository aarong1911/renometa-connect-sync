-- supabase/verification/organizations_integration_settings_postflight.sql
--
-- Run right after applying 20261102_organizations_integration_settings_privileges.sql
-- (role postgres, Supabase SQL Editor). Read-only: the behavioural checks
-- run inside a transaction that is rolled back, use `where false` so no row
-- is touched, and print no data.

-- 1. The hidden columns are unreachable for browser roles (all false).
select r.role, c.col,
       has_column_privilege(r.role, 'public.organizations', c.col, 'SELECT') as can_select,
       has_column_privilege(r.role, 'public.organizations', c.col, 'INSERT') as can_insert,
       has_column_privilege(r.role, 'public.organizations', c.col, 'UPDATE') as can_update
  from (values ('anon'), ('authenticated')) r(role),
       (values ('integration_settings'), ('ein')) c(col);

-- 2. No table-level privilege remains for anon/authenticated (expect 0 rows).
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'organizations'
   and grantee in ('anon', 'authenticated');

-- 3. Every other column is still selectable by both roles (expect 0 rows).
select r.role, column_name from information_schema.columns, (values ('anon'), ('authenticated')) r(role)
 where table_schema = 'public' and table_name = 'organizations'
   and column_name not in ('integration_settings', 'ein')
   and not has_column_privilege(r.role, 'public.organizations', column_name, 'SELECT');

-- 4. Write privileges are exactly as intended (review the list).
select privilege_type, string_agg(column_name, ', ' order by column_name) as columns
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'organizations'
   and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE')
 group by privilege_type;

-- 5. Behaviour as the authenticated role (rolled back; every line must say OK).
begin;
set local role authenticated;
do $$
declare
  probes constant text[][] := array[
    -- statement,                                                                                     expect_denied
    array['select integration_settings from public.organizations where false',                         'yes'],
    array['select ein from public.organizations where false',                                          'yes'],
    array['select * from public.organizations where false',                                            'yes'],
    array['update public.organizations set integration_settings = integration_settings where false',   'yes'],
    array['update public.organizations set ai_center_settings = null where false',                     'yes'],
    array['update public.organizations set created_by = null where false',                             'yes'],
    array['delete from public.organizations where false',                                              'yes'],
    array['insert into public.organizations (id, name, integration_settings) select gen_random_uuid(), ''x'', ''{}''::jsonb where false', 'yes'],
    array['select id, name, public_name, logo_url, timezone, created_by from public.organizations where false', 'no'],
    array['select name, public_name, phone, website, industry, address, business_address, logo_url, crm_goals, timezone from public.organizations where false', 'no'],
    array['update public.organizations set name = name, public_name = public_name, phone = phone, logo_url = logo_url, timezone = timezone, onboarding_complete = onboarding_complete, appointment_sms_reminder_enabled = appointment_sms_reminder_enabled where id is null', 'no'],
    array['insert into public.organizations (id, name, public_name, created_by, onboarding_complete) select gen_random_uuid(), ''x'', ''x'', null, false where false', 'no']
  ];
  p text[];
  denied boolean;
begin
  foreach p slice 1 in array probes loop
    begin
      execute p[1];
      denied := false;
    exception when insufficient_privilege then
      denied := true;
    end;
    raise notice '% | expected %, got % | %',
      case when denied = (p[2] = 'yes') then 'OK  ' else 'FAIL' end,
      case when p[2] = 'yes' then 'denied' else 'allowed' end,
      case when denied then 'denied' else 'allowed' end,
      left(p[1], 90);
  end loop;
end $$;
rollback;

-- 5b. The 2026-11-01 RPC containment still holds (anon/authenticated false,
--     service_role true). This migration does not touch functions; this only
--     confirms nothing re-granted them.
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('get_decrypted_integration_token', 'get_docusign_settings');

-- 6. Manual (cannot be done in SQL). Use only the internal test
--    organization — never a customer org.
--    6a. Connect smoke test as the OWNER and as a SALES member: dashboard,
--        sidebar logo, Settings → Organization save, Settings → Appointments
--        save, Settings → Integrations (Twilio status/save/disconnect, owner
--        only), estimate PDF header, onboarding of a NEW test account.
--    6b. Realtime (RELEASE GATE — the fix is not complete until this passes):
--        with Connect open as a sales member of the test org (DevTools →
--        Network → WS), change the test org's logo as its owner. The
--        organizations UPDATE frame must arrive (sidebar logo updates) and its
--        record must NOT contain integration_settings or ein. Then save the
--        test org's Twilio config as owner and confirm the resulting frame
--        has no integration_settings either. If either leaks, run
--        organizations_integration_settings_realtime_contingency.sql.
--    6c. From outside with the anon key + a sales member's access token:
--        GET /rest/v1/organizations?select=integration_settings  → 401/403 (42501)
--        GET /rest/v1/organizations?select=*                     → 401/403 (42501)
--        PATCH /rest/v1/organizations?id=eq.<test org> {"integration_settings":{}} → 401/403
--        GET /rest/v1/organizations?select=name,logo_url          → 200, own org only
--    6d. Portal: open a test portal link; branding, project data and
--        messaging still work. Field: open a test /welcome?token= link.
