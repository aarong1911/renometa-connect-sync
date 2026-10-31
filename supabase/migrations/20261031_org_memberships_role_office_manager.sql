-- Allows the office_manager role on org_memberships.
--
-- STATUS: APPLIED to production manually on 2026-10-31 (SQL Editor, as `postgres`). Production verification
-- confirmed org_memberships_role_check allows the nine roles below. This file is now historical: do not edit
-- it; any further change to the role list goes in a new migration.
--
-- WHY: the app supports nine member roles (src/lib/organization.ts Role /
-- ALL_ROLES, src/lib/permissions.ts, src/lib/permission-features.ts,
-- netlify/functions/estimate-suggest-pricing.ts, and the Team invite picker),
-- but the live org_memberships_role_check only allows eight of them: it
-- rejects office_manager. An office_manager invitation therefore created an
-- auth user and a profile but no membership (accept-invite.ts ignored the
-- failed insert), and that member had no role in Connect. Changing an
-- existing member to office_manager (update-user-by-id.ts) failed the same way.
--
-- Live constraint confirmed on 2026-10-31 from production findings:
--   org_memberships_role_check allows exactly
--   owner, admin, project_manager, sales, estimator, accountant, field_worker, viewer
-- No other constraint in this repository's migrations carries a role list;
-- the precondition below also lists any live constraint on another table that
-- names these roles (NOTICE only, nothing else is changed).
--
-- Scope: replaces this one CHECK constraint with the same list plus
-- office_manager. The new list is a superset of the old one, so every
-- existing row stays valid. No RLS policy, grant, trigger, column or row is
-- changed. office_manager gains no database authority from this: the role-
-- aware policies in this repository only test role in ('owner', 'admin').
--
-- Precondition: stops unless the live constraint allows exactly the eight
-- roles above (any order). If it already allows the nine roles, the check
-- passes and the ALTERs below drop and re-add the identical nine-role
-- constraint (same definition, revalidated; no row or policy changes), so a
-- re-run is safe. Any other role list, or a missing constraint/table, stops
-- the transaction before anything changes.

begin;

do $$
declare
  v_def      text;
  v_valid    boolean;
  v_roles    text[];
  v_expected text[] := array['accountant','admin','estimator','field_worker','owner','project_manager','sales','viewer'];
  v_target   text[] := array['accountant','admin','estimator','field_worker','office_manager','owner','project_manager','sales','viewer'];
  v_other    record;
begin
  select pg_get_constraintdef(c.oid), c.convalidated
    into v_def, v_valid
    from pg_constraint c
   where c.conrelid = 'public.org_memberships'::regclass
     and c.conname = 'org_memberships_role_check'
     and c.contype = 'c';

  if v_def is null then
    raise exception 'precondition failed: public.org_memberships has no CHECK constraint named org_memberships_role_check';
  end if;
  if v_def !~ '\mrole\M' then
    raise exception 'precondition failed: org_memberships_role_check does not test the role column: %', v_def;
  end if;

  select array_agg(distinct m[1] order by m[1])
    into v_roles
    from regexp_matches(v_def, '''([^'']+)''', 'g') as m;

  if v_roles = v_target then
    raise notice 'org_memberships_role_check already allows office_manager; nothing to do';
  elsif v_roles is distinct from v_expected then
    raise exception 'precondition failed: org_memberships_role_check differs from the expected eight-role list: %', v_def;
  elsif not v_valid then
    raise exception 'precondition failed: org_memberships_role_check is NOT VALID; investigate existing rows first';
  end if;

  if exists (select 1 from public.org_memberships where role is not null and role::text <> all (v_target)) then
    raise exception 'precondition failed: org_memberships has a role outside the nine supported roles';
  end if;

  for v_other in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.contype = 'c'
       and c.conname <> 'org_memberships_role_check'
       and pg_get_constraintdef(c.oid) ~ '''field_worker'''
  loop
    raise notice 'another constraint names member roles (not changed here): %.%', v_other.tbl, v_other.conname;
  end loop;
end $$;

alter table public.org_memberships drop constraint org_memberships_role_check;
alter table public.org_memberships add constraint org_memberships_role_check
  check (role in ('owner', 'admin', 'office_manager', 'estimator', 'sales', 'project_manager', 'field_worker', 'accountant', 'viewer'));

commit;

-- ── Before applying (read-only; keep the output) ─────────────────────────────
--   select conname, pg_get_constraintdef(oid), convalidated from pg_constraint
--    where conrelid = 'public.org_memberships'::regclass and contype = 'c';
--   select c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid) from pg_constraint c
--    where c.contype = 'c' and pg_get_constraintdef(c.oid) ~ '''field_worker''';
--
-- ── Verification (run after applying) ───────────────────────────────────────
-- 1. The constraint lists nine roles, including office_manager, and is validated:
--   select pg_get_constraintdef(oid), convalidated from pg_constraint
--    where conrelid = 'public.org_memberships'::regclass and conname = 'org_memberships_role_check';
-- 2. Policies and grants are unchanged (compare with the "before" output):
--   select policyname, cmd, roles, qual from pg_policies where tablename = 'org_memberships';
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restores the original eight-role constraint. It fails (and changes nothing)
-- while any office_manager membership exists; reassign or remove those rows
-- first, deliberately:
--   select member_id, org_id from public.org_memberships where role = 'office_manager';
--
-- ROLLBACK-SQL-BEGIN
-- begin;
-- alter table public.org_memberships drop constraint org_memberships_role_check;
-- alter table public.org_memberships add constraint org_memberships_role_check
--   check (role in ('owner', 'admin', 'project_manager', 'sales', 'estimator', 'accountant', 'field_worker', 'viewer'));
-- commit;
-- ROLLBACK-SQL-END
