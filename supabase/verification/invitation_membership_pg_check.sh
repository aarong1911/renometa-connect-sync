#!/usr/bin/env bash
# supabase/verification/invitation_membership_pg_check.sh
#
# Real-Postgres checks for
#   supabase/migrations/20261031_org_memberships_role_office_manager.sql
#   supabase/migrations/20261031_handle_invited_user_no_metadata_authority.sql   (+ its rollback)
#   supabase/verification/handle_invited_user_preflight.sql                      (runs read-only, classifies)
# and for the trigger-safe order accept-invite.ts uses (user created without metadata, confirmed, then profile +
# membership + invitation, metadata last).
#
#   *** THROWAWAY POSTGRES SERVER ONLY. NEVER RUN AGAINST PRODUCTION. ***
#
# It creates its own databases (invcheck, invneg1, invneg2) on the server PSQL points at, loads
# invitation_membership_local_schema.sql into each (a minimal reconstruction with a STAND-IN for the production
# handle_invited_user(), see that file), runs the preflight, fills the migration's fingerprint placeholder the way an
# operator would, applies the real migration files and their ROLLBACK-SQL blocks, and prints PASS/FAIL lines.
# It refuses to run if the server has any database other than postgres/template0/template1.
# With PROD_DEF_SQL + PROD_DEF_MD5 set, it also applies the deployment copy (supabase/deploy/) VERBATIM against the real
# saved production definition, then its rollback (database invreal).
#
# Usage (from the repository root):
#   docker run -d --rm --name inv-pgcheck -e POSTGRES_PASSWORD=local postgres:17-alpine
#   PSQL="docker exec -i inv-pgcheck psql -U postgres" supabase/verification/invitation_membership_pg_check.sh
#   PSQL=... PROD_DEF_SQL=<exact definition file> PROD_DEF_MD5=<def_md5> supabase/verification/invitation_membership_pg_check.sh
#   docker stop inv-pgcheck

set -uo pipefail
PSQL=${PSQL:?set PSQL, e.g. PSQL="docker exec -i inv-pgcheck psql -U postgres"}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../migrations"
ROLE_MIG="$MIG/20261031_org_memberships_role_office_manager.sql"
HARDEN_MIG="$MIG/20261031_handle_invited_user_no_metadata_authority.sql"
PREFLIGHT="$HERE/handle_invited_user_preflight.sql"
SCHEMA="$HERE/invitation_membership_local_schema.sql"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DB=postgres
q()     { $PSQL -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
qfile() { $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q < "$1"; }
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1  (expected '$3', got '$2')"; FAILS=$((FAILS + 1)); fi; }
fails() { if "$@" >/dev/null 2>&1; then echo no; else echo yes; fi; }
rollback_sql() { sed -n '/ROLLBACK-SQL-BEGIN/,/ROLLBACK-SQL-END/p' "$1" | sed '1d;$d' | sed 's/^-- \{0,1\}//'; }

# What an operator does: preflight -> def_md5 + rollback artifact; fill the migration; later fill the rollback.
def_md5()  { q -c "select md5(pg_get_functiondef(to_regprocedure('public.handle_invited_user()')))"; }
save_artifact() { q -c "select pg_get_functiondef(to_regprocedure('public.handle_invited_user()'))" > "$WORK/artifact.sql"; }
filled_migration() { sed "s/@@PREFLIGHT_DEF_MD5@@/$1/" "$HARDEN_MIG" > "$WORK/harden.sql"; echo "$WORK/harden.sql"; }
# Byte-exact splice of an artifact file into a rollback template at its @@ROLLBACK_ARTIFACT@@ line (keeps CR bytes;
# awk/sed line handling may not). $1 = template, $2 = artifact, $3 = output.
splice_artifact() {
  local n; n=$(grep -n '@@ROLLBACK_ARTIFACT@@' "$1" | cut -d: -f1)
  { head -n $((n - 1)) "$1"; cat "$2"; printf ';\n'; tail -n +$((n + 1)) "$1"; } > "$3"
}
filled_rollback() {
  rollback_sql "$HARDEN_MIG" | sed "s/@@PREFLIGHT_DEF_MD5@@/$1/" > "$WORK/rollback_template.sql"
  splice_artifact "$WORK/rollback_template.sql" "$WORK/artifact.sql" "$WORK/rollback.sql"
  echo "$WORK/rollback.sql"
}
role_rollback() { rollback_sql "$ROLE_MIG" > "$WORK/role_rollback.sql"; echo "$WORK/role_rollback.sql"; }

ORG_A=a1000000-0000-4000-8000-0000000000a1
ORG_B=b1000000-0000-4000-8000-0000000000b1
OWNER_B=b1000000-0000-4000-8000-00000000b0b1
uid() { printf 'e1000000-0000-4000-8000-%012d' "$1"; }
signup()  { q -c "insert into auth.users (id, email, raw_user_meta_data) values ('$1', '$2', '$3'::jsonb)"; }  # unconfirmed
confirm() { q -c "update auth.users set email_confirmed_at = now() where id = '$1'"; }                       # NULL -> value
invite()  { q -c "insert into public.invitations (organization_id, email, role, status) values ('$1', '$2', '$3', '$4')"; }
memberships() { q -c "select count(*) from public.org_memberships where member_id = '$1'"; }
role_def() { q -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.org_memberships'::regclass and conname = 'org_memberships_role_check'"; }
fn_state() { q -c "select md5(pg_get_functiondef(oid)) || ':' || oid || ':' || prosecdef from pg_proc where oid = 'public.handle_invited_user()'::regprocedure"; }

others=$(DB=postgres q -c "select count(*) from pg_database where datname not in ('postgres', 'template0', 'template1')")
if [ "$others" != "0" ]; then echo "Refusing to run: this server has other databases (throwaway servers only)." >&2; exit 2; fi

fresh_db() {
  DB=postgres q -c "create database $1" || exit 2
  DB=$1
  qfile "$SCHEMA" || exit 2
  q -c "insert into public.organizations values ('$ORG_A', 'Org A'), ('$ORG_B', 'Org B');
        insert into auth.users (id, email, email_confirmed_at) values ('$OWNER_B', 'owner-b@example.invalid', now());
        insert into public.org_memberships (member_id, org_id, role) values ('$OWNER_B', '$ORG_B', 'owner');"
}

echo "── main database: before any migration (stand-in trigger as described for production)"
fresh_db invcheck
ORIGINAL_STATE=$(fn_state)

A1=$(uid 1); signup "$A1" attacker1@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$A1"
check "before: self-signup metadata {org_id: B, role: owner} + own email confirmation => owner membership in org B (vulnerability reproduced)" \
  "$(q -c "select count(*) from public.org_memberships where member_id = '$A1' and org_id = '$ORG_B' and role = 'owner'")" "1"

G1=$(uid 2); invite "$ORG_A" ghost1@example.invalid office_manager roster_only
signup "$G1" ghost1@example.invalid "{\"org_id\": \"$ORG_A\", \"role\": \"office_manager\", \"roster_only\": true}"
q -c "insert into public.profiles (id, email, organization_id) values ('$G1', 'ghost1@example.invalid', '$ORG_A')"
check "before: a roster office_manager's magic-link confirmation FAILS (trigger insert hits the eight-role check => sign-in blocked)" \
  "$(fails confirm "$G1")" "yes"

echo "── role migration"
ROWS_BEFORE=$(q -c "select count(*) from public.org_memberships")
qfile "$ROLE_MIG" >/dev/null 2>&1; check "role migration applies on the eight-role constraint" "$?" "0"
check "constraint now allows office_manager" "$(role_def | grep -c "'office_manager'")" "1"
check "existing membership rows preserved" "$(q -c "select count(*) from public.org_memberships")" "$ROWS_BEFORE"
qfile "$ROLE_MIG" >/dev/null 2>&1; check "role migration re-run is a no-op success" "$?" "0"
check "constraint still validated" "$(q -c "select convalidated from pg_constraint where conname = 'org_memberships_role_check'")" "t"

echo "── accept-invite order against the UNHARDENED trigger (Part A deployed before Part B)"
C1=$(uid 3); invite "$ORG_A" acc1@example.invalid office_manager pending
signup "$C1" acc1@example.invalid '{}'; confirm "$C1"       # createUser(email_confirm: true), NO metadata
check "safe order: confirmation without org_id metadata grants nothing" "$(memberships "$C1")" "0"
q -c "insert into public.profiles (id, email, organization_id) values ('$C1', 'acc1@example.invalid', '$ORG_A');
      insert into public.org_memberships (member_id, org_id, role) values ('$C1', '$ORG_A', 'office_manager');"
check "safe order: invitation accepted by accept-invite's guarded update" \
  "$(q -c "update public.invitations set status = 'accepted' where email = 'acc1@example.invalid' and status = 'pending' returning 1" | head -1)" "1"
INV_C1=$(q -c "select id from public.invitations where email = 'acc1@example.invalid'")
q -c "update auth.users set raw_user_meta_data = '{\"org_id\": \"$ORG_B\", \"role\": \"owner\", \"invitation_id\": \"$INV_C1\"}'::jsonb where id = '$C1'"
check "safe order: metadata written after confirmation does not fire the trigger (even naming another org)" \
  "$(q -c "select string_agg(org_id::text || ':' || role, ',') from public.org_memberships where member_id = '$C1'")" "$ORG_A:office_manager"
C2=$(uid 4); invite "$ORG_A" acc2@example.invalid viewer pending
signup "$C2" acc2@example.invalid "{\"org_id\": \"$ORG_A\", \"role\": \"viewer\"}"; confirm "$C2"
check "unsafe order (metadata at createUser): the trigger consumes the invitation before onboarding writes anything" \
  "$(q -c "select status from public.invitations where email = 'acc2@example.invalid'")" "accepted"
G2=$(uid 7); invite "$ORG_A" ghost2@example.invalid office_manager roster_only
signup "$G2" ghost2@example.invalid "{\"org_id\": \"$ORG_A\", \"role\": \"office_manager\", \"roster_only\": true}"
q -c "insert into public.profiles (id, email, organization_id) values ('$G2', 'ghost2@example.invalid', '$ORG_A');
      insert into public.org_memberships (member_id, org_id, role) values ('$G2', '$ORG_A', 'office_manager');"   # invite-member's roster writes
U1=$(uid 9); q -c "insert into auth.users (id, email, email_confirmed_at) values ('$U1', 'promoted@example.invalid', now())"
invite "$ORG_A" promoted@example.invalid viewer accepted
q -c "insert into public.org_memberships (member_id, org_id, role) values ('$U1', '$ORG_A', 'admin')"           # admin -> or forged? review

echo "── preflight (read-only) against this data"
PRE_AT=$($PSQL -d invcheck -v ON_ERROR_STOP=1 -qAt < "$PREFLIGHT" 2>&1); check "preflight runs read-only without error" "$?" "0"
check "preflight reports the fingerprint the migration needs (def_md5 column)" \
  "$(echo "$PRE_AT" | grep "^handle_invited_user()|" | cut -d'|' -f8)" "$(def_md5)"
check "preflight: forged-metadata owner is classified trigger-shaped (no_invitation_metadata_org)" \
  "$(echo "$PRE_AT" | grep -c "^no_invitation_metadata_org|owner|1|")" "1"
check "preflight: the org founder is no_invitation_owner, not flagged" "$(echo "$PRE_AT" | grep -c "^no_invitation_owner|owner|1|")" "1"
check "preflight: accept-invite / roster / trigger-path members with invitations are backed_by_invitation" \
  "$(echo "$PRE_AT" | grep -E "^backed_by_invitation\|(office_manager|viewer)\|" | awk -F'|' '{s += $3} END {print s}')" "3"
check "preflight: a role above every invitation is flagged role_upgrade" "$(echo "$PRE_AT" | grep -c "^role_differs_from_invitation|admin|1|1|")" "1"
check "preflight drill-down lists the forged owner and the upgrade, nothing else" \
  "$(echo "$PRE_AT" | grep -cE "^($A1|$U1)\|")|$(echo "$PRE_AT" | grep -cE "^($OWNER_B|$C1|$C2|$G2)\|")" "2|0"
check "preflight lists the unconfirmed roster account missing its membership" "$(echo "$PRE_AT" | grep -c "^$G1|$ORG_A|office_manager$")" "1"
check "preflight finds the metadata-reading trigger function" "$(echo "$PRE_AT" | grep -c "^function|public.handle_invited_user|t$")" "1"

echo "── hardening migration: fingerprint gate"
check "refuses while the fingerprint placeholder is not filled in" "$(fails qfile "$HARDEN_MIG")" "yes"
check "refuses a fingerprint that does not match the live definition (production changed after review)" \
  "$(fails qfile "$(filled_migration 0123456789abcdef0123456789abcdef)")" "yes"
check "...and changed nothing" "$(fn_state)" "$ORIGINAL_STATE"

echo "── hardening migration: apply"
DEF_MD5=$(def_md5); save_artifact
ACL_BEFORE=$(q -c "select string_agg(relname || '=' || coalesce(relacl::text, '-'), ';' order by relname) from pg_class where relname in ('org_memberships', 'profiles', 'invitations') and relnamespace = 'public'::regnamespace")
FN_ACL_OWNER=$(q -c "select coalesce(proacl::text, '-') || ':' || proowner::regrole from pg_proc where oid = 'public.handle_invited_user()'::regprocedure")
POL_BEFORE=$(q -c "select count(*) from pg_policies where schemaname = 'public'")
qfile "$(filled_migration "$DEF_MD5")" >/dev/null 2>&1; check "hardening migration applies with the preflight fingerprint" "$?" "0"
FN_OID=$(echo "$ORIGINAL_STATE" | cut -d: -f2)
check "hardened in place: same OID, SECURITY INVOKER, pinned search_path" \
  "$(q -c "select oid = $FN_OID and prosrc ~ 's1:no-metadata-authority' and not prosecdef and proconfig = '{\"search_path=pg_catalog, pg_temp\"}' from pg_proc where oid = 'public.handle_invited_user()'::regprocedure")" "t"
check "function owner and ACL unchanged" "$(q -c "select coalesce(proacl::text, '-') || ':' || proowner::regrole from pg_proc where oid = 'public.handle_invited_user()'::regprocedure")" "$FN_ACL_OWNER"
check "no executable backup function is created" "$(q -c "select count(*) from pg_proc where proname like 'handle_invited_user%'")" "1"
check "trigger still attached and enabled" "$(q -c "select tgenabled from pg_trigger where tgname = 'on_invited_user_confirmed'")" "O"
check "table ACLs unchanged" "$(q -c "select string_agg(relname || '=' || coalesce(relacl::text, '-'), ';' order by relname) from pg_class where relname in ('org_memberships', 'profiles', 'invitations') and relnamespace = 'public'::regnamespace")" "$ACL_BEFORE"
check "policies unchanged" "$(q -c "select count(*) from pg_policies where schemaname = 'public'")" "$POL_BEFORE"

echo "── after hardening"
A2=$(uid 5); signup "$A2" attacker2@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$A2"
check "after: self-signup metadata claiming owner of org B grants nothing" "$(memberships "$A2")" "0"
V1=$(uid 6); invite "$ORG_A" victim@example.invalid viewer pending
signup "$V1" victim@example.invalid "{\"org_id\": \"$ORG_A\", \"role\": \"owner\"}"
q -c "insert into public.profiles (id, email) values ('$V1', 'victim@example.invalid')"; confirm "$V1"
check "after: an invited email signing up with a forged role gets no membership" "$(memberships "$V1")" "0"
check "after: its invitation stays pending (only the token flow accepts it)" "$(q -c "select status from public.invitations where email = 'victim@example.invalid'")" "pending"
check "after: its profile organization is not set from metadata" "$(q -c "select coalesce(organization_id::text, 'null') from public.profiles where id = '$V1'")" "null"
A4=$(uid 10); signup "$A4" attacker4@example.invalid '{"org_id": "not-a-uuid", "role": "owner"}'
check "after: malformed metadata cannot break sign-in" "$(fails confirm "$A4")" "no"
check "after: roster office_manager magic-link confirmation succeeds" "$(fails confirm "$G2")" "no"
check "after: roster membership/profile unchanged" \
  "$(q -c "select m.role || ':' || p.organization_id from public.org_memberships m join public.profiles p on p.id = m.member_id where m.member_id = '$G2'")" "office_manager:$ORG_A"
check "after: the previously blocked roster user can now confirm (sign-in unblocked)" "$(fails confirm "$G1")" "no"
check "after: ...but gets no membership from metadata (repair it before hardening — preflight section 6)" "$(memberships "$G1")" "0"

echo "── re-run, rollback, re-apply"
qfile "$(filled_migration "$DEF_MD5")" >/dev/null 2>&1; check "hardening re-run is a no-op success" "$?" "0"
qfile "$HARDEN_MIG" >/dev/null 2>&1; check "re-run is a no-op even without a fingerprint (already hardened)" "$?" "0"
qfile "$(filled_rollback "$DEF_MD5")" >/dev/null 2>&1; check "rollback with the saved artifact applies" "$?" "0"
check "rollback restores the exact original definition on the same OID" "$(fn_state)" "$ORIGINAL_STATE"
check "rollback refuses when the live function is not the hardened one" "$(fails qfile "$(filled_rollback "$DEF_MD5")")" "yes"
A3=$(uid 8); signup "$A3" attacker3@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$A3"
check "after rollback the original behavior is back (escalation re-opened, as documented)" "$(memberships "$A3")" "1"
qfile "$(filled_migration "$DEF_MD5")" >/dev/null 2>&1; check "hardening re-applies after a rollback" "$?" "0"
check "role-migration rollback refuses while office_manager memberships exist (constraint unchanged)" \
  "$(fails qfile "$(role_rollback)"):$(role_def | grep -c "'office_manager'")" "yes:1"

echo "── preconditions (separate databases)"
fresh_db invneg1
q -c "alter table public.org_memberships drop constraint org_memberships_role_check;
      alter table public.org_memberships add constraint org_memberships_role_check check (role in ('owner', 'admin', 'viewer'));"
DEF_BEFORE=$(role_def)
check "role migration stops when the live constraint differs from the expected eight roles" "$(fails qfile "$ROLE_MIG")" "yes"
check "...and leaves that constraint unchanged" "$(role_def)" "$DEF_BEFORE"
q -c "drop trigger on_invited_user_confirmed on auth.users;
      create trigger on_invited_user_confirmed after update of email_confirmed_at on auth.users for each row
        when (old.email_confirmed_at is null and new.email_confirmed_at is not null) execute function public.handle_invited_user();"
check "hardening accepts an AFTER UPDATE OF ... WHEN (...) trigger" "$(fails qfile "$(filled_migration "$(def_md5)")")" "no"

fresh_db invneg2
qfile "$ROLE_MIG" >/dev/null 2>&1
qfile "$(role_rollback)" >/dev/null 2>&1; check "role-migration rollback restores the eight-role constraint when no office_manager rows exist" "$?:$(role_def | grep -c "'office_manager'")" "0:0"
NEG2_MD5=$(def_md5)
q -c "drop trigger on_invited_user_confirmed on auth.users"
check "hardening stops when the trigger is missing" "$(fails qfile "$(filled_migration "$NEG2_MD5")")" "yes"
q -c "create trigger on_invited_user_confirmed after insert on auth.users for each row execute function public.handle_invited_user()"
check "hardening stops when the trigger is not AFTER UPDATE" "$(fails qfile "$(filled_migration "$NEG2_MD5")")" "yes"
q -c "drop trigger on_invited_user_confirmed on auth.users;
      create trigger on_invited_user_confirmed after update on auth.users for each row execute function public.handle_invited_user();
      create trigger zz_second_trigger after update on public.profiles for each row execute function public.handle_invited_user();"
check "hardening stops when more than one trigger executes the function" "$(fails qfile "$(filled_migration "$NEG2_MD5")")" "yes"
check "...and leaves the function as it was" "$(def_md5)" "$NEG2_MD5"

# ── Optional: the DEPLOYMENT COPY against the REAL production definition ──────
# PROD_DEF_SQL = a file holding the exact saved definition (pg_get_functiondef text, CR bytes preserved, no trailing ';').
# DEPLOY_MIG   = the deployment copy (default: supabase/deploy/...production.sql). PROD_DEF_MD5 = its fingerprint.
if [ -n "${PROD_DEF_SQL:-}" ]; then
  DEPLOY_MIG=${DEPLOY_MIG:-"$HERE/../deploy/20261031_handle_invited_user_no_metadata_authority.production.sql"}
  PROD_DEF_MD5=${PROD_DEF_MD5:?set PROD_DEF_MD5 with PROD_DEF_SQL}
  load_prod_def() { { cat "$PROD_DEF_SQL"; printf ';\n'; } | $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q; }
  deploy_rollback() {   # $1 = artifact file
    rollback_sql "$DEPLOY_MIG" > "$WORK/deploy_rollback_template.sql"
    splice_artifact "$WORK/deploy_rollback_template.sql" "$1" "$WORK/deploy_rollback.sql"
    echo "$WORK/deploy_rollback.sql"
  }
  tr -d '\r' < "$PROD_DEF_SQL" > "$WORK/prod_def_no_cr.sql"

  echo "── deployment copy: static checks"
  check "deployment copy has no unresolved placeholder in executable SQL" "$(grep -v '^[[:space:]]*--' "$DEPLOY_MIG" | grep -cE '@@[A-Z0-9_]+@@')" "0"
  check "deployment copy pins the expected fingerprint in code" "$(grep -v '^[[:space:]]*--' "$DEPLOY_MIG" | grep -c "v_expected_def_md5 constant text := '$PROD_DEF_MD5';")" "1"
  check "deployment copy contains no CR bytes (a CR ends a -- comment in psql)" "$(tr -cd '\r' < "$DEPLOY_MIG" | wc -c | tr -d ' ')" "0"
  check "deployment copy has nothing executable after commit" "$(awk 'f && !/^[[:space:]]*(--|$)/ {n++} /^commit;/ {f=1} END {print n+0}' "$DEPLOY_MIG")" "0"
  check "deployment copy's executable section equals the generic migration's except the fingerprint line" \
    "$(diff <(sed -n '/^begin;/,/^commit;/p' "$HARDEN_MIG") <(sed -n '/^begin;/,/^commit;/p' "$DEPLOY_MIG") | grep -c '^[<>]')" "4"

  echo "── deployment copy against the REAL production definition"
  fresh_db invreal
  load_prod_def; check "the saved production definition loads and reproduces the production fingerprint" "$(def_md5)" "$PROD_DEF_MD5"
  REAL_STATE=$(fn_state)
  R1=$(uid 21); signup "$R1" real-attacker1@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$R1"
  check "real definition, before: forged metadata => owner membership in org B" \
    "$(q -c "select count(*) from public.org_memberships where member_id = '$R1' and org_id = '$ORG_B' and role = 'owner'")" "1"
  R2=$(uid 22); signup "$R2" real-bad@example.invalid '{"org_id": "not-a-uuid"}'
  check "real definition, before: malformed org_id metadata makes the confirmation itself fail" "$(fails confirm "$R2")" "yes"
  FN_ACL_OWNER=$(q -c "select coalesce(proacl::text, '-') || ':' || proowner::regrole from pg_proc where oid = 'public.handle_invited_user()'::regprocedure")
  DEPLOY_OUT=$(qfile "$DEPLOY_MIG" 2>&1); check "deployment copy applies VERBATIM against the real definition (psql exit 0, no error)" "$?:$(echo "$DEPLOY_OUT" | grep -c ERROR)" "0:0"
  check "hardened in place: same OID, SECURITY INVOKER, pinned search_path" \
    "$(q -c "select oid = $(echo "$REAL_STATE" | cut -d: -f2) and prosrc ~ 's1:no-metadata-authority' and not prosecdef and proconfig = '{\"search_path=pg_catalog, pg_temp\"}' from pg_proc where oid = 'public.handle_invited_user()'::regprocedure")" "t"
  check "owner and ACL unchanged; still exactly one trigger" \
    "$(q -c "select coalesce(proacl::text, '-') || ':' || proowner::regrole from pg_proc where oid = 'public.handle_invited_user()'::regprocedure"):$(q -c "select count(*) from pg_trigger where tgfoid = 'public.handle_invited_user()'::regprocedure")" "$FN_ACL_OWNER:1"
  R3=$(uid 23); signup "$R3" real-attacker2@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$R3"
  check "real definition, after: forged metadata grants nothing" "$(memberships "$R3")" "0"
  check "real definition, after: the malformed-metadata account can now confirm" "$(fails confirm "$R2")" "no"
  qfile "$DEPLOY_MIG" >/dev/null 2>&1; check "deployment copy re-run is a no-op success" "$?" "0"

  qfile "$(deploy_rollback "$PROD_DEF_SQL")" >/dev/null 2>&1; check "deployment rollback with the exact saved artifact applies" "$?" "0"
  check "...restoring the exact production fingerprint, OID and SECURITY DEFINER" "$(fn_state)" "$REAL_STATE"
  check "deployment rollback refuses when the live function is not the hardened one" "$(fails qfile "$(deploy_rollback "$PROD_DEF_SQL")")" "yes"
  R4=$(uid 24); signup "$R4" real-attacker3@example.invalid "{\"org_id\": \"$ORG_B\", \"role\": \"owner\"}"; confirm "$R4"
  check "after rollback the real definition behaves as before (escalation re-opened, as documented)" "$(memberships "$R4")" "1"
  qfile "$DEPLOY_MIG" >/dev/null 2>&1; check "deployment copy re-applies after the rollback" "$?" "0"

  qfile "$(deploy_rollback "$WORK/prod_def_no_cr.sql")" >/dev/null 2>&1
  check "rollback from a line-ending-normalised artifact is accepted by the CR-insensitive check" "$?" "0"
  check "...the restored definition differs from production only in CR bytes" \
    "$(q -c "select md5(replace(pg_get_functiondef('public.handle_invited_user()'::regprocedure), E'\r', ''))")" "$(md5sum < "$WORK/prod_def_no_cr.sql" | cut -c1-32)"
  check "...after which the deployment copy refuses (fingerprint changed: re-run the preflight)" "$(fails qfile "$DEPLOY_MIG")" "yes"
  load_prod_def
  check "re-loading the exact artifact restores the production fingerprint" "$(def_md5)" "$PROD_DEF_MD5"
  q -c "create trigger zz_second_trigger after update on public.profiles for each row execute function public.handle_invited_user()"
  check "deployment copy refuses when a second trigger executes the function" "$(fails qfile "$DEPLOY_MIG")" "yes"
  check "...and leaves the real definition untouched" "$(def_md5)" "$PROD_DEF_MD5"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL PASS"; else echo "$FAILS FAILED"; fi
exit $((FAILS > 0))
