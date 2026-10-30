#!/usr/bin/env bash
# supabase/verification/change_order_pending_sends_concurrency.sh
#
# Multi-session checks for 20261030_change_order_pending_sends.sql.
#
#   *** THROWAWAY DATABASE ONLY. NEVER RUN AGAINST PRODUCTION. ***
#
# Needs the same setup as change_order_pending_sends_verification.sql (local
# schema + 20260815 + 20261030 applied). It COMMITS synthetic fixtures
# (org "zz-concurrency", fixed UUIDs) so separate sessions can see them, and
# deletes them again at the end. Refuses to run if the database has any
# organization other than its own fixture.
#
# Every RPC call runs as `service_role` (what PostgREST uses for the Netlify
# functions), not as the superuser.
#
# Usage:  PSQL="psql postgresql://..." ./change_order_pending_sends_concurrency.sh
#   e.g.  PSQL="docker exec -i <container> psql -U postgres" ./change_order_pending_sends_concurrency.sh

set -uo pipefail
PSQL=${PSQL:-psql}
q() { $PSQL -v ON_ERROR_STOP=1 -qAt "$@"; }

ORG=c0000000-0000-4000-8000-0000000000c1
USR=c0000000-0000-4000-8000-00000000c0a1
CON=c0000000-0000-4000-8000-00000000c0c1
PRJ=c0000000-0000-4000-8000-00000000c0e1
CO1=c0000000-0000-4000-8000-00000000c101
CO2=c0000000-0000-4000-8000-00000000c102
CO3=c0000000-0000-4000-8000-00000000c103
h() { printf "encode(sha256(convert_to(rpad('tok-%s-', 64, 'x'), 'UTF8')), 'hex')" "$1"; }
EXP="now() + interval '30 days'"
FAILS=0
S1OUT=$(mktemp)
trap 'rm -f "$S1OUT"' EXIT
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1  (expected '$3', got '$2')"; FAILS=$((FAILS + 1)); fi; }

if [ "$(q -c "select count(*) from public.organizations where id <> '$ORG'")" != "0" ]; then
  echo "Refusing to run: this database has real organizations." >&2; exit 2
fi

cleanup() {
  q -c "delete from public.project_change_order_pending_sends where org_id = '$ORG';
        delete from public.project_change_order_approvals where org_id = '$ORG';
        delete from public.project_change_order_access_tokens where org_id = '$ORG';
        delete from public.project_change_order_versions where org_id = '$ORG';
        delete from public.project_change_order_items where org_id = '$ORG';
        delete from public.project_change_orders where org_id = '$ORG';
        delete from public.projects where org_id = '$ORG';
        delete from public.contacts where org_id = '$ORG';
        delete from public.org_memberships where org_id = '$ORG';
        delete from public.profiles where id = '$USR';
        delete from public.organizations where id = '$ORG';" >/dev/null
}
cleanup

q <<SQL >/dev/null
insert into public.organizations (id, name) values ('$ORG', 'zz-concurrency');
insert into public.profiles (id, organization_id) values ('$USR', '$ORG');
insert into public.org_memberships (org_id, member_id, role) values ('$ORG', '$USR', 'owner');
insert into public.contacts (id, org_id, full_name) values ('$CON', '$ORG', 'C');
insert into public.projects (id, org_id, client_id, name) values ('$PRJ', '$ORG', '$CON', 'P');
insert into public.project_change_orders (id, org_id, project_id, status, title, created_by)
  values ('$CO1', '$ORG', '$PRJ', 'ready_to_send', 'C1', '$USR'),
         ('$CO2', '$ORG', '$PRJ', 'ready_to_send', 'C2', '$USR'),
         ('$CO3', '$ORG', '$PRJ', 'ready_to_send', 'C3', '$USR');
insert into public.project_change_order_items (org_id, project_id, change_order_id, name, quantity, unit_price)
  select '$ORG', '$PRJ', id, 'Item', 1, 100 from public.project_change_orders where org_id = '$ORG';
SQL

as_service() { q -c "set role service_role; $1"; }
prepare() { as_service "select public.prepare_project_change_order_send('$1', '$ORG', '$USR', $(h "$2"), $EXP) is not null"; }

# ── 0. role boundary, exercised for real (not just has_*_privilege) ──────
out=$(q -c "set role authenticated; select public.prepare_project_change_order_send('$CO1', '$ORG', '$USR', $(h x), $EXP);" 2>&1)
check "authenticated cannot EXECUTE prepare" "$(echo "$out" | grep -c 'permission denied')" "1"
out=$(q -c "set role anon; select public.activate_project_change_order_send($(h x));" 2>&1)
check "anon cannot EXECUTE activate" "$(echo "$out" | grep -c 'permission denied')" "1"
out=$(q -c "set role authenticated; select count(*) from public.project_change_order_pending_sends;" 2>&1)
check "authenticated cannot SELECT pending_sends" "$(echo "$out" | grep -c 'permission denied')" "1"

# ── 1. the SAME link activated by two sessions at once ───────────────────
prepare "$CO1" same >/dev/null
( q <<< "set role service_role; begin; select public.activate_project_change_order_send($(h same)) ->> 'status'; select pg_sleep(3); commit;" > "$S1OUT" 2>&1 ) &
sleep 1
start=$(date +%s)
s2=$(as_service "select public.activate_project_change_order_send($(h same)) ->> 'status'" 2>&1)
waited=$(( $(date +%s) - start ))
wait
s1=$(grep -E '^(activated|already_active|changed|discarded)' "$S1OUT")
check "same link: first session activated" "$s1" "activated"
check "same link: second session waited for the lock, then already_active" "$s2" "already_active"
check "same link: second session actually blocked (>=1s)" "$([ $waited -ge 1 ] && echo yes || echo no)" "yes"
check "same link: exactly one access token, live" \
  "$(q -c "select count(*) || ':' || count(*) filter (where revoked_at is null) from public.project_change_order_access_tokens where change_order_id = '$CO1'")" "1:1"
check "same link: status sent" "$(q -c "select status from public.project_change_orders where id = '$CO1'")" "sent"

# ── 2. two DIFFERENT pending links for one Change Order activated at once ─
prepare "$CO2" first >/dev/null
sleep 1
prepare "$CO2" second >/dev/null
( q <<< "set role service_role; begin; select public.activate_project_change_order_send($(h first)) ->> 'status'; select pg_sleep(3); commit;" > "$S1OUT" 2>&1 ) &
sleep 1
s2=$(as_service "select public.activate_project_change_order_send($(h second)) ->> 'status'" 2>&1)
wait
s1=$(grep -E '^(activated|already_active|changed|discarded)' "$S1OUT")
check "two links: no deadlock, both complete (first)" "$s1" "activated"
check "two links: no deadlock, both complete (second = newer resend)" "$s2" "activated"
check "two links: exactly one live token, the newer link's" \
  "$(q -c "select string_agg(case when token_hash = $(h second) then 'second' else 'first' end, ',') from public.project_change_order_access_tokens where change_order_id = '$CO2' and revoked_at is null")" "second"
check "two links: one 'resent' audit row" \
  "$(q -c "select count(*) from public.project_change_order_approvals where change_order_id = '$CO2' and action = 'resent'")" "1"

# ── 3. prepare while an activation holds the Change Order lock ───────────
prepare "$CO3" held >/dev/null
( q <<< "set role service_role; begin; select public.activate_project_change_order_send($(h held)) ->> 'status'; select pg_sleep(3); commit;" > "$S1OUT" 2>&1 ) &
sleep 1
s2=$(prepare "$CO3" during 2>&1)
wait
check "prepare during activation: waits, then succeeds" "$s2" "t"
check "prepare during activation: new link pending, not live" \
  "$(q -c "select (activated_at is null and discarded_at is null)::text from public.project_change_order_pending_sends where token_hash = $(h during)")" "true"
check "prepare during activation: activating it later is a normal resend" \
  "$(as_service "select public.activate_project_change_order_send($(h during)) ->> 'status'")" "activated"

# ── 4. a failure inside send rolls back the whole activation ─────────────
prepare "$CO1" rollback >/dev/null
# Make send_project_change_order() raise (membership check) by removing the sender's org links.
q -c "update public.profiles set organization_id = null where id = '$USR'; delete from public.org_memberships where member_id = '$USR';" >/dev/null
out=$(as_service "select public.activate_project_change_order_send($(h rollback))" 2>&1)
check "send failure: activation raises" "$(echo "$out" | grep -c 'not a member')" "1"
check "send failure: pending row left pending (rolled back), retryable" \
  "$(q -c "select (activated_at is null and discarded_at is null)::text from public.project_change_order_pending_sends where token_hash = $(h rollback)")" "true"
q -c "update public.profiles set organization_id = '$ORG' where id = '$USR'; insert into public.org_memberships (org_id, member_id, role) values ('$ORG', '$USR', 'owner');" >/dev/null
check "send failure: retry after the cause is fixed activates" \
  "$(as_service "select public.activate_project_change_order_send($(h rollback)) ->> 'status'")" "activated"

cleanup
echo
if [ "$FAILS" = "0" ]; then echo "ALL PASS"; else echo "$FAILS FAILURE(S)"; exit 1; fi
