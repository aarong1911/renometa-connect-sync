-- Phase 13.9 (Tier 1)
-- Accounting reversal infrastructure:
--   - canonical journal-entry reversal
--   - direct expense reversal support
--   - vendor bill reversal support
--   - append-only vendor payment reversal support
--
-- Includes Phase 13.9A / 13.9B hardening:
--   - reversal source identity derived from original JE
--   - reversal-of-reversal protection
--   - reversed vendor bills cannot receive payments
--   - paid vendor bills cannot receive ordinary new payments
--   - paid vendor bills CAN receive legitimate payment-reversal rows
--   - overdue fully-unpaid bills may be reversed
--   - amount_paid is canonical/derived from vendor payment ledger
--   - payment reversals support partial -> open / paid -> partial/open
--   - overpayment calculations net original payments minus reversals
--   - vendor payment writes serialize through vendor_bill row locking
--
-- This migration assumes 20260818 through 20260822 are already applied.
--
-- NOT applied automatically.
-- Apply manually through the Supabase SQL Editor.

begin;

-- ============================================================================
-- 1. JOURNAL IMMUTABILITY HARDENING
-- ============================================================================

create or replace function public.enforce_journal_entry_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('posted', 'reversed') then
    if new.status <> old.status then
      raise exception
        'Journal entry % is % and terminal -- status changes require a dedicated reversal path',
        old.entry_number,
        old.status;
    end if;

    if new.created_by is distinct from old.created_by
       and new.created_by is not null
    then
      raise exception
        'Journal entry %''s created_by can only be cleared, never reassigned',
        old.entry_number;
    end if;

    -- reversed_entry_id may transition exactly once:
    -- null -> reversal journal entry id.
    if old.reversed_entry_id is not null
       and new.reversed_entry_id is distinct from old.reversed_entry_id
    then
      raise exception
        'Journal entry %''s reversed_entry_id can only be set once, never changed',
        old.entry_number;
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
      raise exception
        'Journal entry % is % and its business record cannot be modified',
        old.entry_number,
        old.status;
    end if;
  end if;

  return new;
end;
$$;

create index if not exists idx_accounting_journal_entries_reversed
  on public.accounting_journal_entries (reversed_entry_id)
  where reversed_entry_id is not null;


-- ============================================================================
-- 2. CANONICAL JOURNAL REVERSAL RPC
-- ============================================================================

create or replace function public.reverse_journal_entry(
  p_org_id uuid,
  p_entry_id uuid,
  p_reversal_date date,
  p_reason text,
  p_created_by uuid default null
)
returns table (
  reversal_entry_id uuid,
  reversal_entry_number text,
  original_entry_id uuid,
  already_reversed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig record;
  v_line record;
  v_lines jsonb := '[]'::jsonb;
  v_post record;
  v_reversal_number text;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;

  if p_entry_id is null then
    raise exception 'entry_id is required';
  end if;

  if p_reversal_date is null then
    raise exception 'reversal_date is required';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reversal reason is required';
  end if;

  -- A reversal journal entry cannot itself be reversed in Tier 1.
  if exists (
    select 1
    from public.accounting_journal_entries
    where org_id = p_org_id
      and reversed_entry_id = p_entry_id
  ) then
    raise exception
      'A reversal journal entry cannot itself be reversed in this phase';
  end if;

  select *
    into v_orig
  from public.accounting_journal_entries
  where id = p_entry_id
    and org_id = p_org_id
  for update;

  if v_orig.id is null then
    raise exception 'Journal entry not found for this org';
  end if;

  if v_orig.status <> 'posted' then
    raise exception
      'Only a posted journal entry can be reversed (current status: %)',
      v_orig.status;
  end if;

  -- Idempotent retry.
  if v_orig.reversed_entry_id is not null then
    select entry_number
      into v_reversal_number
    from public.accounting_journal_entries
    where id = v_orig.reversed_entry_id;

    return query
    select
      v_orig.reversed_entry_id,
      v_reversal_number,
      v_orig.id,
      true;

    return;
  end if;

  -- Exact accounting reversal:
  -- preserve dimensions and swap debit/credit.
  for v_line in
    select
      account_id,
      debit,
      credit,
      description,
      project_id,
      contact_id
    from public.accounting_journal_entry_lines
    where journal_entry_id = v_orig.id
  loop
    v_lines :=
      v_lines ||
      jsonb_build_object(
        'account_id', v_line.account_id,
        'debit', v_line.credit,
        'credit', v_line.debit,
        'description', coalesce(v_line.description, ''),
        'project_id', v_line.project_id,
        'contact_id', v_line.contact_id
      );
  end loop;

  if jsonb_array_length(v_lines) < 2 then
    raise exception
      'Original journal entry % has fewer than 2 lines -- cannot reverse',
      v_orig.entry_number;
  end if;

  -- Source identity is derived from the original JE.
  -- Caller cannot relabel the reversal.
  select *
    into v_post
  from public.post_journal_entry(
    p_org_id,
    p_reversal_date,
    'Reversal of ' || v_orig.entry_number || ' -- ' || p_reason,
    v_orig.source_type,
    v_orig.source_id,
    'reversed',
    v_lines,
    v_orig.project_id,
    v_orig.contact_id,
    p_created_by
  );

  update public.accounting_journal_entries
  set reversed_entry_id = v_post.entry_id
  where id = v_orig.id
    and reversed_entry_id is null;

  return query
  select
    v_post.entry_id,
    v_post.entry_number,
    v_orig.id,
    v_post.already_posted;
end;
$$;

revoke all
on function public.reverse_journal_entry(
  uuid,
  uuid,
  date,
  text,
  uuid
)
from public, anon, authenticated;

grant execute
on function public.reverse_journal_entry(
  uuid,
  uuid,
  date,
  text,
  uuid
)
to service_role;


-- ============================================================================
-- 3. EXPENSE REVERSAL SUPPORT
-- ============================================================================

alter table public.expenses
  add column if not exists reversal_reason text null;

alter table public.expenses
  drop constraint if exists expenses_status_check;

alter table public.expenses
  add constraint expenses_status_check
  check (
    status in (
      'draft',
      'posted',
      'cancelled',
      'reversed'
    )
  );

create or replace function public.enforce_expense_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'reversed' then
    raise exception 'Reversed expenses cannot be modified';
  end if;

  if old.status = 'posted' then

    if new.status = 'reversed' then
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
      then
        raise exception
          'Reversing an expense cannot also change its financial fields';
      end if;

      if new.reversal_reason is null
         or btrim(new.reversal_reason) = ''
      then
        raise exception 'A reversal reason is required';
      end if;

    elsif new.status <> old.status then
      raise exception
        'Posted expenses cannot change status outside the dedicated reversal path';

    elsif new.org_id <> old.org_id
       or new.vendor_id is distinct from old.vendor_id
       or new.project_id is distinct from old.project_id
       or new.contact_id is distinct from old.contact_id
       or new.expense_date <> old.expense_date
       or new.description <> old.description
       or new.amount <> old.amount
       or new.currency <> old.currency
       or new.payment_method is distinct from old.payment_method
       or new.account_id <> old.account_id
    then
      raise exception
        'Posted expenses cannot have financial fields edited';
    end if;

  end if;

  return new;
end;
$$;


-- ============================================================================
-- 4. VENDOR BILL REVERSAL + CANONICAL PAYMENT STATE
-- ============================================================================

alter table public.vendor_bills
  add column if not exists reversal_reason text null;

alter table public.vendor_bills
  drop constraint if exists vendor_bills_status_check;

alter table public.vendor_bills
  add constraint vendor_bills_status_check
  check (
    status in (
      'draft',
      'open',
      'partial',
      'paid',
      'overdue',
      'cancelled',
      'reversed'
    )
  );

create or replace function public.enforce_vendor_bill_immutability()
returns trigger
language plpgsql
as $$
declare
  v_effective_paid numeric(14,2);
  v_expected_status text;
begin
  if old.status = 'reversed' then
    raise exception 'Reversed vendor bills cannot be modified';
  end if;

  if old.status <> 'draft' then

    -- Financial structure remains immutable once posted.
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
      raise exception
        'Posted vendor bills cannot have financial fields edited';
    end if;

    -- ----------------------------------------------------------
    -- Explicit bill reversal.
    -- ----------------------------------------------------------
    if new.status = 'reversed' then

      if old.status not in ('open', 'overdue') then
        raise exception
          'Only a fully unpaid open or overdue bill can be reversed -- current status is %',
          old.status;
      end if;

      if old.amount_paid <> 0 then
        raise exception
          'Cannot reverse a bill with a non-zero amount paid -- reverse vendor payments first';
      end if;

      if new.amount_paid <> old.amount_paid then
        raise exception
          'Reversing a bill cannot also change amount_paid';
      end if;

      if new.reversal_reason is null
         or btrim(new.reversal_reason) = ''
      then
        raise exception 'A reversal reason is required';
      end if;

    -- ----------------------------------------------------------
    -- Payment-driven status / amount recalculation.
    --
    -- This supports both:
    --   forward: open -> partial -> paid
    --   backward: paid -> partial/open, partial -> open
    --
    -- But ONLY when the new values exactly match the canonical
    -- vendor payment ledger.
    -- ----------------------------------------------------------
    elsif new.status <> old.status
       or new.amount_paid <> old.amount_paid
    then

      if old.status not in (
        'open',
        'partial',
        'paid',
        'overdue'
      ) then
        raise exception
          'Vendor bill status cannot transition from % to %',
          old.status,
          new.status;
      end if;

      select
        coalesce(
          sum(
            case
              when reverses_payment_id is null then amount
              else -amount
            end
          ),
          0
        )
      into v_effective_paid
      from public.vendor_payments
      where vendor_bill_id = old.id
        and status = 'succeeded';

      v_expected_status :=
        case
          when v_effective_paid >= old.total_amount
               and old.total_amount > 0
            then 'paid'

          when v_effective_paid > 0
            then 'partial'

          else 'open'
        end;

      if new.amount_paid <> v_effective_paid then
        raise exception
          'vendor_bills.amount_paid must match effective vendor payments (expected %, got %)',
          v_effective_paid,
          new.amount_paid;
      end if;

      if new.status <> v_expected_status then
        raise exception
          'Vendor bill status must match canonical payment-derived state (expected %, got %)',
          v_expected_status,
          new.status;
      end if;

    end if;
  end if;

  return new;
end;
$$;


-- ============================================================================
-- 5. APPEND-ONLY VENDOR PAYMENT REVERSALS
-- ============================================================================

alter table public.vendor_payments
  add column if not exists reverses_payment_id uuid null
  references public.vendor_payments(id)
  on delete restrict;

alter table public.vendor_payments
  add column if not exists reversal_reason text null;

create unique index if not exists uq_vendor_payments_reverses_payment
  on public.vendor_payments (reverses_payment_id)
  where reverses_payment_id is not null;


-- ============================================================================
-- 5A. VENDOR PAYMENT REVERSAL SHAPE VALIDATION
-- ============================================================================

create or replace function public.validate_vendor_payment_reversal_shape()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_orig record;
begin
  if new.reverses_payment_id is null then
    return new;
  end if;

  select *
    into v_orig
  from public.vendor_payments
  where id = new.reverses_payment_id;

  if v_orig.id is null then
    raise exception
      'reverses_payment_id does not reference an existing vendor payment';
  end if;

  if v_orig.org_id <> new.org_id then
    raise exception
      'A payment reversal must belong to the same org as the original payment';
  end if;

  if v_orig.vendor_bill_id <> new.vendor_bill_id then
    raise exception
      'A payment reversal must reference the same bill as the original payment';
  end if;

  if v_orig.vendor_id <> new.vendor_id then
    raise exception
      'A payment reversal must reference the same vendor as the original payment';
  end if;

  if v_orig.status <> 'succeeded' then
    raise exception
      'Only a succeeded payment can be reversed';
  end if;

  if v_orig.reverses_payment_id is not null then
    raise exception
      'Cannot reverse a payment that is itself a reversal';
  end if;

  if new.amount <> v_orig.amount then
    raise exception
      'A payment reversal must reverse the original payment''s exact amount (%)',
      v_orig.amount;
  end if;

  if new.status <> 'succeeded' then
    raise exception
      'A payment reversal row must be recorded as succeeded';
  end if;

  if new.reversal_reason is null
     or btrim(new.reversal_reason) = ''
  then
    raise exception 'A reversal reason is required';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_payment_reversal_shape
  on public.vendor_payments;

create trigger trg_validate_vendor_payment_reversal_shape
  before insert
  on public.vendor_payments
  for each row
  execute function public.validate_vendor_payment_reversal_shape();

revoke all
on function public.validate_vendor_payment_reversal_shape()
from public, anon, authenticated;


-- ============================================================================
-- 5B. VENDOR PAYMENT IMMUTABILITY
-- ============================================================================

create or replace function public.enforce_vendor_payment_immutability()
returns trigger
language plpgsql
as $$
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
       or new.reverses_payment_id is distinct from old.reverses_payment_id
       or new.reversal_reason is distinct from old.reversal_reason
    then
      raise exception
        'Succeeded vendor payments are immutable';
    end if;
  end if;

  return new;
end;
$$;


-- ============================================================================
-- 5C. CANONICAL BILL AMOUNT_PAID SYNC
-- ============================================================================

create or replace function public.sync_vendor_bill_amount_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id uuid := coalesce(new.vendor_bill_id, old.vendor_bill_id);
  v_paid numeric(14,2);
  v_total numeric(14,2);
  v_status text;
begin
  select
    coalesce(
      sum(
        case
          when reverses_payment_id is null then amount
          else -amount
        end
      ),
      0
    )
  into v_paid
  from public.vendor_payments
  where vendor_bill_id = v_bill_id
    and status = 'succeeded';

  select
    total_amount,
    status
  into
    v_total,
    v_status
  from public.vendor_bills
  where id = v_bill_id;

  if v_status not in (
    'cancelled',
    'draft',
    'reversed'
  ) then
    update public.vendor_bills
    set
      amount_paid = v_paid,
      status =
        case
          when v_paid >= v_total
               and v_total > 0
            then 'paid'

          when v_paid > 0
            then 'partial'

          else 'open'
        end
    where id = v_bill_id;
  end if;

  return null;
end;
$$;


-- ============================================================================
-- 5D. VENDOR PAYMENT DIMENSION + BILL-STATE VALIDATION
-- ============================================================================

create or replace function public.validate_vendor_payment_dimensions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_org uuid;
  v_bill_vendor uuid;
  v_bill_project uuid;
  v_bill_status text;
  v_vendor_org uuid;
  v_project_org uuid;
begin
  select
    org_id,
    vendor_id,
    project_id,
    status
  into
    v_bill_org,
    v_bill_vendor,
    v_bill_project,
    v_bill_status
  from public.vendor_bills
  where id = new.vendor_bill_id;

  if v_bill_org is null then
    raise exception
      'vendor_bill_id does not reference an existing bill';
  end if;

  if v_bill_org <> new.org_id then
    raise exception
      'vendor_payments.org_id must match its bill''s org_id';
  end if;

  -- ----------------------------------------------------------
  -- Terminal / non-payable bill states.
  -- ----------------------------------------------------------

  if v_bill_status = 'draft' then
    raise exception
      'Cannot record a payment against a draft bill -- post it first';
  end if;

  if v_bill_status = 'cancelled' then
    raise exception
      'Cannot record a payment against a cancelled bill';
  end if;

  if v_bill_status = 'reversed' then
    raise exception
      'Cannot record a payment against a reversed bill';
  end if;

  -- A fully paid bill may ONLY receive a legitimate reversal row.
  --
  -- The reversal-shape trigger below remains responsible for proving
  -- reverses_payment_id points at a valid succeeded original payment.
  if v_bill_status = 'paid'
     and new.reverses_payment_id is null
  then
    raise exception
      'Cannot record a payment against a fully paid bill';
  end if;

  -- ----------------------------------------------------------
  -- Bill dimensional integrity.
  -- ----------------------------------------------------------

  if v_bill_vendor <> new.vendor_id then
    raise exception
      'vendor_payments.vendor_id must match its bill''s vendor_id';
  end if;

  if new.project_id is distinct from v_bill_project then
    raise exception
      'vendor_payments.project_id must match its bill''s project_id';
  end if;

  -- ----------------------------------------------------------
  -- Tenant integrity.
  -- ----------------------------------------------------------

  select org_id
    into v_vendor_org
  from public.vendors
  where id = new.vendor_id;

  if v_vendor_org is null
     or v_vendor_org <> new.org_id
  then
    raise exception
      'vendor_payments.vendor_id must belong to the same org';
  end if;

  if new.project_id is not null then
    select org_id
      into v_project_org
    from public.projects
    where id = new.project_id;

    if v_project_org is null
       or v_project_org <> new.org_id
    then
      raise exception
        'vendor_payments.project_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;


-- ============================================================================
-- 5E. RECORD VENDOR PAYMENT
-- ============================================================================

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
returns table (
  payment_id uuid,
  bill_status text,
  bill_amount_paid numeric
)
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

  if p_amount is null
     or p_amount <= 0
  then
    raise exception 'amount must be a positive number';
  end if;

  -- Parent bill is the concurrency lock.
  select *
    into v_bill
  from public.vendor_bills
  where id = p_vendor_bill_id
    and org_id = p_org_id
  for update;

  if v_bill.id is null then
    raise exception 'Bill not found for this org';
  end if;

  if v_bill.status = 'draft' then
    raise exception
      'This bill must be posted before it can be paid';
  end if;

  if v_bill.status = 'cancelled' then
    raise exception 'This bill is cancelled';
  end if;

  if v_bill.status = 'reversed' then
    raise exception
      'This bill has been reversed and can no longer be paid';
  end if;

  if v_bill.status = 'paid' then
    raise exception
      'This bill is already fully paid';
  end if;

  -- Effective payment balance includes append-only reversals.
  select
    coalesce(
      sum(
        case
          when reverses_payment_id is null then amount
          else -amount
        end
      ),
      0
    )
  into v_paid
  from public.vendor_payments
  where vendor_bill_id = p_vendor_bill_id
    and status = 'succeeded';

  v_remaining :=
    round(v_bill.total_amount - v_paid, 2);

  if v_remaining <= 0 then
    raise exception
      'This bill has no remaining balance';
  end if;

  if p_amount > v_remaining + 0.005 then
    raise exception
      'Payment of % exceeds the remaining balance of %',
      p_amount,
      v_remaining;
  end if;

  insert into public.vendor_payments (
    org_id,
    vendor_bill_id,
    vendor_id,
    project_id,
    amount,
    currency,
    status,
    payment_method,
    provider,
    provider_payment_id,
    source,
    paid_at,
    reference,
    notes,
    created_by
  )
  values (
    p_org_id,
    p_vendor_bill_id,
    v_bill.vendor_id,
    v_bill.project_id,
    p_amount,
    coalesce(p_currency, 'usd'),
    'succeeded',
    p_payment_method,
    coalesce(p_provider, 'manual'),
    p_provider_payment_id,
    coalesce(p_source, 'manual'),
    coalesce(p_paid_at, now()),
    p_reference,
    p_notes,
    p_created_by
  )
  returning id
  into v_payment_id;

  select
    status,
    amount_paid
  into
    v_bill.status,
    v_bill.amount_paid
  from public.vendor_bills
  where id = p_vendor_bill_id;

  return query
  select
    v_payment_id,
    v_bill.status,
    v_bill.amount_paid;
end;
$$;


-- ============================================================================
-- 6. ATOMIC VENDOR PAYMENT REVERSAL
-- ============================================================================

create or replace function public.record_vendor_payment_reversal(
  p_org_id uuid,
  p_payment_id uuid,
  p_reason text,
  p_reversal_date date default current_date,
  p_created_by uuid default null
)
returns table (
  reversal_payment_id uuid,
  vendor_bill_id uuid,
  bill_status text,
  bill_amount_paid numeric,
  already_reversed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill_id_lookup uuid;
  v_bill record;
  v_orig record;
  v_existing_reversal_id uuid;
  v_new_id uuid;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;

  if p_payment_id is null then
    raise exception 'payment_id is required';
  end if;

  if p_reason is null
     or btrim(p_reason) = ''
  then
    raise exception 'A reversal reason is required';
  end if;

  -- vendor_bill_id is immutable on succeeded payment rows,
  -- so this initial lookup is safe.
  select vendor_bill_id
    into v_bill_id_lookup
  from public.vendor_payments
  where id = p_payment_id
    and org_id = p_org_id;

  if v_bill_id_lookup is null then
    raise exception
      'Vendor payment not found for this org';
  end if;

  -- IMPORTANT:
  -- lock bill FIRST, matching record_vendor_payment().
  select *
    into v_bill
  from public.vendor_bills
  where id = v_bill_id_lookup
    and org_id = p_org_id
  for update;

  if v_bill.id is null then
    raise exception
      'Bill not found for this org';
  end if;

  -- Then lock original payment.
  select *
    into v_orig
  from public.vendor_payments
  where id = p_payment_id
    and org_id = p_org_id
  for update;

  if v_orig.id is null then
    raise exception
      'Vendor payment not found for this org';
  end if;

  if v_orig.status <> 'succeeded' then
    raise exception
      'Only a succeeded payment can be reversed (current status: %)',
      v_orig.status;
  end if;

  if v_orig.reverses_payment_id is not null then
    raise exception
      'Cannot reverse a payment that is itself a reversal';
  end if;

  -- Idempotent retry.
  select id
    into v_existing_reversal_id
  from public.vendor_payments
  where reverses_payment_id = p_payment_id;

  if v_existing_reversal_id is not null then
    select
      status,
      amount_paid
    into
      v_bill.status,
      v_bill.amount_paid
    from public.vendor_bills
    where id = v_orig.vendor_bill_id;

    return query
    select
      v_existing_reversal_id,
      v_orig.vendor_bill_id,
      v_bill.status,
      v_bill.amount_paid,
      true;

    return;
  end if;

  -- Append-only reversal transaction.
  insert into public.vendor_payments (
    org_id,
    vendor_bill_id,
    vendor_id,
    project_id,
    amount,
    currency,
    status,
    payment_method,
    provider,
    provider_payment_id,
    source,
    paid_at,
    reference,
    notes,
    reverses_payment_id,
    reversal_reason,
    created_by
  )
  values (
    v_orig.org_id,
    v_orig.vendor_bill_id,
    v_orig.vendor_id,
    v_orig.project_id,
    v_orig.amount,
    v_orig.currency,
    'succeeded',
    v_orig.payment_method,
    'manual',
    null,
    'reversal',
    coalesce(p_reversal_date, current_date)::timestamptz,
    null,
    null,
    p_payment_id,
    p_reason,
    p_created_by
  )
  returning id
  into v_new_id;

  -- sync_vendor_bill_amount_paid() has already executed.
  select
    status,
    amount_paid
  into
    v_bill.status,
    v_bill.amount_paid
  from public.vendor_bills
  where id = v_orig.vendor_bill_id;

  return query
  select
    v_new_id,
    v_orig.vendor_bill_id,
    v_bill.status,
    v_bill.amount_paid,
    false;
end;
$$;

revoke all
on function public.record_vendor_payment_reversal(
  uuid,
  uuid,
  text,
  date,
  uuid
)
from public, anon, authenticated;

grant execute
on function public.record_vendor_payment_reversal(
  uuid,
  uuid,
  text,
  date,
  uuid
)
to service_role;


commit;


-- ============================================================================
-- MANUAL VERIFICATION QUERIES
-- Run these AFTER the migration succeeds.
-- ============================================================================

-- 1. New operational reversal columns
select
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'expenses'
      and column_name = 'reversal_reason')
    or
    (table_name = 'vendor_bills'
      and column_name = 'reversal_reason')
    or
    (table_name = 'vendor_payments'
      and column_name in (
        'reverses_payment_id',
        'reversal_reason'
      ))
  )
order by table_name, column_name;


-- 2. Reversal RPCs exist and are SECURITY DEFINER
select
  p.proname,
  p.prosecdef
from pg_proc p
join pg_namespace n
  on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'reverse_journal_entry',
    'record_vendor_payment_reversal'
  );


-- 3. Check execution grants
select
  grantee,
  routine_name,
  privilege_type
from information_schema.role_routine_grants
where routine_schema = 'public'
  and routine_name in (
    'reverse_journal_entry',
    'record_vendor_payment_reversal'
  )
order by routine_name, grantee;


-- 4. Expense status constraint
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.expenses'::regclass
  and conname = 'expenses_status_check';


-- 5. Vendor bill status constraint
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.vendor_bills'::regclass
  and conname = 'vendor_bills_status_check';


-- 6. Unique reversal relationship
select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'vendor_payments'
  and indexname = 'uq_vendor_payments_reverses_payment';


-- 7. Important function definitions
select
  p.proname,
  pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n
  on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'enforce_vendor_bill_immutability',
    'validate_vendor_payment_dimensions',
    'validate_vendor_payment_reversal_shape',
    'sync_vendor_bill_amount_paid',
    'record_vendor_payment',
    'record_vendor_payment_reversal',
    'reverse_journal_entry'
  )
order by p.proname;