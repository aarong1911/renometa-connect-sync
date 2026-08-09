-- Phase 13.5 -- Accounting Foundation (Chart of Accounts, Journal Entries,
-- Journal Entry Lines, Accounting Periods, Accounting Settings).
--
-- This is a NEW, additive migration. It does not modify
-- 20260818_invoice_payments_ledger.sql or 20260819_expand_invoice_status_check.sql.
--
-- Architecture (see Phase 13.5 report for full rationale):
--
--   Operational event (invoice issued, payment succeeded, ...)
--     -> Accounting Posting Service (netlify/lib/accounting.ts)
--     -> post_journal_entry() RPC (this file, SECURITY DEFINER, transactional)
--     -> accounting_journal_entries + accounting_journal_entry_lines
--     -> General Ledger / Trial Balance / P&L / Balance Sheet (derived, read-only)
--
-- Operational tables (invoices, invoice_payments, projects, project_financial_
-- adjustments) remain the source of truth for OPERATIONAL metrics (Outstanding,
-- Collected, Contracted Revenue, etc.) exactly as before -- this migration adds
-- a parallel accounting layer, it does not touch or read-replace them.
--
-- NOT applied automatically. Review and run manually in the Supabase SQL
-- Editor. Every statement (CREATE OR REPLACE, guarded CREATE/DROP TRIGGER,
-- ON CONFLICT DO NOTHING seeding, idempotent GRANT/REVOKE) is safe and
-- deterministic to re-run -- re-running does not duplicate rows, accounts,
-- or triggers -- though it is not literally a no-op each time (e.g. it
-- will still re-seed any org created since the last run).
-- No live invoice/payment event is hooked into this ledger by this
-- migration -- see the Phase 13.5 report ("no auto-posting yet").
--
-- Phase 13.5B (this revision) -- pre-deployment hardening pass. Still
-- never applied. Changes: explicit service_role-only EXECUTE grants on
-- every SECURITY DEFINER function (previously relied on implicit/default
-- privilege), journal-entry HEADER org validation (previously only lines
-- were validated), full posted-entry immutability + DB-level delete
-- protection on entries (previously only lines were delete-protected),
-- posted entries are now fully terminal (no direct posted->reversed
-- transition -- see section 5's comment for the documented future
-- reversal design), an advisory-lock-guarded concurrency-safe idempotency
-- path in post_journal_entry() (previously a plain check-then-insert
-- race), true fiscal-year-aware entry numbering (previously always
-- calendar-year), an accounting-period overlap guard, system-account
-- structural-field UPDATE protection (previously delete-only), explicit
-- table-level GRANT/REVOKE for both `authenticated` and `service_role`
-- (previously relied on Supabase's default privileges), and a manual
-- verification-query appendix.

begin;

-- ============================================================================
-- 1. ACCOUNTING_SETTINGS -- one row per org, tracks initialization state
-- ============================================================================
--
-- A dedicated table rather than new organizations columns, matching this
-- codebase's existing per-feature-table convention (invoice_payments,
-- project_financial_adjustments) rather than growing organizations with
-- one-off flags.

create table if not exists public.accounting_settings (
  org_id uuid primary key
    references public.organizations(id)
    on delete cascade,

  -- This is a deliberate BUSINESS/SYSTEM state, set by an explicit action
  -- (an approval, a completed+reconciled backfill run) -- never inferred
  -- from incidental row counts such as "at least one journal entry
  -- exists." A single stray posted entry (a manual test, a one-off
  -- correction) must not flip an org into looking "initialized."
  --
  -- not_initialized: Chart of Accounts may already be seeded (reference
  --   data only), but no one has reviewed/approved turning accounting on
  --   for this org -- accounting reports must not be presented as
  --   authoritative regardless of what happens to exist in the ledger.
  -- ready_for_backfill: staff has explicitly approved (backfill_approved_at/
  --   backfill_approved_by set) running the historical backfill, but it
  --   has not been executed/completed yet.
  -- initialized: the historical backfill has been run AND reconciled
  --   (accounting A/R / collected balances match operational totals -- see
  --   fetchReconciliationReport()) AND live posting has been switched on
  --   for this org. Only this state means "trust these statements."
  status text not null default 'not_initialized',

  fiscal_year_start_month smallint not null default 1,
  backfill_approved_at timestamptz null,
  backfill_approved_by uuid null references public.profiles(id) on delete set null,
  backfilled_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_settings_status_check
    check (status in ('not_initialized', 'ready_for_backfill', 'initialized')),
  constraint accounting_settings_fiscal_month_check
    check (fiscal_year_start_month between 1 and 12)
);

create or replace function public.set_accounting_settings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounting_settings_updated_at on public.accounting_settings;
create trigger trg_accounting_settings_updated_at
  before update on public.accounting_settings
  for each row execute function public.set_accounting_settings_updated_at();

-- Phase 13.5C, Part 12 -- every accounting_* table below uses ENABLE ROW
-- LEVEL SECURITY, deliberately not FORCE ROW LEVEL SECURITY. FORCE would
-- also apply RLS to the table owner, which would block this migration's
-- own seeding/backfill statements and any future maintenance run as the
-- owning/superuser role -- ordinary RLS already fully constrains
-- `authenticated`/`anon` (the only roles that actually need constraining;
-- there is no direct DML grant to either one on any accounting table),
-- and service_role bypasses RLS via BYPASSRLS regardless of FORCE. This
-- is confirmed as the intended choice, not an oversight.
alter table public.accounting_settings enable row level security;

drop policy if exists accounting_settings_select on public.accounting_settings;
create policy accounting_settings_select on public.accounting_settings
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Part 17/18 -- explicit table-level privileges, not left to Supabase's
-- default grants. RLS policies alone do not grant access; the underlying
-- GRANT is what makes SELECT reachable at all, and only the org-scoped
-- policy above then filters rows. authenticated gets read-only; anon gets
-- nothing; service_role gets full DML (Supabase's service_role already
-- bypasses RLS via BYPASSRLS, but the grant is made explicit here anyway
-- so this migration is self-documenting about intent, not dependent on
-- that implicit platform behavior).
revoke all on public.accounting_settings from anon, authenticated;
grant select on public.accounting_settings to authenticated;
grant select, insert, update, delete on public.accounting_settings to service_role;

-- Every existing org starts out explicitly not_initialized -- never left
-- implicit/absent, so callers can distinguish "row missing because query
-- failed" from "genuinely not initialized."
insert into public.accounting_settings (org_id, status)
select id, 'not_initialized' from public.organizations
on conflict (org_id) do nothing;

-- ============================================================================
-- 2. ACCOUNTING_ACCOUNTS -- Chart of Accounts
-- ============================================================================

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  code text not null,
  name text not null,
  description text null,

  account_type text not null,
  account_subtype text not null,
  normal_balance text not null,

  is_system boolean not null default false,
  is_active boolean not null default true,
  parent_account_id uuid null references public.accounting_accounts(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_accounts_type_check
    check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  constraint accounting_accounts_normal_balance_check
    check (normal_balance in ('debit', 'credit'))
);

create unique index if not exists uq_accounting_accounts_org_code
  on public.accounting_accounts (org_id, code);

create index if not exists idx_accounting_accounts_org_type
  on public.accounting_accounts (org_id, account_type) where is_active;

-- A parent account must belong to the same org -- CHECK constraints can't
-- reference other rows, so this is a trigger, matching invoice_payments'
-- validate_invoice_payment_org() pattern.
create or replace function public.validate_accounting_account_parent_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_parent_org uuid;
begin
  if new.parent_account_id is null then
    return new;
  end if;
  select org_id into v_parent_org from public.accounting_accounts where id = new.parent_account_id;
  if v_parent_org is null then
    raise exception 'parent_account_id does not reference an existing account';
  end if;
  if v_parent_org <> new.org_id then
    raise exception 'parent_account_id must belong to the same org';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_accounting_account_parent_org on public.accounting_accounts;
create trigger trg_validate_accounting_account_parent_org
  before insert or update on public.accounting_accounts
  for each row execute function public.validate_accounting_account_parent_org();

-- Part 1 -- trigger-only function. Postgres already refuses to invoke a
-- function returning `trigger` from ordinary SQL (`... is not fired by
-- trigger manager` at call time) regardless of EXECUTE grants, but the
-- revoke is made explicit anyway so this migration doesn't rely on that
-- implicit behavior for its security story.
revoke all on function public.validate_accounting_account_parent_org() from public, anon, authenticated;

create or replace function public.set_accounting_accounts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounting_accounts_updated_at on public.accounting_accounts;
create trigger trg_accounting_accounts_updated_at
  before update on public.accounting_accounts
  for each row execute function public.set_accounting_accounts_updated_at();

-- System accounts (is_system=true) are the ones the posting service resolves
-- by code -- ordinary staff CRUD must never delete or retype these, so
-- deletion is blocked outright at the DB layer, not just in the UI.
create or replace function public.prevent_system_account_delete()
returns trigger language plpgsql as $$
begin
  if old.is_system then
    raise exception 'System accounts cannot be deleted (account %: %)', old.code, old.name;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_system_account_delete on public.accounting_accounts;
create trigger trg_prevent_system_account_delete
  before delete on public.accounting_accounts
  for each row execute function public.prevent_system_account_delete();

revoke all on function public.prevent_system_account_delete() from public, anon, authenticated;

-- Part 15 -- deletion isn't the only way to break a system account: an
-- UPDATE that retypes 1100 Accounts Receivable's code/type/subtype/
-- normal_balance would silently break resolveSystemAccounts()'s
-- code-based lookup (netlify/lib/accounting.ts) or make future postings
-- financially wrong. Structural fields are frozen for is_system rows;
-- name/description remain editable (renaming a system account for display
-- purposes doesn't break resolution by code). is_system itself is frozen
-- too, so a row can never be quietly "unprotected" and then retyped.
--
-- Phase 13.5C, Part 4 -- resolveSystemAccounts() (netlify/lib/
-- accounting.ts) resolves by code alone and does NOT filter on
-- is_active -- so deactivating a system account wouldn't stop postings
-- from resolving it (a separate, milder correctness gap), but the real
-- risk is deactivating it elsewhere in the product (e.g. a future Chart
-- of Accounts UI hiding "inactive" accounts from pickers/reports) while
-- automated posting silently keeps using it. is_active=false is therefore
-- now blocked for is_system rows at the DB level, the same as the other
-- structural fields -- staff may still rename/re-describe a system
-- account, just never deactivate or structurally retype it while it
-- remains a system account.
create or replace function public.prevent_system_account_structural_change()
returns trigger language plpgsql as $$
begin
  if old.is_system then
    if new.code <> old.code
       or new.account_type <> old.account_type
       or new.account_subtype <> old.account_subtype
       or new.normal_balance <> old.normal_balance
       or new.is_system <> old.is_system
       or new.is_active <> old.is_active
    then
      raise exception 'System account % (%) cannot have its code/type/subtype/normal_balance/is_system/is_active changed', old.code, old.name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_system_account_structural_change on public.accounting_accounts;
create trigger trg_prevent_system_account_structural_change
  before update on public.accounting_accounts
  for each row execute function public.prevent_system_account_structural_change();

alter table public.accounting_accounts enable row level security;

drop policy if exists accounting_accounts_select on public.accounting_accounts;
create policy accounting_accounts_select on public.accounting_accounts
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Part 17/18/29/35 -- writes prefer backend for this phase (CRUD UI is
-- future work); no insert/update/delete grant to authenticated yet.
-- Explicit for both roles rather than relying on Supabase defaults.
revoke all on public.accounting_accounts from anon, authenticated;
grant select on public.accounting_accounts to authenticated;
grant select, insert, update, delete on public.accounting_accounts to service_role;

-- ── Default contractor Chart of Accounts (Part 4) ──────────────────────────
--
-- Idempotent: ON CONFLICT (org_id, code) DO NOTHING, safe to re-run. Seeds
-- every EXISTING org now (reference data only -- no financial postings, so
-- this is not the "backfill" Part 31/41 says must stay manual/reviewed) and
-- is also called by seed_default_chart_of_accounts() for any org created
-- after this migration runs (see netlify/lib/accounting.ts).

create or replace function public.seed_default_chart_of_accounts(p_org_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.accounting_accounts (org_id, code, name, account_type, account_subtype, normal_balance, is_system)
  values
    -- ASSETS
    (p_org_id, '1000', 'Cash',                     'asset',     'cash',                  'debit', false),
    (p_org_id, '1010', 'Operating Bank',            'asset',     'bank',                  'debit', false),
    (p_org_id, '1020', 'Undeposited Funds',         'asset',     'undeposited_funds',     'debit', true),
    (p_org_id, '1100', 'Accounts Receivable',       'asset',     'accounts_receivable',   'debit', true),
    (p_org_id, '1200', 'Other Current Assets',      'asset',     'other_current_asset',   'debit', false),
    (p_org_id, '1500', 'Equipment',                 'asset',     'fixed_asset',           'debit', false),
    (p_org_id, '1600', 'Vehicles',                  'asset',     'fixed_asset',           'debit', false),
    (p_org_id, '1700', 'Accumulated Depreciation',  'asset',     'fixed_asset',           'credit', false),
    -- LIABILITIES
    (p_org_id, '2000', 'Accounts Payable',          'liability', 'accounts_payable',      'credit', true),
    (p_org_id, '2100', 'Credit Cards',               'liability', 'credit_card',           'credit', false),
    (p_org_id, '2200', 'Sales Tax Payable',          'liability', 'other_current_liability','credit', false),
    (p_org_id, '2300', 'Other Current Liabilities',  'liability', 'other_current_liability','credit', false),
    (p_org_id, '2500', 'Long-Term Liabilities',      'liability', 'long_term_liability',   'credit', false),
    -- EQUITY
    (p_org_id, '3000', 'Owner''s Equity',            'equity',    'owner_equity',          'credit', false),
    (p_org_id, '3100', 'Retained Earnings',          'equity',    'retained_earnings',     'credit', true),
    (p_org_id, '3200', 'Owner Draw / Distributions', 'equity',    'owner_equity',          'debit', false),
    -- REVENUE
    (p_org_id, '4000', 'Construction Revenue',       'revenue',   'service_revenue',       'credit', true),
    (p_org_id, '4100', 'Change Order Revenue',       'revenue',   'service_revenue',       'credit', true),
    (p_org_id, '4200', 'Service Revenue',            'revenue',   'service_revenue',       'credit', false),
    (p_org_id, '4900', 'Other Revenue',              'revenue',   'other_revenue',         'credit', false),
    -- COST OF GOODS SOLD
    (p_org_id, '5000', 'Materials',                  'expense',   'cost_of_goods_sold',    'debit', false),
    (p_org_id, '5100', 'Direct Labor',                'expense',   'labor',                 'debit', false),
    (p_org_id, '5200', 'Subcontractors',              'expense',   'subcontractor',         'debit', false),
    (p_org_id, '5300', 'Equipment Rental',            'expense',   'equipment',             'debit', false),
    (p_org_id, '5400', 'Permits & Fees',              'expense',   'cost_of_goods_sold',    'debit', false),
    (p_org_id, '5500', 'Other Direct Project Costs',  'expense',   'cost_of_goods_sold',    'debit', false),
    -- OPERATING EXPENSES
    (p_org_id, '6000', 'Advertising & Marketing',     'expense',   'marketing',             'debit', false),
    (p_org_id, '6100', 'Vehicle Expense',             'expense',   'other_expense',         'debit', false),
    (p_org_id, '6200', 'Insurance',                   'expense',   'insurance',             'debit', false),
    (p_org_id, '6300', 'Office Expense',              'expense',   'office',                'debit', false),
    (p_org_id, '6400', 'Software & Subscriptions',    'expense',   'office',                'debit', false),
    (p_org_id, '6500', 'Professional Services',       'expense',   'professional_services', 'debit', false),
    (p_org_id, '6600', 'Rent',                        'expense',   'office',                'debit', false),
    (p_org_id, '6700', 'Utilities',                   'expense',   'utilities',             'debit', false),
    (p_org_id, '6800', 'Bank & Merchant Fees',        'expense',   'other_expense',         'debit', false),
    (p_org_id, '6900', 'Other Operating Expense',     'expense',   'other_expense',         'debit', false)
  on conflict (org_id, code) do nothing;
end;
$$;

-- Part 3 -- SECURITY DEFINER + org_id parameter is exactly the shape of
-- function an ordinary authenticated user must never be able to call
-- directly with an arbitrary UUID (it would let one org seed/no-op against
-- another org's id, and more importantly is meant to be an internal step
-- of a controlled initialization flow, not a standalone public operation).
-- Restricted to service_role only. The DO block immediately below (this
-- migration, run as the migration-owning role) and any future service-role
-- Netlify initialization helper both remain able to call it; ordinary
-- `authenticated` callers cannot, from Postgres or from PostgREST/RPC.
revoke all on function public.seed_default_chart_of_accounts(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_chart_of_accounts(uuid) to service_role;

do $$
declare
  v_org record;
begin
  for v_org in select id from public.organizations loop
    perform public.seed_default_chart_of_accounts(v_org.id);
  end loop;
end $$;

-- ============================================================================
-- 3. ACCOUNTING_PERIODS
-- ============================================================================

create table if not exists public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  start_date date not null,
  end_date date not null,
  name text not null,
  status text not null default 'open',

  closed_at timestamptz null,
  closed_by uuid null references public.profiles(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint accounting_periods_status_check check (status in ('open', 'closed')),
  constraint accounting_periods_date_order check (end_date >= start_date)
);

create index if not exists idx_accounting_periods_org_dates
  on public.accounting_periods (org_id, start_date, end_date);

alter table public.accounting_periods enable row level security;

drop policy if exists accounting_periods_select on public.accounting_periods;
create policy accounting_periods_select on public.accounting_periods
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.accounting_periods from anon, authenticated;
grant select on public.accounting_periods to authenticated;
grant select, insert, update, delete on public.accounting_periods to service_role;

-- Part 9 design decision: option A -- posting is allowed unless a matching
-- CLOSED period explicitly exists. No org needs to pre-create periods
-- before it can post; a period only needs to exist at all once someone
-- actually closes a month. See is_accounting_period_open() below.
--
-- Part 14 overlap audit: this predicate checks "does ANY closed period
-- cover this date" (not "is there a specific open period covering it"),
-- so an overlapping OPEN period can never accidentally unblock a date a
-- CLOSED period also covers -- closed always wins regardless of overlap.
-- Overlapping rows are still prohibited outright below (messy/ambiguous
-- data even though not exploitable) via a validation trigger rather than
-- a Postgres exclusion-constraint extension (btree_gist), since a plain
-- trigger is sufficient for this table's write volume.
create or replace function public.is_accounting_period_open(p_org_id uuid, p_date date)
returns boolean language sql stable as $$
  select not exists (
    select 1 from public.accounting_periods
    where org_id = p_org_id
      and status = 'closed'
      and p_date between start_date and end_date
  );
$$;

create or replace function public.prevent_accounting_period_overlap()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.accounting_periods
    where org_id = new.org_id
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and start_date <= new.end_date
      and end_date >= new.start_date
  ) then
    raise exception 'Accounting period % to % overlaps an existing period for this org', new.start_date, new.end_date;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_accounting_period_overlap on public.accounting_periods;
create trigger trg_prevent_accounting_period_overlap
  before insert or update on public.accounting_periods
  for each row execute function public.prevent_accounting_period_overlap();

revoke all on function public.prevent_accounting_period_overlap() from public, anon, authenticated;

-- ============================================================================
-- 4. ACCOUNTING_JOURNAL_ENTRY_COUNTERS -- row-locked, race-safe numbering
-- ============================================================================
--
-- Part 5 explicitly warns against count(*) + 1 under concurrency. This
-- mirrors the spirit of project_change_orders' advisory-lock-guarded
-- numbering but uses a plain per-org-per-year counter row + `select ...
-- for update` instead of an advisory lock -- simpler to reason about for a
-- single monotonic counter, and still fully race-safe: two concurrent
-- postings block on the same row until the first commits.

-- `fiscal_year` genuinely means fiscal year (Part 13) -- see
-- next_journal_entry_number() below, which now derives it from the org's
-- accounting_settings.fiscal_year_start_month instead of always using the
-- calendar year. Kept named `fiscal_year` (not renamed to `calendar_year`)
-- because that is now an accurate name for what it stores.
create table if not exists public.accounting_journal_entry_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year int not null,
  next_number int not null default 1,
  primary key (org_id, fiscal_year)
);

alter table public.accounting_journal_entry_counters enable row level security;
-- No browser access at all, in either direction -- this table is a purely
-- internal counter for next_journal_entry_number(); nothing in the product
-- ever needs to read or write it directly (Part 17).
revoke all on public.accounting_journal_entry_counters from anon, authenticated;

-- Part 13 -- fiscal year is named for the calendar year it STARTS in (a
-- fiscal year beginning Jul 2026 and ending Jun 2027 is "FY2026" / entry
-- numbers "JE-2026-######"), matching common small-business/QuickBooks
-- default framing. fiscal_year_start_month=1 (the default) makes this
-- identical to calendar-year numbering, so orgs that never touch that
-- setting see no behavior change.
create or replace function public.fiscal_year_for_date(p_org_id uuid, p_date date)
returns int language plpgsql stable as $$
declare
  v_start_month int;
  v_month int := extract(month from p_date);
  v_calendar_year int := extract(year from p_date);
begin
  select fiscal_year_start_month into v_start_month
    from public.accounting_settings where org_id = p_org_id;
  v_start_month := coalesce(v_start_month, 1);

  if v_start_month = 1 then
    return v_calendar_year;
  elsif v_month >= v_start_month then
    return v_calendar_year;
  else
    return v_calendar_year - 1;
  end if;
end;
$$;

create or replace function public.next_journal_entry_number(p_org_id uuid, p_entry_date date)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fiscal_year int := public.fiscal_year_for_date(p_org_id, p_entry_date);
  v_next int;
begin
  insert into public.accounting_journal_entry_counters (org_id, fiscal_year, next_number)
  values (p_org_id, v_fiscal_year, 1)
  on conflict (org_id, fiscal_year) do nothing;

  update public.accounting_journal_entry_counters
     set next_number = next_number + 1
   where org_id = p_org_id and fiscal_year = v_fiscal_year
   returning next_number - 1 into v_next;

  return 'JE-' || v_fiscal_year || '-' || lpad(v_next::text, 6, '0');
end;
$$;

-- Part 4/Phase 13.5C Part 14 -- both are internal helpers ONLY called from
-- within post_journal_entry() (itself SECURITY DEFINER) -- never invoked
-- directly by netlify/lib/accounting.ts. A SECURITY DEFINER function's
-- nested calls run as ITS OWNER, who implicitly retains EXECUTE on
-- functions it owns regardless of this REVOKE, so post_journal_entry()
-- keeps working correctly with no service_role grant needed here. An
-- authenticated user must never be able to call either of these directly
-- (advancing/gapping another org's journal sequence, or reading fiscal-
-- year math out of context) -- revoked from every client-facing role and
-- deliberately NOT exposed to service_role either, since nothing needs to
-- invoke them as a standalone RPC (Part 14: "do not grant unnecessary RPC
-- access").
revoke all on function public.next_journal_entry_number(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.fiscal_year_for_date(uuid, date) from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. ACCOUNTING_JOURNAL_ENTRIES
-- ============================================================================

create table if not exists public.accounting_journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  entry_number text not null,
  entry_date date not null,
  description text null,

  status text not null default 'draft',

  source_type text not null,
  source_id uuid null,
  -- Distinguishes multiple accounting events that can occur against the
  -- SAME source record over its lifecycle (e.g. one invoice can eventually
  -- have 'issued' and, later, 'voided' events) -- see Part 10/11.
  posting_key text not null default 'default',

  -- Phase 13.5C, Part 1 -- deliberately ON DELETE RESTRICT, not SET NULL.
  -- A hard DELETE of a Project/Contact referenced here would make Postgres
  -- UPDATE this row to null out the dimension -- but posted entries are
  -- immutable (enforce_journal_entry_immutability rejects ANY change to a
  -- posted row's project_id/contact_id), so that UPDATE would fail anyway,
  -- just later and less clearly. RESTRICT fails fast with an unambiguous
  -- foreign-key error instead of a confusing immutability-trigger error,
  -- and -- the actual point -- makes it impossible for financial history
  -- to silently lose its Project/Customer dimension. A Project or Contact
  -- with posted accounting history therefore cannot be hard-deleted at
  -- all until a deliberate accounting-safe archival workflow exists (see
  -- the Phase 13.5C report's audit of projects.index.tsx's/contacts-
  -- store.ts's current hard-delete behavior -- neither table has a soft-
  -- delete/archive column today, so this is a real, intended constraint,
  -- not a theoretical one).
  project_id uuid null references public.projects(id) on delete restrict,
  contact_id uuid null references public.contacts(id) on delete restrict,

  posted_at timestamptz null,
  -- Self-referential; SET NULL is fine here -- the row this points at can
  -- only be a draft (posted/reversed entries can never be deleted at all,
  -- per prevent_posted_journal_entry_delete()), so losing the link on a
  -- draft's deletion has no accounting-history consequence.
  reversed_entry_id uuid null references public.accounting_journal_entries(id) on delete set null,

  -- Phase 13.5C, Part 3 -- audit-trail "who," not a financial amount or
  -- dimension. SET NULL is the pragmatic, deliberate choice: a deleted
  -- staff profile must not block the org from ever deleting that profile,
  -- and losing "created by" on very old entries is a normal, acceptable
  -- audit-trail degradation (the same tradeoff invoice_payments.created_by
  -- and project_change_orders already make). Unlike project_id/contact_id,
  -- this WOULD otherwise conflict with posted-entry immutability the exact
  -- same way (ON DELETE SET NULL performs an UPDATE, which the
  -- immutability trigger would reject for a posted row) -- so created_by
  -- is deliberately EXCLUDED from enforce_journal_entry_immutability()'s
  -- frozen-field list below. This does not weaken MONETARY immutability
  -- (account_id/debit/credit/amounts, entry_date, source linkage, and the
  -- project/contact dimensions all remain fully frozen) -- only the
  -- auxiliary "which staff profile created this" attribution is allowed to
  -- degrade to null if that profile is later deleted.
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint accounting_journal_entries_status_check
    check (status in ('draft', 'posted', 'reversed')),
  constraint accounting_journal_entries_source_type_check
    check (source_type in (
      'invoice', 'invoice_payment', 'expense', 'vendor_bill', 'vendor_payment',
      'change_order', 'manual', 'refund', 'credit_memo', 'opening_balance'
    ))
);

create unique index if not exists uq_accounting_journal_entries_org_number
  on public.accounting_journal_entries (org_id, entry_number);

-- The idempotency guarantee from Part 10: one operational event (identified
-- by org + source_type + source_id + posting_key) posts at most once. Only
-- enforced for rows that actually have a source_id (manual entries have
-- source_id null and are exempt by definition).
create unique index if not exists uq_accounting_journal_entries_source
  on public.accounting_journal_entries (org_id, source_type, source_id, posting_key)
  where source_id is not null;

create index if not exists idx_accounting_journal_entries_org_date
  on public.accounting_journal_entries (org_id, entry_date desc);
create index if not exists idx_accounting_journal_entries_project
  on public.accounting_journal_entries (project_id) where project_id is not null;
create index if not exists idx_accounting_journal_entries_contact
  on public.accounting_journal_entries (contact_id) where contact_id is not null;

create or replace function public.set_accounting_journal_entries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounting_journal_entries_updated_at on public.accounting_journal_entries;
create trigger trg_accounting_journal_entries_updated_at
  before update on public.accounting_journal_entries
  for each row execute function public.set_accounting_journal_entries_updated_at();

-- Part 5 -- the line-level trigger (validate_journal_entry_line_org, section
-- 6) validates project_id/contact_id org consistency per line; the HEADER
-- carries its own project_id/contact_id too (used for the dashboard-level
-- dimension filters) and must be validated the same way, in the database,
-- not only by the Netlify posting service.
create or replace function public.validate_journal_entry_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_project_org uuid;
  v_contact_org uuid;
begin
  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'accounting_journal_entries.project_id must belong to the same org as the entry';
    end if;
  end if;

  if new.contact_id is not null then
    select org_id into v_contact_org from public.contacts where id = new.contact_id;
    if v_contact_org is null or v_contact_org <> new.org_id then
      raise exception 'accounting_journal_entries.contact_id must belong to the same org as the entry';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_journal_entry_org on public.accounting_journal_entries;
create trigger trg_validate_journal_entry_org
  before insert or update on public.accounting_journal_entries
  for each row execute function public.validate_journal_entry_org();

revoke all on function public.validate_journal_entry_org() from public, anon, authenticated;

-- Part 6/8 -- posted-entry immutability, hardened. A posted entry's
-- complete business record is now frozen -- every accounting/audit field,
-- including description, project_id, contact_id, and posted_at (previously
-- only org/date/source/posting_key were protected, and description/
-- dimensions/posted_at could still be silently rewritten by an application
-- bug).
--
-- Phase 13.5C, Part 3 -- created_by is deliberately NOT in the frozen list.
-- project_id/contact_id are frozen AND their FKs are ON DELETE RESTRICT
-- (see the table definition above), so a Project/Contact delete can never
-- reach this trigger as an UPDATE at all -- it's rejected earlier, by the
-- FK itself. created_by references profiles(id) ON DELETE SET NULL
-- instead (deleting a staff profile must not be permanently blocked by
-- every journal entry they ever created), which DOES reach this trigger
-- as a real UPDATE. The narrower check below allows exactly that one
-- transition -- an existing value clearing to null -- and nothing else:
-- created_by can never be reassigned to a *different* profile once
-- posted. This does not weaken monetary immutability; every amount,
-- account, date, and dimension stays fully frozen.
--
-- Part 8/9 reversal decision: for THIS hardening pass, posted is fully
-- TERMINAL -- status can never change away from 'posted' via ordinary
-- UPDATE, not even to 'reversed'. The 'reversed' value stays defined in
-- the CHECK constraint because reversed_entry_id and the future reversal
-- flow need it, but nothing in this migration ever sets it. This
-- deliberately defers building the actual reversal mechanism rather than
-- allow a status flip that would make the original entry's lines vanish
-- from posted-only reports while a compensating entry existed alone (see
-- Part 9's "reports must net to zero from the pair" -- src/lib/accounting/
-- ledger.ts's fetchGeneralLedgerLines() already includes any non-draft
-- status, not only 'posted', specifically so that whichever future design
-- is chosen -- flipping the original to 'reversed' once a real reversal
-- RPC exists, or leaving it 'posted' forever and relying solely on the
-- new reversal entry -- both the original and its reversal remain visible
-- together and net to zero. THE FUTURE REVERSAL RPC MUST NOT be built as a
-- plain UPDATE ... SET status='reversed' against this trigger; it will
-- need its own SECURITY DEFINER function that this trigger is deliberately
-- NOT taught to special-case here, so that no path -- not even a future
-- one -- can flip a posted entry without that dedicated, reviewed RPC.
create or replace function public.enforce_journal_entry_immutability()
returns trigger language plpgsql as $$
begin
  if old.status in ('posted', 'reversed') then
    if new.status <> old.status then
      raise exception 'Journal entry % is % and terminal -- status changes (including reversal) require a dedicated future reversal RPC, not a direct update', old.entry_number, old.status;
    end if;
    if new.created_by is distinct from old.created_by and new.created_by is not null then
      raise exception 'Journal entry %''s created_by can only be cleared (e.g. by profile deletion), never reassigned', old.entry_number;
    end if;
    if new.org_id <> old.org_id
       or new.entry_number <> old.entry_number
       or new.entry_date <> old.entry_date
       or new.description is distinct from old.description
       or new.source_type <> old.source_type
       or new.source_id is distinct from old.source_id
       or new.posting_key <> old.posting_key
       or new.project_id is distinct from old.project_id
       or new.contact_id is distinct from old.contact_id
       or new.posted_at is distinct from old.posted_at
       or new.created_at <> old.created_at
    then
      raise exception 'Journal entry % is % and its business record cannot be modified', old.entry_number, old.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_journal_entry_immutability on public.accounting_journal_entries;
create trigger trg_enforce_journal_entry_immutability
  before update on public.accounting_journal_entries
  for each row execute function public.enforce_journal_entry_immutability();

revoke all on function public.enforce_journal_entry_immutability() from public, anon, authenticated;

-- Part 7 -- a posted/reversed entry must not be directly DELETEd either
-- (an unprotected DELETE would cascade into accounting_journal_entry_lines
-- via its FK and erase accounting history outright). Draft entries may
-- still be deleted -- that's the normal "abandon this draft" workflow.
create or replace function public.prevent_posted_journal_entry_delete()
returns trigger language plpgsql as $$
begin
  if old.status in ('posted', 'reversed') then
    raise exception 'Journal entry % is % and cannot be deleted', old.entry_number, old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_journal_entry_delete on public.accounting_journal_entries;
create trigger trg_prevent_posted_journal_entry_delete
  before delete on public.accounting_journal_entries
  for each row execute function public.prevent_posted_journal_entry_delete();

revoke all on function public.prevent_posted_journal_entry_delete() from public, anon, authenticated;

alter table public.accounting_journal_entries enable row level security;

drop policy if exists accounting_journal_entries_select on public.accounting_journal_entries;
create policy accounting_journal_entries_select on public.accounting_journal_entries
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Part 17/18/29 -- no direct client writes at all. Every journal entry is
-- created through post_journal_entry() (SECURITY DEFINER, below), called
-- only from the service-role Netlify accounting posting service.
revoke all on public.accounting_journal_entries from anon, authenticated;
grant select on public.accounting_journal_entries to authenticated;
grant select, insert, update, delete on public.accounting_journal_entries to service_role;

-- ============================================================================
-- 6. ACCOUNTING_JOURNAL_ENTRY_LINES
-- ============================================================================

create table if not exists public.accounting_journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  journal_entry_id uuid not null references public.accounting_journal_entries(id) on delete cascade,
  -- Phase 13.5C, Part 11 -- no ON DELETE action specified defaults to NO
  -- ACTION (behaves as RESTRICT for our purposes): an accounting account
  -- referenced by any journal line can never be deleted while that
  -- history exists. Combined with system-account protection
  -- (prevent_system_account_delete/prevent_system_account_structural_
  -- change), a line can never lose its account_id.
  account_id uuid not null references public.accounting_accounts(id),

  -- Phase 13.5C, Part 1 -- same reasoning as accounting_journal_entries.
  -- project_id/contact_id above: ON DELETE RESTRICT, not SET NULL, so a
  -- Project/Contact with posted line-level history cannot be hard-deleted
  -- and financial history never silently loses its dimension.
  project_id uuid null references public.projects(id) on delete restrict,
  contact_id uuid null references public.contacts(id) on delete restrict,

  description text null,
  debit numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0,

  created_at timestamptz not null default now(),

  constraint accounting_journal_entry_lines_debit_nonneg check (debit >= 0),
  constraint accounting_journal_entry_lines_credit_nonneg check (credit >= 0),
  constraint accounting_journal_entry_lines_not_both check (not (debit > 0 and credit > 0)),
  constraint accounting_journal_entry_lines_not_zero check (debit > 0 or credit > 0)
);

create index if not exists idx_accounting_journal_entry_lines_entry
  on public.accounting_journal_entry_lines (journal_entry_id);
create index if not exists idx_accounting_journal_entry_lines_account
  on public.accounting_journal_entry_lines (account_id, org_id);
create index if not exists idx_accounting_journal_entry_lines_project
  on public.accounting_journal_entry_lines (project_id) where project_id is not null;

-- Part 6 -- account/entry/project/contact must all belong to the same org
-- as the line itself. Cross-table checks require a trigger (CHECK
-- constraints cannot reference other tables).
create or replace function public.validate_journal_entry_line_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entry_org uuid;
  v_entry_status text;
  v_account_org uuid;
  v_project_org uuid;
  v_contact_org uuid;
begin
  select org_id, status into v_entry_org, v_entry_status
    from public.accounting_journal_entries where id = new.journal_entry_id;
  if v_entry_org is null then
    raise exception 'journal_entry_id does not reference an existing journal entry';
  end if;
  if v_entry_org <> new.org_id then
    raise exception 'journal_entry_lines.org_id must match its journal entry''s org_id';
  end if;
  if v_entry_status = 'posted' then
    raise exception 'Cannot add/modify lines on posted journal entry (id %) -- use a reversal instead', new.journal_entry_id;
  end if;
  if v_entry_status = 'reversed' then
    raise exception 'Cannot add/modify lines on a reversed journal entry';
  end if;

  select org_id into v_account_org from public.accounting_accounts where id = new.account_id;
  if v_account_org is null then
    raise exception 'account_id does not reference an existing account';
  end if;
  if v_account_org <> new.org_id then
    raise exception 'account_id must belong to the same org as the journal entry line';
  end if;

  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'project_id must belong to the same org as the journal entry line';
    end if;
  end if;

  if new.contact_id is not null then
    select org_id into v_contact_org from public.contacts where id = new.contact_id;
    if v_contact_org is null or v_contact_org <> new.org_id then
      raise exception 'contact_id must belong to the same org as the journal entry line';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_journal_entry_line_org on public.accounting_journal_entry_lines;
create trigger trg_validate_journal_entry_line_org
  before insert or update on public.accounting_journal_entry_lines
  for each row execute function public.validate_journal_entry_line_org();

revoke all on function public.validate_journal_entry_line_org() from public, anon, authenticated;

-- Part 10 -- all three mutation paths on a posted/reversed entry's lines
-- are blocked at the DB level (not only via RLS, so a service-role
-- application bug is caught too): INSERT and UPDATE both go through
-- validate_journal_entry_line_org() above (it checks v_entry_status and
-- raises for 'posted'/'reversed' before the row is written); DELETE goes
-- through prevent_posted_line_delete() below. Verified: no fourth mutation
-- path exists (no TRUNCATE grant to anon/authenticated, and the table has
-- no other trigger-bypassing route).
create or replace function public.prevent_posted_line_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from public.accounting_journal_entries where id = old.journal_entry_id;
  if v_status in ('posted', 'reversed') then
    raise exception 'Cannot delete a line from a % journal entry', v_status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_line_delete on public.accounting_journal_entry_lines;
create trigger trg_prevent_posted_line_delete
  before delete on public.accounting_journal_entry_lines
  for each row execute function public.prevent_posted_line_delete();

revoke all on function public.prevent_posted_line_delete() from public, anon, authenticated;

alter table public.accounting_journal_entry_lines enable row level security;

drop policy if exists accounting_journal_entry_lines_select on public.accounting_journal_entry_lines;
create policy accounting_journal_entry_lines_select on public.accounting_journal_entry_lines
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.accounting_journal_entry_lines from anon, authenticated;
grant select on public.accounting_journal_entry_lines to authenticated;
grant select, insert, update, delete on public.accounting_journal_entry_lines to service_role;

-- ============================================================================
-- 7. post_journal_entry() -- the ONLY way a balanced entry gets posted
-- ============================================================================
--
-- Part 7/10 -- single transactional RPC: builds the draft entry, inserts
-- every line, validates SUM(debit) = SUM(credit) to the cent, checks the
-- accounting period is open, and only then flips status to 'posted'. Any
-- failure raises and the whole transaction rolls back -- an unbalanced or
-- otherwise invalid entry can never be left half-written.
--
-- Idempotency: if a row already exists for (org_id, source_type, source_id,
-- posting_key), returns that existing entry's id/entry_number unchanged
-- instead of erroring or duplicating -- safe to call this function twice
-- for the same event (e.g. a retried webhook).
--
-- Phase 13.5D, Part 2/3 -- this guarantee is conditional on source_id:
--   Automated operational events (invoice, invoice_payment, expense,
--   vendor_bill, vendor_payment, change_order, refund, credit_memo):
--   source_id is REQUIRED (enforced below, before any lock/insert) --
--   every call is idempotent against (org_id, source_type, source_id,
--   posting_key), and a retried/duplicated call safely returns the
--   original entry instead of posting twice.
--   Manual and opening_balance entries: source_id MAY be null -- there is
--   no natural operational record to be idempotent against, so each call
--   is an intentionally independent new entry, not a duplicate to guard
--   against. The unique index, the advisory lock, and the idempotent
--   re-check are all scoped to "source_id is not null" for exactly this
--   reason.
--
-- Part 11 concurrency hardening: a plain "SELECT existing, then INSERT if
-- none" has a race -- two simultaneous calls for the same event can both
-- pass the SELECT before either INSERTs, and the loser then hits the
-- uq_accounting_journal_entries_source unique violation as a hard error
-- instead of an idempotent result. Fixed with a transaction-scoped
-- advisory lock keyed on (org_id, source_type, source_id, posting_key),
-- taken BEFORE the existence check: the second caller blocks until the
-- first caller's transaction commits (entry now exists -> re-check finds
-- it, returns already_posted=true) or rolls back (entry doesn't exist ->
-- proceeds to post normally). pg_advisory_xact_lock auto-releases at
-- commit/rollback, so nothing can leak a held lock. The unique index
-- remains as the final guarantee regardless -- a second INSERT ... ON
-- CONFLICT-style guard around the actual insert catches unique_violation
-- as a defense-in-depth backstop even if the lock were somehow bypassed.
-- Manual entries (source_id is null) skip locking entirely -- idempotency
-- is meaningless for them (the unique index itself only applies where
-- source_id is not null), and serializing all of an org's manual entries
-- against a constant lock key would be pure unnecessary contention.
--
-- p_lines shape: jsonb array of
--   { "account_id": uuid, "debit": numeric, "credit": numeric,
--     "description": text|null, "project_id": uuid|null, "contact_id": uuid|null }
--
-- SECURITY DEFINER, not granted to authenticated -- callable only by
-- service_role (i.e. only from the trusted Netlify accounting posting
-- service), matching this codebase's established pattern for every other
-- financially-sensitive RPC (approve_project_change_order, etc.). See the
-- explicit REVOKE/GRANT immediately after the function body -- do not
-- assume default privileges.
create or replace function public.post_journal_entry(
  p_org_id uuid,
  p_entry_date date,
  p_description text,
  p_source_type text,
  p_source_id uuid,
  p_posting_key text,
  p_lines jsonb,
  p_project_id uuid default null,
  p_contact_id uuid default null,
  p_created_by uuid default null
)
returns table (entry_id uuid, entry_number text, already_posted boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing record;
  v_entry_id uuid;
  v_entry_number text;
  v_total_debit numeric(14,2) := 0;
  v_total_credit numeric(14,2) := 0;
  v_line jsonb;
  v_line_count int := 0;
  v_valid_source_types text[] := array[
    'invoice', 'invoice_payment', 'expense', 'vendor_bill', 'vendor_payment',
    'change_order', 'manual', 'refund', 'credit_memo', 'opening_balance'
  ];
  v_line_account_id uuid;
  v_line_debit numeric(14,2);
  v_line_credit numeric(14,2);
begin
  -- Phase 13.5C, Part 5/6/7/8 -- explicit, deterministic input validation
  -- BEFORE the advisory lock or any insert. The table CHECK constraints
  -- and FKs remain the final authority (a bug here can never let a bad
  -- row through) -- this exists purely so a caller gets one clear
  -- "Invalid source_type X" error instead of an opaque constraint-
  -- violation error after a lock was already taken.
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if not exists (select 1 from public.organizations where id = p_org_id) then
    -- Part 6 -- the FK on accounting_journal_entries.org_id would
    -- eventually catch this too, but a named check up front is clearer.
    -- Only existence is checked/returned -- no org data is exposed, and
    -- this RPC is service_role-only regardless (see the REVOKE/GRANT
    -- after the function body).
    raise exception 'Organization % does not exist', p_org_id;
  end if;
  if p_entry_date is null then
    raise exception 'entry_date is required';
  end if;
  if p_source_type is null or btrim(p_source_type) = '' then
    raise exception 'source_type is required';
  end if;
  if not (p_source_type = any(v_valid_source_types)) then
    raise exception 'Invalid source_type % -- must be one of %', p_source_type, array_to_string(v_valid_source_types, ', ');
  end if;
  -- Phase 13.5D, Part 2/3 -- the (org_id, source_type, source_id,
  -- posting_key) unique index, the idempotency re-check, and the
  -- concurrency-serializing advisory lock are ALL scoped by "where
  -- source_id is not null" / "if p_source_id is not null" -- an automated
  -- operational event posted with source_id NULL would silently bypass
  -- every one of those protections, letting a backend retry/bug double-
  -- post the same invoice/payment/etc. with no duplicate detection at
  -- all. Only 'manual' (a human deliberately creating an independent
  -- entry) and 'opening_balance' (a one-time balance with no natural
  -- operational record to link) are exempt -- and that exemption is the
  -- point for them, not an oversight: a manual entry is SUPPOSED to be
  -- allowed to post again independently; it has no "source event" to be
  -- idempotent against in the first place. Every other source_type is a
  -- real operational event with a real row backing it, so source_id is
  -- required, never invented/faked.
  if p_source_type not in ('manual', 'opening_balance') and p_source_id is null then
    raise exception 'source_id is required for source_type % -- only manual and opening_balance entries may omit it', p_source_type;
  end if;
  if p_posting_key is null or btrim(p_posting_key) = '' then
    raise exception 'posting_key is required';
  end if;
  -- Part 7 -- trim only; deterministic event keys like 'issued'/
  -- 'succeeded'/'refund' are caller-chosen constants, not user text, so
  -- there is nothing else to normalize and no reason to lowercase an
  -- arbitrary external id a future Stripe integration might pass here.
  p_posting_key := btrim(p_posting_key);

  if p_lines is null then
    raise exception 'lines is required';
  end if;
  -- Check the type before calling jsonb_array_length -- calling it on a
  -- non-array value (e.g. a bare object) raises an opaque internal error
  -- instead of this clear one.
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a JSON array';
  end if;
  if jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry requires at least two lines';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if nullif(v_line->>'account_id', '') is null then
      raise exception 'Every line requires an account_id';
    end if;
    begin
      v_line_account_id := (v_line->>'account_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid account_id % -- not a UUID', v_line->>'account_id';
    end;
    begin
      v_line_debit := coalesce((v_line->>'debit')::numeric(14,2), 0);
      v_line_credit := coalesce((v_line->>'credit')::numeric(14,2), 0);
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Invalid debit/credit on line for account % -- not a parseable non-negative number', v_line_account_id;
    end;
    if v_line_debit < 0 or v_line_credit < 0 then
      raise exception 'Line debit/credit cannot be negative (account %)', v_line_account_id;
    end if;
    if v_line_debit > 0 and v_line_credit > 0 then
      raise exception 'Line cannot have both debit and credit > 0 (account %)', v_line_account_id;
    end if;
    if v_line_debit = 0 and v_line_credit = 0 then
      raise exception 'Line cannot be zero on both sides (account %)', v_line_account_id;
    end if;
  end loop;

  -- Part 11 -- serialize concurrent attempts at the SAME event before
  -- either checks or inserts anything. Two different events (different
  -- source_id/posting_key) hash to different lock keys and never block
  -- each other; two org-scoped-but-otherwise-unrelated postings likewise
  -- proceed independently.
  if p_source_id is not null then
    perform pg_advisory_xact_lock(hashtext(p_org_id::text), hashtext(p_source_type || ':' || p_source_id::text || ':' || p_posting_key));

    select id, accounting_journal_entries.entry_number into v_existing
      from public.accounting_journal_entries
     where org_id = p_org_id and source_type = p_source_type
       and source_id = p_source_id and posting_key = p_posting_key;
    if found then
      return query select v_existing.id, v_existing.entry_number, true;
      return;
    end if;
  end if;

  if not public.is_accounting_period_open(p_org_id, p_entry_date) then
    raise exception 'Accounting period covering % is closed for org %', p_entry_date, p_org_id;
  end if;

  -- Phase 13.5C, Part 10 -- this consumes a number even on the rare path
  -- where the unique_violation handler below discards the insert and
  -- returns an existing entry instead (the advisory lock above should
  -- make that path practically unreachable for same-event concurrency,
  -- but it is not physically impossible). That leaves a harmless gap in
  -- the sequence for this fiscal year, never a duplicate or reused
  -- number. Accounting journal numbers must be unique and auditable, not
  -- gapless -- the same tradeoff real accounting systems make (a void
  -- check or a cancelled invoice number is not reissued either) -- so
  -- this is accepted as-is rather than adding rollback-a-number
  -- complexity for a practically-unreachable edge case.
  v_entry_number := public.next_journal_entry_number(p_org_id, p_entry_date);

  begin
    insert into public.accounting_journal_entries (
      org_id, entry_number, entry_date, description, status,
      source_type, source_id, posting_key, project_id, contact_id, created_by
    ) values (
      p_org_id, v_entry_number, p_entry_date, p_description, 'draft',
      p_source_type, p_source_id, p_posting_key, p_project_id, p_contact_id, p_created_by
    ) returning id into v_entry_id;
  exception when unique_violation then
    -- Defense-in-depth backstop (Part 11): under the advisory lock above
    -- this should be unreachable for the source-uniqueness case, but if it
    -- somehow still fires for that specific constraint, degrade to the
    -- same idempotent result rather than a hard error. Any other unique
    -- violation (e.g. a genuine entry_number collision) is a real bug and
    -- must still surface.
    if sqlerrm like '%uq_accounting_journal_entries_source%' and p_source_id is not null then
      select id, accounting_journal_entries.entry_number into v_existing
        from public.accounting_journal_entries
       where org_id = p_org_id and source_type = p_source_type
         and source_id = p_source_id and posting_key = p_posting_key;
      if found then
        return query select v_existing.id, v_existing.entry_number, true;
        return;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_count := v_line_count + 1;
    insert into public.accounting_journal_entry_lines (
      org_id, journal_entry_id, account_id, project_id, contact_id, description, debit, credit
    ) values (
      p_org_id,
      v_entry_id,
      (v_line->>'account_id')::uuid,
      nullif(v_line->>'project_id', '')::uuid,
      nullif(v_line->>'contact_id', '')::uuid,
      v_line->>'description',
      coalesce((v_line->>'debit')::numeric(14,2), 0),
      coalesce((v_line->>'credit')::numeric(14,2), 0)
    );
    v_total_debit := v_total_debit + coalesce((v_line->>'debit')::numeric(14,2), 0);
    v_total_credit := v_total_credit + coalesce((v_line->>'credit')::numeric(14,2), 0);
  end loop;

  if v_total_debit <> v_total_credit then
    raise exception 'Journal entry does not balance: debits % <> credits %', v_total_debit, v_total_credit;
  end if;
  if v_total_debit = 0 then
    raise exception 'Journal entry has zero total -- nothing to post';
  end if;

  update public.accounting_journal_entries
     set status = 'posted', posted_at = now()
   where id = v_entry_id;

  return query select v_entry_id, v_entry_number, false;
end;
$$;

-- Part 2 -- explicit, not assumed. service_role can post; anon,
-- authenticated, and PUBLIC categorically cannot -- confirmed by the
-- verification queries appendix below (section G/H).
revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, text, jsonb, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, text, jsonb, uuid, uuid, uuid) to service_role;

commit;

-- ============================================================================
-- MANUAL VERIFICATION QUERIES (Part 25) -- run these individually AFTER
-- applying the migration above. Not part of the transaction; nothing here
-- executes automatically, and none of it posts a test journal entry
-- against live data.
-- ============================================================================

-- A. Tables exist
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'accounting_%'
--  order by table_name;

-- B. Default COA count (expect 36 per org -- 8 Assets, 5 Liabilities,
--    3 Equity, 4 Revenue, 6 Direct Cost/COGS, 10 Operating Expenses;
--    counted directly against seed_default_chart_of_accounts()'s VALUES
--    list, not assumed)
-- select org_id, count(*) from public.accounting_accounts group by org_id;

-- C. System accounts (expect exactly: 1020, 1100, 2000, 3100, 4000, 4100)
-- select org_id, code, name, is_system from public.accounting_accounts
--  where is_system order by org_id, code;

-- D. RLS enabled on every accounting table
-- select relname, relrowsecurity, relforcerowsecurity from pg_class
--  where relname like 'accounting_%' and relkind = 'r';

-- E. authenticated has SELECT (expect a row for every accounting_* table
--    EXCEPT accounting_journal_entry_counters)
-- select table_name, privilege_type from information_schema.role_table_grants
--  where grantee = 'authenticated' and table_schema = 'public'
--    and table_name like 'accounting_%' and privilege_type = 'SELECT'
--  order by table_name;

-- F. authenticated has NO insert/update/delete anywhere (expect ZERO rows)
-- select table_name, privilege_type from information_schema.role_table_grants
--  where grantee in ('authenticated', 'anon') and table_schema = 'public'
--    and table_name like 'accounting_%' and privilege_type in ('INSERT','UPDATE','DELETE');

-- G. service_role can execute post_journal_entry (expect one row)
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--  where routine_name = 'post_journal_entry' and grantee = 'service_role';

-- H. authenticated/anon/PUBLIC CANNOT execute post_journal_entry (expect ZERO rows)
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--  where routine_name = 'post_journal_entry' and grantee in ('authenticated', 'anon', 'PUBLIC');

-- I. seed_default_chart_of_accounts not exposed to authenticated (expect ZERO rows)
-- select routine_name, grantee from information_schema.role_routine_grants
--  where routine_name = 'seed_default_chart_of_accounts' and grantee in ('authenticated', 'anon', 'PUBLIC');

-- J. next_journal_entry_number not exposed to authenticated (expect ZERO rows)
-- select routine_name, grantee from information_schema.role_routine_grants
--  where routine_name = 'next_journal_entry_number' and grantee in ('authenticated', 'anon', 'PUBLIC');

-- K. Journal entry triggers present (expect 4: updated_at, org-validation,
--    immutability, delete-protection)
-- select tgname from pg_trigger
--  where tgrelid = 'public.accounting_journal_entries'::regclass and not tgisinternal;

-- L. Journal line triggers present (expect 2: org-validation, delete-protection)
-- select tgname from pg_trigger
--  where tgrelid = 'public.accounting_journal_entry_lines'::regclass and not tgisinternal;

-- M. accounting_settings state (expect status='not_initialized' for every org, right now)
-- select org_id, status, fiscal_year_start_month from public.accounting_settings;

-- N. Zero journal entries before backfill (expect ZERO rows -- this
--    migration never posts anything)
-- select count(*) from public.accounting_journal_entries;
-- select count(*) from public.accounting_journal_entry_lines;

-- ── Phase 13.5C additions ────────────────────────────────────────────────

-- O. FK delete action on journal Project/Contact references (expect 'r' =
--    RESTRICT for all four rows; NOT 'a' = no action's default display
--    differs by pg_constraint.confdeltype convention, so also sanity-check
--    against a known SET NULL column like created_by, which should show 'n')
-- select conrelid::regclass as table_name, conname, confdeltype
--  from pg_constraint
--  where conrelid in ('public.accounting_journal_entries'::regclass, 'public.accounting_journal_entry_lines'::regclass)
--    and contype = 'f'
--  order by conrelid::regclass::text, conname;

-- P. Critical system accounts are active (expect is_active = true for
--    every row -- is_active can never be false for is_system rows once
--    the structural-change trigger is in place)
-- select org_id, code, name, is_system, is_active from public.accounting_accounts
--  where is_system order by org_id, code;

-- Q. post_journal_entry / seed_default_chart_of_accounts execute grants
--    (expect exactly one row each, grantee = service_role)
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--  where routine_name in ('post_journal_entry', 'seed_default_chart_of_accounts')
--  order by routine_name, grantee;

-- R. next_journal_entry_number / fiscal_year_for_date have NO grants to
--    any role at all (expect ZERO rows -- internal-only, not even
--    service_role, per Phase 13.5C Part 14)
-- select routine_name, grantee from information_schema.role_routine_grants
--  where routine_name in ('next_journal_entry_number', 'fiscal_year_for_date');

-- S. RLS is ENABLED but not FORCED on every accounting table (expect
--    relrowsecurity = true, relforcerowsecurity = false for all rows --
--    confirms the deliberate choice from Part 12)
-- select relname, relrowsecurity, relforcerowsecurity from pg_class
--  where relname like 'accounting_%' and relkind = 'r';

-- T. Every accounting-related function's actual security mode (expect 9
--    rows total: 8 with prosecdef = true (SECURITY DEFINER) each showing
--    'search_path=public, pg_temp' in proconfig -- validate_accounting_
--    account_parent_org, seed_default_chart_of_accounts, prevent_
--    accounting_period_overlap, next_journal_entry_number, validate_
--    journal_entry_org, validate_journal_entry_line_org, prevent_posted_
--    line_delete, post_journal_entry -- and exactly 1 row with
--    prosecdef = false -- fiscal_year_for_date(), which is intentionally
--    plain `language plpgsql stable`, not SECURITY DEFINER: it is never
--    directly executable by any client role (revoked from public/anon/
--    authenticated/service_role alike -- see the grants after its
--    definition) and is only ever called from WITHIN post_journal_entry(),
--    which runs as its owner and so already has implicit EXECUTE on it
--    regardless of SECURITY DEFINER status. Do not expect/require
--    search_path on this one row.)
-- select proname, prosecdef, proconfig from pg_proc
--  where pronamespace = 'public'::regnamespace
--    and proname in (
--      'validate_accounting_account_parent_org', 'seed_default_chart_of_accounts',
--      'prevent_accounting_period_overlap', 'next_journal_entry_number',
--      'fiscal_year_for_date', 'validate_journal_entry_org',
--      'validate_journal_entry_line_org', 'prevent_posted_line_delete',
--      'post_journal_entry'
--    )
--  order by proname;
