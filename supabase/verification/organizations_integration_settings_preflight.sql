-- supabase/verification/organizations_integration_settings_preflight.sql
--
-- READ-ONLY preflight for 20261102_organizations_integration_settings_privileges.sql.
-- Run every query in the Supabase SQL Editor (role postgres) and SAVE the
-- output before applying the migration. Nothing here writes, and no query
-- returns a credential value (section 9 reports counts and key names only).
--
-- Sections marked GATE must come back as described, or stop and review.

-- 1. Table-level privileges anon/authenticated hold today. Expected (Supabase
--    default): both roles hold SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--    REFERENCES, TRIGGER. A table-level grant is why a column-level REVOKE
--    alone does nothing, and why the migration revokes at table level.
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'organizations'
   and grantee in ('anon', 'authenticated')
 group by grantee order by grantee;

-- 1b. SAVE THIS OUTPUT — it is the exact rollback for the table grants.
select format('grant %s on table public.organizations to %I;', string_agg(privilege_type, ', ' order by privilege_type), grantee) as rollback_statement
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'organizations'
   and grantee in ('anon', 'authenticated')
 group by grantee order by grantee;

-- 2. Column-level grants that already exist (expect none).
select grantee, column_name, privilege_type
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'organizations'
   and grantee in ('anon', 'authenticated')
   and not exists (select 1 from information_schema.role_table_grants g
                    where g.table_schema = 'public' and g.table_name = 'organizations'
                      and g.grantee = column_privileges.grantee and g.privilege_type = column_privileges.privilege_type)
 order by grantee, column_name, privilege_type;

-- 3. RLS state + every policy on organizations. Record who can SELECT /
--    INSERT / UPDATE which rows. GATE: no policy expression mentions
--    integration_settings or ein (the migration also refuses to run if one does).
select relrowsecurity, relforcerowsecurity, relreplident as replica_identity  -- d = primary key, f = FULL (old row also sent to Realtime)
  from pg_class where oid = 'public.organizations'::regclass;
select policyname, cmd, roles, permissive, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'organizations'
 order by cmd, policyname;

-- 3b. Policies on OTHER tables that read organizations. Policy expressions run
--     with the querying role's column privileges, so every organizations
--     column they mention must stay granted. Expected mentions: id,
--     created_by (both stay granted). GATE: refs_hidden_columns = false.
select schemaname, tablename, policyname, cmd, roles,
       (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* '\y(integration_settings|ein)\y' as refs_hidden_columns
  from pg_policies
 where (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* '\yorganizations\y'
   and tablename <> 'organizations'
 order by 1, 2, 3;

-- 4. Live column list. The migration grants SELECT on every column except
--    integration_settings and ein, INSERT/UPDATE on fixed lists, and refuses
--    to run if a listed column is missing. Compare with the lists in the
--    migration header.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'organizations'
 order by ordinal_position;

-- 5. Views over organizations. GATE: no view exposes integration_settings
--    or ein (a view owned by postgres bypasses the column grants).
select v.view_schema, v.view_name, v.column_name
  from information_schema.view_column_usage v
 where v.table_schema = 'public' and v.table_name = 'organizations'
 order by 1, 2, 3;
select c.relname as view_name, c.relowner::regrole as owner,
       coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), 'false') as security_invoker
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join pg_class c on c.oid = r.ev_class
 where d.refobjid = 'public.organizations'::regclass and c.relkind in ('v', 'm') and c.oid <> d.refobjid
 group by c.relname, c.relowner, c.reloptions;

-- 6. Invoker-rights functions that read organizations. SECURITY DEFINER
--    functions run as their owner and are unaffected by the grant change.
--    GATE: no row with security_definer = false AND (mentions_hidden OR
--    selects_star) AND authenticated_can_execute = true.
select p.oid::regprocedure as function, p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       p.prosrc ~* '\y(integration_settings|ein)\y' as mentions_hidden,
       p.prosrc ~* 'select\s+\*\s+(into\s+\w+\s+)?from\s+(public\.)?organizations' as selects_star
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosrc ~* '\yorganizations\y'
 order by p.prosecdef, 1::text;

-- 7. Realtime. Connect subscribes to organizations UPDATE events
--    (sidebar.tsx, realtime-bridge.tsx). Until the privileges migration is
--    applied, every UPDATE to the row — including an integration-config-save
--    — can broadcast the full new row (integration_settings included) to
--    every subscribed member. After it, Realtime omits columns the subscriber
--    cannot SELECT. attnames non-null = a publication column list is in use.
select pubname, schemaname, tablename, attnames, rowfilter
  from pg_publication_tables
 where schemaname = 'public' and tablename = 'organizations';

-- 7b. Triggers on organizations. GATE: no trigger function both emits events
--     (realtime.send / broadcast_changes / pg_notify) and reads the whole row
--     or integration_settings — that would bypass the column grants.
select t.tgname, t.tgenabled, p.oid::regprocedure as trigger_function, p.prosecdef as security_definer,
       p.prosrc ~* 'realtime\.|pg_notify|broadcast' as emits_events,
       p.prosrc ~* '\yintegration_settings\y|to_jsonb\(\s*new\s*\)|row_to_json\(\s*new\s*\)' as reads_secret_or_whole_row
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'public.organizations'::regclass and not t.tgisinternal
 order by 1;

-- 7c. Does this project's Realtime filter columns by privilege? Supabase
--     Realtime's database side (realtime.apply_rls) is expected to drop every
--     column the subscriber's role cannot SELECT. GATE: filters_by_column_privilege
--     = true. If false or the function is missing, the column grants do NOT
--     protect Realtime payloads — use the contingency in
--     organizations_integration_settings_realtime_contingency.sql instead of
--     claiming Realtime is fixed. The runtime check after applying (postflight
--     6b) is still required either way.
select p.oid::regprocedure as function,
       p.prosrc ~* 'has_column_privilege' as filters_by_column_privilege
  from pg_proc p
 where p.pronamespace = 'realtime'::regnamespace and p.proname = 'apply_rls';

-- 8. Default privileges (informational; explains future grants).
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
  from pg_default_acl
 where defaclnamespace = 'public'::regnamespace;

-- 9. Credential inventory — counts and key names only, never values.
select key as provider, count(*) as orgs
  from public.organizations, jsonb_each(integration_settings)
 group by key order by key;
select count(*) filter (where integration_settings->'twilio' ? 'authToken')   as twilio_auth_tokens,
       count(*) filter (where integration_settings->'gmail'  ? 'appPassword') as legacy_gmail_app_passwords,
       count(*) filter (where integration_settings->'stripe' ? 'secretKey')   as stripe_secret_keys,
       count(*) filter (where integration_settings->'jotform' ? 'apiKey')     as jotform_api_keys
  from public.organizations;

-- ── Alternate paths: SECURITY DEFINER functions ─────────────────────────────
-- A SECURITY DEFINER function runs as its owner, so the column grants in the
-- migration do not limit what it can read or return.

-- 10. The 2026-11-01 containment must still hold. GATE: anon = false and
--     authenticated = false for get_decrypted_integration_token(uuid,text)
--     and get_docusign_settings(uuid); service_role = true. Do NOT re-run
--     any containment — this only checks it. upsert_docusign_settings was
--     not part of that containment: if it exists and anon or authenticated
--     can execute it, review its body (it takes p_org_id and writes a
--     secret) before release.
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('get_decrypted_integration_token', 'get_docusign_settings', 'upsert_docusign_settings')
 order by 1::text;

-- 10b. Every OTHER function a browser role can EXECUTE that looks credential-
--      bearing. GATE: no row with (reads_integration_settings OR
--      touches_secrets) AND takes_org_arg, unless its body (read it with
--      pg_get_functiondef) checks auth.uid()'s membership of that org.
--      Expected allowed rows: get_portal_data (Portal, see 11).
select p.oid::regprocedure as function, p.prosecdef as security_definer, p.proowner::regrole as owner, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       pg_get_function_identity_arguments(p.oid) ~* 'org' as takes_org_arg,
       p.prosrc ~* '\yintegration_settings\y' as reads_integration_settings,
       p.prosrc ~* 'decrypt|pgp_sym|vault\.|secret|access_token|refresh_token|password|organization_integration_secrets' as touches_secrets,
       p.prosrc ~* 'auth\.uid\(\)|is_org_member|org_memberships' as mentions_membership_check
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
   and p.proname not in ('get_decrypted_integration_token', 'get_docusign_settings')
   and p.prosrc ~* 'integration|decrypt|secret|token|docusign|password'
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
 order by reads_integration_settings desc, touches_secrets desc, 1::text;

-- 11. Portal RPC. The Portal (portal.renometa.com, repo project-haven) calls
--     only get_portal_data, with the anon key, and reads organization.name /
--     logo_url / office_phone. It is SECURITY DEFINER, so the grant change does
--     not affect it — but it is its own exposure path. GATE: no overload
--     mentions integration_settings or converts the whole org row
--     (to_jsonb(v_org), row_to_json(v_org), v_org.*). For a key-level check
--     against a TEST invite, use the rolled-back read-only script prepared on
--     the feat/phones-s1-security worktree
--     (supabase/verification/get_portal_data_readonly_verify.sql).
select p.oid::regprocedure as function, p.prosecdef as security_definer, p.proconfig as config,
       p.prosrc ~* '\yintegration_settings\y' as mentions_integration_settings,
       p.prosrc ~* 'to_jsonb\(\s*v_org\s*\)|row_to_json\(\s*v_org\s*\)|v_org\.\*|to_jsonb\(\s*o\s*\)|row_to_json\(\s*o\s*\)' as returns_whole_org_row
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.proname in ('get_portal_data', 'lookup_invitation_welcome')
 order by 1::text;

-- 12. Membership integrity. Owner-only integration management
--     (resolveIntegrationManager) trusts org_memberships.role, with a
--     profiles.role fallback. The production schema dump of 2026-10-30
--     showed a permissive org_memberships INSERT policy (member_id =
--     auth.uid() only) and self-editable profiles.organization_id / role,
--     i.e. any signed-up user could make themselves OWNER of any
--     organization. The fix, 20261031_membership_rls_containment.sql
--     (branch fix/emergency-membership-authorization), was UNAPPLIED.
--     GATE: all 4 restrictive policies below exist. If not, owner-only
--     endpoints can be reached by a forged owner — apply that containment
--     first (separate review).
select tablename, policyname, permissive, cmd
  from pg_policies
 where schemaname = 'public'
   and policyname in ('rls_containment_memberships_insert', 'rls_containment_memberships_update',
                      'rls_containment_profiles_insert', 'rls_containment_profiles_update')
 order by 1, 2;
select policyname, cmd, permissive, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'org_memberships' and cmd in ('INSERT', 'ALL')
 order by permissive, policyname;
