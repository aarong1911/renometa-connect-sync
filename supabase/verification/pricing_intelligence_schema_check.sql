-- supabase/verification/pricing_intelligence_schema_check.sql
--
-- READ-ONLY production schema confirmation for Pricing Intelligence (P0).
--
--   * Paste into the Supabase SQL Editor and run it. It is ONE SELECT statement.
--   * CATALOG metadata (pg_class / pg_attribute / pg_constraint / pg_index / pg_trigger) PLUS a small, clearly separated
--     block of AGGREGATE COUNTS (section 90_*). The aggregates return numbers only (row counts, null/non-null counts,
--     counts per status / per project_type, and the most common free-text `unit` values that occur at least 5 times).
--     They never return item names, descriptions, customer names, addresses, amounts, ids or any row content.
--     If you would rather not run any aggregate, delete the whole `aggregates` CTE and the last UNION ALL branch.
--   * No CREATE / ALTER / DROP / GRANT / INSERT / UPDATE / DELETE, no temp tables, no DO blocks, no functions created.
--   * Tolerates a table that does not exist yet (it is reported as missing instead of failing the query).
--
-- OUTPUT: one result set: section | item | detail (jsonb). Copy the whole result back for review.
--
-- WHAT EACH SECTION CONFIRMS
--   10_tables            the tables exist; RLS flag
--   20_needed_columns    every column Pricing Intelligence plans to read: present? type, NOT NULL, default
--   30_unlisted_columns  columns that exist but are NOT in the "needed" list (so you can see pricing-relevant fields the
--                        migrations/code do not show, e.g. a hidden cost/markup column on estimate_items)
--   40_check_constraints status / enum / numeric CHECK definitions (which statuses exist; which are valid evidence)
--   50_keys              PRIMARY KEY / UNIQUE / FOREIGN KEY definitions (estimate <-> project <-> lead/contact, change order <->
--                        project, source_estimate_item_id, ...)
--   60_indexes           indexes usable for org / date / status pricing lookups
--   70_triggers          non-internal triggers on these tables (anything that rewrites prices or totals)
--   90_aggregates        AGGREGATE counts only: volume of usable evidence by status and age, project_type coverage, how many
--                        change-order items have internal_cost / internal_markup populated, expense/bill linkage to projects

with
needed(tbl, col) as (
  values
    ('estimates','id'),('estimates','org_id'),('estimates','number'),('estimates','status'),('estimates','client_id'),('estimates','lead_id'),
    ('estimates','project_id'),('estimates','deal_id'),('estimates','title'),('estimates','scope'),('estimates','subtotal'),('estimates','tax_rate'),
    ('estimates','tax_total'),('estimates','discount_type'),('estimates','discount_value'),('estimates','discount_total'),('estimates','total'),
    ('estimates','client_total'),('estimates','deposit_type'),('estimates','deposit_value'),('estimates','deposit_amount'),('estimates','created_at'),
    ('estimates','updated_at'),('estimates','sent_at'),('estimates','approved_at'),('estimates','converted_at'),('estimates','valid_until'),
    ('estimates','converted_project_id'),('estimates','version_number'),('estimates','metadata'),
    ('estimate_items','id'),('estimate_items','estimate_id'),('estimate_items','category'),('estimate_items','item_type'),('estimate_items','name'),
    ('estimate_items','description'),('estimate_items','quantity'),('estimate_items','unit'),('estimate_items','unit_price'),('estimate_items','total'),
    ('estimate_items','position'),('estimate_items','taxable'),('estimate_items','optional'),('estimate_items','selected_by_customer'),
    ('estimate_items','is_heading'),('estimate_items','discount_type'),('estimate_items','discount_value'),('estimate_items','metadata'),
    ('estimate_versions','id'),('estimate_versions','org_id'),('estimate_versions','estimate_id'),('estimate_versions','version_number'),
    ('estimate_versions','snapshot'),('estimate_versions','created_at'),('estimate_versions','created_by'),
    ('projects','id'),('projects','org_id'),('projects','name'),('projects','client_id'),('projects','lead_id'),('projects','deal_id'),('projects','estimate_id'),
    ('projects','status'),('projects','project_type'),('projects','custom_project_type'),('projects','address'),('projects','budget_total'),
    ('projects','budget_range'),('projects','original_estimate_total'),('projects','actual_cost'),('projects','completion_percentage'),
    ('projects','start_date'),('projects','end_date'),('projects','created_at'),('projects','updated_at'),
    ('project_change_orders','id'),('project_change_orders','org_id'),('project_change_orders','project_id'),('project_change_orders','change_order_number'),
    ('project_change_orders','title'),('project_change_orders','status'),('project_change_orders','subtotal'),('project_change_orders','discount_amount'),
    ('project_change_orders','tax_rate'),('project_change_orders','tax_amount'),('project_change_orders','markup_type'),('project_change_orders','markup_value'),
    ('project_change_orders','markup_amount'),('project_change_orders','total_amount'),('project_change_orders','approved_at'),('project_change_orders','version'),
    ('project_change_orders','parent_change_order_id'),('project_change_orders','created_at'),('project_change_orders','updated_at'),
    ('project_change_order_items','id'),('project_change_order_items','org_id'),('project_change_order_items','project_id'),('project_change_order_items','change_order_id'),
    ('project_change_order_items','item_type'),('project_change_order_items','name'),('project_change_order_items','description'),('project_change_order_items','quantity'),
    ('project_change_order_items','unit'),('project_change_order_items','unit_price'),('project_change_order_items','line_subtotal'),('project_change_order_items','taxable'),
    ('project_change_order_items','internal_cost'),('project_change_order_items','internal_markup'),('project_change_order_items','source_estimate_item_id'),
    ('project_change_order_items','created_at'),('project_change_order_items','updated_at'),('project_change_order_items','metadata'),
    ('expenses','id'),('expenses','org_id'),('expenses','vendor_id'),('expenses','project_id'),('expenses','contact_id'),('expenses','expense_date'),
    ('expenses','description'),('expenses','amount'),('expenses','currency'),('expenses','status'),('expenses','account_id'),('expenses','created_at'),
    ('vendor_bill_lines','id'),('vendor_bill_lines','org_id'),('vendor_bill_lines','vendor_bill_id'),('vendor_bill_lines','description'),('vendor_bill_lines','quantity'),
    ('vendor_bill_lines','unit_cost'),('vendor_bill_lines','amount'),('vendor_bill_lines','account_id'),('vendor_bill_lines','project_id'),('vendor_bill_lines','created_at'),
    ('vendor_bills','id'),('vendor_bills','org_id'),('vendor_bills','status')
),
tbls(tbl) as (select distinct tbl from needed),
rel as (
  select t.tbl, c.oid, c.relrowsecurity, c.relforcerowsecurity
    from tbls t
    left join pg_class c on c.relname = t.tbl and c.relkind in ('r', 'p')
                        and c.relnamespace = (select oid from pg_namespace where nspname = 'public')
),
cols as (
  select r.tbl, a.attname::text as col, format_type(a.atttypid, a.atttypmod) as ftype, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as defexpr, a.attnum
    from rel r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where r.oid is not null
),
-- Aggregate COUNTS only (no row content). Each entry is [item, comma-separated guard tables (all must exist), SQL returning ONE jsonb column named r].
-- query_to_xml() runs the SELECT below; a missing table is reported instead of erroring.
aggregates(item, guard_tbl, sql) as (
  values
    ('estimates_by_status', 'estimates',
     $q$select coalesce(jsonb_object_agg(coalesce(status, '(null)'), n), '{}'::jsonb) as r from (select status, count(*) n from public.estimates group by 1) s$q$),
    ('estimate_lines_usable_for_pricing_by_estimate_status_and_age', 'estimate_items,estimates',
     $q$select coalesce(jsonb_agg(jsonb_build_object('estimate_status', st, 'within_36_months', recent, 'lines', n) order by st, recent), '[]'::jsonb) as r
          from (select e.status as st, (e.created_at >= now() - interval '36 months') as recent, count(*) n
                  from public.estimate_items i join public.estimates e on e.id = i.estimate_id
                 where coalesce(i.unit_price, 0) > 0 and not coalesce(i.is_heading, false) and coalesce(i.optional, false) = false
                   and coalesce(i.item_type, '') <> 'discount' and coalesce(i.metadata ->> 'price_pending', '') <> 'true'
                   and coalesce(i.metadata ->> 'ai_proposed', '') <> 'true'
                 group by 1, 2) s$q$),
    ('estimates_linked_to_a_project_with_a_project_type', 'estimates,projects',
     $q$select jsonb_build_object('estimates_total', count(*), 'with_project_id', count(e.project_id),
                                  'with_project_id_and_project_type', count(p.project_type),
                                  'with_lead_id', count(e.lead_id)) as r
          from public.estimates e left join public.projects p on p.id = e.project_id$q$),
    ('projects_by_project_type_and_status', 'projects',
     $q$select coalesce(jsonb_agg(jsonb_build_object('project_type', pt, 'status', st, 'projects', n) order by pt, st), '[]'::jsonb) as r
          from (select coalesce(project_type, '(null)') pt, status st, count(*) n from public.projects group by 1, 2) s$q$),
    ('most_common_units_on_priced_estimate_lines_(count>=5)', 'estimate_items',
     $q$select coalesce(jsonb_agg(jsonb_build_object('unit', u, 'lines', n) order by n desc), '[]'::jsonb) as r
          from (select coalesce(lower(btrim(unit)), '(null)') u, count(*) n from public.estimate_items
                 where coalesce(unit_price, 0) > 0 and not coalesce(is_heading, false) group by 1 having count(*) >= 5 order by 2 desc limit 40) s$q$),
    ('change_order_items_internal_cost_population', 'project_change_order_items,project_change_orders',
     $q$select jsonb_build_object('items_total', count(*),
                                  'items_on_approved_change_orders', count(*) filter (where co.status = 'approved'),
                                  'internal_cost_not_null', count(i.internal_cost),
                                  'internal_cost_gt_0', count(*) filter (where coalesce(i.internal_cost, 0) > 0),
                                  'internal_markup_not_null', count(i.internal_markup),
                                  'internal_markup_gt_0', count(*) filter (where coalesce(i.internal_markup, 0) > 0),
                                  'priced_items_gt_0', count(*) filter (where i.unit_price > 0)) as r
          from public.project_change_order_items i join public.project_change_orders co on co.id = i.change_order_id$q$),
    ('change_orders_by_status', 'project_change_orders',
     $q$select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) as r from (select status, count(*) n from public.project_change_orders group by 1) s$q$),
    ('estimate_items_with_no_unit_or_zero_quantity', 'estimate_items',
     $q$select jsonb_build_object('priced_lines', count(*), 'unit_null_or_blank', count(*) filter (where nullif(btrim(coalesce(unit, '')), '') is null),
                                  'quantity_le_0', count(*) filter (where coalesce(quantity, 0) <= 0)) as r
          from public.estimate_items where coalesce(unit_price, 0) > 0 and not coalesce(is_heading, false)$q$),
    ('projects_cost_field_reliability', 'projects,expenses',
     $q$select jsonb_build_object('projects_total', count(*), 'completed', count(*) filter (where status = 'completed'),
                                  'actual_cost_gt_0', count(*) filter (where coalesce(actual_cost, 0) > 0),
                                  'completed_with_actual_cost_gt_0', count(*) filter (where status = 'completed' and coalesce(actual_cost, 0) > 0),
                                  'with_posted_expenses', count(*) filter (where exists (select 1 from public.expenses x where x.project_id = projects.id and x.status = 'posted'))) as r
          from public.projects$q$),
    ('expenses_and_bill_lines_linked_to_projects', 'expenses,vendor_bill_lines',
     $q$select jsonb_build_object('expenses_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.expenses group by 1) s),
                                  'posted_expenses_with_project_id', (select count(*) from public.expenses where status = 'posted' and project_id is not null),
                                  'bill_lines_with_project_id', (select count(*) from public.vendor_bill_lines where project_id is not null),
                                  'bill_lines_total', (select count(*) from public.vendor_bill_lines)) as r$q$)
)

select section, item, detail from (

  select '10_tables'::text as section, r.tbl::text as item,
         jsonb_build_object('exists', r.oid is not null, 'rls_enabled', r.relrowsecurity, 'rls_forced', r.relforcerowsecurity) as detail
    from rel r

  union all
  select '20_needed_columns', n.tbl || '.' || n.col,
         case when c.col is null then jsonb_build_object('present', false)
              else jsonb_build_object('present', true, 'type', c.ftype, 'not_null', c.attnotnull, 'default', c.defexpr) end
    from needed n left join cols c on c.tbl = n.tbl and c.col = n.col

  union all
  select '30_unlisted_columns', c.tbl,
         jsonb_build_object('columns_not_in_the_needed_list', (
           select jsonb_agg(c2.col || ' ' || c2.ftype order by c2.attnum)
             from cols c2
            where c2.tbl = c.tbl and not exists (select 1 from needed n where n.tbl = c2.tbl and n.col = c2.col)))
    from (select distinct tbl from cols) c

  union all
  select '40_check_constraints', rel.tbl || ' :: ' || k.conname, jsonb_build_object('definition', pg_get_constraintdef(k.oid), 'validated', k.convalidated)
    from rel join pg_constraint k on k.conrelid = rel.oid and k.contype = 'c'

  union all
  select '50_keys', rel.tbl || ' :: ' || k.conname,
         jsonb_build_object('kind', case k.contype when 'p' then 'primary key' when 'u' then 'unique' when 'f' then 'foreign key' else 'other' end,
                            'definition', pg_get_constraintdef(k.oid))
    from rel join pg_constraint k on k.conrelid = rel.oid and k.contype in ('p', 'u', 'f')

  union all
  select '60_indexes', i.tablename || ' :: ' || i.indexname, to_jsonb(i.indexdef)
    from pg_indexes i where i.schemaname = 'public' and i.tablename in (select tbl from tbls)

  union all
  select '70_triggers', rel.tbl || ' :: ' || g.tgname,
         jsonb_build_object('enabled_state', g.tgenabled::text, 'function', (select p.proname::text from pg_proc p where p.oid = g.tgfoid))
    from rel join pg_trigger g on g.tgrelid = rel.oid and not g.tgisinternal

  union all
  -- AGGREGATE COUNTS ONLY (section 90). Delete this branch (and the `aggregates` CTE) to run catalog-only.
  select '90_aggregates', a.item,
         case when exists (select 1 from unnest(string_to_array(a.guard_tbl, ',')) g where to_regclass('public.' || g) is null) then jsonb_build_object('skipped', 'a required table (' || a.guard_tbl || ') does not exist')
              else (xpath('/row/r/text()', query_to_xml(a.sql, false, true, '')))[1]::text::jsonb end
    from aggregates a

) x
order by section, item;
