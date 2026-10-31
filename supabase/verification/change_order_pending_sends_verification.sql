-- supabase/verification/change_order_pending_sends_verification.sql
--
-- SQL VERIFICATION for 20261030_change_order_pending_sends.sql.
--
--   *** NEVER RUN AGAINST PRODUCTION OR ANY DATABASE WITH REAL DATA. ***
--
-- Runs the REAL migration functions (prepare/activate/fingerprint) together
-- with the REAL 20260815 change-order functions (send/approve, lifecycle
-- and validation triggers) on PostgreSQL. Self-contained: creates its own
-- synthetic fixtures inside one transaction and ends in ROLLBACK. A guard
-- aborts if the database already has any organization.
--
-- HOW TO RUN (throwaway database, e.g. a disposable container from
-- public.ecr.aws/supabase/postgres):
--   psql -v ON_ERROR_STOP=1 -f change_order_pending_sends_local_schema.sql
--   psql -v ON_ERROR_STOP=1 -f ../migrations/20260815_project_change_orders.sql
--   psql -v ON_ERROR_STOP=1 -f ../migrations/20261030_change_order_pending_sends.sql
--   psql -v ON_ERROR_STOP=1 -f change_order_pending_sends_verification.sql
-- Every row of the final result must be PASS, and the verdict ALL PASS.
-- Concurrency needs two sessions: see change_order_pending_sends_concurrency.sh.
--
-- "Gmail" is simulated exactly as change-order-send.ts behaves: a rejected
-- send discards the pending row (service-role UPDATE); an accepted send
-- calls activate. No network is involved anywhere.

begin;

do $$
begin
  if exists (select 1 from public.organizations) then
    raise exception 'organizations is not empty -- run this only on a throwaway database';
  end if;
end $$;

create temp table vr (n serial, check_name text, pass boolean, detail text) on commit drop;

create function pg_temp.tok(label text) returns text language sql immutable as
  $$ select rpad('tok-' || label || '-', 64, 'x') $$;
create function pg_temp.h(t text) returns text language sql immutable as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.ok(name text, cond boolean, detail text default null) returns void language sql as
  $$ insert into vr (check_name, pass, detail) values (name, coalesce(cond, false), detail) $$;

-- ── fixtures ────────────────────────────────────────────────────────────
insert into public.organizations (id, name) values
  ('a0000000-0000-4000-8000-0000000000a1', 'Org A'),
  ('b0000000-0000-4000-8000-0000000000b1', 'Org B');
insert into public.profiles (id, organization_id, first_name) values
  ('a0000000-0000-4000-8000-00000000a001', 'a0000000-0000-4000-8000-0000000000a1', 'Ann'),
  ('b0000000-0000-4000-8000-00000000b001', 'b0000000-0000-4000-8000-0000000000b1', 'Bob');
insert into public.org_memberships (org_id, member_id, role) values
  ('a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-00000000a001', 'owner'),
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-00000000b001', 'owner');
insert into public.contacts (id, org_id, full_name, email) values
  ('a0000000-0000-4000-8000-00000000c001', 'a0000000-0000-4000-8000-0000000000a1', 'Jane', 'jane@example.invalid');
insert into public.projects (id, org_id, client_id, name) values
  ('a0000000-0000-4000-8000-00000000e001', 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-00000000c001', 'Kitchen');

-- Seven ready_to_send Change Orders in org A, each with two items (2 x 50 + 1 x 150 = 250).
insert into public.project_change_orders (id, org_id, project_id, status, title, description, created_by)
select ('a0000000-0000-4000-8000-00000000c0' || lpad(g::text, 2, '0'))::uuid,
       'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-00000000e001',
       'ready_to_send', 'CO ' || g, 'Scope ' || g, 'a0000000-0000-4000-8000-00000000a001'
from generate_series(11, 17) g;
insert into public.project_change_order_items (org_id, project_id, change_order_id, "position", name, description, quantity, unit_price)
select co.org_id, co.project_id, co.id, x.pos, x.name, x.descr, x.qty, x.price
from public.project_change_orders co
cross join (values (0, 'Shelving', 'Pine shelving', 2::numeric, 50::numeric), (1, 'Install', 'Labor', 1::numeric, 150::numeric)) as x(pos, name, descr, qty, price)
where co.org_id = 'a0000000-0000-4000-8000-0000000000a1';

-- ── 1. privileges / definitions ─────────────────────────────────────────
select pg_temp.ok('grants: anon cannot execute prepare/activate/fingerprint',
  not has_function_privilege('anon', 'public.prepare_project_change_order_send(uuid,uuid,uuid,text,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.activate_project_change_order_send(text)', 'execute')
  and not has_function_privilege('anon', 'public.change_order_terms_fingerprint(uuid)', 'execute'));
select pg_temp.ok('grants: authenticated cannot execute prepare/activate/fingerprint',
  not has_function_privilege('authenticated', 'public.prepare_project_change_order_send(uuid,uuid,uuid,text,timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.activate_project_change_order_send(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.change_order_terms_fingerprint(uuid)', 'execute'));
select pg_temp.ok('grants: service_role can execute prepare/activate',
  has_function_privilege('service_role', 'public.prepare_project_change_order_send(uuid,uuid,uuid,text,timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.activate_project_change_order_send(text)', 'execute'));
select pg_temp.ok('table: anon/authenticated have no privileges on pending_sends',
  not has_table_privilege('anon', 'public.project_change_order_pending_sends', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'public.project_change_order_pending_sends', 'select,insert,update,delete'));
select pg_temp.ok('table: RLS enabled, zero policies',
  (select relrowsecurity from pg_class where oid = 'public.project_change_order_pending_sends'::regclass)
  and not exists (select 1 from pg_policies where tablename = 'project_change_order_pending_sends'));
select pg_temp.ok('functions: prepare/activate SECURITY DEFINER; all pin search_path=public, pg_temp',
  (select bool_and(p.proconfig = array['search_path=public, pg_temp'])
          and bool_and(p.prosecdef) filter (where p.proname <> 'change_order_terms_fingerprint')
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('prepare_project_change_order_send', 'activate_project_change_order_send', 'change_order_terms_fingerprint')),
  (select string_agg(proname || ':' || prosecdef || ':' || coalesce(array_to_string(proconfig, ','), '-'), ' ; ')
     from pg_proc where proname in ('prepare_project_change_order_send', 'activate_project_change_order_send', 'change_order_terms_fingerprint')));
select pg_temp.ok('unknown hash -> not_pending',
  public.activate_project_change_order_send(pg_temp.h('nobody')) ->> 'status' = 'not_pending');

-- ── 2. behavior ─────────────────────────────────────────────────────────
do $$
declare
  org_a constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  org_b constant uuid := 'b0000000-0000-4000-8000-0000000000b1';
  ua constant uuid := 'a0000000-0000-4000-8000-00000000a001';
  ub constant uuid := 'b0000000-0000-4000-8000-00000000b001';
  co1 constant uuid := 'a0000000-0000-4000-8000-00000000c011';
  co2 constant uuid := 'a0000000-0000-4000-8000-00000000c012';
  co3 constant uuid := 'a0000000-0000-4000-8000-00000000c013';
  co4 constant uuid := 'a0000000-0000-4000-8000-00000000c014';
  co5 constant uuid := 'a0000000-0000-4000-8000-00000000c015';
  co6 constant uuid := 'a0000000-0000-4000-8000-00000000c016';
  co7 constant uuid := 'a0000000-0000-4000-8000-00000000c017';
  exp constant timestamptz := now() + interval '30 days';
  r jsonb;
  st text;
  n int;
  err text;
begin
  -- prepare: authoritative totals, pending row only, NOTHING else changes
  r := public.prepare_project_change_order_send(co1, org_a, ua, pg_temp.h(pg_temp.tok('a1')), exp);
  perform pg_temp.ok('prepare: returns DB totals', (r ->> 'totalAmount')::numeric = 250 and r ->> 'isFirstSend' = 'true', r::text);
  perform pg_temp.ok('prepare: status unchanged (ready_to_send)', (select status from public.project_change_orders where id = co1) = 'ready_to_send');
  perform pg_temp.ok('prepare: no access token, no version snapshot',
    not exists (select 1 from public.project_change_order_access_tokens where change_order_id = co1)
    and not exists (select 1 from public.project_change_order_versions where change_order_id = co1));
  perform pg_temp.ok('prepare: pending row stores hash + 64-char fingerprint only',
    exists (select 1 from public.project_change_order_pending_sends
             where change_order_id = co1 and token_hash = pg_temp.h(pg_temp.tok('a1'))
               and length(terms_fingerprint) = 64 and activated_at is null and discarded_at is null));

  -- prepare: tenant isolation + validation
  begin
    perform public.prepare_project_change_order_send(co2, org_a, ub, pg_temp.h(pg_temp.tok('x1')), exp);
    perform pg_temp.ok('prepare: actor from another org refused', false);
  exception when others then
    get stacked diagnostics err = message_text;
    perform pg_temp.ok('prepare: actor from another org refused', err like '%not a member%', err);
  end;
  begin
    perform public.prepare_project_change_order_send(co2, org_b, ub, pg_temp.h(pg_temp.tok('x2')), exp);
    perform pg_temp.ok('prepare: Change Order of another org not found', false);
  exception when others then
    get stacked diagnostics err = message_text;
    perform pg_temp.ok('prepare: Change Order of another org not found', err like '%not found in the specified organization%', err);
  end;
  begin
    perform public.prepare_project_change_order_send(co2, org_a, ua, pg_temp.h(pg_temp.tok('x3')), now() - interval '1 minute');
    perform pg_temp.ok('prepare: past expiry refused', false);
  exception when others then
    perform pg_temp.ok('prepare: past expiry refused', true);
  end;
  begin
    perform public.prepare_project_change_order_send(co2, org_a, ua, 'short', exp);
    perform pg_temp.ok('prepare: short hash refused', false);
  exception when others then
    perform pg_temp.ok('prepare: short hash refused', true);
  end;
  perform pg_temp.ok('prepare: refusals left no pending rows', not exists (select 1 from public.project_change_order_pending_sends where change_order_id = co2));

  -- Gmail rejected (co5): discard, then activation can never make it live
  perform public.prepare_project_change_order_send(co5, org_a, ua, pg_temp.h(pg_temp.tok('rej')), exp);
  update public.project_change_order_pending_sends set discarded_at = now()
   where token_hash = pg_temp.h(pg_temp.tok('rej')) and org_id = org_a and activated_at is null;
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('rej'))) ->> 'status';
  perform pg_temp.ok('gmail rejected: activation -> discarded, nothing sent', st = 'discarded'
    and (select status from public.project_change_orders where id = co5) = 'ready_to_send'
    and not exists (select 1 from public.project_change_order_access_tokens where change_order_id = co5), st);

  -- Gmail accepted (co1): activation makes the SAME hash live and marks sent
  r := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('a1')));
  perform pg_temp.ok('activate: activated with send result', r ->> 'status' = 'activated' and (r -> 'result' ->> 'isFirstSend') = 'true', r::text);
  perform pg_temp.ok('activate: status sent, snapshot written, emailed hash live',
    (select status from public.project_change_orders where id = co1) = 'sent'
    and exists (select 1 from public.project_change_order_versions where change_order_id = co1 and version = 1)
    and exists (select 1 from public.project_change_order_access_tokens where change_order_id = co1
                 and token_hash = pg_temp.h(pg_temp.tok('a1')) and revoked_at is null));
  perform pg_temp.ok('activate: snapshot carries the fingerprinted total',
    (select (snapshot ->> 'totalAmount')::numeric from public.project_change_order_versions where change_order_id = co1) = 250);
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('a1'))) ->> 'status';
  select count(*) into n from public.project_change_order_access_tokens where change_order_id = co1 and revoked_at is null;
  perform pg_temp.ok('activate twice: already_active, link NOT revoked, one live token', st = 'already_active' and n = 1, st || ' live=' || n);

  -- customer approval through the real token-gated RPC works on an activated link
  r := public.approve_project_change_order(pg_temp.tok('a1'), 'Jane', 'jane@example.invalid', 'I approve', null, null, null);
  perform pg_temp.ok('approve: activated pending link approves via approve_project_change_order',
    (select status from public.project_change_orders where id = co1) = 'approved', r::text);

  -- stale content: edit an item description only (total unchanged)
  perform public.prepare_project_change_order_send(co2, org_a, ua, pg_temp.h(pg_temp.tok('c2')), exp);
  update public.project_change_order_items set description = 'Oak shelving' where change_order_id = co2 and "position" = 0;
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c2'))) ->> 'status';
  perform pg_temp.ok('stale: item description edited (same total) -> changed, not sent',
    st = 'changed'
    and (select status from public.project_change_orders where id = co2) = 'ready_to_send'
    and (select discarded_at is not null from public.project_change_order_pending_sends where token_hash = pg_temp.h(pg_temp.tok('c2')))
    and not exists (select 1 from public.project_change_order_access_tokens where change_order_id = co2), st);

  -- stale content: quantities/rates rebalanced to the SAME total (2x50 -> 1x100)
  perform public.prepare_project_change_order_send(co3, org_a, ua, pg_temp.h(pg_temp.tok('c3')), exp);
  update public.project_change_order_items set quantity = 1, unit_price = 100 where change_order_id = co3 and "position" = 0;
  perform pg_temp.ok('stale: rebalanced line keeps the total identical', (select total_amount from public.calculate_change_order_totals(co3)) = 250);
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c3'))) ->> 'status';
  perform pg_temp.ok('stale: qty/rate change with same total -> changed', st = 'changed', st);

  -- stale content: approval deadline / customer message changes
  perform public.prepare_project_change_order_send(co6, org_a, ua, pg_temp.h(pg_temp.tok('c6a')), exp);
  update public.project_change_orders set customer_message = 'New terms: payment due on start' where id = co6;
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c6a'))) ->> 'status';
  perform pg_temp.ok('stale: customer message edited -> changed', st = 'changed', st);

  -- internal-only edits do NOT invalidate the emailed link
  perform public.prepare_project_change_order_send(co4, org_a, ua, pg_temp.h(pg_temp.tok('c4')), exp);
  update public.project_change_orders set internal_notes = 'call supplier' where id = co4;
  update public.project_change_order_items set internal_cost = 20 where change_order_id = co4;
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c4'))) ->> 'status';
  perform pg_temp.ok('internal-only edits (notes, internal cost) still activate', st = 'activated', st);

  -- resend: new emailed link revokes the old live one (existing semantics, "resent" audit)
  perform public.prepare_project_change_order_send(co4, org_a, ua, pg_temp.h(pg_temp.tok('c4b')), exp);
  perform pg_temp.ok('resend prepare: old link still live while the new one is pending',
    exists (select 1 from public.project_change_order_access_tokens where token_hash = pg_temp.h(pg_temp.tok('c4')) and revoked_at is null));
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c4b'))) ->> 'status';
  perform pg_temp.ok('resend activate: old link revoked, new live, resent audit row',
    st = 'activated'
    and exists (select 1 from public.project_change_order_access_tokens where token_hash = pg_temp.h(pg_temp.tok('c4')) and revoked_at is not null)
    and exists (select 1 from public.project_change_order_access_tokens where token_hash = pg_temp.h(pg_temp.tok('c4b')) and revoked_at is null)
    and exists (select 1 from public.project_change_order_approvals where change_order_id = co4 and action = 'resent'), st);

  -- supersession: two pending links; activating the newer discards the older
  perform public.prepare_project_change_order_send(co4, org_a, ua, pg_temp.h(pg_temp.tok('c4old')), exp);
  update public.project_change_order_pending_sends set created_at = now() - interval '5 minutes' where token_hash = pg_temp.h(pg_temp.tok('c4old'));
  perform public.prepare_project_change_order_send(co4, org_a, ua, pg_temp.h(pg_temp.tok('c4new')), exp);
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c4new'))) ->> 'status';
  perform pg_temp.ok('supersede: newer activated, older discarded -> its later use cannot revoke the newer',
    st = 'activated'
    and public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c4old'))) ->> 'status' = 'discarded'
    and exists (select 1 from public.project_change_order_access_tokens where token_hash = pg_temp.h(pg_temp.tok('c4new')) and revoked_at is null), st);

  -- expiry
  perform public.prepare_project_change_order_send(co6, org_a, ua, pg_temp.h(pg_temp.tok('c6b')), exp);
  update public.project_change_order_pending_sends set expires_at = now() - interval '1 second' where token_hash = pg_temp.h(pg_temp.tok('c6b'));
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c6b'))) ->> 'status';
  perform pg_temp.ok('expired pending link -> expired, not sent', st = 'expired'
    and (select status from public.project_change_orders where id = co6) = 'ready_to_send', st);

  -- not sendable: Change Order cancelled while its link was pending
  perform public.prepare_project_change_order_send(co6, org_a, ua, pg_temp.h(pg_temp.tok('c6c')), exp);
  update public.project_change_orders set status = 'cancelled', cancelled_at = now() where id = co6;
  st := public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('c6c'))) ->> 'status';
  perform pg_temp.ok('cancelled while pending -> not_sendable, stays cancelled', st = 'not_sendable'
    and (select status from public.project_change_orders where id = co6) = 'cancelled', st);

  -- compatibility: a link issued by the unchanged direct send RPC (link-only path / pre-existing links)
  r := public.send_project_change_order(co7, org_a, ua, pg_temp.h(pg_temp.tok('legacy')), exp);
  perform pg_temp.ok('legacy: direct send still works', (select status from public.project_change_orders where id = co7) = 'sent', r::text);
  perform pg_temp.ok('legacy: activation of a non-pending link is a no-op',
    public.activate_project_change_order_send(pg_temp.h(pg_temp.tok('legacy'))) ->> 'status' = 'not_pending'
    and (select count(*) from public.project_change_order_access_tokens where change_order_id = co7) = 1);
  r := public.approve_project_change_order(pg_temp.tok('legacy'), 'Jane', 'jane@example.invalid', 'I approve', null, null, null);
  perform pg_temp.ok('legacy: existing link approves exactly as before',
    (select status from public.project_change_orders where id = co7) = 'approved', r::text);

  -- tenant: an activation can only ever touch its own org's Change Order
  perform pg_temp.ok('tenant: every pending row belongs to the same org/project as its Change Order',
    not exists (select 1 from public.project_change_order_pending_sends ps
                 join public.project_change_orders co on co.id = ps.change_order_id
                where ps.org_id <> co.org_id or ps.project_id <> co.project_id));
end $$;

select n, case when pass then 'PASS' else 'FAIL' end as result, check_name, detail from vr order by n;
select case when bool_and(pass) then 'ALL PASS (' || count(*) || ' checks)' else 'FAILURES: ' || count(*) filter (where not pass) end as verdict from vr;

rollback;
