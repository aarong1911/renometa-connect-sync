-- supabase/verification/estimate_transactional_rpcs_preapply_snapshot.sql
--
-- READ-ONLY PRE-APPLY SNAPSHOT for 20261017_estimate_transactional_rpcs.sql.
--
-- Contains ONLY SELECTs against system catalogs. It does not read any application row data, create or alter anything,
-- change grants, or write. It is safe to run in the Supabase SQL editor of a NON-PRODUCTION project (and read-only
-- enough that it is also safe on any database, but it is intended for the non-production pre-apply check).
--
-- OUTPUT: ONE result set with columns (section, item, detail). `detail` is jsonb or text; expand rows as needed.
-- Copy the whole result (e.g. "Download CSV" / "Copy as JSON") back for review. Nothing in it is a secret: it holds
-- schema structure, policy / trigger / function DEFINITIONS and privilege flags only.
--
-- BEFORE RUNNING: this file cannot tell you whether the database is production. Confirm that yourself and write the
-- project ref / name into the review notes. Section 01 prints the database name and server identity to compare.
--
-- SECTIONS (what each one verifies):
--   01_identity            which database/server/roles this is; extensions; whether the 3 tables are where we expect
--   02_rls_flags           RLS enabled / forced on estimates, estimate_items, estimate_activities
--   03_policies            every pg_policies row for estimates + estimate_items (the RLS the SECURITY INVOKER editor RPC relies on)
--   04_columns             column type / nullability / default for the 3 tables (NOT NULL + defaults the RPC inserts depend on)
--   05_constraints         PK / FK / CHECK / UNIQUE definitions (status and item_type check sets, deposit<=total, etc.)
--   06_indexes             indexes on the 3 tables (e.g. whether ai_execution_id lookups or unique numbering exist)
--   07_triggers            each trigger: table, enabled state, timing, events, level, function, full definition
--   08_trigger_functions   full source + security mode + search_path + owner of every function those triggers call
--   09_rpc_functions       the 4 new functions, IF they already exist (expected: none before apply)
--   10_rpc_privileges      EXECUTE for public/anon/authenticated/service_role on those functions, if they exist
--   11_name_collisions     any OTHER function with the same names / any overload (must be empty before apply)
--   12_expected_checks     boolean checklist of the design assumptions (all should be true before apply)

with
tables as (
  select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
     and c.relname in ('estimates', 'estimate_items', 'estimate_activities')
),
role_names as (
  select unnest(array['anon', 'authenticated', 'service_role']) as rolname
),
trg as (
  select t.oid as tgoid, t.tgname, t.tgenabled, t.tgtype, t.tgfoid, tb.relname as table_name
    from pg_trigger t join tables tb on tb.oid = t.tgrelid
   where not t.tgisinternal
),
trg_fn as (
  select distinct p.oid, p.proname, n.nspname, p.prosecdef, p.proconfig, p.prosrc,
         pg_get_userbyid(p.proowner) as owner,
         pg_get_functiondef(p.oid) as definition
    from trg join pg_proc p on p.oid = trg.tgfoid join pg_namespace n on n.oid = p.pronamespace
),
rpc as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_userbyid(p.proowner) as owner,
         pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_estimate_draft_transaction', 'add_estimate_line_items_transaction',
                       'replace_estimate_items_transaction', 'estimate_rpc_normalize_ai_items')
),
rows_all as (

  -- 01 identity ---------------------------------------------------------------------------------------------
  select '01_identity' as section, 'database' as item, to_jsonb(current_database()) as detail
  union all select '01_identity', 'current_schema', to_jsonb(current_schema())
  union all select '01_identity', 'session_user / current_user', to_jsonb(session_user || ' / ' || current_user)
  union all select '01_identity', 'server_version', to_jsonb(version())
  union all select '01_identity', 'transaction_read_only', to_jsonb(current_setting('transaction_read_only'))
  union all select '01_identity', 'extensions', coalesce((select jsonb_agg(extname order by extname) from pg_extension), '[]')
  union all select '01_identity', 'application roles present',
                   coalesce((select jsonb_agg(rolname order by rolname) from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'postgres', 'authenticator')), '[]')
  union all select '01_identity', 'tables found in public', coalesce((select jsonb_agg(relname order by relname) from tables), '[]')
  union all select '01_identity', 'auth.uid() exists', to_jsonb(to_regprocedure('auth.uid()') is not null)
  union all select '01_identity', 'public schema owner / USAGE for service_role',
                   (select jsonb_build_object('owner', pg_get_userbyid(nspowner),
                           'service_role_usage', case when exists (select 1 from pg_roles where rolname = 'service_role') then has_schema_privilege('service_role', 'public', 'usage') end)
                      from pg_namespace where nspname = 'public')

  -- 02 RLS flags --------------------------------------------------------------------------------------------
  union all
  select '02_rls_flags', c.relname, jsonb_build_object('rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner))
    from pg_class c join tables t on t.oid = c.oid

  -- 03 policies ---------------------------------------------------------------------------------------------
  union all
  select '03_policies', p.tablename || ' :: ' || p.policyname,
         jsonb_build_object('permissive', p.permissive, 'roles', p.roles, 'cmd', p.cmd, 'using', p.qual, 'with_check', p.with_check)
    from pg_policies p
   where p.schemaname = 'public' and p.tablename in ('estimates', 'estimate_items')

  -- 04 columns ----------------------------------------------------------------------------------------------
  union all
  select '04_columns', t.relname || '.' || a.attname,
         jsonb_build_object('pos', a.attnum, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
                            'default', pg_get_expr(d.adbin, d.adrelid), 'generated', nullif(a.attgenerated::text, ''),
                            'identity', nullif(a.attidentity::text, ''))
    from tables t
    join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum

  -- 05 constraints ------------------------------------------------------------------------------------------
  union all
  select '05_constraints', t.relname || ' :: ' || c.conname,
         jsonb_build_object('type', case c.contype when 'p' then 'PRIMARY KEY' when 'f' then 'FOREIGN KEY' when 'c' then 'CHECK' when 'u' then 'UNIQUE' when 'x' then 'EXCLUDE' else c.contype::text end,
                            'definition', pg_get_constraintdef(c.oid), 'validated', c.convalidated, 'deferrable', c.condeferrable)
    from pg_constraint c join tables t on t.oid = c.conrelid

  -- 06 indexes ----------------------------------------------------------------------------------------------
  union all
  select '06_indexes', i.tablename || ' :: ' || i.indexname, to_jsonb(i.indexdef)
    from pg_indexes i
   where i.schemaname = 'public' and i.tablename in ('estimates', 'estimate_items', 'estimate_activities')

  -- 07 triggers ---------------------------------------------------------------------------------------------
  union all
  select '07_triggers', trg.table_name || ' :: ' || trg.tgname,
         jsonb_build_object(
           'enabled', case trg.tgenabled when 'O' then 'enabled (origin)' when 'D' then 'DISABLED' when 'R' then 'replica only' when 'A' then 'always' else trg.tgenabled::text end,
           'timing', case when (trg.tgtype & 2) <> 0 then 'BEFORE' when (trg.tgtype & 64) <> 0 then 'INSTEAD OF' else 'AFTER' end,
           'events', concat_ws(' OR ', case when (trg.tgtype & 4) <> 0 then 'INSERT' end, case when (trg.tgtype & 8) <> 0 then 'DELETE' end,
                                       case when (trg.tgtype & 16) <> 0 then 'UPDATE' end, case when (trg.tgtype & 32) <> 0 then 'TRUNCATE' end),
           'level', case when (trg.tgtype & 1) <> 0 then 'ROW' else 'STATEMENT' end,
           'function', (select n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = trg.tgfoid),
           'definition', pg_get_triggerdef(trg.tgoid))
    from trg

  -- 08 trigger functions ------------------------------------------------------------------------------------
  union all
  select '08_trigger_functions', f.nspname || '.' || f.proname,
         jsonb_build_object('security_definer', f.prosecdef, 'config', f.proconfig, 'owner', f.owner, 'definition', f.definition)
    from trg_fn f

  -- 09 RPC functions (expected: none before apply) -----------------------------------------------------------
  union all
  select '09_rpc_functions', r.proname || '(' || r.args || ')',
         jsonb_build_object('security_definer', r.prosecdef, 'config', r.proconfig, 'owner', r.owner, 'definition', r.definition)
    from rpc r
  union all
  select '09_rpc_functions', '(none found)', to_jsonb('none of the 4 functions exist yet - expected before apply'::text)
   where not exists (select 1 from rpc)

  -- 10 RPC privileges (EXECUTE) -------------------------------------------------------------------------------
  union all
  select '10_rpc_privileges', r.proname || '(' || r.args || ')',
         jsonb_build_object(
           'public_pseudo_role', exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', (select proowner from pg_proc where oid = r.oid)))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE'),
           'anon', case when exists (select 1 from pg_roles where rolname = 'anon') then has_function_privilege('anon', r.oid, 'execute') end,
           'authenticated', case when exists (select 1 from pg_roles where rolname = 'authenticated') then has_function_privilege('authenticated', r.oid, 'execute') end,
           'service_role', case when exists (select 1 from pg_roles where rolname = 'service_role') then has_function_privilege('service_role', r.oid, 'execute') end,
           'raw_acl', r.proacl::text)
    from rpc r

  -- 11 name collisions / overloads -----------------------------------------------------------------------------
  union all
  select '11_name_collisions', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         jsonb_build_object('security_definer', p.prosecdef, 'owner', pg_get_userbyid(p.proowner))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('create_estimate_draft_transaction', 'add_estimate_line_items_transaction',
                       'replace_estimate_items_transaction', 'estimate_rpc_normalize_ai_items')
     and n.nspname <> 'public'
  union all
  select '11_name_collisions', '(none outside public)', to_jsonb('no same-named function in another schema'::text)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('create_estimate_draft_transaction', 'add_estimate_line_items_transaction',
                          'replace_estimate_items_transaction', 'estimate_rpc_normalize_ai_items') and n.nspname <> 'public')

  -- 12 expected checks (design assumptions; every value should be true BEFORE apply) ----------------------------
  union all
  select '12_expected_checks', k.item, to_jsonb(k.ok)
    from (values
      ('estimates.created_by is NOT NULL', coalesce((select a.attnotnull from pg_attribute a where a.attrelid = 'public.estimates'::regclass and a.attname = 'created_by'), false)),
      ('estimates.created_by default mentions auth.uid()', coalesce((select pg_get_expr(d.adbin, d.adrelid) ilike '%auth.uid()%' from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = 'public.estimates'::regclass and a.attname = 'created_by'), false)),
      ('estimates.metadata is jsonb NOT NULL', coalesce((select a.attnotnull and format_type(a.atttypid, a.atttypmod) = 'jsonb' from pg_attribute a where a.attrelid = 'public.estimates'::regclass and a.attname = 'metadata'), false)),
      ('estimate_items.metadata is jsonb NOT NULL', coalesce((select a.attnotnull and format_type(a.atttypid, a.atttypmod) = 'jsonb' from pg_attribute a where a.attrelid = 'public.estimate_items'::regclass and a.attname = 'metadata'), false)),
      ('estimates.client_total exists', exists (select 1 from pg_attribute a where a.attrelid = 'public.estimates'::regclass and a.attname = 'client_total' and not a.attisdropped)),
      ('estimate_activities has actor_id / actor_type / metadata / version_number', (select count(*) = 4 from pg_attribute a where a.attrelid = 'public.estimate_activities'::regclass and a.attname in ('actor_id', 'actor_type', 'metadata', 'version_number') and not a.attisdropped)),
      ('all 8 expected estimates triggers are present and not disabled', (select count(*) = 8 from trg where trg.table_name = 'estimates' and trg.tgenabled <> 'D' and trg.tgname in ('estimates_set_number', 'estimates_validate_relationships', 'estimates_log_activity', 'estimates_prevent_number_change', 'trg_sync_total', 'on_estimate_update', 'estimate_sent_trigger', 'estimates_link_approved_contract'))),
      ('trg_sync_total body assigns NEW.total from NEW.client_total', coalesce((select bool_or(f.prosrc ~* 'new\.total\s*:=\s*new\.client_total') from trg_fn f join trg on trg.tgfoid = f.oid where trg.tgname = 'trg_sync_total'), false)),
      ('log_estimate_activity writes created / actor_type system when auth.uid() is null', coalesce((select bool_or(f.prosrc ~* 'activity_type' and f.prosrc ~* '''created''' and f.prosrc ~* '''system''') from trg_fn f join trg on trg.tgfoid = f.oid where trg.tgname = 'estimates_log_activity'), false)),
      ('RLS enabled on estimates and estimate_items', (select count(*) = 2 from pg_class c join tables t on t.oid = c.oid where c.relrowsecurity and c.relname in ('estimates', 'estimate_items'))),
      ('estimates has at least one policy', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimates')),
      ('estimate_items has at least one policy', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'estimate_items')),
      ('roles anon, authenticated and service_role all exist', (select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))),
      ('none of the 4 new functions exists yet (clean pre-apply state)', not exists (select 1 from rpc))
    ) as k(item, ok)
)
select section, item, detail from rows_all order by section, item;
