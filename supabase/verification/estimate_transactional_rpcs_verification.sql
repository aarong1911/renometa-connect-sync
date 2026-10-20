-- supabase/verification/estimate_transactional_rpcs_verification.sql
--
-- MANUAL SQL VERIFICATION for 20261017_estimate_transactional_rpcs.sql.
--
--   *** NOT AN AUTOMATED TEST. NOT RUN BY `pnpm test`. NEVER RUN AGAINST PRODUCTION. ***
--
-- SELF-CONTAINED, LOCAL ONLY. Run it against the LOCAL Supabase database after loading
-- supabase/verification/estimate_transactional_rpcs_local_schema.sql and applying the RPC migration. It creates ALL the synthetic
-- fixture rows it needs (auth users, organizations, profiles, memberships, contacts, leads, projects) inside its own
-- transaction, runs every check, and ends in ROLLBACK, so no fixture or test data persists. Nothing needs to be filled in.
-- It also creates throwaway helper objects (a schema `zz_verify` and a failure-injection trigger); the ROLLBACK removes them.
--
--   *** NEVER RUN THIS AGAINST PRODUCTION OR ANY DATABASE WITH REAL DATA. ***
--   It inserts into auth.users and disables/creates triggers. A guard below ABORTS if the database already contains any
--   organization, profile or auth user, so it can only run on an empty local reconstruction.
--
-- WHY THIS EXISTS: the all-or-nothing guarantees are properties of PL/pgSQL running in Postgres. The TypeScript
-- tests only prove the callers' payloads / error mapping; they cannot prove atomicity. This script is the SQL-level
-- check. (A throwaway in-process-Postgres smoke run against a RECONSTRUCTED stand-in schema was done during
-- development, but that is NOT proof against the live schema, its RLS policies, or its other triggers.)
--
-- HOW TO RUN (local psql, after the schema script and the migration):
--   psql "<local db url>" -v ON_ERROR_STOP=1 -f supabase/verification/estimate_transactional_rpcs_verification.sql
--   Read the result set at the end: every row must say PASS and the verdict must be ALL PASS. A FAIL (or any error, which
--   aborts the transaction loudly) means: do not ship.
--
-- SYNTHETIC FIXTURES CREATED (fixed fake UUIDs, .invalid emails; all removed by the final ROLLBACK):
--   org A  a0a0a0a0-0000-4000-8000-0000000000a1   user_a (profile in org A + owner membership)
--          user_m (membership ONLY, no profile org)   contact_a, lead_a (-> contact_a), project_a
--   org B  b0b0b0b0-0000-4000-8000-0000000000b1   user_b (profile in org B + owner membership)
--          contact_b, lead_b (-> contact_b), project_b
--
-- NOT COVERED HERE (needs two sessions, see the MANUAL CONCURRENCY PROCEDURE at the bottom).

begin;

create schema zz_verify;                      -- throwaway helpers; removed by the final ROLLBACK
grant usage on schema zz_verify to public;
create table zz_verify.fx (k text primary key, v text not null);
insert into zz_verify.fx values
  ('org_a',     'a0a0a0a0-0000-4000-8000-0000000000a1'),
  ('user_a',    'a0a0a0a0-0000-4000-8000-0000000000a2'),   -- member of org A via profiles.organization_id (+ owner membership)
  ('user_m',    'a0a0a0a0-0000-4000-8000-0000000000a3'),   -- member of org A via org_memberships ONLY
  ('contact_a', 'a0a0a0a0-0000-4000-8000-0000000000a4'),
  ('lead_a',    'a0a0a0a0-0000-4000-8000-0000000000a5'),
  ('project_a', 'a0a0a0a0-0000-4000-8000-0000000000a6'),
  ('org_b',     'b0b0b0b0-0000-4000-8000-0000000000b1'),
  ('user_b',    'b0b0b0b0-0000-4000-8000-0000000000b2'),   -- member of org B ONLY
  ('contact_b', 'b0b0b0b0-0000-4000-8000-0000000000b4'),
  ('lead_b',    'b0b0b0b0-0000-4000-8000-0000000000b5'),
  ('project_b', 'b0b0b0b0-0000-4000-8000-0000000000b6');

create table zz_verify.results (n serial primary key, test text, outcome text, detail text);
grant all on zz_verify.results, zz_verify.fx to public;       -- the checks below switch roles
grant all on sequence zz_verify.results_n_seq to public;

create function zz_verify.id(p text) returns uuid language sql stable as $$ select v::uuid from zz_verify.fx where k = p $$;
create function zz_verify.record(p_test text, p_ok boolean, p_detail text default null) returns void language sql as
$$ insert into zz_verify.results (test, outcome, detail) values (p_test, case when p_ok then 'PASS' else 'FAIL' end, p_detail) $$;
grant execute on all functions in schema zz_verify to public;

-- ── 0a. SAFETY GUARD: only an EMPTY local reconstruction may run this script ─────────────────────────────
do $$ begin
  if exists (select 1 from public.organizations) or exists (select 1 from public.profiles) or exists (select 1 from auth.users) then
    raise exception 'Refusing to run: this database already contains organizations/profiles/auth users. This script is LOCAL-ONLY and creates its own synthetic fixtures; run it on an EMPTY local reconstruction (estimate_transactional_rpcs_local_schema.sql).';
  end if;
end $$;

-- ── 0b. SYNTHETIC FIXTURES (inserted as the connecting local role; removed by the final ROLLBACK) ───────
-- Respects the real constraints: profiles.id -> auth.users.id; contacts carry org_id EXPLICITLY (the production
-- contact-org triggers are intentionally not part of the local schema); estimates.created_by is supplied by the RPC.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select zz_verify.id(v.k), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  from (values ('user_a', 'local-rpc-test-a@example.invalid'),
               ('user_m', 'local-rpc-test-m@example.invalid'),
               ('user_b', 'local-rpc-test-b@example.invalid')) as v(k, email);

insert into public.organizations (id, name) values
  (zz_verify.id('org_a'), 'LOCAL RPC TEST ORG A'),
  (zz_verify.id('org_b'), 'LOCAL RPC TEST ORG B');

insert into public.profiles (id, email, organization_id, role) values
  (zz_verify.id('user_a'), 'local-rpc-test-a@example.invalid', zz_verify.id('org_a'), 'owner'),
  (zz_verify.id('user_m'), 'local-rpc-test-m@example.invalid', null,                  'estimator'),
  (zz_verify.id('user_b'), 'local-rpc-test-b@example.invalid', zz_verify.id('org_b'), 'owner');

insert into public.org_memberships (org_id, member_id, role) values
  (zz_verify.id('org_a'), zz_verify.id('user_a'), 'owner'),
  (zz_verify.id('org_a'), zz_verify.id('user_m'), 'estimator'),
  (zz_verify.id('org_b'), zz_verify.id('user_b'), 'owner');

insert into public.contacts (id, org_id, full_name) values
  (zz_verify.id('contact_a'), zz_verify.id('org_a'), 'Local RPC Test Contact A'),
  (zz_verify.id('contact_b'), zz_verify.id('org_b'), 'Local RPC Test Contact B');

insert into public.leads (id, org_id, contact_id, status) values
  (zz_verify.id('lead_a'), zz_verify.id('org_a'), zz_verify.id('contact_a'), 'new'),
  (zz_verify.id('lead_b'), zz_verify.id('org_b'), zz_verify.id('contact_b'), 'new');

insert into public.projects (id, org_id, name, client_id) values
  (zz_verify.id('project_a'), zz_verify.id('org_a'), 'Local RPC Test Project A', zz_verify.id('contact_a')),
  (zz_verify.id('project_b'), zz_verify.id('org_b'), 'Local RPC Test Project B', zz_verify.id('contact_b'));

do $$ begin
  if (select count(*) from public.organizations) <> 2 or (select count(*) from public.profiles) <> 3
     or (select count(*) from public.contacts) <> 2 or (select count(*) from public.leads) <> 2
     or (select count(*) from public.projects) <> 2 or (select count(*) from public.org_memberships) <> 3 then
    raise exception 'Fixture sanity check failed: unexpected row counts after inserting the synthetic fixtures.';
  end if;
end $$;

-- ── 0. STATIC: security mode, grants, search_path ───────────────────────────────────────────────
select zz_verify.record('0.1 create_ + add_ are SECURITY DEFINER, replace_ is SECURITY INVOKER',
  (select bool_and(case p.proname when 'replace_estimate_items_transaction' then not p.prosecdef else p.prosecdef end)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_estimate_draft_transaction','add_estimate_line_items_transaction','replace_estimate_items_transaction')));

select zz_verify.record('0.2 all three pin search_path (pg_catalog first, pg_temp last)',
  (select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=pg_catalog%pg_temp'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_estimate_draft_transaction','add_estimate_line_items_transaction','replace_estimate_items_transaction')));

select zz_verify.record('0.3 create_/add_ EXECUTE: service_role yes; anon + authenticated NO',
  has_function_privilege('service_role', 'public.create_estimate_draft_transaction(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text)', 'execute')
  and has_function_privilege('service_role', 'public.add_estimate_line_items_transaction(uuid,uuid,jsonb,text)', 'execute')
  and not has_function_privilege('anon', 'public.create_estimate_draft_transaction(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_estimate_draft_transaction(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text)', 'execute')
  and not has_function_privilege('anon', 'public.add_estimate_line_items_transaction(uuid,uuid,jsonb,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.add_estimate_line_items_transaction(uuid,uuid,jsonb,text)', 'execute'));

select zz_verify.record('0.4 replace_: authenticated ONLY (anon, service_role NO)',
  has_function_privilege('authenticated', 'public.replace_estimate_items_transaction(uuid,jsonb,jsonb,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.replace_estimate_items_transaction(uuid,jsonb,jsonb,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.replace_estimate_items_transaction(uuid,jsonb,jsonb,jsonb)', 'execute'));

select zz_verify.record('0.4b normalize helper: NO application role can execute it directly',
  not has_function_privilege('anon', 'public.estimate_rpc_normalize_ai_items(jsonb,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.estimate_rpc_normalize_ai_items(jsonb,integer,integer)', 'execute')
  and not has_function_privilege('service_role', 'public.estimate_rpc_normalize_ai_items(jsonb,integer,integer)', 'execute'));

select zz_verify.record('0.5 the live estimate triggers are all still present and enabled',
  (select count(*) = 8 from pg_trigger t where t.tgrelid = 'public.estimates'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
      and t.tgname in ('estimates_set_number','estimates_validate_relationships','estimates_log_activity','estimates_prevent_number_change','trg_sync_total','on_estimate_update','estimate_sent_trigger','estimates_link_approved_contract')),
  (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'public.estimates'::regclass and not tgisinternal));

select zz_verify.record('0.6 on_estimate_update trigger function sync_project_estimate_total is hardened: own search_path = pg_catalog, pg_temp, SECURITY INVOKER, schema-qualified public.projects (and the trigger still points at it)',
  (select p.proconfig @> array['search_path=pg_catalog, pg_temp'] and not p.prosecdef
          and p.prosrc ~* 'update\s+public\.projects' and p.prosrc !~* 'update\s+projects'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_project_estimate_total')
  and exists (select 1 from pg_trigger t where t.tgrelid = 'public.estimates'::regclass and t.tgname = 'on_estimate_update' and not t.tgisinternal
                 and t.tgfoid = 'public.sync_project_estimate_total()'::regprocedure));

-- failure injection: any estimate_items insert named FORCE_FAIL raises (trigger + schema removed by the final ROLLBACK)
create function zz_verify.force_fail() returns trigger language plpgsql as $$ begin
  if new.name = 'FORCE_FAIL' then raise exception 'forced item failure'; end if; return new; end $$;
create trigger zz_force_fail before insert on public.estimate_items for each row execute function zz_verify.force_fail();
grant execute on function zz_verify.force_fail() to public;

-- ── 1. create_estimate_draft_transaction (run as service_role, exactly as the Netlify handler does) ──
set local role service_role;

do $$
declare r jsonb; e record; n_items int; n_created int; a record; before_cnt int; err text;
begin
  -- 1.1 header + ALL items + one attributed `created` activity, hardcoded money
  r := public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), zz_verify.id('lead_a'), null,
        'VERIFY create', 'scope', '[{"name":"V Cabinets","itemType":"material"},{"name":"V Counters","description":"Quartz"},{"name":"V Labor","itemType":"labor"}]'::jsonb, 'verify-exec-1');
  select * into e from public.estimates where id = (r->>'estimate_id')::uuid;
  select count(*) into n_items from public.estimate_items where estimate_id = e.id;
  perform zz_verify.record('1.1 header and all 3 items were created together', n_items = 3 and e.status = 'draft' and e.created_by = zz_verify.id('user_a') and e.org_id = zz_verify.id('org_a') and e.number is not null);
  perform zz_verify.record('1.2 every item is a $0 pending placeholder (qty 1, unit_price 0, total 0, price_pending, ai_execution_id)',
    (select bool_and(unit_price = 0 and total = 0 and quantity = 1 and (metadata->>'price_pending')::boolean and metadata->>'ai_execution_id' = 'verify-exec-1' and not is_heading) from public.estimate_items where estimate_id = e.id));
  perform zz_verify.record('1.3 header money is zero and total = client_total (trg_sync_total contract)', e.total = 0 and e.client_total = 0 and e.subtotal = 0 and e.tax_total = 0 and e.discount_total = 0);
  select count(*) into n_created from public.estimate_activities where estimate_id = e.id and activity_type = 'created';
  select * into a from public.estimate_activities where estimate_id = e.id and activity_type = 'created' limit 1;
  perform zz_verify.record('1.4 exactly ONE created activity, attributed to the verified approver (user), not system', n_created = 1 and a.actor_id = zz_verify.id('user_a') and a.actor_type = 'user', coalesce(a.actor_type, 'none'));

  -- 1.5 replay with the same execution id: same estimate, nothing duplicated
  r := public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), zz_verify.id('lead_a'), null,
        'VERIFY create', 'scope', '[{"name":"V Cabinets"}]'::jsonb, 'verify-exec-1');
  perform zz_verify.record('1.5 replay returns the EXISTING estimate (already_created) and creates nothing more',
    (r->>'already_created')::boolean and (r->>'estimate_id')::uuid = e.id
    and (select count(*) from public.estimates where metadata->>'ai_execution_id' = 'verify-exec-1') = 1
    and (select count(*) from public.estimate_items where estimate_id = e.id) = 3
    and (select count(*) from public.estimate_activities where estimate_id = e.id and activity_type = 'created') = 1);

  -- 1.6 FORCED item failure => NO header, NO items, NO activity remain
  select count(*) into before_cnt from public.estimates where org_id = zz_verify.id('org_a');
  begin
    perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, null, 'VERIFY forced failure', null,
        '[{"name":"ok one"},{"name":"FORCE_FAIL"},{"name":"ok three"}]'::jsonb, 'verify-exec-fail');
    err := null;
  exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.6 FORCED item failure rolls back the header, items and activity (nothing remains)',
    err like '%forced item failure%'
    and (select count(*) from public.estimates where org_id = zz_verify.id('org_a')) = before_cnt
    and not exists (select 1 from public.estimates where metadata->>'ai_execution_id' = 'verify-exec-fail')
    and not exists (select 1 from public.estimate_items where metadata->>'ai_execution_id' = 'verify-exec-fail'), coalesce(err, 'no error raised'));

  -- 1.7 tenant / attribution / money guards (each must raise the documented code and write nothing)
  begin perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_b'), zz_verify.id('contact_a'), null, null, 'x', null, '[{"name":"x"}]'::jsonb, 'verify-g1'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.7a approver from ANOTHER org => attribution_required', err like '%estimate_rpc:attribution_required%', coalesce(err, 'no error'));
  begin perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_b'), null, null, 'x', null, '[{"name":"x"}]'::jsonb, 'verify-g2'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.7b foreign-org contact => not_found', err like '%estimate_rpc:not_found%', coalesce(err, 'no error'));
  begin perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), zz_verify.id('lead_b'), null, 'x', null, '[{"name":"x"}]'::jsonb, 'verify-g3'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.7c foreign-org lead => not_found', err like '%estimate_rpc:not_found%', coalesce(err, 'no error'));
  begin perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, zz_verify.id('project_b'), 'x', null, '[{"name":"x"}]'::jsonb, 'verify-g4'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.7d foreign-org project => not_found', err like '%estimate_rpc:not_found%', coalesce(err, 'no error'));
  begin perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, null, 'x', null, '[{"name":"x","unitPrice":5}]'::jsonb, 'verify-g5'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('1.7e a money key in an item (unitPrice) is rejected in SQL => invalid_item_field', err like '%estimate_rpc:invalid_item_field%', coalesce(err, 'no error'));
  -- 1.8 a membership-only approver (org_memberships, no profiles.organization_id) is accepted and attributed
  r := public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_m'), zz_verify.id('contact_a'), null, null, 'VERIFY membership approver', null, '[{"name":"m"}]'::jsonb, 'verify-member-1');
  perform zz_verify.record('1.8 membership-only approver accepted; estimate created_by and the created activity both name that user',
    (select e2.created_by = zz_verify.id('user_m') from public.estimates e2 where e2.id = (r->>'estimate_id')::uuid)
    and (select count(*) = 1 and bool_and(a2.actor_type = 'user' and a2.actor_id = zz_verify.id('user_m'))
           from public.estimate_activities a2 where a2.estimate_id = (r->>'estimate_id')::uuid and a2.activity_type = 'created'));
  perform zz_verify.record('1.7f none of the rejected calls wrote anything', not exists (select 1 from public.estimates where metadata->>'ai_execution_id' like 'verify-g%'));
end $$;

-- ── 1b. STRICT attribution: a missing or ambiguous 'created' activity rolls the WHOLE create back ─────
reset role;
do $$
declare err text; n0 int; ok boolean;
begin
  select count(*) into n0 from public.estimates where org_id = zz_verify.id('org_a');

  -- (a) MISSING: with the activity trigger disabled there is no system 'created' row to attribute
  alter table public.estimates disable trigger estimates_log_activity;
  set local role service_role;
  begin
    perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, null, 'VERIFY no-activity', null, '[{"name":"a"}]'::jsonb, 'verify-b2-missing');
    err := null;
  exception when others then err := sqlerrm; end;
  reset role;
  alter table public.estimates enable trigger estimates_log_activity;
  perform zz_verify.record('1b.1 ZERO matching created activity => attribution_failed and the whole create rolled back (no header, no fabricated activity)',
    err like '%estimate_rpc:attribution_failed%'
    and (select count(*) from public.estimates where org_id = zz_verify.id('org_a')) = n0
    and not exists (select 1 from public.estimates where metadata->>'ai_execution_id' = 'verify-b2-missing')
    and not exists (select 1 from public.estimate_activities where metadata->>'ai_execution_id' = 'verify-b2-missing'), coalesce(err, 'no error'));

  -- (b) AMBIGUOUS: a second trigger writes a SECOND system 'created' row
  create function zz_verify.dup_created() returns trigger language plpgsql security definer as $f$
  begin
    insert into public.estimate_activities (org_id, estimate_id, version_number, activity_type, actor_id, actor_type, title)
    values (new.org_id, new.id, new.version_number, 'created', null, 'system', 'duplicate created');
    return new;
  end $f$;
  create trigger zz_dup_created after insert on public.estimates for each row execute function zz_verify.dup_created();
  set local role service_role;
  begin
    perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, null, 'VERIFY dup-activity', null, '[{"name":"a"}]'::jsonb, 'verify-b2-multi');
    err := null;
  exception when others then err := sqlerrm; end;
  reset role;
  drop trigger zz_dup_created on public.estimates;
  perform zz_verify.record('1b.2 TWO matching created activities => attribution_failed and the whole create rolled back',
    err like '%estimate_rpc:attribution_failed%'
    and (select count(*) from public.estimates where org_id = zz_verify.id('org_a')) = n0
    and not exists (select 1 from public.estimates where metadata->>'ai_execution_id' = 'verify-b2-multi'), coalesce(err, 'no error'));

  -- (c) the normal path still attributes exactly one row, merging (not replacing) the trigger row's metadata
  set local role service_role;
  perform public.create_estimate_draft_transaction(zz_verify.id('org_a'), zz_verify.id('user_a'), zz_verify.id('contact_a'), null, null, 'VERIFY merge', null, '[{"name":"a"}]'::jsonb, 'verify-b2-ok');
  reset role;
  perform zz_verify.record('1b.3 normal path: one user-attributed created row, metadata carries attributed_via + originally_recorded_as + ai_execution_id',
    (select count(*) = 1 and bool_and(a.actor_type = 'user' and a.actor_id = zz_verify.id('user_a') and a.metadata ? 'attributed_via' and a.metadata->>'originally_recorded_as' = 'system' and a.metadata->>'ai_execution_id' = 'verify-b2-ok')
       from public.estimate_activities a join public.estimates e on e.id = a.estimate_id
      where e.metadata->>'ai_execution_id' = 'verify-b2-ok' and a.activity_type = 'created'));
end $$;
set local role service_role;

-- ── 2. add_estimate_line_items_transaction (service_role) ───────────────────────────────────────
do $$
declare est uuid; r jsonb; err text; items_before int; tot_before numeric; ids_before text; e record;
begin
  select id into est from public.estimates where metadata->>'ai_execution_id' = 'verify-exec-1';
  update public.estimate_items set unit_price = 100, quantity = 2, total = 200, metadata = '{}'::jsonb where estimate_id = est and name = 'V Cabinets';  -- a real priced line
  select total, client_total into tot_before from public.estimates where id = est;  -- total stays whatever it was; add must NOT touch it
  select count(*) into items_before from public.estimate_items where estimate_id = est;

  r := public.add_estimate_line_items_transaction(zz_verify.id('org_a'), est, '[{"name":"v cabinets"},{"name":"V Backsplash","itemType":"material"},{"name":"v   backsplash"}]'::jsonb, 'verify-add-1');
  perform zz_verify.record('2.1 appends only the new, de-duplicated name as a $0 pending placeholder after the last position',
    jsonb_array_length(r->'added_item_ids') = 1 and jsonb_array_length(r->'skipped_duplicate_names') = 2
    and (select position from public.estimate_items where estimate_id = est and name = 'V Backsplash') > (select max(position) from public.estimate_items where estimate_id = est and name <> 'V Backsplash')
    and (select unit_price = 0 and (metadata->>'price_pending')::boolean from public.estimate_items where estimate_id = est and name = 'V Backsplash'));
  perform zz_verify.record('2.2 header totals are NOT recomputed/clobbered', (select total is not distinct from tot_before from public.estimates where id = est));

  r := public.add_estimate_line_items_transaction(zz_verify.id('org_a'), est, '[{"name":"V Backsplash"}]'::jsonb, 'verify-add-1');
  perform zz_verify.record('2.3 replay (same execution id) inserts nothing and reports already_applied', (r->>'already_applied')::boolean and (select count(*) from public.estimate_items where estimate_id = est and name = 'V Backsplash') = 1);

  -- 2.4 FORCED failure mid-batch => none of the batch persists
  select count(*) into items_before from public.estimate_items where estimate_id = est;
  begin perform public.add_estimate_line_items_transaction(zz_verify.id('org_a'), est, '[{"name":"V fine one"},{"name":"FORCE_FAIL"},{"name":"V fine three"}]'::jsonb, 'verify-add-fail'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('2.4 FORCED item failure => no partial new items', err like '%forced item failure%' and (select count(*) from public.estimate_items where estimate_id = est) = items_before, coalesce(err, 'no error'));

  -- 2.5 wrong org => not_found (identical to a missing estimate)
  begin perform public.add_estimate_line_items_transaction(zz_verify.id('org_b'), est, '[{"name":"V intruder"}]'::jsonb, 'verify-add-x'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('2.5 another org cannot add to this estimate => not_found', err like '%estimate_rpc:not_found%' and not exists (select 1 from public.estimate_items where name = 'V intruder'), coalesce(err, 'no error'));

  -- 2.6 draft status is enforced INSIDE the transaction
  update public.estimates set status = 'sent' where id = est;
  begin perform public.add_estimate_line_items_transaction(zz_verify.id('org_a'), est, '[{"name":"V too late"}]'::jsonb, 'verify-add-late'); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('2.6 a non-draft estimate (sent) => not_draft, nothing inserted', err like '%estimate_rpc:not_draft%' and not exists (select 1 from public.estimate_items where name = 'V too late'), coalesce(err, 'no error'));
  update public.estimates set status = 'draft' where id = est;
end $$;

-- ── 3. replace_estimate_items_transaction (authenticated + RLS, SECURITY INVOKER) ───────────────
-- Needs a JWT-like identity: set the claims, then switch to the authenticated role.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', zz_verify.id('user_a'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', zz_verify.id('user_a')::text, true);
set local role authenticated;

do $$
declare est uuid; r jsonb; err text; before_e record; before_items jsonb; after_e record; meta_before jsonb;
begin
  select id into est from public.estimates where metadata->>'ai_execution_id' = 'verify-exec-1';
  perform set_config('verify.est', est::text, true);
  select * into before_e from public.estimates where id = est;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]') into before_items from public.estimate_items i where i.estimate_id = est;

  -- 3.1 FORCED item failure => header AND old items EXACTLY unchanged
  begin
    perform public.replace_estimate_items_transaction(est, '{"title":"VERIFY SHOULD NOT PERSIST","total":999}'::jsonb, '{"serviceAddress":"SHOULD NOT PERSIST"}'::jsonb,
      '[{"category":"Material","name":"ok","unit_price":1,"total":1,"position":0,"metadata":{}},{"category":"Material","name":"FORCE_FAIL","position":1,"metadata":{}}]'::jsonb);
    err := null;
  exception when others then err := sqlerrm; end;
  select * into after_e from public.estimates where id = est;
  perform zz_verify.record('3.1 FORCED item failure leaves the header AND the old items exactly unchanged',
    err like '%forced item failure%' and after_e.title = before_e.title and after_e.total = before_e.total and after_e.metadata = before_e.metadata
    and (select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]') from public.estimate_items i where i.estimate_id = est) = before_items, coalesce(err, 'no error'));

  -- 3.2 success: header + items together, AI provenance preserved, immutable columns untouched, client_total = total
  select metadata into meta_before from public.estimates where id = est;
  r := public.replace_estimate_items_transaction(est, '{"title":"VERIFY EDITED","total":300,"subtotal":300,"tax_total":0}'::jsonb, '{"serviceAddress":"123 Verified St"}'::jsonb,
      '[{"category":"Material","item_type":"material","name":"Edited A","quantity":1,"unit":"each","unit_price":300,"total":300,"position":0,"metadata":{}},
        {"category":"Material","name":"Still pending","position":1,"metadata":{"price_pending":true,"ai_proposed":true}}]'::jsonb);
  select * into after_e from public.estimates where id = est;
  perform zz_verify.record('3.2 header edit and the full item replacement applied together',
    after_e.title = 'VERIFY EDITED' and after_e.total = 300 and (select count(*) from public.estimate_items where estimate_id = est) = 2 and (r->>'item_count')::int = 2);
  perform zz_verify.record('3.3 client_total equals total (trg_sync_total stays consistent)', after_e.client_total = after_e.total);
  perform zz_verify.record('3.4 metadata MERGED: serviceAddress set, ai_generated / ai_execution_id preserved',
    after_e.metadata->>'serviceAddress' = '123 Verified St' and after_e.metadata->>'ai_execution_id' = meta_before->>'ai_execution_id' and (after_e.metadata->>'ai_generated') = (meta_before->>'ai_generated'));
  perform zz_verify.record('3.5 immutable / DB-owned columns untouched (org_id, created_by, number, status, public_token, version_number)',
    after_e.org_id = before_e.org_id and after_e.created_by = before_e.created_by and after_e.number = before_e.number and after_e.status = before_e.status
    and after_e.public_token is not distinct from before_e.public_token and after_e.version_number = before_e.version_number);
  perform zz_verify.record('3.6 every stored item metadata is a JSON object (never NULL)', (select bool_and(jsonb_typeof(metadata) = 'object') from public.estimate_items where estimate_id = est));

  -- 3.7 input whitelists
  begin perform public.replace_estimate_items_transaction(est, '{"status":"approved"}'::jsonb, '{}'::jsonb, '[]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.7a header key status is rejected => invalid_header_field', err like '%estimate_rpc:invalid_header_field%', coalesce(err, 'no error'));
  begin perform public.replace_estimate_items_transaction(est, '{"org_id":"00000000-0000-0000-0000-000000000001"}'::jsonb, '{}'::jsonb, '[]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.7b header key org_id is rejected', err like '%estimate_rpc:invalid_header_field%', coalesce(err, 'no error'));
  begin perform public.replace_estimate_items_transaction(est, '{}'::jsonb, '{"ai_execution_id":"forged"}'::jsonb, '[]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.7c metadata patch key ai_execution_id is rejected => invalid_metadata_field', err like '%estimate_rpc:invalid_metadata_field%', coalesce(err, 'no error'));
  begin perform public.replace_estimate_items_transaction(est, '{}'::jsonb, '{}'::jsonb, '[{"category":"x","name":"y","estimate_id":"00000000-0000-0000-0000-000000000001"}]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.7d item key estimate_id is rejected => invalid_item_field', err like '%estimate_rpc:invalid_item_field%', coalesce(err, 'no error'));
  perform zz_verify.record('3.7e rejected calls changed nothing', (select title from public.estimates where id = est) = 'VERIFY EDITED' and (select count(*) from public.estimate_items where estimate_id = est) = 2);
end $$;

-- 3.8 tenant isolation: a member of ANOTHER org (RLS) cannot touch or even see this estimate
reset role;
select set_config('request.jwt.claims', json_build_object('sub', zz_verify.id('user_b'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', zz_verify.id('user_b')::text, true);
set local role authenticated;
do $$
declare est uuid; err text;
begin
  est := current_setting('verify.est')::uuid;   -- user B cannot read org A's estimate; the id was stashed by 3.x above
  begin perform public.replace_estimate_items_transaction(est, '{"title":"HIJACK"}'::jsonb, '{}'::jsonb, '[]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.8 org B user replacing org A''s estimate => not_found (RLS), nothing changed', err like '%estimate_rpc:not_found%', coalesce(err, 'no error'));
end $$;

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ declare err text; begin
  begin perform public.replace_estimate_items_transaction(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, '[]'::jsonb); err := null; exception when others then err := sqlerrm; end;
  perform zz_verify.record('3.9 anon cannot execute replace_ (permission denied)', err like '%permission denied%', coalesce(err, 'no error'));
end $$;
reset role;

-- ── RESULT ──────────────────────────────────────────────────────────────────────────────────────
select n, test, outcome, detail from zz_verify.results order by n;
select case when bool_and(outcome = 'PASS') then 'ALL PASS' else 'FAILURES PRESENT - DO NOT SHIP' end as verdict, count(*) filter (where outcome = 'FAIL') as failures, count(*) as checks from zz_verify.results;

rollback;   -- nothing above persists

-- ── MANUAL CONCURRENCY PROCEDURE (two sessions; not automatable inside one transaction) ─────────
-- On a non-production database, with an existing DRAFT estimate E in org A that has items:
--   Session 1:  begin;  select public.replace_estimate_items_transaction('<E>', '{"title":"S1"}', '{}', '[{"category":"Material","name":"S1 item","position":0,"metadata":{}}]');   -- do NOT commit yet
--   Session 2:  select public.add_estimate_line_items_transaction('<ORG_A>', '<E>', '[{"name":"S2 item"}]', 'concurrency-1');  -- run as service_role; it must BLOCK on the estimate row lock
--   Session 1:  commit;
--   Session 2:  (unblocks) -> succeeds, appended AFTER S1's item (position computed under the lock). Verify:
--               select name, position from estimate_items where estimate_id = '<E>' order by position;   -- exactly "S1 item", "S2 item"
--   Repeat with the roles swapped (add first, replace second): the replacement must wait, then fully REPLACE the set
--   (the AI-added line is gone: replace is "the editor's full item set wins"), with no duplicated or interleaved rows.
--   Also: two sessions calling create_estimate_draft_transaction with the SAME p_execution_id must produce ONE estimate
--   (the second blocks on the advisory lock, then returns already_created = true).
-- Clean up any rows these steps created.
