-- supabase/verification/organizations_integration_settings_rollback.sql
--
-- Rollback for 20261102_organizations_integration_settings_privileges.sql.
-- Restores the table-wide browser-role grants that existed before it
-- (which RE-OPENS the integration_settings exposure — use only if the
-- migration broke something that cannot be fixed forward).
--
-- Preferred: replay the statements saved from preflight section 1b
-- instead of the default below, if they differ.

begin;

-- Also removes every column-level grant the migration added.
revoke all on table public.organizations from anon, authenticated;

-- Supabase default (what preflight section 1 is expected to have shown):
grant all on table public.organizations to anon, authenticated;

commit;

-- Verify (expect both roles to list DELETE, INSERT, REFERENCES, SELECT,
-- TRIGGER, TRUNCATE, UPDATE — or exactly what preflight 1 recorded):
-- select grantee, string_agg(privilege_type, ', ' order by privilege_type)
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'organizations' and grantee in ('anon', 'authenticated')
--  group by grantee;
