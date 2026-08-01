-- supabase/migrations/20260811_scope_of_work_templates.sql
--
-- Phase 10.4 continuation — adds Scope of Work as a fifth Proposal Content
-- template category, filtered by Work Type. Reuses the existing
-- estimate_proposal_templates table from 20260810 (does NOT create a new
-- table) — adds one nullable column, widens the category check, adds a
-- work_type validity check, and replaces the one-default-per-category
-- unique index with one that also accounts for work_type.
--
-- Additive, guarded, non-destructive. Does NOT touch 20260809 or 20260810.
-- Deploy manually via the Supabase SQL Editor — do not run `supabase db push`.
-- RLS policies from 20260810 are already org_id-scoped only (no category
-- hard-coding), so they apply to scope_of_work rows unchanged — this
-- migration does not touch RLS.

-- ── Column ───────────────────────────────────────────────────────────────
alter table public.estimate_proposal_templates
  add column if not exists work_type text;

-- ── Category check — widen to include scope_of_work ─────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'estimate_proposal_templates_category_check'
  ) then
    alter table public.estimate_proposal_templates
      drop constraint estimate_proposal_templates_category_check;
  end if;

  alter table public.estimate_proposal_templates
    add constraint estimate_proposal_templates_category_check
    check (category in ('customer_note', 'exclusions', 'assumptions', 'terms', 'scope_of_work'));
end $$;

-- ── Work Type check — required + canonical for scope_of_work, null otherwise ──
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'estimate_proposal_templates_work_type_check'
  ) then
    alter table public.estimate_proposal_templates
      add constraint estimate_proposal_templates_work_type_check
      check (
        (
          category = 'scope_of_work'
          and work_type in (
            'kitchen_remodel', 'bathroom_remodel', 'full_home_remodel', 'home_addition',
            'roofing', 'flooring', 'interior_painting', 'exterior_painting',
            'hvac_installation', 'hvac_repair', 'plumbing', 'electrical', 'landscaping',
            'commercial_renovation', 'new_construction', 'repair_maintenance',
            'inspection', 'consultation', 'other'
          )
        )
        or (category <> 'scope_of_work' and work_type is null)
      );
  end if;
end $$;

-- ── Default unique index — one default per org + category + work_type ──
-- (coalesce(work_type,'') so the existing four work_type-less categories
-- keep exactly their 20260810 "one default per org+category" behavior,
-- while scope_of_work gets "one default per org+category+work_type").
drop index if exists idx_estimate_proposal_templates_one_default;
create unique index if not exists idx_estimate_proposal_templates_one_default
  on public.estimate_proposal_templates (org_id, category, coalesce(work_type, ''))
  where is_default;

-- ── Lookup index for the Scope Template selector ────────────────────────
create index if not exists idx_estimate_proposal_templates_scope_lookup
  on public.estimate_proposal_templates (org_id, category, work_type, name);

-- ── Verification (run after applying, in SQL Editor) ────────────────────
-- 1. select column_name from information_schema.columns where table_name='estimate_proposal_templates' and column_name='work_type';
-- 2. select pg_get_constraintdef(oid) from pg_constraint where conname='estimate_proposal_templates_category_check';
-- 3. select pg_get_constraintdef(oid) from pg_constraint where conname='estimate_proposal_templates_work_type_check';
-- 4. select indexdef from pg_indexes where indexname='idx_estimate_proposal_templates_one_default';
-- 5. select indexdef from pg_indexes where indexname='idx_estimate_proposal_templates_scope_lookup';
-- 6. select count(*) from public.estimate_proposal_templates; -- unchanged row count from before this migration
-- 7. select count(*) from public.estimate_proposal_templates where category <> 'scope_of_work' and work_type is not null; -- expect 0
-- 8. select org_id, category, coalesce(work_type,'') , count(*) from public.estimate_proposal_templates where is_default group by 1,2,3 having count(*) > 1; -- expect 0 rows
-- 9. select relrowsecurity from pg_class where oid = 'public.estimate_proposal_templates'::regclass; -- expect true
-- 10. select policyname, cmd from pg_policies where tablename = 'estimate_proposal_templates'; -- expect the same 4 policies from 20260810
-- Test insert/cleanup:
-- insert into public.estimate_proposal_templates (org_id, category, work_type, name, content) values ('<your org id>', 'scope_of_work', 'kitchen_remodel', 'Test Scope', 'Test content') returning *;
-- delete from public.estimate_proposal_templates where name = 'Test Scope';
