-- supabase/verification/organizations_integration_settings_realtime_contingency.sql
--
-- CONTINGENCY ONLY — run if preflight 7c shows Realtime does not filter
-- columns by privilege, or postflight 6b sees integration_settings / ein in
-- an organizations Realtime frame. Not part of the normal release.
--
-- Stops Realtime from broadcasting organizations row changes at all. Cost:
-- the sidebar logo and organization realtime refresh in Connect
-- (sidebar.tsx, realtime-bridge.tsx) stop updating live — they still load
-- correctly on navigation/reload. Nothing else subscribes to organizations
-- (Portal and Field have no organizations subscriptions).

-- 1. Confirm the publication and table first (expect one row).
select pubname, schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'organizations';

-- 2. Remove the table from the publication.
begin;
alter publication supabase_realtime drop table public.organizations;
commit;

-- 3. Verify (expect 0 rows), then repeat postflight 6b: no organizations
--    frame should arrive at all.
select pubname, tablename from pg_publication_tables
 where schemaname = 'public' and tablename = 'organizations';

-- Undo (only after a Realtime path that filters columns is confirmed):
-- alter publication supabase_realtime add table public.organizations;
