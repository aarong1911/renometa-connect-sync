-- supabase/verification/handle_invited_user_preflight.sql
--
-- READ-ONLY preflight for 20261031_handle_invited_user_no_metadata_authority.sql. Run it IMMEDIATELY before
-- deploying that migration and keep the full output with the change record. It runs in a READ ONLY transaction
-- (any write would error) and ends in ROLLBACK. Output contains ids, never emails or names.
--
--   psql "<production url>" -v ON_ERROR_STOP=1 -f supabase/verification/handle_invited_user_preflight.sql
--   (or paste sections into the SQL editor; each section is a single read-only statement.)
--
-- Metadata values are client-controlled and may not be valid uuids, so they are compared as TEXT, never cast.

begin transaction read only;
set local statement_timeout = '60s';

-- ── 1. Function fingerprint, owner, attributes ───────────────────────────────
-- def_md5 goes into v_expected_def_md5 in the migration (and into the rollback). can_replace must be true.
select p.oid::regprocedure                     as function,
       p.proowner::regrole                     as owner,
       pg_has_role(current_user, p.proowner, 'MEMBER') as can_replace,
       p.prosecdef                             as security_definer,
       p.proconfig                             as settings,
       p.proacl                                as acl,
       md5(p.prosrc)                           as body_md5,
       md5(pg_get_functiondef(p.oid))          as def_md5,
       p.prosrc ~ 's1:no-metadata-authority'   as already_hardened
  from pg_proc p
 where p.oid = to_regprocedure('public.handle_invited_user()');

-- ── 2. ROLLBACK ARTIFACT — save this exact text (it is the rollback) ─────────
select pg_get_functiondef(to_regprocedure('public.handle_invited_user()')) as rollback_artifact;

-- ── 3. Triggers: everything on auth.users, and everything executing the function ─
select t.tgrelid::regclass as on_table, t.tgname, t.tgenabled, t.tgfoid::regprocedure as function, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
 where not t.tgisinternal
   and (t.tgrelid = 'auth.users'::regclass or t.tgfoid = to_regprocedure('public.handle_invited_user()'))
 order by 1, 2;

-- ── 4. Memberships vs invitations — AGGREGATED ──────────────────────────────
-- Categories (a membership can be legitimate without an invitation; only the review flags below point at misuse):
--   backed_by_invitation          an invitation exists for this email + org + role
--   role_differs_from_invitation  invitation for email + org exists, role differs (admins change roles: legit unless
--                                 it is an UPGRADE to owner/admin — see role_upgrade)
--   no_invitation_metadata_org    no invitation for email + org, and the user's metadata org_id names this org:
--                                 the shape the confirmation trigger produces — REVIEW
--   no_invitation_owner           no invitation, owner role, metadata does not name the org: typically the founder /
--                                 org creator or a manual record
--   no_invitation_other           no invitation, other role: legacy or manually created records
--   no_auth_user                  membership whose auth user no longer exists (orphan)
with m as (
  select m.member_id, m.org_id, m.role,
         u.id is not null                                as has_user,
         u.email,
         u.email_confirmed_at,
         nullif(to_jsonb(m)->>'created_at', '')::timestamptz as membership_created_at,
         u.raw_user_meta_data->>'org_id'                 as meta_org,
         u.raw_user_meta_data->>'invitation_id'          as meta_invitation_id,
         coalesce(u.raw_user_meta_data->>'roster_only', '') = 'true' as meta_roster_only
    from public.org_memberships m
    left join auth.users u on u.id = m.member_id
), c as (
  select m.*,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id and i.role = m.role) as inv_same_role,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id) as inv_any,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id
                    and i.role not in ('owner', 'admin')) and m.role in ('owner', 'admin')
           and not exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id and i.role = m.role) as role_upgrade,
         exists (select 1 from public.invitations i
                  where i.id::text = m.meta_invitation_id and i.organization_id = m.org_id
                    and lower(i.email) = lower(m.email)) as meta_invitation_valid
    from m
), review as (
select c.*,
       case
         when not has_user                then 'no_auth_user'
         when inv_same_role               then 'backed_by_invitation'
         when inv_any                     then 'role_differs_from_invitation'
         when meta_org = org_id::text     then 'no_invitation_metadata_org'
         when role = 'owner'              then 'no_invitation_owner'
         else                                  'no_invitation_other'
       end as category,
       extract(epoch from (membership_created_at - email_confirmed_at)) as secs_confirm_to_membership
  from c
)
select category, role, count(*) as memberships,
       count(*) filter (where role_upgrade)          as role_upgrade,
       count(*) filter (where meta_invitation_valid) as meta_invitation_valid
  from review
 group by 1, 2
 order by 1, 2;

-- ── 5. Drill-down — ONLY the rows that need a human look (ids only) ──────────
-- review_reason explains why. Strong evidence of trigger misuse = no_invitation_metadata_org (or role_upgrade)
-- AND no valid metadata invitation_id AND the membership appeared within ~60 s of email confirmation (when
-- org_memberships has created_at) AND the org already had an earlier owner. Treat as an incident only after review.
with m as (
  select m.member_id, m.org_id, m.role,
         u.id is not null                                as has_user,
         u.email,
         u.email_confirmed_at,
         nullif(to_jsonb(m)->>'created_at', '')::timestamptz as membership_created_at,
         u.raw_user_meta_data->>'org_id'                 as meta_org,
         u.raw_user_meta_data->>'invitation_id'          as meta_invitation_id,
         coalesce(u.raw_user_meta_data->>'roster_only', '') = 'true' as meta_roster_only
    from public.org_memberships m
    left join auth.users u on u.id = m.member_id
), c as (
  select m.*,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id and i.role = m.role) as inv_same_role,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id) as inv_any,
         exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id
                    and i.role not in ('owner', 'admin')) and m.role in ('owner', 'admin')
           and not exists (select 1 from public.invitations i
                  where lower(i.email) = lower(m.email) and i.organization_id = m.org_id and i.role = m.role) as role_upgrade,
         exists (select 1 from public.invitations i
                  where i.id::text = m.meta_invitation_id and i.organization_id = m.org_id
                    and lower(i.email) = lower(m.email)) as meta_invitation_valid
    from m
), review as (
select c.*,
       case
         when not has_user                then 'no_auth_user'
         when inv_same_role               then 'backed_by_invitation'
         when inv_any                     then 'role_differs_from_invitation'
         when meta_org = org_id::text     then 'no_invitation_metadata_org'
         when role = 'owner'              then 'no_invitation_owner'
         else                                  'no_invitation_other'
       end as category,
       extract(epoch from (membership_created_at - email_confirmed_at)) as secs_confirm_to_membership
  from c
)
select r.member_id, r.org_id, r.role, r.category, r.role_upgrade, r.meta_invitation_valid, r.meta_roster_only,
       r.email_confirmed_at, r.membership_created_at, round(r.secs_confirm_to_membership::numeric, 1) as secs_confirm_to_membership,
       exists (select 1 from review o
                where o.org_id = r.org_id and o.role = 'owner' and o.member_id <> r.member_id
                  and (o.membership_created_at is null or r.membership_created_at is null or o.membership_created_at < r.membership_created_at)) as org_had_other_owner,
       case
         when r.category = 'no_invitation_metadata_org' and not r.meta_invitation_valid then 'trigger-shaped, no invitation'
         when r.role_upgrade then 'role higher than every invitation for this email/org'
       end as review_reason
  from review r
 where (r.category = 'no_invitation_metadata_org' and not r.meta_invitation_valid) or r.role_upgrade
 order by r.membership_created_at nulls last
 limit 200;

-- ── 6. Accounts carrying org_id metadata without the matching membership ────
-- Unconfirmed ones (mostly roster-only workers) relied on the trigger as a backstop: after hardening, their first
-- Field magic-link sign-in grants nothing, so an administrator must add the membership first.
select u.email_confirmed_at is null                                    as unconfirmed,
       coalesce(u.raw_user_meta_data->>'roster_only', '') = 'true'     as roster_only,
       count(*)                                                        as accounts,
       count(*) filter (where m.member_id is null)                     as missing_membership,
       count(*) filter (where p.organization_id::text is distinct from u.raw_user_meta_data->>'org_id') as profile_org_differs
  from auth.users u
  left join public.org_memberships m on m.member_id = u.id and m.org_id::text = u.raw_user_meta_data->>'org_id'
  left join public.profiles p on p.id = u.id
 where u.raw_user_meta_data ? 'org_id'
 group by 1, 2
 order by 1 desc, 2 desc;

select u.id as user_id, u.raw_user_meta_data->>'org_id' as meta_org, u.raw_user_meta_data->>'role' as meta_role
  from auth.users u
 where u.email_confirmed_at is null and u.raw_user_meta_data ? 'org_id'
   and not exists (select 1 from public.org_memberships m where m.member_id = u.id and m.org_id::text = u.raw_user_meta_data->>'org_id')
 order by u.id
 limit 200;

-- ── 7. Database code and RLS that read user metadata ────────────────────────
-- Any hit needs review: user_metadata / raw_user_meta_data are client-controlled. (app_metadata is not.)
select 'function' as kind, n.nspname || '.' || p.proname as name, p.prosecdef as security_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and p.prokind in ('f', 'p')
   and p.prosrc ~* 'raw_user_meta_data|user_metadata'
union all
select 'policy', schemaname || '.' || tablename || ' / ' || policyname, null
  from pg_policies
 where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* 'raw_user_meta_data|user_metadata'
union all
select 'view', schemaname || '.' || viewname, null
  from pg_views
 where schemaname not in ('pg_catalog', 'information_schema')
   and definition ~* 'raw_user_meta_data|user_metadata'
 order by 1, 2;

rollback;
