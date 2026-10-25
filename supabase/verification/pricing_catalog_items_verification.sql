-- supabase/verification/pricing_catalog_items_verification.sql
--
-- Pricing Intelligence P4 — behavioral verification of 20261026_pricing_catalog_items.sql.
-- NOT a migration. Run ONLY against a LOCAL / disposable database, with the migration applied inside the SAME transaction and the
-- whole thing rolled back, e.g.:
--
--   ( echo 'begin;'; cat supabase/migrations/20261026_pricing_catalog_items.sql;
--     cat supabase/verification/pricing_catalog_items_verification.sql; echo 'rollback;' ) \
--     | docker exec -i <local supabase db container> psql -U postgres -v ON_ERROR_STOP=1
--
-- It creates its own throwaway organizations / users inside that transaction. Every check RAISES on failure; success prints
-- NOTICE lines "PASS: ...". Requires public.organizations, public.profiles (FK to auth.users) and public.org_memberships.

do $$
declare
  org_a uuid := gen_random_uuid(); org_b uuid := gen_random_uuid();
  user_owner uuid := gen_random_uuid(); user_member uuid := gen_random_uuid(); user_b uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name) values (org_a, 'P4 verify A'), (org_b, 'P4 verify B');
  insert into auth.users (id, email, aud, role) values
    (user_owner, 'p4-owner-' || user_owner || '@example.invalid', 'authenticated', 'authenticated'),
    (user_member, 'p4-member-' || user_member || '@example.invalid', 'authenticated', 'authenticated'),
    (user_b, 'p4-b-' || user_b || '@example.invalid', 'authenticated', 'authenticated');
  insert into public.profiles (id, email, organization_id) values
    (user_owner, 'p4-owner-' || user_owner || '@example.invalid', org_a),
    (user_member, 'p4-member-' || user_member || '@example.invalid', org_a),
    (user_b, 'p4-b-' || user_b || '@example.invalid', org_b);
  insert into public.org_memberships (org_id, member_id, role) values
    (org_a, user_owner, 'owner'), (org_a, user_member, 'sales'), (org_b, user_b, 'owner')
    on conflict do nothing;
  perform set_config('p4.org_a', org_a::text, true);
  perform set_config('p4.org_b', org_b::text, true);
  perform set_config('p4.owner', user_owner::text, true);
  perform set_config('p4.member', user_member::text, true);
  perform set_config('p4.user_b', user_b::text, true);
end $$;

-- 1) a valid row is accepted; defaults apply
do $$
declare r public.pricing_catalog_items;
begin
  insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price)
  values (current_setting('p4.org_a')::uuid, 'Vanity installation', 'vanity installation', 'each', 450) returning * into r;
  if r.active is not true or r.taxable is not true or r.source <> 'manual' or r.aliases <> '{}' or r.project_types <> '{}' then
    raise exception 'defaults wrong: %', r;
  end if;
  raise notice 'PASS: valid insert + defaults';
end $$;

-- 2) every invalid shape is rejected
do $$
declare
  org uuid := current_setting('p4.org_a')::uuid;
  cases text[][] := array[
    array['negative sell',        'sell_unit_price', '-1'],
    array['low above sell',       'low_unit_price',  '999'],
    array['high below sell',      'high_unit_price', '1'],
    array['negative cost',        'internal_unit_cost', '-5'],
    array['negative markup',      'default_markup_percent', '-1']
  ];
  c text[];
  failed boolean;
begin
  foreach c slice 1 in array cases loop
    failed := false;
    begin
      if c[2] = 'sell_unit_price' then
        execute format('insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values ($1, ''x'', ''x'', ''each'', %s)', c[3]) using org;
      else
        execute format('insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price, %I) values ($1, ''x'', ''x'', ''each'', 450, %s)', c[2], c[3]) using org;
      end if;
    exception when check_violation then failed := true; end;
    if not failed then raise exception 'accepted invalid: %', c[1]; end if;
  end loop;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (org, '  ', 'x', 'each', 1);
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'accepted blank name'; end if;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (org, 'x', 'x', ' ', 1);
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'accepted blank unit'; end if;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price, item_type) values (org, 'x', 'x', 'each', 1, 'discount');
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'accepted item_type discount'; end if;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price, project_types) values (org, 'x', 'x', 'each', 1, array['moon_base']);
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'accepted unknown project type'; end if;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price, aliases) values (org, 'x', 'x', 'each', 1, array['ok', '  ']);
  exception when others then failed := true; end;
  if not failed then raise exception 'accepted a blank alias'; end if;

  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (gen_random_uuid(), 'x', 'x', 'each', 1);
  exception when foreign_key_violation then failed := true; end;
  if not failed then raise exception 'accepted unknown org'; end if;

  -- sell exactly equal to low / high is allowed; a lone low or lone high is ordered against sell
  insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price, low_unit_price, high_unit_price) values (org, 'edge', 'edge', 'each', 10, 10, 10);
  raise notice 'PASS: constraints reject invalid prices / names / units / vocab / aliases / orgs';
end $$;

-- 3) guard trigger: org immutable, same-org reviewer, server-maintained timestamps
do $$
declare
  org_a uuid := current_setting('p4.org_a')::uuid; org_b uuid := current_setting('p4.org_b')::uuid;
  id_ uuid; failed boolean; ua timestamptz;
begin
  insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (org_a, 'Guard test', 'guard test', 'each', 10) returning id into id_;

  failed := false;
  begin update public.pricing_catalog_items set org_id = org_b where id = id_; exception when others then failed := true; end;
  if not failed then raise exception 'org_id was changeable'; end if;

  failed := false;
  begin update public.pricing_catalog_items set reviewed_by = current_setting('p4.user_b')::uuid, reviewed_at = now() where id = id_;
  exception when others then failed := true; end;
  if not failed then raise exception 'accepted a reviewer from another organization'; end if;

  update public.pricing_catalog_items set reviewed_by = current_setting('p4.owner')::uuid, reviewed_at = now() where id = id_;

  update public.pricing_catalog_items set updated_at = '2000-01-01', created_at = '2000-01-01' where id = id_;
  select updated_at into ua from public.pricing_catalog_items where id = id_;
  if ua < now() - interval '1 minute' then raise exception 'updated_at is not server-maintained'; end if;
  if (select created_at from public.pricing_catalog_items where id = id_) < now() - interval '1 minute' then raise exception 'created_at was rewritable'; end if;
  raise notice 'PASS: guard trigger (org immutable, same-org reviewer, server timestamps)';
end $$;

-- 4) structure: RLS on, exactly 3 owner/admin policies, none for DELETE, no anon access
do $$
declare n int;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.pricing_catalog_items'::regclass) then raise exception 'RLS not enabled'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'pricing_catalog_items';
  if n <> 3 then raise exception 'expected 3 policies, found %', n; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pricing_catalog_items' and cmd in ('DELETE', 'ALL')) then raise exception 'unexpected DELETE/ALL policy'; end if;
  if has_table_privilege('anon', 'public.pricing_catalog_items', 'select') then raise exception 'anon can select'; end if;
  if has_table_privilege('authenticated', 'public.pricing_catalog_items', 'delete') then raise exception 'authenticated can delete'; end if;
  if has_function_privilege('authenticated', 'public.pricing_catalog_items_guard()', 'execute') then raise exception 'guard function is executable by authenticated'; end if;
  if (select prosecdef from pg_proc where oid = 'public.pricing_catalog_items_guard()'::regprocedure) is not true then raise exception 'guard is not security definer'; end if;
  if not exists (select 1 from pg_proc where oid = 'public.pricing_catalog_items_guard()'::regprocedure and proconfig @> array['search_path=pg_catalog, pg_temp']) then raise exception 'guard search_path not pinned'; end if;
  raise notice 'PASS: RLS enabled, 3 owner/admin policies, no delete/anon, guard hardened';
end $$;

-- 5) RLS behavior as an authenticated end user
insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (current_setting('p4.org_b')::uuid, 'B only', 'b only', 'each', 5);

set local role authenticated;

do $$
declare n int; failed boolean;
begin
  -- owner of org A: sees org A rows only
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('p4.owner'), 'role', 'authenticated')::text, true);
  select count(*) into n from public.pricing_catalog_items;
  if n = 0 then raise exception 'owner cannot see their own org''s rows'; end if;
  if exists (select 1 from public.pricing_catalog_items where org_id = current_setting('p4.org_b')::uuid) then raise exception 'owner sees ANOTHER org''s rows'; end if;
  -- owner can insert into own org, not into org B
  insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (current_setting('p4.org_a')::uuid, 'Owner insert', 'owner insert', 'each', 1);
  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (current_setting('p4.org_b')::uuid, 'cross', 'cross', 'each', 1);
  exception when others then failed := true; end;
  if not failed then raise exception 'owner inserted into another org'; end if;
  -- cannot delete
  failed := false;
  begin delete from public.pricing_catalog_items where name = 'Owner insert'; exception when insufficient_privilege then failed := true; end;
  if not failed then raise exception 'delete was permitted'; end if;

  -- a non-admin member of org A (sales): sees nothing, cannot insert
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('p4.member'), 'role', 'authenticated')::text, true);
  select count(*) into n from public.pricing_catalog_items;
  if n <> 0 then raise exception 'non owner/admin member can read the price book (% rows)', n; end if;
  failed := false;
  begin insert into public.pricing_catalog_items (org_id, name, normalized_name, unit, sell_unit_price) values (current_setting('p4.org_a')::uuid, 'member', 'member', 'each', 1);
  exception when others then failed := true; end;
  if not failed then raise exception 'non owner/admin member inserted'; end if;

  -- org B owner: sees only org B
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('p4.user_b'), 'role', 'authenticated')::text, true);
  if exists (select 1 from public.pricing_catalog_items where org_id = current_setting('p4.org_a')::uuid) then raise exception 'org B sees org A rows'; end if;
  raise notice 'PASS: RLS isolates orgs, restricts to owner/admin, forbids delete';
end $$;

reset role;
