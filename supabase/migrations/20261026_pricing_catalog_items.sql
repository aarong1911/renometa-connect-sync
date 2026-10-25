-- Pricing Intelligence P4 — organization-owned Price Book (pricing catalog).
--
-- STATUS: UNAPPLIED. Written for review; applied manually (Supabase SQL Editor) by the owner only after review.
-- Not applied by any tool or script.
--
-- WHAT THIS ADDS (additive only): one NEW table public.pricing_catalog_items, one trigger function, one trigger, RLS policies,
-- grants, two indexes. It changes NO existing table, function, trigger, policy or grant.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: no seed rows, no backfill from estimates, no write path for the browser (all writes go
-- through the trusted Netlify function price-book.ts, which uses the service role and derives org / reviewer from the
-- authenticated session), no delete (rows are soft-disabled with active = false), no automatic price application, no link from
-- estimate_items (suggestions are advisory and nothing is written to an estimate).
--
-- AUDITED BEFORE WRITING (repo evidence; the live schema was NOT inspected by this migration):
--   * No pricing_catalog_items table, price book, or catalog exists in supabase/migrations/ (the only "catalog" is the Business
--     Knowledge question catalog). P0 production verification (user-run) confirmed all pricing source tables exist and that no
--     catalog structure was in use. The table is treated as NEW: it is created with plain CREATE TABLE (not IF NOT EXISTS) so an
--     unexpected pre-existing table makes the migration FAIL LOUDLY instead of silently no-opping against a different shape.
--   * Org-owned table conventions followed: org_id uuid not null references organizations(id) on delete cascade; RLS enabled;
--     same-org validation by BEFORE trigger (project_change_orders pattern); named CHECK constraints; created_at/updated_at.
--   * public.set_updated_at() / public.is_org_member() exist in production but are NOT defined in any repo migration, so this
--     migration does NOT depend on them: it ships its own hardened trigger function.
--
-- VOCABULARY (kept in sync with application code):
--   project_types : the CHECK-constrained keys of projects.project_type (migration 20260808), minus 'other' (carries no signal)
--   item_type     : the pricing vocabulary (labor, material, service, equipment, allowance, fee, custom). 'discount' is NOT allowed:
--                   a discount is never priced from a catalog.
--
-- SENSITIVE COLUMNS: internal_unit_cost, default_markup_percent and notes are STAFF-ONLY configuration. The suggestion pipeline
-- never selects them, so they cannot reach a model prompt, a customer reply, a public proposal or tool output.
--
-- RLS MODEL: the table holds internal cost data, so direct (browser) access is limited to owner/admin of the org. Normal use is
-- through the trusted function with the service role (which bypasses RLS) — RLS is defense in depth, not the only gate.

create table public.pricing_catalog_items (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations(id) on delete cascade,

  name                    text not null,
  -- Computed SERVER-SIDE by the shared line-item normalizer (src/lib/pricing/line-item-normalizer.ts). Never trusted from a browser.
  normalized_name         text not null,
  -- Normalized (same normalizer) alternate names.
  aliases                 text[] not null default '{}',

  -- Empty = a generic entry valid for any project type. Otherwise canonical projects.project_type keys.
  project_types           text[] not null default '{}',
  item_type               text null,
  unit                    text not null,

  sell_unit_price         numeric(14,2) not null,
  low_unit_price          numeric(14,2) null,
  high_unit_price         numeric(14,2) null,

  -- STAFF-ONLY configuration. Never used to derive the sell price in this version.
  internal_unit_cost      numeric(14,2) null,
  default_markup_percent  numeric(8,4) null,

  taxable                 boolean not null default true,
  active                  boolean not null default true,

  source                  text not null default 'manual',
  notes                   text null,

  reviewed_at             timestamptz null,
  reviewed_by             uuid null references public.profiles(id) on delete set null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint pricing_catalog_items_name_not_blank check (btrim(name) <> ''),
  constraint pricing_catalog_items_normalized_name_not_blank check (btrim(normalized_name) <> ''),
  constraint pricing_catalog_items_unit_not_blank check (btrim(unit) <> ''),
  constraint pricing_catalog_items_source_not_blank check (btrim(source) <> ''),
  constraint pricing_catalog_items_sell_nonneg check (sell_unit_price >= 0),
  constraint pricing_catalog_items_low_nonneg check (low_unit_price is null or low_unit_price >= 0),
  constraint pricing_catalog_items_high_nonneg check (high_unit_price is null or high_unit_price >= 0),
  -- low <= sell <= high for whichever of the three exist (pairwise, so a lone low or a lone high is still ordered against sell).
  constraint pricing_catalog_items_low_le_sell check (low_unit_price is null or low_unit_price <= sell_unit_price),
  constraint pricing_catalog_items_sell_le_high check (high_unit_price is null or sell_unit_price <= high_unit_price),
  constraint pricing_catalog_items_cost_nonneg check (internal_unit_cost is null or internal_unit_cost >= 0),
  constraint pricing_catalog_items_markup_nonneg check (default_markup_percent is null or default_markup_percent >= 0),
  constraint pricing_catalog_items_item_type_check check (
    item_type is null or item_type in ('labor', 'material', 'service', 'equipment', 'allowance', 'fee', 'custom')
  ),
  constraint pricing_catalog_items_project_types_check check (
    project_types <@ array[
      'kitchen_remodel', 'bathroom_remodel', 'full_home_remodel', 'home_addition', 'roofing', 'flooring', 'painting', 'hvac',
      'plumbing', 'electrical', 'landscaping', 'commercial_renovation', 'new_construction', 'repair_maintenance'
    ]::text[]
  )
);

comment on table public.pricing_catalog_items is
  'Pricing Intelligence P4: organization-owned Price Book. Deterministic staff-only price SUGGESTIONS; never written to an estimate. Soft-disabled via active=false (no delete). Written only by the trusted price-book Netlify function.';
comment on column public.pricing_catalog_items.normalized_name is
  'Canonical name computed server-side by the shared line-item normalizer; never browser-supplied.';
comment on column public.pricing_catalog_items.project_types is
  'Empty = generic entry for any project type; otherwise canonical projects.project_type keys. Same-project-type entries are preferred but never required.';
comment on column public.pricing_catalog_items.internal_unit_cost is
  'STAFF-ONLY. Never used to derive sell price in this version; never selected by the suggestion pipeline; never shown to a model or customer.';
comment on column public.pricing_catalog_items.default_markup_percent is
  'STAFF-ONLY. Configuration only in this version; the sell price is NOT derived from it.';
comment on column public.pricing_catalog_items.reviewed_at is
  'Set by the trusted function (reviewed_by = the authenticated user) when staff mark the item reviewed. A reviewed exact match earns HIGH confidence.';

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Guard trigger: org immutability, same-org reviewer, alias hygiene, server-maintained updated_at.
-- SECURITY DEFINER only so the same-org check can read profiles / org_memberships regardless of the caller's RLS; search_path is
-- pinned and every relation is schema-qualified. It writes nothing outside NEW.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.pricing_catalog_items_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_alias text;
begin
  if new.org_id is null then
    raise exception 'pricing_catalog_items.org_id is required';
  end if;

  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'pricing_catalog_items.org_id cannot be changed';
    end if;
    new.created_at := old.created_at;
  end if;

  -- reviewed_by must be a member of THIS organization (profile org OR org_memberships), exactly like other same-org validators.
  if new.reviewed_by is not null and (tg_op = 'INSERT' or new.reviewed_by is distinct from old.reviewed_by) then
    if not (
      exists (select 1 from public.profiles p where p.id = new.reviewed_by and p.organization_id = new.org_id)
      or exists (select 1 from public.org_memberships m where m.member_id = new.reviewed_by and m.org_id = new.org_id)
    ) then
      raise exception 'pricing_catalog_items.reviewed_by must be a member of the same organization';
    end if;
  end if;

  if char_length(new.name) > 200 then
    raise exception 'pricing_catalog_items.name is too long';
  end if;
  if coalesce(array_length(new.aliases, 1), 0) > 25 then
    raise exception 'pricing_catalog_items.aliases has too many entries';
  end if;
  foreach v_alias in array coalesce(new.aliases, '{}'::text[]) loop
    if v_alias is null or btrim(v_alias) = '' or char_length(v_alias) > 200 then
      raise exception 'pricing_catalog_items.aliases contains a blank or oversized entry';
    end if;
  end loop;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.pricing_catalog_items_guard() from public, anon, authenticated;

drop trigger if exists pricing_catalog_items_guard on public.pricing_catalog_items;
create trigger pricing_catalog_items_guard
  before insert or update on public.pricing_catalog_items
  for each row execute function public.pricing_catalog_items_guard();

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Indexes: the suggestion pipeline reads ACTIVE items for one org; the management list filters by org + active.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
create index if not exists idx_pricing_catalog_items_org_active on public.pricing_catalog_items (org_id, active, normalized_name);
create index if not exists idx_pricing_catalog_items_org_normalized on public.pricing_catalog_items (org_id, normalized_name);

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- RLS + grants. No DELETE policy and no DELETE grant for end users (soft-disable only). anon gets nothing.
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.pricing_catalog_items enable row level security;

revoke all on public.pricing_catalog_items from public, anon;
revoke delete, truncate on public.pricing_catalog_items from authenticated;
grant select, insert, update on public.pricing_catalog_items to authenticated;
grant select, insert, update, delete on public.pricing_catalog_items to service_role;

-- Owner/admin of the row's organization only (the table carries internal cost data).
drop policy if exists pricing_catalog_items_select_owner_admin on public.pricing_catalog_items;
create policy pricing_catalog_items_select_owner_admin on public.pricing_catalog_items
  for select to authenticated
  using (
    org_id in (select m.org_id from public.org_memberships m where m.member_id = auth.uid() and m.role in ('owner', 'admin'))
  );

drop policy if exists pricing_catalog_items_insert_owner_admin on public.pricing_catalog_items;
create policy pricing_catalog_items_insert_owner_admin on public.pricing_catalog_items
  for insert to authenticated
  with check (
    org_id in (select m.org_id from public.org_memberships m where m.member_id = auth.uid() and m.role in ('owner', 'admin'))
  );

drop policy if exists pricing_catalog_items_update_owner_admin on public.pricing_catalog_items;
create policy pricing_catalog_items_update_owner_admin on public.pricing_catalog_items
  for update to authenticated
  using (
    org_id in (select m.org_id from public.org_memberships m where m.member_id = auth.uid() and m.role in ('owner', 'admin'))
  )
  with check (
    org_id in (select m.org_id from public.org_memberships m where m.member_id = auth.uid() and m.role in ('owner', 'admin'))
  );

-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run AFTER applying, before trusting the change)
-- ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- 1) Columns:
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'pricing_catalog_items' order by ordinal_position;
-- 2) Constraints:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.pricing_catalog_items'::regclass order by 1;
-- 3) RLS enabled + policies (expect 3 policies, all owner/admin, none for DELETE):
--   select relrowsecurity from pg_class where oid = 'public.pricing_catalog_items'::regclass;
--   select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'pricing_catalog_items';
-- 4) Grants (expect: anon none; authenticated select/insert/update; service_role all):
--   select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'pricing_catalog_items' order by 1, 2;
-- 5) Trigger + function hardening (expect prosecdef = true, proconfig = {"search_path=pg_catalog, pg_temp"}):
--   select tgname from pg_trigger where tgrelid = 'public.pricing_catalog_items'::regclass and not tgisinternal;
--   select proname, prosecdef, proconfig from pg_proc where proname = 'pricing_catalog_items_guard';
-- 6) Indexes:
--   select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'pricing_catalog_items';
