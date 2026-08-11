-- Phase 13.8 -- Expenses, Vendors, Bills, A/P, and Project Cost Posting.
--
-- NEW, additive migration. Does not modify 20260818_invoice_payments_ledger.sql,
-- 20260819_expand_invoice_status_check.sql, 20260820_accounting_foundation.sql,
-- or 20260821_public_invoice_payments.sql.
--
-- Phase 13.8D CORRECTION -- the original Phase 13.8 audit incorrectly
-- concluded no `vendors` table existed anywhere in this codebase and this
-- migration originally included a `create table if not exists public.vendors
-- (...)` defining a flat CRM-style schema (name/contact_name/email/phone/
-- website/address/status/created_by). That was WRONG: `public.vendors`
-- already exists live (like `companies`/`contacts`, its CREATE TABLE was
-- never captured in this migrations folder -- see those two tables' own
-- store files for the same undocumented-baseline pattern), with a
-- CRM-relational shape instead:
--
--   id uuid PK, org_id uuid NOT NULL -> organizations.id,
--   company_id uuid NULL -> companies.id, contact_id uuid NULL -> contacts.id,
--   vendor_type text NOT NULL DEFAULT 'subcontractor', specialties text[] NULL,
--   license_number text NULL, insurance_expiry date NULL, rating integer NULL,
--   is_active boolean NOT NULL DEFAULT true, notes text NULL,
--   custom_fields jsonb NULL DEFAULT '{}', created_at/updated_at timestamptz.
--
-- The `create table if not exists` would have silently no-op'd against the
-- real table (Postgres skips the whole statement, not just missing columns)
-- while every downstream vendors.* reference in this file (indexes/RLS
-- policies naming `status`, `expenses`/`vendor_bills`/`vendor_payments`'
-- validation triggers) had been written against the wrong, nonexistent
-- shape -- this migration failed with `ERROR: 42703: column "status" does
-- not exist` the one time it was actually run against the real database.
-- Fixed by DELETING the entire vendors CREATE TABLE/index/RLS/grant section
-- below and treating the existing `public.vendors` table, its existing RLS
-- policies, and its existing grants as canonical and untouched -- this
-- migration only ever references `vendors.id`, `vendors.org_id`, and
-- `vendors.is_active` (all confirmed-real columns) from here on, and adds
-- no columns, indexes, triggers, or policies to `vendors` itself.
--
-- Audit finding (see Phase 13.8 report): no expense/vendor-bill/A-P tables
-- exist anywhere in this codebase today. accounting_journal_entries.
-- source_type already accepts 'expense' | 'vendor_bill' | 'vendor_payment'
-- (added in 20260820_accounting_foundation.sql) and the default Chart of
-- Accounts already seeds 1010 Operating Bank, 2100 Credit Cards, 2000
-- Accounts Payable (system), and the 5000/6000-series expense/COGS accounts
-- for every org -- so this migration needs NO change to the accounting core
-- at all. It only adds the operational layer that feeds it.
--
-- Architecture:
--   Operational event (expense recorded, bill posted, bill paid)
--     -> trusted Netlify function (validates org/account/amount server-side)
--     -> netlify/lib/accounting.ts posting helper
--     -> post_journal_entry() RPC (existing, unchanged)
--     -> accounting_journal_entries / accounting_journal_entry_lines
--
-- React never writes expenses/vendor_bills/vendor_bill_lines/vendor_payments
-- financial fields directly -- those four tables are SELECT-only for
-- `authenticated` (mirrors invoice_payments' access model). `vendors` is
-- untouched by this migration's RLS/grants entirely -- its existing,
-- pre-existing access model (whatever it already is) governs vendor reads/
-- writes, same as `companies`/`contacts`.
--
-- NOT applied automatically. Review and run manually in the Supabase SQL
-- Editor.

begin;

-- ============================================================================
-- 1. EXPENSES -- direct/cash-paid expenses
-- ============================================================================

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  vendor_id uuid null references public.vendors(id) on delete restrict,
  project_id uuid null references public.projects(id) on delete restrict,
  contact_id uuid null references public.contacts(id) on delete restrict,

  expense_date date not null,
  description text not null,
  amount numeric(14,2) not null,
  currency text not null default 'usd',
  payment_method text null,
  account_id uuid not null references public.accounting_accounts(id),

  status text not null default 'posted',
  reference text null,
  receipt_url text null,
  notes text null,

  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint expenses_amount_positive check (amount > 0),
  constraint expenses_status_check check (status in ('draft', 'posted', 'cancelled')),
  constraint expenses_description_not_blank check (btrim(description) <> ''),
  constraint expenses_payment_method_check check (
    payment_method is null or payment_method in ('cash', 'check', 'ach', 'wire', 'bank_transfer', 'card', 'other')
  ),
  -- Phase 13.8B, Part 3 -- payment_method determines which asset/liability
  -- account gets credited (card -> 2100 Credit Cards, everything else ->
  -- 1010 Operating Bank -- see resolvePaymentAccount() in netlify/lib/
  -- accounting.ts). A 'posted' expense has (or, once accounting is
  -- initialized, will have) a real journal entry crediting one of those two
  -- accounts, so it can never be genuinely ambiguous about which one --
  -- payment_method is therefore required the moment status='posted'. A
  -- draft expense has no journal entry yet and may leave it unset.
  constraint expenses_posted_requires_payment_method check (
    status <> 'posted' or payment_method is not null
  ),
  -- Phase 13.8A, Part 24 -- every posting helper in netlify/lib/accounting.ts
  -- posts amounts as-is with no FX conversion, and the rest of this
  -- codebase (Stripe integration, all money formatters) is USD-only today.
  -- A non-'usd' row here would silently post financially wrong journal
  -- amounts rather than a real currency conversion, so it is rejected
  -- outright rather than accepted and mishandled. Revisit when real
  -- multi-currency accounting exists.
  constraint expenses_currency_usd_only check (currency = 'usd')
);

create index if not exists idx_expenses_org_date on public.expenses (org_id, expense_date desc);
create index if not exists idx_expenses_project on public.expenses (project_id) where project_id is not null;
create index if not exists idx_expenses_vendor on public.expenses (vendor_id) where vendor_id is not null;

create or replace function public.set_expenses_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_expenses_updated_at on public.expenses;
create trigger trg_expenses_updated_at
  before update on public.expenses
  for each row execute function public.set_expenses_updated_at();

-- Part 4/5 -- account_id must belong to the same org and must be an
-- expense-type account (COGS-subtype or opex-subtype -- both are
-- account_type='expense' in this Chart of Accounts; there is no separate
-- 'cogs' account_type). Revenue/asset/liability/equity accounts can never
-- be selected as an expense category. vendor_id/project_id/contact_id are
-- validated the same org-consistency way accounting_journal_entries already
-- does it.
create or replace function public.validate_expense_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_account_org uuid;
  v_account_type text;
  v_account_active boolean;
  v_vendor_org uuid;
  v_vendor_active boolean;
  v_project_org uuid;
  v_contact_org uuid;
begin
  select org_id, account_type, is_active into v_account_org, v_account_type, v_account_active
    from public.accounting_accounts where id = new.account_id;
  if v_account_org is null then
    raise exception 'account_id does not reference an existing accounting account';
  end if;
  if v_account_org <> new.org_id then
    raise exception 'expenses.account_id must belong to the same org';
  end if;
  if v_account_type <> 'expense' then
    raise exception 'expenses.account_id must be an expense/COGS account, not a % account', v_account_type;
  end if;
  -- Phase 13.8C -- the is_active check must only fire when account_id is
  -- actually being CHOSEN: a fresh INSERT, or an UPDATE that changes
  -- account_id. This trigger is BEFORE INSERT OR UPDATE with no other
  -- gating, so without this TG_OP guard it also ran on a posted expense's
  -- safe-metadata-only edits (reference/notes/receipt_url -- the only
  -- fields enforce_expense_immutability still allows once posted) and would
  -- incorrectly reject that edit if the expense's (unchanged, immutable)
  -- account_id had since been deactivated. enforce_expense_immutability
  -- already guarantees account_id itself can never change on a posted row,
  -- so a posted row's metadata-only UPDATE is exactly the case that must
  -- skip this check -- historical account references remain valid
  -- regardless of the account's current is_active state. Branched
  -- explicitly on tg_op (rather than a combined boolean expression) to
  -- avoid referencing `old` at all on INSERT, matching this codebase's
  -- existing tg_op-branching convention (e.g. 20260805_task_system_
  -- completion.sql).
  if tg_op = 'INSERT' then
    if not v_account_active then
      raise exception 'expenses.account_id references an inactive account -- reactivate it before using it for new expenses';
    end if;
  elsif new.account_id is distinct from old.account_id and not v_account_active then
    raise exception 'expenses.account_id references an inactive account -- reactivate it before using it for new expenses';
  end if;

  if new.vendor_id is not null then
    select org_id, is_active into v_vendor_org, v_vendor_active from public.vendors where id = new.vendor_id;
    if v_vendor_org is null or v_vendor_org <> new.org_id then
      raise exception 'expenses.vendor_id must belong to the same org';
    end if;
    -- Phase 13.8D, Part 9 -- same TG_OP-gated pattern as the account_id
    -- check above (Phase 13.8C): only enforce is_active when vendor_id is
    -- actually being chosen (INSERT, or an UPDATE that changes vendor_id on
    -- a still-draft row -- enforce_expense_immutability already freezes
    -- vendor_id once posted). A posted expense's harmless metadata edit
    -- must not be rejected merely because its (unchanged) vendor was later
    -- deactivated.
    if tg_op = 'INSERT' then
      if not v_vendor_active then
        raise exception 'expenses.vendor_id references an inactive vendor -- reactivate it before using it for new expenses';
      end if;
    elsif new.vendor_id is distinct from old.vendor_id and not v_vendor_active then
      raise exception 'expenses.vendor_id references an inactive vendor -- reactivate it before using it for new expenses';
    end if;
  end if;

  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'expenses.project_id must belong to the same org';
    end if;
  end if;

  if new.contact_id is not null then
    select org_id into v_contact_org from public.contacts where id = new.contact_id;
    if v_contact_org is null or v_contact_org <> new.org_id then
      raise exception 'expenses.contact_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_expense_dimensions on public.expenses;
create trigger trg_validate_expense_dimensions
  before insert or update on public.expenses
  for each row execute function public.validate_expense_dimensions();

revoke all on function public.validate_expense_dimensions() from public, anon, authenticated;

-- Phase 13.8A, Part 2 -- reversal RPC does not exist yet, so a posted
-- expense's full financial/business shape must not be silently editable
-- from a plain UPDATE. Frozen once status='posted': org_id, vendor_id,
-- project_id, contact_id, expense_date, description, amount, currency,
-- payment_method, account_id, status. payment_method is frozen because it
-- determines which asset/liability account was credited when the journal
-- entry posted (bank vs. credit card) -- changing it after the fact would
-- silently desync operational data from the ledger. description is frozen
-- because it is part of the entry's business narrative, same reasoning as
-- amount/date. reference/notes/receipt_url remain editable -- they are
-- pure metadata with no accounting-entry consequence (a receipt image can
-- be attached after the fact; a reference number corrected without
-- changing what happened financially).
create or replace function public.enforce_expense_immutability()
returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    if new.org_id <> old.org_id
       or new.vendor_id is distinct from old.vendor_id
       or new.project_id is distinct from old.project_id
       or new.contact_id is distinct from old.contact_id
       or new.expense_date <> old.expense_date
       or new.description <> old.description
       or new.amount <> old.amount
       or new.currency <> old.currency
       or new.payment_method is distinct from old.payment_method
       or new.account_id <> old.account_id
       or new.status <> old.status
    then
      raise exception 'Posted expenses cannot have financial fields edited yet -- reversal/correction is a future capability';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_expense_immutability on public.expenses;
create trigger trg_enforce_expense_immutability
  before update on public.expenses
  for each row execute function public.enforce_expense_immutability();

-- Phase 13.8A, Part 3 -- only a draft expense may ever be deleted. A row
-- that was ever posted must remain historically present -- there is no
-- posting-history flag beyond `status` today, so "not draft" is the
-- correct, conservative rule (covers 'posted' and any future 'cancelled'
-- use identically, since neither represents a row that never had -- or
-- could not have had -- a journal entry).
create or replace function public.prevent_non_draft_expense_delete()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'Posted expenses cannot be deleted; reversal/correction is not implemented yet.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_non_draft_expense_delete on public.expenses;
create trigger trg_prevent_non_draft_expense_delete
  before delete on public.expenses
  for each row execute function public.prevent_non_draft_expense_delete();

revoke all on function public.prevent_non_draft_expense_delete() from public, anon, authenticated;

alter table public.expenses enable row level security;

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Part 32 -- financial writes are backend-only (trusted Netlify function
-- resolves org server-side, validates the account, and drives accounting
-- posting). No insert/update/delete grant to authenticated.
revoke all on public.expenses from anon, authenticated;
grant select on public.expenses to authenticated;
grant select, insert, update, delete on public.expenses to service_role;

-- ============================================================================
-- 2. VENDOR_BILLS + VENDOR_BILL_LINES
-- ============================================================================

create table if not exists public.vendor_bills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  vendor_id uuid not null references public.vendors(id) on delete restrict,
  project_id uuid null references public.projects(id) on delete restrict,

  bill_number text null,
  bill_date date not null,
  due_date date null,

  currency text not null default 'usd',
  subtotal numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,

  status text not null default 'draft',
  reference text null,
  notes text null,

  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vendor_bills_status_check check (status in ('draft', 'open', 'partial', 'paid', 'overdue', 'cancelled')),
  constraint vendor_bills_amounts_nonneg check (subtotal >= 0 and tax_amount >= 0 and total_amount >= 0 and amount_paid >= 0),
  constraint vendor_bills_total_positive_when_posted check (status = 'draft' or total_amount > 0),
  -- Phase 13.8A, Part 24 -- see expenses_currency_usd_only above.
  constraint vendor_bills_currency_usd_only check (currency = 'usd')
);

-- Part 40 / Phase 13.8A Part 8 -- duplicate protection: org + vendor +
-- CASE-INSENSITIVE, TRIM-NORMALIZED bill_number, only when bill_number is
-- present. Multiple vendors may reuse the same bill number; a single vendor
-- may not have two bills with the same non-blank number regardless of
-- casing/whitespace (" INV-100", "inv-100", "INV-100" must all collide).
-- Indexed on lower(btrim(bill_number)) rather than the raw column so the
-- stored/displayed value keeps the vendor's original casing while
-- uniqueness is evaluated on the normalized form. Dropped and recreated
-- (not `create ... if not exists` with the old expression) so re-running
-- this migration against a database that already has the OLD un-normalized
-- index definition replaces it rather than leaving both/neither in effect.
drop index if exists public.uq_vendor_bills_org_vendor_number;
create unique index uq_vendor_bills_org_vendor_number
  on public.vendor_bills (org_id, vendor_id, lower(btrim(bill_number)))
  where bill_number is not null and btrim(bill_number) <> '';

create index if not exists idx_vendor_bills_org_status on public.vendor_bills (org_id, status);
create index if not exists idx_vendor_bills_org_due on public.vendor_bills (org_id, due_date) where status in ('open', 'partial');
create index if not exists idx_vendor_bills_vendor on public.vendor_bills (vendor_id);
create index if not exists idx_vendor_bills_project on public.vendor_bills (project_id) where project_id is not null;

create or replace function public.set_vendor_bills_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_vendor_bills_updated_at on public.vendor_bills;
create trigger trg_vendor_bills_updated_at
  before update on public.vendor_bills
  for each row execute function public.set_vendor_bills_updated_at();

create or replace function public.validate_vendor_bill_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_vendor_org uuid;
  v_vendor_active boolean;
  v_project_org uuid;
begin
  select org_id, is_active into v_vendor_org, v_vendor_active from public.vendors where id = new.vendor_id;
  if v_vendor_org is null or v_vendor_org <> new.org_id then
    raise exception 'vendor_bills.vendor_id must belong to the same org';
  end if;
  -- Phase 13.8D, Part 10 -- same TG_OP-gated pattern as expenses' vendor
  -- check: only enforce is_active when vendor_id is actually being chosen
  -- (INSERT, or a draft-bill UPDATE that changes vendor_id --
  -- enforce_vendor_bill_immutability already freezes vendor_id once the
  -- bill leaves 'draft'). Without this gate, this trigger firing on every
  -- UPDATE (including the status-only transitions sync_vendor_bill_amount_
  -- paid() performs as bills get paid) would incorrectly reject a legitimate
  -- status update the moment the bill's (unchanged) vendor was deactivated.
  if tg_op = 'INSERT' then
    if not v_vendor_active then
      raise exception 'vendor_bills.vendor_id references an inactive vendor -- reactivate it before using it for new bills';
    end if;
  elsif new.vendor_id is distinct from old.vendor_id and not v_vendor_active then
    raise exception 'vendor_bills.vendor_id references an inactive vendor -- reactivate it before using it for new bills';
  end if;

  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'vendor_bills.project_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_bill_dimensions on public.vendor_bills;
create trigger trg_validate_vendor_bill_dimensions
  before insert or update on public.vendor_bills
  for each row execute function public.validate_vendor_bill_dimensions();

revoke all on function public.validate_vendor_bill_dimensions() from public, anon, authenticated;

-- Part 18 -- once a bill has left 'draft', its financial shape (vendor,
-- project, dates, totals) is frozen -- no reversal RPC exists yet. Status
-- may still progress forward (open -> partial -> paid, or -> overdue, all
-- driven by the payment-sync trigger below / a future overdue sweep), and
-- amount_paid is maintained by that same trigger, not by hand.
--
-- Phase 13.8A, Part 18 -- freezing the FIELDS above still left status
-- itself unrestricted once posted (any status could jump to any other
-- status, e.g. paid -> open, or -> cancelled, via a plain UPDATE with no
-- other field changed). Added an explicit forward-only status-transition
-- allowlist for the post-draft lifecycle. draft -> open (the "Post Bill"
-- action) is NOT governed by this list -- it's the transition INTO the
-- guarded state, handled by the `old.status <> 'draft'` gate itself, and
-- vendor-bill-post.ts only ever changes status on that call (no other
-- field), so it is unaffected. No transition ever reaches 'cancelled' or
-- back to 'draft' -- both require reversal/correction infrastructure that
-- does not exist yet (Part 30).
create or replace function public.enforce_vendor_bill_immutability()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    if new.org_id <> old.org_id
       or new.vendor_id <> old.vendor_id
       or new.project_id is distinct from old.project_id
       or new.bill_date <> old.bill_date
       or new.due_date is distinct from old.due_date
       or new.currency <> old.currency
       or new.subtotal <> old.subtotal
       or new.tax_amount <> old.tax_amount
       or new.total_amount <> old.total_amount
    then
      raise exception 'Posted vendor bills cannot have financial fields edited yet -- reversal/correction is a future capability';
    end if;

    if new.status <> old.status then
      if not (
        (old.status = 'open' and new.status in ('partial', 'paid', 'overdue'))
        or (old.status = 'partial' and new.status in ('paid', 'overdue'))
        or (old.status = 'overdue' and new.status in ('partial', 'paid'))
      ) then
        raise exception 'Vendor bill status cannot transition from % to % -- reversal/cancellation is not implemented yet', old.status, new.status;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_vendor_bill_immutability on public.vendor_bills;
create trigger trg_enforce_vendor_bill_immutability
  before update on public.vendor_bills
  for each row execute function public.enforce_vendor_bill_immutability();

-- Phase 13.8A, Part 4 -- only a draft bill may ever be deleted. A bill that
-- left draft may already have an immutable journal entry (Dr expense/COGS,
-- Cr A/P) posted against it -- deleting the operational row while that
-- ledger entry remains would make A/P and Project Profitability reference
-- a bill that no longer exists. vendor_bill_lines' own delete guard
-- (prevent_posted_bill_line_delete) is insufficient alone since it does not
-- stop the parent bill row itself from being deleted (which would then
-- cascade-delete the lines anyway).
create or replace function public.prevent_non_draft_vendor_bill_delete()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'Only draft vendor bills can be deleted; % bills cannot be removed.', old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_non_draft_vendor_bill_delete on public.vendor_bills;
create trigger trg_prevent_non_draft_vendor_bill_delete
  before delete on public.vendor_bills
  for each row execute function public.prevent_non_draft_vendor_bill_delete();

revoke all on function public.prevent_non_draft_vendor_bill_delete() from public, anon, authenticated;

alter table public.vendor_bills enable row level security;

drop policy if exists vendor_bills_select on public.vendor_bills;
create policy vendor_bills_select on public.vendor_bills
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.vendor_bills from anon, authenticated;
grant select on public.vendor_bills to authenticated;
grant select, insert, update, delete on public.vendor_bills to service_role;

create table if not exists public.vendor_bill_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  vendor_bill_id uuid not null references public.vendor_bills(id) on delete cascade,

  description text not null,
  quantity numeric(14,4) not null default 1,
  unit_cost numeric(14,4) not null default 0,
  amount numeric(14,2) not null,
  account_id uuid not null references public.accounting_accounts(id),
  project_id uuid null references public.projects(id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint vendor_bill_lines_amount_positive check (amount > 0),
  constraint vendor_bill_lines_quantity_positive check (quantity > 0),
  constraint vendor_bill_lines_description_not_blank check (btrim(description) <> ''),
  -- Phase 13.8A, Part 25 -- vendor-bill-create.ts already computes `amount`
  -- server-side as round(quantity * unit_cost, 2) and never accepts a
  -- client-supplied amount, but this CHECK makes that authority a DB-level
  -- guarantee rather than an application-layer convention -- no insert path
  -- (present or future) can persist a line whose amount doesn't match its
  -- own quantity/unit_cost.
  constraint vendor_bill_lines_amount_matches_calc check (amount = round(quantity * unit_cost, 2))
);

create index if not exists idx_vendor_bill_lines_bill on public.vendor_bill_lines (vendor_bill_id);

create or replace function public.validate_vendor_bill_line_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill_org uuid;
  v_bill_status text;
  v_account_org uuid;
  v_account_type text;
  v_account_active boolean;
  v_project_org uuid;
begin
  select org_id, status into v_bill_org, v_bill_status
    from public.vendor_bills where id = new.vendor_bill_id;
  if v_bill_org is null then
    raise exception 'vendor_bill_id does not reference an existing bill';
  end if;
  if v_bill_org <> new.org_id then
    raise exception 'vendor_bill_lines.org_id must match its bill''s org_id';
  end if;
  if v_bill_status <> 'draft' then
    raise exception 'Cannot add/modify lines on a % bill -- only draft bills are editable', v_bill_status;
  end if;

  select org_id, account_type, is_active into v_account_org, v_account_type, v_account_active
    from public.accounting_accounts where id = new.account_id;
  if v_account_org is null then
    raise exception 'account_id does not reference an existing accounting account';
  end if;
  if v_account_org <> new.org_id then
    raise exception 'vendor_bill_lines.account_id must belong to the same org';
  end if;
  if v_account_type <> 'expense' then
    raise exception 'vendor_bill_lines.account_id must be an expense/COGS account, not a % account', v_account_type;
  end if;
  -- Phase 13.8A, Part 10 -- same reasoning as validate_expense_dimensions.
  -- Only applies to new/edited lines on a still-draft bill (the earlier
  -- v_bill_status <> 'draft' check already rejects any write once posted),
  -- so historical posted lines against a since-deactivated account are
  -- untouched.
  if not v_account_active then
    raise exception 'vendor_bill_lines.account_id references an inactive account -- reactivate it before using it on new bill lines';
  end if;

  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'vendor_bill_lines.project_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_bill_line_dimensions on public.vendor_bill_lines;
create trigger trg_validate_vendor_bill_line_dimensions
  before insert or update on public.vendor_bill_lines
  for each row execute function public.validate_vendor_bill_line_dimensions();

revoke all on function public.validate_vendor_bill_line_dimensions() from public, anon, authenticated;

create or replace function public.prevent_posted_bill_line_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from public.vendor_bills where id = old.vendor_bill_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Cannot delete a line from a % bill', v_status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_bill_line_delete on public.vendor_bill_lines;
create trigger trg_prevent_posted_bill_line_delete
  before delete on public.vendor_bill_lines
  for each row execute function public.prevent_posted_bill_line_delete();

revoke all on function public.prevent_posted_bill_line_delete() from public, anon, authenticated;

alter table public.vendor_bill_lines enable row level security;

drop policy if exists vendor_bill_lines_select on public.vendor_bill_lines;
create policy vendor_bill_lines_select on public.vendor_bill_lines
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.vendor_bill_lines from anon, authenticated;
grant select on public.vendor_bill_lines to authenticated;
grant select, insert, update, delete on public.vendor_bill_lines to service_role;

-- ============================================================================
-- 3. VENDOR_PAYMENTS -- one row per bill payment (partial payments supported)
-- ============================================================================

create table if not exists public.vendor_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  vendor_bill_id uuid not null references public.vendor_bills(id) on delete restrict,
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  project_id uuid null references public.projects(id) on delete restrict,

  amount numeric(14,2) not null,
  currency text not null default 'usd',
  status text not null default 'succeeded',
  payment_method text not null default 'other',
  provider text not null default 'manual',
  provider_payment_id text null,
  source text not null default 'manual',

  paid_at timestamptz not null default now(),
  reference text null,
  notes text null,

  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vendor_payments_amount_positive check (amount > 0),
  constraint vendor_payments_status_check check (status in ('pending', 'succeeded', 'failed', 'refunded', 'voided')),
  constraint vendor_payments_method_check check (
    payment_method in ('cash', 'check', 'ach', 'wire', 'bank_transfer', 'card', 'other')
  ),
  -- Phase 13.8A, Part 24 -- see expenses_currency_usd_only above.
  constraint vendor_payments_currency_usd_only check (currency = 'usd')
);

create index if not exists idx_vendor_payments_bill on public.vendor_payments (vendor_bill_id);
create index if not exists idx_vendor_payments_org_date on public.vendor_payments (org_id, paid_at desc);
create index if not exists idx_vendor_payments_vendor on public.vendor_payments (vendor_id);

create or replace function public.set_vendor_payments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_vendor_payments_updated_at on public.vendor_payments;
create trigger trg_vendor_payments_updated_at
  before update on public.vendor_payments
  for each row execute function public.set_vendor_payments_updated_at();

create or replace function public.validate_vendor_payment_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill_org uuid;
  v_bill_vendor uuid;
  v_bill_project uuid;
  v_bill_status text;
  v_vendor_org uuid;
  v_project_org uuid;
begin
  select org_id, vendor_id, project_id, status into v_bill_org, v_bill_vendor, v_bill_project, v_bill_status
    from public.vendor_bills where id = new.vendor_bill_id;
  if v_bill_org is null then
    raise exception 'vendor_bill_id does not reference an existing bill';
  end if;
  if v_bill_org <> new.org_id then
    raise exception 'vendor_payments.org_id must match its bill''s org_id';
  end if;
  if v_bill_status = 'draft' then
    raise exception 'Cannot record a payment against a draft bill -- post it first';
  end if;
  if v_bill_status = 'cancelled' then
    raise exception 'Cannot record a payment against a cancelled bill';
  end if;
  if v_bill_vendor <> new.vendor_id then
    raise exception 'vendor_payments.vendor_id must match its bill''s vendor_id';
  end if;
  -- Phase 13.8B, Part 2 -- record_vendor_payment() already derives
  -- project_id from the locked bill row, so this is unreachable through the
  -- normal payment path. It closes the same gap for any OTHER insert path
  -- (a direct service-role insert, a future endpoint) that might supply a
  -- project_id independently of the bill's own. Null-safe: a null-project
  -- bill requires a null-project payment; a project-linked bill requires an
  -- exact match, never merely "same org."
  if new.project_id is distinct from v_bill_project then
    raise exception 'vendor_payments.project_id must match its bill''s project_id';
  end if;

  select org_id into v_vendor_org from public.vendors where id = new.vendor_id;
  if v_vendor_org is null or v_vendor_org <> new.org_id then
    raise exception 'vendor_payments.vendor_id must belong to the same org';
  end if;

  -- Same-org project validation kept as defense in depth alongside the
  -- exact-match check above -- if the bill's own project_id were ever
  -- somehow cross-org (it shouldn't be, per validate_vendor_bill_dimensions),
  -- this still catches it independently.
  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'vendor_payments.project_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_payment_dimensions on public.vendor_payments;
create trigger trg_validate_vendor_payment_dimensions
  before insert or update on public.vendor_payments
  for each row execute function public.validate_vendor_payment_dimensions();

revoke all on function public.validate_vendor_payment_dimensions() from public, anon, authenticated;

-- Phase 13.8A, Part 5/7 -- a 'succeeded' vendor payment is an accounting
-- source record: once it exists, postVendorPaymentSucceeded() has (or, if
-- accounting isn't initialized for this org, one day may) post Dr A/P / Cr
-- bank-or-card against it, keyed on this row's own id. No reversal RPC
-- exists yet, so 'succeeded' is made a TERMINAL state at the DB level --
-- every field, including status itself, is frozen once succeeded. This is
-- deliberately stricter than expenses/vendor_bills (which still allow
-- reference/notes edits after posting) because a vendor PAYMENT's
-- reference/notes are commonly the reconciliation trail (check #, provider
-- transaction id) -- silently rewritable metadata on a cash-movement record
-- is a worse audit-trail gap here than on an expense or bill.
--
-- Part 7 -- 'refunded' is explicitly REMOVED from reachable behavior for
-- now (see sync_vendor_bill_amount_paid below): no code path creates a
-- refunded row, and this trigger ensures a succeeded row can never become
-- one via UPDATE either. The status value itself stays in the CHECK
-- constraint for forward schema compatibility with a future reversal
-- design, but Phase 13.8A treats "succeeded payment, no refunds" as the
-- only real behavior -- pretending refund accounting exists today would be
-- worse than not having it.
create or replace function public.enforce_vendor_payment_immutability()
returns trigger language plpgsql as $$
begin
  if old.status = 'succeeded' then
    if new.org_id <> old.org_id
       or new.vendor_bill_id <> old.vendor_bill_id
       or new.vendor_id <> old.vendor_id
       or new.project_id is distinct from old.project_id
       or new.amount <> old.amount
       or new.currency <> old.currency
       or new.status <> old.status
       or new.payment_method <> old.payment_method
       or new.provider <> old.provider
       or new.provider_payment_id is distinct from old.provider_payment_id
       or new.source <> old.source
       or new.paid_at <> old.paid_at
       or new.reference is distinct from old.reference
       or new.notes is distinct from old.notes
    then
      raise exception 'Succeeded vendor payments are immutable -- reversal/correction is not implemented yet';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_vendor_payment_immutability on public.vendor_payments;
create trigger trg_enforce_vendor_payment_immutability
  before update on public.vendor_payments
  for each row execute function public.enforce_vendor_payment_immutability();

-- Phase 13.8A, Part 6 -- a succeeded payment may never be deleted (its
-- journal entry, if posted, would then reference a nonexistent operational
-- record). 'refunded'/'voided' are blocked too even though nothing creates
-- them today -- if a future phase starts using either status to represent
-- a real historical event, deleting that row must not become the escape
-- hatch. Only 'pending'/'failed' (transient, never-accounted-for states)
-- remain deletable.
create or replace function public.prevent_settled_vendor_payment_delete()
returns trigger language plpgsql as $$
begin
  if old.status in ('succeeded', 'refunded', 'voided') then
    raise exception 'Vendor payments with status % cannot be deleted.', old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_settled_vendor_payment_delete on public.vendor_payments;
create trigger trg_prevent_settled_vendor_payment_delete
  before delete on public.vendor_payments
  for each row execute function public.prevent_settled_vendor_payment_delete();

revoke all on function public.prevent_settled_vendor_payment_delete() from public, anon, authenticated;

-- Part 11 -- keeps vendor_bills.amount_paid / status in sync with the
-- payment ledger, the same pattern invoice_payments' sync_invoice_amount_
-- paid() trigger already uses for invoices.amount_paid. Only 'succeeded'
-- payments count. Status becomes 'paid' once amount_paid >= total_amount
-- (to the cent), 'partial' if >0 and <total, else reverts to 'open' (never
-- touches 'cancelled' or 'draft').
--
-- Phase 13.8A, Part 7/16 -- 'refunded' no longer subtracts back out. No
-- reversal accounting exists (nothing ever posts a compensating Dr A/P / Cr
-- Bank entry for a "refunded" vendor payment), so letting a status flip
-- silently reduce amount_paid here would desync operational A/P from the
-- ledger exactly the way Part 7 warned about. Combined with
-- enforce_vendor_payment_immutability (a succeeded row can never actually
-- become 'refunded'), this SUM is now effectively just SUM(succeeded
-- amounts) -- written as a plain status filter rather than a CASE so the
-- intent (no subtraction, ever) is explicit at the call site.
create or replace function public.sync_vendor_bill_amount_paid()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill_id uuid := coalesce(new.vendor_bill_id, old.vendor_bill_id);
  v_paid numeric(14,2);
  v_total numeric(14,2);
  v_status text;
begin
  select coalesce(sum(amount), 0)
    into v_paid
    from public.vendor_payments
    where vendor_bill_id = v_bill_id and status = 'succeeded';

  select total_amount, status into v_total, v_status from public.vendor_bills where id = v_bill_id;

  if v_status not in ('cancelled', 'draft') then
    update public.vendor_bills
       set amount_paid = v_paid,
           status = case
             when v_paid >= v_total and v_total > 0 then 'paid'
             when v_paid > 0 then 'partial'
             else 'open'
           end
     where id = v_bill_id;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_sync_vendor_bill_amount_paid on public.vendor_payments;
create trigger trg_sync_vendor_bill_amount_paid
  after insert or update or delete on public.vendor_payments
  for each row execute function public.sync_vendor_bill_amount_paid();

revoke all on function public.sync_vendor_bill_amount_paid() from public, anon, authenticated;

alter table public.vendor_payments enable row level security;

drop policy if exists vendor_payments_select on public.vendor_payments;
create policy vendor_payments_select on public.vendor_payments
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.vendor_payments from anon, authenticated;
grant select on public.vendor_payments to authenticated;
grant select, insert, update, delete on public.vendor_payments to service_role;

-- ============================================================================
-- 4. record_vendor_payment() -- atomic, race-safe bill-payment RPC
-- ============================================================================
--
-- Phase 13.8A, Part 12/13/14 -- vendor-bill-record-payment.ts previously did
-- a plain "SELECT bill, check remaining balance, INSERT vendor_payments" as
-- two sequential Supabase calls with no locking in between. Two concurrent
-- payment requests for the same bill could both read the same remaining
-- balance and both insert, overpaying the bill -- the same class of race
-- post_journal_entry() already guards against for journal postings via
-- pg_advisory_xact_lock. This RPC closes the equivalent gap for vendor
-- payments using a `select ... for update` row lock instead (simpler to
-- reason about for a single bill row than an advisory lock, and the lock
-- naturally scopes to exactly the one bill being paid).
--
-- vendor_id/project_id are deliberately NOT accepted as parameters (unlike
-- the shape sketched in the Phase 13.8A request) -- they are read from the
-- locked bill row itself instead. Accepting them from the caller would
-- either be redundant (if correct) or a way to desync a payment's
-- vendor_id/project_id from its own bill's (if wrong) -- deriving them
-- server-side from the row we already hold FOR UPDATE removes an entire
-- class of caller error for no loss of functionality.
--
-- Overpayment protection here is authoritative -- it recomputes remaining
-- balance from SUM(succeeded vendor_payments.amount) against the LOCKED
-- bill's total_amount, not from the bill's own (trigger-maintained, but not
-- lock-held-fresh at call time) amount_paid column, so a second caller
-- blocked behind the row lock always sees the first caller's payment
-- reflected before making its own decision.
create or replace function public.record_vendor_payment(
  p_org_id uuid,
  p_vendor_bill_id uuid,
  p_amount numeric,
  p_currency text default 'usd',
  p_payment_method text default 'other',
  p_provider text default 'manual',
  p_provider_payment_id text default null,
  p_source text default 'manual',
  p_paid_at timestamptz default now(),
  p_reference text default null,
  p_notes text default null,
  p_created_by uuid default null
)
returns table (payment_id uuid, bill_status text, bill_amount_paid numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill record;
  v_paid numeric(14,2);
  v_remaining numeric(14,2);
  v_payment_id uuid;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if p_vendor_bill_id is null then
    raise exception 'vendor_bill_id is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be a positive number';
  end if;

  -- Row lock taken up front -- a second concurrent call for the same bill
  -- blocks here until this transaction commits or rolls back, so it always
  -- recomputes v_paid against this call's own committed result.
  select * into v_bill from public.vendor_bills
    where id = p_vendor_bill_id and org_id = p_org_id
    for update;
  if v_bill.id is null then
    raise exception 'Bill not found for this org';
  end if;
  if v_bill.status = 'draft' then
    raise exception 'This bill must be posted before it can be paid';
  end if;
  if v_bill.status = 'cancelled' then
    raise exception 'This bill is cancelled';
  end if;
  if v_bill.status = 'paid' then
    raise exception 'This bill is already fully paid';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.vendor_payments
    where vendor_bill_id = p_vendor_bill_id and status = 'succeeded';

  v_remaining := round(v_bill.total_amount - v_paid, 2);
  if v_remaining <= 0 then
    raise exception 'This bill has no remaining balance';
  end if;
  if p_amount > v_remaining + 0.005 then
    raise exception 'Payment of % exceeds the remaining balance of %', p_amount, v_remaining;
  end if;

  insert into public.vendor_payments (
    org_id, vendor_bill_id, vendor_id, project_id, amount, currency, status,
    payment_method, provider, provider_payment_id, source, paid_at, reference, notes, created_by
  ) values (
    p_org_id, p_vendor_bill_id, v_bill.vendor_id, v_bill.project_id, p_amount, coalesce(p_currency, 'usd'), 'succeeded',
    p_payment_method, coalesce(p_provider, 'manual'), p_provider_payment_id, coalesce(p_source, 'manual'),
    coalesce(p_paid_at, now()), p_reference, p_notes, p_created_by
  )
  returning id into v_payment_id;

  -- trg_sync_vendor_bill_amount_paid (AFTER INSERT on vendor_payments) has
  -- already updated vendor_bills.amount_paid/status by the time this SELECT
  -- runs -- we're still holding the row lock, so this reads our own write.
  select status, amount_paid into v_bill.status, v_bill.amount_paid
    from public.vendor_bills where id = p_vendor_bill_id;

  return query select v_payment_id, v_bill.status, v_bill.amount_paid;
end;
$$;

-- Part 15 -- service_role-only, matching post_journal_entry()'s own
-- security posture. No browser/authenticated caller may invoke this
-- directly with an arbitrary org_id -- only the trusted Netlify function
-- (vendor-bill-record-payment.ts), which resolves org_id server-side from
-- the caller's bearer token before ever constructing this call.
revoke all on function public.record_vendor_payment(uuid, uuid, numeric, text, text, text, text, text, timestamptz, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_vendor_payment(uuid, uuid, numeric, text, text, text, text, text, timestamptz, text, text, uuid) to service_role;

commit;

-- ============================================================================
-- Manual verification queries (run after applying, before use)
-- ============================================================================
-- select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('vendors','expenses','vendor_bills','vendor_bill_lines','vendor_payments');
--
-- select tablename, policyname, cmd, roles from pg_policies
--   where schemaname = 'public'
--     and tablename in ('vendors','expenses','vendor_bills','vendor_bill_lines','vendor_payments')
--   order by tablename, cmd;
--
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('vendors','expenses','vendor_bills','vendor_bill_lines','vendor_payments')
--   order by table_name, grantee;
