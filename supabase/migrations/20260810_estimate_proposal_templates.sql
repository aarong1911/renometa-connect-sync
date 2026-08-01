-- supabase/migrations/20260810_estimate_proposal_templates.sql
--
-- Phase 10.4 continuation — organization-owned Proposal Content templates
-- (Customer Note / Exclusions / Assumptions / Terms). The shared, read-only
-- starter presets live in src/lib/proposal-presets.ts (application
-- constants, not a table — no org can mutate them). This table only stores
-- what an organization has explicitly copied and customized, or authored
-- from scratch, as "Save as Organization Template".
--
-- Additive, guarded, non-destructive. Does NOT touch the applied 20260809
-- migration or any existing table. Deploy manually via the Supabase SQL
-- Editor — do not run `supabase db push`.

-- ── Table ────────────────────────────────────────────────────────────────
create table if not exists public.estimate_proposal_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  category text not null,
  name text not null,
  content text not null default '',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'estimate_proposal_templates_category_check'
  ) then
    alter table public.estimate_proposal_templates
      add constraint estimate_proposal_templates_category_check
      check (category in ('customer_note', 'exclusions', 'assumptions', 'terms'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'estimate_proposal_templates_name_check'
  ) then
    alter table public.estimate_proposal_templates
      add constraint estimate_proposal_templates_name_check
      check (char_length(btrim(name)) > 0 and char_length(name) <= 120);
  end if;
end $$;

-- ── Indexes ──────────────────────────────────────────────────────────────
create index if not exists idx_estimate_proposal_templates_org_category
  on public.estimate_proposal_templates (org_id, category);

-- Enforces "one default per category per organization" at the database
-- level — the application clears the previous default before setting a
-- new one (see setDefaultTemplate() in src/lib/proposal-templates-store.ts),
-- and this index is the backstop against a race producing two defaults.
create unique index if not exists idx_estimate_proposal_templates_one_default
  on public.estimate_proposal_templates (org_id, category)
  where is_default;

-- ── updated_at trigger (mirrors the pattern already used elsewhere) ───────
create or replace function public.set_estimate_proposal_template_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists estimate_proposal_templates_set_updated_at on public.estimate_proposal_templates;
create trigger estimate_proposal_templates_set_updated_at
  before update on public.estimate_proposal_templates
  for each row execute function public.set_estimate_proposal_template_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.estimate_proposal_templates enable row level security;

drop policy if exists estimate_proposal_templates_select on public.estimate_proposal_templates;
create policy estimate_proposal_templates_select
  on public.estimate_proposal_templates for select
  to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists estimate_proposal_templates_insert on public.estimate_proposal_templates;
create policy estimate_proposal_templates_insert
  on public.estimate_proposal_templates for insert
  to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists estimate_proposal_templates_update on public.estimate_proposal_templates;
create policy estimate_proposal_templates_update
  on public.estimate_proposal_templates for update
  to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  )
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists estimate_proposal_templates_delete on public.estimate_proposal_templates;
create policy estimate_proposal_templates_delete
  on public.estimate_proposal_templates for delete
  to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- ── Verification (run after applying, in SQL Editor) ────────────────────
-- select table_name from information_schema.tables where table_name = 'estimate_proposal_templates';
-- select column_name, data_type, is_nullable from information_schema.columns where table_name = 'estimate_proposal_templates' order by ordinal_position;
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.estimate_proposal_templates'::regclass;
-- select indexname, indexdef from pg_indexes where tablename = 'estimate_proposal_templates';
-- select policyname, cmd from pg_policies where tablename = 'estimate_proposal_templates';
-- insert into public.estimate_proposal_templates (org_id, category, name, content) values ('<your org id>', 'terms', 'Test Template', 'Test content') returning *;
-- delete from public.estimate_proposal_templates where name = 'Test Template';
