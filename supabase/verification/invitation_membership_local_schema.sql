-- supabase/verification/invitation_membership_local_schema.sql
--
-- MINIMAL LOCAL RECONSTRUCTION for invitation_membership_pg_check.sh.
--
--   *** THROWAWAY DATABASE ONLY. NEVER RUN AGAINST PRODUCTION. ***
--   Aborts if the database already has an `auth` schema, so it can only run on an empty Postgres.
--
-- Only the columns the two migrations and the checks touch:
--   auth.users (id, email, email_confirmed_at, raw_user_meta_data), public.organizations, public.profiles,
--   public.org_memberships (with the live eight-role org_memberships_role_check and a (member_id, org_id) unique key),
--   public.invitations, and the Supabase roles anon / authenticated / service_role.
--
-- public.handle_invited_user() below is a STAND-IN written from the reviewed description of the production function
-- (2026-10-31): fires on email_confirmed_at NULL -> value with metadata org_id present; inserts org_memberships from
-- the metadata org_id/role ON CONFLICT DO NOTHING; updates profiles.organization_id and names; marks the org's pending
-- invitations for that email accepted; validates no invitation. It is NOT the production source text. The hardening
-- migration's fingerprint gate and rollback are exercised against THIS body; in production they use the live
-- definition captured by supabase/verification/handle_invited_user_preflight.sql.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    raise exception 'refusing to run: schema auth already exists (this script is for an empty throwaway database only)';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema auth;
create table auth.users (
  id                 uuid primary key,
  email              text unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create table public.organizations (id uuid primary key, name text);
create table public.profiles (
  id uuid primary key, email text, first_name text, last_name text, organization_id uuid, worker_type text
);
create table public.org_memberships (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null,
  org_id      uuid not null,
  role        text not null,
  worker_type text,
  name        text,
  created_at  timestamptz not null default clock_timestamp(),
  constraint org_memberships_member_org_key unique (member_id, org_id),
  constraint org_memberships_role_check
    check (role in ('owner', 'admin', 'project_manager', 'sales', 'estimator', 'accountant', 'field_worker', 'viewer'))
);
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  email           text not null,
  role            text,
  status          text not null default 'pending',
  token           uuid not null default gen_random_uuid(),
  expires_at      timestamptz,
  accepted_at     timestamptz,
  project_id      uuid
);

-- STAND-IN for the production function (see header).
create function public.handle_invited_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_role text;
begin
  if new.raw_user_meta_data->>'org_id' is not null
     and new.email_confirmed_at is not null
     and old.email_confirmed_at is null then
    v_org  := (new.raw_user_meta_data->>'org_id')::uuid;
    v_role := coalesce(new.raw_user_meta_data->>'role', 'viewer');
    insert into org_memberships (member_id, org_id, role) values (new.id, v_org, v_role) on conflict do nothing;
    update profiles
       set organization_id = v_org,
           first_name = coalesce(new.raw_user_meta_data->>'first_name', first_name),
           last_name  = coalesce(new.raw_user_meta_data->>'last_name', last_name)
     where id = new.id;
    update invitations set status = 'accepted', accepted_at = now()
     where lower(email) = lower(new.email) and organization_id = v_org and status = 'pending';
  end if;
  return new;
end
$$;

create trigger on_invited_user_confirmed
  after update on auth.users
  for each row execute function public.handle_invited_user();
