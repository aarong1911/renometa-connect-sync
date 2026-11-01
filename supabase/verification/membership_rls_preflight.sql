-- supabase/verification/membership_rls_preflight.sql
--
-- READ-ONLY. Run in the production SQL Editor (as postgres) immediately before
-- supabase/migrations/20261031_membership_rls_containment.sql, and keep the output. Runs inside a READ ONLY transaction that
-- is rolled back; it changes nothing. Drill-downs return ids and roles only — no names, emails, SSN/EIN or tokens.
--
--   1. the live policies on the four tables (compare with the migration's audited list; re-run after applying)
--   2. RLS / FORCE RLS flags (the migration stops if RLS is off, or FORCE RLS is on for organizations/org_memberships)
--   3. name collisions with the objects the migration creates
--   4. signs the open policies were already used (each count should be explained before or right after containment)
--   5. rows the new rules would make read-only for their own user (compatibility)
--   6. get_user_id_by_email privileges

begin;
set transaction read only;

-- ── 1. live policies ────────────────────────────────────────────────────────
select '1_policy' as section, tablename, policyname, permissive, roles::text, cmd, qual, with_check
  from pg_policies where schemaname = 'public' and tablename in ('organizations', 'profiles', 'org_memberships', 'invitations')
 order by tablename, policyname;

-- ── 2. RLS flags ────────────────────────────────────────────────────────────
select '2_rls' as section, c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c where c.relnamespace = 'public'::regnamespace
   and c.relname in ('organizations', 'profiles', 'org_memberships', 'invitations') order by 2;

-- ── 3. collisions (expect 0 rows on the first apply) ────────────────────────
select '3_existing_containment_object' as section, kind, name from (
  select 'policy' as kind, tablename || '.' || policyname as name from pg_policies
   where schemaname = 'public' and policyname like 'rls_containment_%'
  union all
  select 'function', proname from pg_proc
   where pronamespace = 'public'::regnamespace and proname in ('rls_my_org_role', 'rls_org_unclaimed_by_me', 'rls_shares_org_with')
) x order by 2, 3;

-- ── 4. signs of prior use of the open policies ──────────────────────────────
-- 4a profile points at an organization the user has no membership in (self-repointed organization_id, or legacy data)
select '4a_profile_org_without_membership' as section, p.id as user_id, p.organization_id, p.role as profile_role
  from public.profiles p
 where p.organization_id is not null
   and not exists (select 1 from public.org_memberships m where m.member_id = p.id and m.org_id = p.organization_id)
 order by 3, 2;

-- 4b owner memberships that neither created the organization nor accepted an owner invitation for it
select '4b_owner_not_creator_nor_invited' as section, m.org_id, m.member_id, o.created_by
  from public.org_memberships m
  join public.organizations o on o.id = m.org_id
  left join public.profiles p on p.id = m.member_id
 where m.role = 'owner'
   and m.member_id is distinct from o.created_by
   and not exists (select 1 from public.invitations i
                    where i.organization_id = m.org_id and i.role = 'owner' and i.status = 'accepted'
                      and lower(i.email) = lower(p.email))
 order by 2, 3;

-- 4c organizations with more than one owner
select '4c_multiple_owners' as section, org_id, count(*) as owners
  from public.org_memberships where role = 'owner' group by org_id having count(*) > 1 order by 1;

-- 4d profiles claiming owner/admin without the matching membership role in that organization
select '4d_profile_role_mismatch' as section, p.id as user_id, p.organization_id, p.role as profile_role, m.role as membership_role
  from public.profiles p
  left join public.org_memberships m on m.member_id = p.id and m.org_id = p.organization_id
 where p.role in ('owner', 'admin') and p.role is distinct from m.role
 order by 3, 2;

-- 4e invitations with an owner role or a role outside the nine supported roles
select '4e_invitation_role' as section, i.id, i.organization_id, i.role, i.status, (i.project_id is not null) as portal
  from public.invitations i
 where i.role is null or i.role = 'owner'
    or i.role not in ('admin', 'office_manager', 'estimator', 'sales', 'project_manager', 'field_worker', 'accountant', 'viewer')
 order by 3, 2;

-- 4f invitation tokens that were readable anonymously and are still usable (consider re-issuing them after containment)
select '4f_live_tokens_exposed' as section, count(*) filter (where project_id is null) as team_invites,
       count(*) filter (where project_id is not null) as portal_invites
  from public.invitations where status = 'pending' and expires_at > now();

-- ── 5. compatibility: users whose own profile writes the new rules would refuse until their data is corrected ──
-- (the 4a rows — organization without membership — and the 4d rows — owner/admin profile role without that membership
--  role — can still read their profile, but can't update it from the browser until fixed server-side)
select '5_summary' as section,
       (select count(*) from public.profiles p where p.organization_id is not null
          and not exists (select 1 from public.org_memberships m where m.member_id = p.id and m.org_id = p.organization_id)) as profile_org_without_membership,
       (select count(*) from public.profiles p left join public.org_memberships m on m.member_id = p.id and m.org_id = p.organization_id
          where p.role in ('owner', 'admin') and p.role is distinct from m.role) as profile_role_mismatch,
       (select count(*) from (select member_id from public.org_memberships group by member_id having count(*) > 1) x) as multi_org_users,
       (select count(*) from public.organizations o where not exists (select 1 from public.org_memberships m where m.org_id = o.id)) as orgs_without_members,
       (select count(*) from public.organizations o where not exists (select 1 from public.org_memberships m where m.org_id = o.id)
          and o.created_by is not null) as unclaimed_orgs_with_creator;

-- ── 6. get_user_id_by_email privileges (anon/authenticated should be true now, false after) ──
select '6_get_user_id_by_email' as section, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_exec
  from pg_proc p where p.oid = to_regprocedure('public.get_user_id_by_email(text)');

rollback;
