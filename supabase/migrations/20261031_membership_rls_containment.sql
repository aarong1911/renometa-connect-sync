-- Emergency RLS containment for organization membership, profiles and invitations.
--
-- STATUS: APPLIED to production manually (SQL Editor, as `postgres`) on 2026-11-01, after the read-only preflight
-- (supabase/verification/membership_rls_preflight.sql). Production verification confirmed 14/14 rls_containment_* policies
-- installed and RESTRICTIVE, and get_user_id_by_email EXECUTE anon=false, authenticated=false, service_role=true.
-- This file is now historical: do not edit its SQL and do not apply it again by hand; any further change goes in a new
-- migration. (Re-running it is harmless — see "Idempotent" below — but it must not be part of any automated replay.)
--
-- AUDITED LIVE SCHEMA: production schema dump of 2026-10-30 (connect-prod-20261030T154610Z-pre-pr31/schema.sql), confirmed by
-- the 2026-10-31 production investigation. Relevant live policies (all PERMISSIVE):
--   org_memberships  INSERT "Users can create their own membership"      WITH CHECK (member_id = auth.uid())
--                    INSERT/UPDATE/DELETE "... memberships in own org"     org_id IN (caller's profiles.organization_id)
--                    INSERT/UPDATE/DELETE "Owners/Admins ... memberships"  caller's profiles.role in (owner, admin)
--   profiles         SELECT "Authenticated users can view all profiles"   USING (true)            -- every SSN/EIN
--                    UPDATE "Users can update own profile", ALL "Users can upsert their own profile"  (id = auth.uid())
--                    -> organization_id and role are self-editable
--   invitations      SELECT "Anyone can look up invitation by token"       USING (true), TO PUBLIC  -- anon reads every token/SSN
--                    INSERT "Users can create invitations for their org"   (caller's profiles.organization_id)
--                    (no UPDATE / DELETE policy)
-- Resulting escalations, each with only a self sign-up:
--   1. insert org_memberships(org_id = <any org>, member_id = self, role = 'owner')          -> owner of any organization;
--   2. set own profiles.organization_id = <any org>, then every profiles.organization_id-based policy in the database grants
--      that org (its memberships, invitations, organization row, and the many other tables keyed that way); set own
--      profiles.role = 'owner' to pass the "Owners/Admins" policies and the server-side profiles.role fallback;
--   3. anonymous SELECT of every invitation (tokens -> accept any pending invitation; SSN/EIN);
--   4. any signed-in user reads every profile (SSN/EIN);
--   5. anonymous get_user_id_by_email() maps any email to an auth user id.
--
-- WHAT THIS DOES (narrowing only):
--   - Adds RESTRICTIVE policies, which are AND-ed with the existing permissive ones. They cannot grant anything, no existing
--     policy is dropped or edited, and roles with BYPASSRLS (service_role: every Netlify function, including accept-invite,
--     invite-member, update-user-by-id, remove-member) are not affected at all.
--   - Adds three SECURITY DEFINER helpers (pinned empty search_path, EXECUTE for authenticated only) so the policies can look
--     at org_memberships/organizations without recursing into their own RLS. They only answer questions about the CALLER.
--   - Revokes EXECUTE on public.get_user_id_by_email(text) from PUBLIC/anon/authenticated (service_role keeps it) and pins its
--     search_path.
--
-- RULES AFTER THIS (for anon/authenticated; service_role unchanged):
--   org_memberships  SELECT  own rows, or rows of an org the caller belongs to
--                    INSERT  only the caller's own 'owner' row in an org the caller created that has NO members yet
--                            (= src/lib/auth.ts createOrganization during sign-up/onboarding)
--                    UPDATE/DELETE  never (Connect does these only through Netlify functions)
--   profiles         SELECT  own row, or users sharing an organization with the caller
--                    INSERT/UPDATE  organization_id must be null, an org the caller belongs to, or an org the caller created
--                            that has no members yet; role 'owner'/'admin' only if it equals the caller's membership role in
--                            that org (or 'owner' for that unclaimed own org)
--   invitations      anon: nothing. authenticated: SELECT/INSERT/UPDATE/DELETE only as an owner of the invitation's org, and
--                    never an invitation with role 'owner' (team management is owner-only in the app)
--
-- NOT CHANGED: tables, columns, rows, existing policies, grants on tables, organizations policies (their cross-tenant reach
-- came only from the self-editable profiles.organization_id, closed here), the 3738b1f migrations (role check constraint,
-- hardened handle_invited_user) — independent of this one.
-- Idempotent: functions are CREATE OR REPLACE, policies DROP IF EXISTS + CREATE. Re-running gives the same state.
-- Correction (comment only, kept outside the SQL): the precondition's inline note says FORCE RLS would make the helpers
-- "recurse". Tested behavior is different: with FORCE RLS on organizations/org_memberships the owner-run helpers see no rows,
-- so legitimate users are denied (fail closed). The precondition is still correct; only that note's wording is wrong.

begin;

do $pre$
declare
  t text;
  v_rls boolean;
  v_force boolean;
begin
  foreach t in array array['organizations', 'profiles', 'org_memberships', 'invitations'] loop
    select c.relrowsecurity, c.relforcerowsecurity into v_rls, v_force
      from pg_class c where c.oid = to_regclass('public.' || t);
    if v_rls is null then raise exception 'precondition failed: table public.% not found', t; end if;
    -- restrictive policies do nothing while RLS is off; enabling RLS is a different, riskier change
    if not v_rls then raise exception 'precondition failed: RLS is not enabled on public.%', t; end if;
    -- the SECURITY DEFINER helpers read these tables as their owner; FORCE RLS would make them recurse
    if v_force and t in ('organizations', 'org_memberships') then
      raise exception 'precondition failed: FORCE ROW LEVEL SECURITY is set on public.%', t;
    end if;
  end loop;

  if (select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name, data_type) in (
        ('org_memberships', 'org_id', 'uuid'), ('org_memberships', 'member_id', 'uuid'), ('org_memberships', 'role', 'text'),
        ('profiles', 'id', 'uuid'), ('profiles', 'organization_id', 'uuid'), ('profiles', 'role', 'text'),
        ('invitations', 'organization_id', 'uuid'), ('invitations', 'role', 'text'),
        ('organizations', 'id', 'uuid'), ('organizations', 'created_by', 'uuid'))) <> 10 then
    raise exception 'precondition failed: membership/profile/invitation/organization columns differ from the audited schema';
  end if;
  if to_regprocedure('auth.uid()') is null then raise exception 'precondition failed: auth.uid() not found'; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'precondition failed: expected Supabase roles anon, authenticated and service_role (BYPASSRLS)';
  end if;
  if to_regprocedure('public.get_user_id_by_email(text)') is null then
    raise exception 'precondition failed: public.get_user_id_by_email(text) not found';
  end if;
end
$pre$;

-- ── Helpers: questions about the CALLER only ─────────────────────────────────

-- The caller's role in p_org, or null if the caller is not a member.
create or replace function public.rls_my_org_role(p_org uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.role from public.org_memberships m where m.member_id = auth.uid() and m.org_id = p_org
$$;

-- True only while p_org was created by the caller and has no members at all: the moment during sign-up between creating the
-- organization and inserting its first (owner) membership.
create or replace function public.rls_org_unclaimed_by_me(p_org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.organizations o where o.id = p_org and o.created_by = auth.uid())
     and not exists (select 1 from public.org_memberships m where m.org_id = p_org)
$$;

-- True when the caller and p_user are members of at least one common organization.
create or replace function public.rls_shares_org_with(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_memberships mine
      join public.org_memberships theirs on theirs.org_id = mine.org_id
     where mine.member_id = auth.uid() and theirs.member_id = p_user)
$$;

revoke all on function public.rls_my_org_role(uuid), public.rls_org_unclaimed_by_me(uuid), public.rls_shares_org_with(uuid)
  from public, anon;
grant execute on function public.rls_my_org_role(uuid), public.rls_org_unclaimed_by_me(uuid), public.rls_shares_org_with(uuid)
  to authenticated, service_role;

-- ── org_memberships ─────────────────────────────────────────────────────────

drop policy if exists rls_containment_memberships_select on public.org_memberships;
create policy rls_containment_memberships_select on public.org_memberships as restrictive for select to authenticated
  using (member_id = auth.uid() or public.rls_my_org_role(org_id) is not null);

drop policy if exists rls_containment_memberships_insert on public.org_memberships;
create policy rls_containment_memberships_insert on public.org_memberships as restrictive for insert to authenticated
  with check (member_id = auth.uid() and role = 'owner' and public.rls_org_unclaimed_by_me(org_id));

drop policy if exists rls_containment_memberships_update on public.org_memberships;
create policy rls_containment_memberships_update on public.org_memberships as restrictive for update to authenticated
  using (false) with check (false);

drop policy if exists rls_containment_memberships_delete on public.org_memberships;
create policy rls_containment_memberships_delete on public.org_memberships as restrictive for delete to authenticated
  using (false);

drop policy if exists rls_containment_memberships_anon on public.org_memberships;
create policy rls_containment_memberships_anon on public.org_memberships as restrictive for all to anon
  using (false) with check (false);

-- ── profiles ────────────────────────────────────────────────────────────────

drop policy if exists rls_containment_profiles_select on public.profiles;
create policy rls_containment_profiles_select on public.profiles as restrictive for select to authenticated
  using (id = auth.uid() or public.rls_shares_org_with(id));

drop policy if exists rls_containment_profiles_insert on public.profiles;
create policy rls_containment_profiles_insert on public.profiles as restrictive for insert to authenticated
  with check (
    (organization_id is null or public.rls_my_org_role(organization_id) is not null or public.rls_org_unclaimed_by_me(organization_id))
    and (role is null or role not in ('owner', 'admin') or role = public.rls_my_org_role(organization_id)
         or (role = 'owner' and public.rls_org_unclaimed_by_me(organization_id))));

drop policy if exists rls_containment_profiles_update on public.profiles;
create policy rls_containment_profiles_update on public.profiles as restrictive for update to authenticated
  using (true)
  with check (
    (organization_id is null or public.rls_my_org_role(organization_id) is not null or public.rls_org_unclaimed_by_me(organization_id))
    and (role is null or role not in ('owner', 'admin') or role = public.rls_my_org_role(organization_id)
         or (role = 'owner' and public.rls_org_unclaimed_by_me(organization_id))));

drop policy if exists rls_containment_profiles_anon on public.profiles;
create policy rls_containment_profiles_anon on public.profiles as restrictive for all to anon
  using (false) with check (false);

-- ── invitations ─────────────────────────────────────────────────────────────

drop policy if exists rls_containment_invitations_anon on public.invitations;
create policy rls_containment_invitations_anon on public.invitations as restrictive for all to anon
  using (false) with check (false);

drop policy if exists rls_containment_invitations_select on public.invitations;
create policy rls_containment_invitations_select on public.invitations as restrictive for select to authenticated
  using (public.rls_my_org_role(organization_id) = 'owner');

drop policy if exists rls_containment_invitations_insert on public.invitations;
create policy rls_containment_invitations_insert on public.invitations as restrictive for insert to authenticated
  with check (role is distinct from 'owner' and public.rls_my_org_role(organization_id) = 'owner');

drop policy if exists rls_containment_invitations_update on public.invitations;
create policy rls_containment_invitations_update on public.invitations as restrictive for update to authenticated
  using (public.rls_my_org_role(organization_id) = 'owner')
  with check (role is distinct from 'owner' and public.rls_my_org_role(organization_id) = 'owner');

drop policy if exists rls_containment_invitations_delete on public.invitations;
create policy rls_containment_invitations_delete on public.invitations as restrictive for delete to authenticated
  using (public.rls_my_org_role(organization_id) = 'owner');

-- ── get_user_id_by_email: service_role only ─────────────────────────────────

revoke all on function public.get_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.get_user_id_by_email(text) to service_role;
alter function public.get_user_id_by_email(text) set search_path = '';

commit;

-- ── Verification (run after applying; read-only) ───────────────────────────
-- 1. 14 restrictive containment policies, none permissive:
--   select tablename, policyname, permissive, roles, cmd from pg_policies
--    where schemaname = 'public' and policyname like 'rls_containment_%' order by 1, 2;
-- 2. Helpers are SECURITY DEFINER with search_path pinned, executable by authenticated and not anon:
--   select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
--     from pg_proc p where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('rls_my_org_role', 'rls_org_unclaimed_by_me', 'rls_shares_org_with', 'get_user_id_by_email');
--   -> rls_*: prosecdef t, anon_exec f, auth_exec t;  get_user_id_by_email: anon_exec f, auth_exec f
-- 3. Existing policies unchanged (compare with the preflight's section 1 output):
--   select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies
--    where schemaname = 'public' and tablename in ('organizations', 'profiles', 'org_memberships', 'invitations')
--      and policyname not like 'rls_containment_%' order by 1, 2;
-- 4. Smoke test in the app (as an owner): sign in, open Team, edit a member, invite, add a roster member, remove a member;
--    as a non-owner: Dashboard and assignee pickers still list team members. A NEW sign-up completes onboarding.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restores the previous (vulnerable) access exactly: drops only what this migration created and re-grants
-- get_user_id_by_email as before (originally EXECUTE for PUBLIC — never revoked — plus explicit anon, authenticated,
-- service_role; no search_path).
-- ROLLBACK-SQL-BEGIN
-- begin;
-- drop policy if exists rls_containment_memberships_select on public.org_memberships;
-- drop policy if exists rls_containment_memberships_insert on public.org_memberships;
-- drop policy if exists rls_containment_memberships_update on public.org_memberships;
-- drop policy if exists rls_containment_memberships_delete on public.org_memberships;
-- drop policy if exists rls_containment_memberships_anon on public.org_memberships;
-- drop policy if exists rls_containment_profiles_select on public.profiles;
-- drop policy if exists rls_containment_profiles_insert on public.profiles;
-- drop policy if exists rls_containment_profiles_update on public.profiles;
-- drop policy if exists rls_containment_profiles_anon on public.profiles;
-- drop policy if exists rls_containment_invitations_anon on public.invitations;
-- drop policy if exists rls_containment_invitations_select on public.invitations;
-- drop policy if exists rls_containment_invitations_insert on public.invitations;
-- drop policy if exists rls_containment_invitations_update on public.invitations;
-- drop policy if exists rls_containment_invitations_delete on public.invitations;
-- drop function if exists public.rls_my_org_role(uuid);
-- drop function if exists public.rls_org_unclaimed_by_me(uuid);
-- drop function if exists public.rls_shares_org_with(uuid);
-- alter function public.get_user_id_by_email(text) reset search_path;
-- grant execute on function public.get_user_id_by_email(text) to public, anon, authenticated, service_role;
-- commit;
-- ROLLBACK-SQL-END
