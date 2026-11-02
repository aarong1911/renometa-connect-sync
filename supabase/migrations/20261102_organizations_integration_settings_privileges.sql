-- 20261102_organizations_integration_settings_privileges.sql
--
-- STATUS: UNAPPLIED. Do NOT apply until ALL of the following are true:
--   1. The Phase 1 code (integration-config-* endpoints; Connect no longer
--      selects organizations "*" or reads/writes integration_settings) is
--      deployed to production and verified.
--   2. supabase/verification/organizations_integration_settings_preflight.sql
--      has been run, every GATE in it passed, and the 1b output (the exact
--      rollback) is saved.
--   3. The Portal and Field app are confirmed not to read organizations
--      directly (verified 2026-10-31 from their deployed bundles and the
--      Portal source; re-check if either was redeployed since).
-- Apply as the `postgres` role in the Supabase SQL Editor, in one run.
--
-- Why: organizations.integration_settings holds per-org integration
-- credentials (a plaintext Twilio auth token today). Supabase's default
-- table-level grants (ALL to anon and authenticated) combined with an
-- org-member RLS policy let ANY member of an org (sales, field_worker, ...)
-- read and overwrite those credentials directly through the REST API with
-- the public anon key + their own login, and receive them in Realtime
-- UPDATE events, whatever the Connect UI does.
--
-- Why table-level REVOKE first: a column-level REVOKE has NO effect while a
-- table-level grant exists. The only way to withhold a column is to revoke
-- the table-level privilege and grant the allowed columns individually.
-- (Revoking a table-level privilege also revokes the matching column
-- privileges, so the result is exactly the grants below.)
--
-- Resulting privileges for the browser roles:
--   SELECT  anon + authenticated: every column EXCEPT integration_settings
--           and ein (organization tax id; no browser code reads it). anon
--           still sees zero rows under RLS; the column grant only keeps RLS
--           policies on other tables that look up organizations.id /
--           created_by working for anon.
--   INSERT  authenticated: exactly what onboarding sends
--           (src/lib/auth.ts createOrganization).
--   UPDATE  authenticated: exactly the 12 columns Connect writes
--           (organization.ts updateOrganization, settings.branding.tsx,
--           onboarding.tsx, auth.ts markOnboardingComplete,
--           settings.appointments.tsx). Never id, created_by,
--           integration_settings, ai_center_settings, ein, timestamps.
--   DELETE, TRUNCATE, REFERENCES, TRIGGER: none. No browser code deletes
--           an organization.
-- Unchanged: RLS policies, service_role (every Netlify function keeps
-- working), SECURITY DEFINER functions (they bypass column grants; the two
-- that returned credentials were contained separately on 2026-11-01 —
-- preflight section 10 checks that still holds), the data itself.
--
-- Not covered here: forged org membership (preflight section 12). Until
-- 20261031_membership_rls_containment.sql is applied, a self-signed-up user
-- can still make themselves a member — or owner — of any organization.
--
-- Consequences (by design):
--   - A browser `select("*")`, bare `select()` or `organizations(*)` embed
--     on organizations now fails with 42501. Connect has none after Phase 1
--     (enforced by tests/netlify-functions/integration-config-security.test.ts).
--   - A column ADDED to organizations later is not readable or writable by
--     browser roles until a migration grants it.
--   - Realtime postgres_changes payloads omit columns the subscriber cannot
--     SELECT (realtime.apply_rls checks has_column_privilege per column);
--     only id must stay selectable, and it does.

begin;

set local lock_timeout = '5s';

do $$
declare
  hidden constant text[] := array['integration_settings', 'ein'];
  insert_cols constant text[] := array[
    'id', 'name', 'public_name', 'phone', 'website', 'address', 'industry',
    'timezone', 'crm_goals', 'logo_url', 'onboarding_complete', 'created_by'
  ];
  update_cols constant text[] := array[
    'name', 'public_name', 'phone', 'website', 'industry', 'address', 'logo_url',
    'crm_goals', 'timezone', 'onboarding_complete',
    'appointment_sms_reminder_enabled', 'appointment_sms_reminder_minutes_before'
  ];
  all_cols text[];
  select_cols text[];
  missing text[];
  refs text;
begin
  select array_agg(column_name::text order by ordinal_position) into all_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'organizations';
  if all_cols is null then raise exception 'public.organizations not found'; end if;

  -- Schema drift: every column named above must exist.
  select array_agg(c) into missing from unnest(hidden || insert_cols || update_cols) c where c <> all (all_cols);
  if missing is not null then raise exception 'schema drift — expected organizations columns missing: %', missing; end if;

  -- A policy or view that still reads a hidden column would either break for
  -- browser roles or re-expose it. Resolve those first.
  select string_agg(distinct x, ', ') into refs from (
    select 'policy ' || pol.tablename || '.' || pol.policyname as x
      from pg_policies pol
     where pol.schemaname = 'public'
       and (coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '')) ~* '\y(integration_settings|ein)\y'
    union all
    select 'view ' || v.view_schema || '.' || v.view_name
      from information_schema.view_column_usage v
     where v.table_schema = 'public' and v.table_name = 'organizations' and v.column_name = any (hidden)
  ) s;
  if refs is not null then raise exception 'hidden organizations columns are still referenced by: %', refs; end if;

  select array_agg(c order by array_position(all_cols, c)) into select_cols from unnest(all_cols) c where c <> all (hidden);

  revoke all on table public.organizations from anon, authenticated;

  execute format('grant select (%s) on table public.organizations to anon, authenticated',
                 (select string_agg(quote_ident(c), ', ') from unnest(select_cols) c));
  execute format('grant insert (%s) on table public.organizations to authenticated',
                 (select string_agg(quote_ident(c), ', ') from unnest(insert_cols) c));
  execute format('grant update (%s) on table public.organizations to authenticated',
                 (select string_agg(quote_ident(c), ', ') from unnest(update_cols) c));

  raise notice 'organizations SELECT granted on % columns; hidden: %', array_length(select_cols, 1), hidden;
end $$;

commit;

-- Postflight: supabase/verification/organizations_integration_settings_postflight.sql
-- Rollback:   supabase/verification/organizations_integration_settings_rollback.sql
