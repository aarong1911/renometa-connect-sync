-- supabase/verification/change_order_pending_sends_local_schema.sql
--
-- LOCAL / THROWAWAY DATABASE ONLY. NEVER RUN AGAINST PRODUCTION.
--
-- Minimal stand-ins for the pre-existing tables that
-- 20260815_project_change_orders.sql references but does not create
-- (organizations, profiles, org_memberships, contacts, projects,
-- project_phases, tasks, project_files). Only the columns those migrations
-- and the change-order functions actually touch are created — this is NOT
-- the live schema, just enough for the real change-order SQL to run
-- unmodified on a fresh Supabase Postgres image
-- (public.ecr.aws/supabase/postgres), which already provides the anon /
-- authenticated / service_role roles, auth.uid() and pgcrypto.
--
-- Order: this file -> 20260815_project_change_orders.sql ->
-- 20261030_change_order_pending_sends.sql ->
-- change_order_pending_sends_verification.sql.

do $$
begin
  if exists (select 1 from pg_class where relname = 'organizations' and relnamespace = 'public'::regnamespace) then
    raise exception 'public.organizations already exists -- this script is only for an EMPTY throwaway database';
  end if;
end $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text,
  public_name text
);

create table public.profiles (
  id uuid primary key,
  organization_id uuid null references public.organizations(id),
  first_name text,
  last_name text
);

create table public.org_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'owner'
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  full_name text,
  email text
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid null references public.contacts(id),
  name text,
  start_date date,
  end_date date
);

create table public.project_phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid null references public.projects(id) on delete cascade
);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid null references public.organizations(id),
  project_id uuid null references public.projects(id) on delete cascade
);

-- Supabase-style grants on the stand-ins (RLS on the change-order tables is
-- what the migrations themselves configure).
grant usage on schema public to anon, authenticated, service_role;
grant select on public.organizations, public.profiles, public.org_memberships, public.contacts, public.projects to authenticated, service_role;
