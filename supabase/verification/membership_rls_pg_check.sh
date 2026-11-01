#!/usr/bin/env bash
# supabase/verification/membership_rls_pg_check.sh
#
# Real-Postgres checks for supabase/migrations/20261031_membership_rls_containment.sql (+ its rollback) and
# supabase/verification/membership_rls_preflight.sql, against membership_rls_local_schema.sql (production policies verbatim).
#
#   *** THROWAWAY POSTGRES SERVER ONLY. NEVER RUN AGAINST PRODUCTION. ***
#
# Creates databases rlsbefore / rlsafter on the server PSQL points at, and refuses to run if the server has any database
# other than postgres/template0/template1. Users act through Supabase's roles: `set role authenticated` with
# request.jwt.claim.sub = <user id> (what auth.uid() reads), `set role anon`, or `set role service_role` (BYPASSRLS).
#
# Usage (from the repository root):
#   docker run -d --rm --name rls-pgcheck -e POSTGRES_PASSWORD=local postgres:17-alpine
#   PSQL="docker exec -i rls-pgcheck psql -U postgres" supabase/verification/membership_rls_pg_check.sh
#   docker stop rls-pgcheck

set -uo pipefail
PSQL=${PSQL:?set PSQL, e.g. PSQL="docker exec -i rls-pgcheck psql -U postgres"}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../migrations/20261031_membership_rls_containment.sql"
SCHEMA="$HERE/membership_rls_local_schema.sql"
PREFLIGHT="$HERE/membership_rls_preflight.sql"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DB=postgres
q()     { $PSQL -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
qfile() { $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q < "$1"; }
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1  (expected '$3', got '$2')"; FAILS=$((FAILS + 1)); fi; }
fails() { if "$@" >/dev/null 2>&1; then echo no; else echo yes; fi; }
rollback_sql() { sed -n '/ROLLBACK-SQL-BEGIN/,/ROLLBACK-SQL-END/p' "$1" | sed '1d;$d' | sed 's/^-- \{0,1\}//'; }

# Run SQL as a signed-in user / anonymous / the service role. Last statement's output is printed.
as()   { local uid=$1; shift; q -c "set role authenticated; set request.jwt.claim.sub = '$uid'; $*"; }
anon() { q -c "set role anon; set request.jwt.claim.sub = ''; $*"; }
svc()  { q -c "set role service_role; $*"; }
n()    { q -c "select count(*) from $*"; }   # superuser count (sees everything)

others=$(q -c "select count(*) from pg_database where datname not in ('postgres', 'template0', 'template1')")
if [ "$others" != "0" ]; then echo "Refusing to run: this server has other databases (throwaway servers only)." >&2; exit 2; fi

ORG_A=11111111-1111-4111-8111-111111111111   # owner OA, admin AA, sales SA
ORG_B=22222222-2222-4222-8222-222222222222   # owner OB, sales SB
ORG_Z=33333333-3333-4333-8333-333333333333   # created by OB, no members (like the 8 member-less production orgs)
OA=aaaaaaaa-0000-4000-8000-000000000001; AA=aaaaaaaa-0000-4000-8000-000000000002; SA=aaaaaaaa-0000-4000-8000-000000000003
OB=bbbbbbbb-0000-4000-8000-000000000001; SB=bbbbbbbb-0000-4000-8000-000000000002
X=cccccccc-0000-4000-8000-000000000001    # self sign-up, no organization (the attacker)
NEW=dddddddd-0000-4000-8000-000000000001  # a legitimate new sign-up going through onboarding
NEW_ORG=44444444-4444-4444-8444-444444444444
FUT="now() + interval '7 days'"

seed() {
  q -c "
    insert into auth.users (id, email) values ('$OA','oa@x.invalid'), ('$AA','aa@x.invalid'), ('$SA','sa@x.invalid'),
      ('$OB','ob@x.invalid'), ('$SB','sb@x.invalid'), ('$X','x@x.invalid'), ('$NEW','new@x.invalid');
    insert into public.organizations (id, name, created_by) values ('$ORG_A','A','$OA'), ('$ORG_B','B','$OB'), ('$ORG_Z','Z','$OB');
    insert into public.profiles (id, email, organization_id, role, ssn) values
      ('$OA','oa@x.invalid','$ORG_A','owner','111-11-1111'), ('$AA','aa@x.invalid','$ORG_A','admin','222-22-2222'),
      ('$SA','sa@x.invalid','$ORG_A','member','333-33-3333'), ('$OB','ob@x.invalid','$ORG_B','owner','444-44-4444'),
      ('$SB','sb@x.invalid','$ORG_B','member','555-55-5555'), ('$X','x@x.invalid',null,'member',null),
      ('$NEW','new@x.invalid',null,'member',null);
    insert into public.org_memberships (org_id, member_id, role) values
      ('$ORG_A','$OA','owner'), ('$ORG_A','$AA','admin'), ('$ORG_A','$SA','sales'), ('$ORG_B','$OB','owner'), ('$ORG_B','$SB','sales');
    insert into public.invitations (organization_id, email, role, token, expires_at, ssn) values
      ('$ORG_A','inv-a@x.invalid','sales','tok-a',$FUT,'999-99-9999'), ('$ORG_B','inv-b@x.invalid','admin','tok-b',$FUT,'888-88-8888');"
}
fresh_db() { DB=postgres q -c "create database $1" || exit 2; DB=$1; qfile "$SCHEMA" >/dev/null || exit 2; seed; }

# ═════════════════════════════════════════════════════════════════════════════
echo "── BEFORE: the production policies (vulnerabilities reproduced)"
fresh_db rlsbefore
check "preflight runs read-only on the unmodified schema" "$(fails qfile "$PREFLIGHT")" "no"
as "$X" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_B', '$X', 'owner')" >/dev/null 2>&1
check "before: a self sign-up inserts an OWNER membership into another org" "$(n "public.org_memberships where member_id = '$X' and org_id = '$ORG_B' and role = 'owner'")" "1"
as "$X" "update public.profiles set organization_id = '$ORG_A', role = 'owner' where id = '$X'" >/dev/null 2>&1
check "before: a self sign-up repoints its profile at another org (role owner)" "$(n "public.profiles where id = '$X' and organization_id = '$ORG_A' and role = 'owner'")" "1"
check "before: ...and then reads that org's invitations (SSN)" "$(as "$X" "select count(*) from public.invitations where organization_id = '$ORG_A' and ssn is not null")" "1"
as "$X" "update public.org_memberships set role = 'viewer' where member_id = '$OA' and org_id = '$ORG_A'" >/dev/null 2>&1
check "before: ...and demotes that org's real owner" "$(n "public.org_memberships where member_id = '$OA' and role = 'viewer'")" "1"
check "before: anonymous users read every invitation token" "$(anon "select count(*) from public.invitations")" "2"
check "before: any signed-in user reads every profile's SSN" "$(as "$SB" "select count(*) from public.profiles where ssn is not null")" "5"
as "$SA" "update public.org_memberships set role = 'owner' where member_id = '$SA' and org_id = '$ORG_A'" >/dev/null 2>&1
check "before: a sales member promotes themselves to owner" "$(n "public.org_memberships where member_id = '$SA' and role = 'owner'")" "1"
check "before: anonymous get_user_id_by_email resolves an email" "$(anon "select count(*) from public.get_user_id_by_email('oa@x.invalid')")" "1"

# ═════════════════════════════════════════════════════════════════════════════
echo "── apply the containment migration"
fresh_db rlsafter
check "migration applies on the production policy set" "$(fails qfile "$MIG")" "no"
check "14 restrictive containment policies, none permissive" \
  "$(q -c "select count(*) filter (where permissive = 'RESTRICTIVE') || '/' || count(*) from pg_policies where policyname like 'rls_containment_%'")" "14/14"
check "the 31 production policies are untouched" "$(q -c "select count(*) from pg_policies where policyname not like 'rls_containment_%'")" "31"
check "preflight runs read-only after the migration" "$(fails qfile "$PREFLIGHT")" "no"

echo "── AFTER: attacks"
check "a self sign-up can't insert an owner membership into another org" \
  "$(fails as "$X" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_B', '$X', 'owner')")" "yes"
check "...nor any membership role" \
  "$(fails as "$X" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_B', '$X', 'viewer')")" "yes"
check "a self sign-up can't claim a member-less org it didn't create (the 8 production orgs)" \
  "$(fails as "$X" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_Z', '$X', 'owner')")" "yes"
check "a self sign-up can't repoint its profile at another org" \
  "$(fails as "$X" "update public.profiles set organization_id = '$ORG_A' where id = '$X'")" "yes"
check "a self sign-up can't set its profile role to owner" "$(fails as "$X" "update public.profiles set role = 'owner' where id = '$X'")" "yes"
check "a member can't set their profile role to admin" "$(fails as "$SA" "update public.profiles set role = 'admin' where id = '$SA'")" "yes"
check "a member can't move their profile to an org they don't belong to" \
  "$(fails as "$SA" "update public.profiles set organization_id = '$ORG_B' where id = '$SA'")" "yes"
as "$SA" "update public.org_memberships set role = 'owner' where member_id = '$SA'" >/dev/null 2>&1
check "a sales member can't promote themselves (no row changes)" "$(q -c "select role from public.org_memberships where member_id = '$SA'")" "sales"
as "$AA" "update public.org_memberships set role = 'viewer' where member_id = '$OA'; delete from public.org_memberships where member_id = '$SA'" >/dev/null 2>&1
check "an admin can't demote the owner or delete members from the browser" \
  "$(q -c "select string_agg(role, ',' order by role) from public.org_memberships where org_id = '$ORG_A'")" "admin,owner,sales"
check "a member can't add someone else to their org" \
  "$(fails as "$AA" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_A', '$X', 'viewer')")" "yes"
as "$X" "update public.organizations set name = 'pwned' where id = '$ORG_A'" >/dev/null 2>&1
check "a self sign-up can't modify another org's row" "$(q -c "select name from public.organizations where id = '$ORG_A'")" "A"

echo "── AFTER: data exposure"
check "anonymous users read no invitations" "$(anon "select count(*) from public.invitations")" "0"
check "anonymous users read no profiles or memberships" "$(anon "select (select count(*) from public.profiles) + (select count(*) from public.org_memberships)")" "0"
check "anonymous get_user_id_by_email is refused" "$(fails anon "select * from public.get_user_id_by_email('oa@x.invalid')")" "yes"
check "signed-in get_user_id_by_email is refused" "$(fails as "$SA" "select * from public.get_user_id_by_email('oa@x.invalid')")" "yes"
check "anonymous users can't call the containment helpers" "$(fails anon "select public.rls_my_org_role('$ORG_A')")" "yes"
check "a self sign-up sees only its own profile" "$(as "$X" "select count(*) from public.profiles")" "1"
check "a member sees exactly their org's profiles (not org B's)" "$(as "$SA" "select string_agg(email, ',' order by email) from public.profiles")" "aa@x.invalid,oa@x.invalid,sa@x.invalid"
check "a member sees their org's memberships, not org B's" "$(as "$SA" "select count(*) || '/' || count(*) filter (where org_id = '$ORG_A') from public.org_memberships")" "3/3"
check "a non-owner member sees no invitations (SSN)" "$(as "$SA" "select count(*) from public.invitations")" "0"
check "an admin sees no invitations" "$(as "$AA" "select count(*) from public.invitations")" "0"
check "an owner sees only their own org's invitations" "$(as "$OA" "select string_agg(token, ',') from public.invitations")" "tok-a"

echo "── AFTER: invitations"
check "a non-owner can't create an invitation" \
  "$(fails as "$SA" "insert into public.invitations (organization_id, email, role, token, expires_at) values ('$ORG_A', 'n1@x.invalid', 'viewer', 'tok-n1', $FUT)")" "yes"
check "an owner can create an admin invitation in their org" \
  "$(fails as "$OA" "insert into public.invitations (organization_id, email, role, token, expires_at) values ('$ORG_A', 'n2@x.invalid', 'admin', 'tok-n2', $FUT)")" "no"
check "an owner can't create an owner invitation" \
  "$(fails as "$OA" "insert into public.invitations (organization_id, email, role, token, expires_at) values ('$ORG_A', 'n3@x.invalid', 'owner', 'tok-n3', $FUT)")" "yes"
check "an owner can't create an invitation in another org" \
  "$(fails as "$OA" "insert into public.invitations (organization_id, email, role, token, expires_at) values ('$ORG_B', 'n4@x.invalid', 'sales', 'tok-n4', $FUT)")" "yes"
as "$OA" "update public.invitations set role = 'owner' where token = 'tok-a'" >/dev/null 2>&1
check "an invitation's role can't be changed to owner from the browser" "$(q -c "select role from public.invitations where token = 'tok-a'")" "sales"

echo "── AFTER: legitimate flows"
check "members can still edit their own profile" "$(fails as "$SA" "update public.profiles set first_name = 'Sam', phone = '555' where id = '$SA'")" "no"
check "an admin (profile role admin = membership admin) can edit their own profile" "$(fails as "$AA" "update public.profiles set phone = '556' where id = '$AA'")" "no"
check "an owner can edit their own profile" "$(fails as "$OA" "update public.profiles set phone = '557' where id = '$OA'")" "no"
check "an owner can still update their organization (branding/onboarding)" \
  "$(fails as "$OA" "update public.organizations set logo_url = 'x', onboarding_complete = true where id = '$ORG_A'")" "no"
# src/lib/auth.ts createOrganization, statement by statement, then onboarding's organization update
check "sign-up 1/3: a new user creates their organization" \
  "$(fails as "$NEW" "insert into public.organizations (id, name, created_by) values ('$NEW_ORG', 'New Co', '$NEW')")" "no"
check "sign-up 2/3: upserts their profile with that org and role owner" \
  "$(fails as "$NEW" "insert into public.profiles (id, email, organization_id, role) values ('$NEW', 'new@x.invalid', '$NEW_ORG', 'owner') on conflict (id) do update set organization_id = excluded.organization_id, role = excluded.role")" "no"
check "sign-up 3/3: inserts their own owner membership" \
  "$(fails as "$NEW" "insert into public.org_memberships (org_id, member_id, role) values ('$NEW_ORG', '$NEW', 'owner')")" "no"
check "onboarding: the new owner completes onboarding and sees their org" \
  "$(as "$NEW" "update public.organizations set onboarding_complete = true where id = '$NEW_ORG'; select count(*) from public.organizations where id = '$NEW_ORG' and onboarding_complete")" "1"
check "after sign-up the org is claimed: the creator can't add a second owner row for someone else" \
  "$(fails as "$NEW" "insert into public.org_memberships (org_id, member_id, role) values ('$NEW_ORG', '$X', 'owner')")" "yes"
check "the creator of a member-less org can still finish sign-up (claim it)" \
  "$(fails as "$OB" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_Z', '$OB', 'owner')")" "no"

echo "── AFTER: service_role (Netlify functions) unaffected"
check "service_role inserts a membership for any user" \
  "$(fails svc "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_B', '$X', 'office_manager')")" "no"
check "service_role updates a role and deletes a membership" \
  "$(fails svc "update public.org_memberships set role = 'estimator' where member_id = '$X'; delete from public.org_memberships where member_id = '$X'")" "no"
check "service_role reads every invitation" "$(svc "select count(*) from public.invitations")" "3"
check "service_role can call get_user_id_by_email" "$(svc "select count(*) from public.get_user_id_by_email('oa@x.invalid')")" "1"
check "service_role sets a profile organization" "$(fails svc "update public.profiles set organization_id = '$ORG_B' where id = '$X'")" "no"

echo "── re-run, rollback, re-apply"
check "re-running the migration succeeds" "$(fails qfile "$MIG")" "no"
check "...and still has exactly 14 containment policies" "$(q -c "select count(*) from pg_policies where policyname like 'rls_containment_%'")" "14"
RB="$WORK/rollback.sql"; rollback_sql "$MIG" > "$RB"
check "rollback applies" "$(fails qfile "$RB")" "no"
check "rollback removes every containment policy and helper" \
  "$(q -c "select (select count(*) from pg_policies where policyname like 'rls_containment_%') + (select count(*) from pg_proc where proname like 'rls\_%' and pronamespace = 'public'::regnamespace)")" "0"
check "rollback restores get_user_id_by_email for anon (as before)" "$(anon "select count(*) from public.get_user_id_by_email('oa@x.invalid')")" "1"
check "rollback restores the previous (open) behavior" \
  "$(fails as "$SB" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_A', '$SB', 'owner')")" "no"
q -c "delete from public.org_memberships where member_id = '$SB' and org_id = '$ORG_A'"
check "re-apply after rollback succeeds" "$(fails qfile "$MIG")" "no"
check "...and the containment is back" \
  "$(fails as "$SB" "insert into public.org_memberships (org_id, member_id, role) values ('$ORG_A', '$SB', 'owner')")" "yes"

echo "── preconditions"
DB=rlsafter q -c "alter table public.invitations disable row level security"
check "the migration stops if RLS is disabled on a table" "$(fails qfile "$MIG")" "yes"
DB=rlsafter q -c "alter table public.invitations enable row level security"

echo
if [ "$FAILS" = "0" ]; then echo "ALL PASS"; else echo "$FAILS FAILED"; exit 1; fi
