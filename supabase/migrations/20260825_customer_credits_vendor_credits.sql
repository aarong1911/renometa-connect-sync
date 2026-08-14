-- Phase 13.10 -- Customer payment reversals, customer credit memos, and
-- vendor credits.
--
-- NEW, additive migration. Does NOT modify 20260818/20260819/20260820/
-- 20260821/20260822/20260823/20260824, all already applied. Where this
-- file needs to change a function's behavior (immutability triggers,
-- sync_invoice_amount_paid, post_journal_entry's source_type allowlist),
-- it does so via `create or replace function` here, in this new file.
--
-- ============================================================================
-- AUDIT FINDINGS (see the Phase 13.10 report for full detail)
-- ============================================================================
--
-- invoice_payments (20260818): status in ('pending','succeeded','failed',
-- 'refunded','voided'); provider in ('manual','stripe','square','other');
-- source in ('manual','legacy_import','stripe_webhook'). sync_invoice_
-- amount_paid() ALREADY subtracts status='refunded' rows from amount_paid
-- (a dormant mechanism -- nothing in the app has ever set status='refunded';
-- Stripe refunds are Phase 13.11). invoice_payments had NO immutability
-- trigger at all before this migration -- any row was freely UPDATE-able.
-- Grepped every netlify/functions/*.ts: nothing ever UPDATEs an
-- invoice_payments row after insert, so adding succeeded-terminal
-- immutability here is safe and closes a real gap, matching vendor_
-- payments' own model exactly.
--
-- invoices.status (20260819): draft/sent/viewed/partial/paid/overdue/
-- cancelled -- no 'void' (despite sync_invoice_amount_paid()'s defensive
-- 'void' check; that value has never been legal). No immutability trigger
-- exists on `invoices` at all (unlike vendor_bills) -- sync_invoice_
-- amount_paid()'s own UPDATE is never blocked, so there is no Phase-13.9B-
-- style "backward transition rejected" bug to fix here: the existing CASE
-- logic already restores partial/paid back to 'sent' when collected cash
-- hits zero. Only the underlying SUM formula needs to account for
-- reversals.
--
-- postInvoiceIssued() (netlify/lib/accounting.ts) always posts to a single
-- revenue account (Construction Revenue, 4000) -- there is no per-line
-- revenue mapping today. Credit memo accounting therefore derives its
-- revenue account from the ORIGINAL invoice's own posted journal entry
-- (found via source_type='invoice', posting_key='issued'), never
-- hardcoded, so it stays correct even if a future invoice posts to a
-- different revenue account.
--
-- post_journal_entry()'s source_type allowlist already includes
-- 'credit_memo' (added in 20260820, never used until now) -- customer
-- credit memos need NO source_type expansion. Vendor credits have no
-- existing equivalent, so 'vendor_credit' is added to both the table
-- CHECK constraint and post_journal_entry()'s internal v_valid_source_
-- types array (both must agree -- the array is the first, friendlier
-- error; the CHECK is the final guarantee).
--
-- ============================================================================
-- ARCHITECTURE
-- ============================================================================
--
-- Payment reversal, manual invoice payments, vendor payments, expenses, and
-- vendor bills all follow the established codebase pattern: the
-- OPERATIONAL row is inserted first (RPC, under a lock on its parent
-- record), and accounting posting is a separate, best-effort step
-- performed by the calling Netlify function immediately afterward, with
-- any accounting failure surfaced as a non-blocking `accountingWarning`.
-- record_invoice_payment() (Phase 13.10B, Section 10) continues that same
-- model -- a manual payment is operationally real and effective the moment
-- it's recorded, exactly like every other payment in this codebase; only
-- its RACE-SAFETY (locking, credit-aware ceiling, idempotency) changes in
-- this phase, not its operational/accounting-posting split.
--
-- Customer credit memos and vendor credits are DIFFERENT as of Phase
-- 13.10B (Part 1/2) -- CRITICAL FIX to the Phase 13.10A design, which
-- created a credit as immediately `posted`/effective, before its journal
-- entry existed. A credit is now a two-step prepare/finalize flow:
-- record_customer_credit_memo()/record_vendor_credit() create a `draft`
-- document, the Netlify layer posts its journal entry, and ONLY THEN does
-- finalize_customer_credit_memo()/finalize_vendor_credit() -- which itself
-- verifies the posted JE exists AND has the exact expected account/amount
-- content, not just a matching identity (Phase 13.10C, Part 21-25) --
-- flip it to `posted`. See Section 6/8's own header comments for the full
-- reasoning and retry/recovery model.
--
-- Phase 13.10C, Part 1-13/27-36/48 -- TWO DISTINCT BALANCE CONCEPTS. Do
-- not conflate them; every formula in this migration and its callers is
-- deliberately one or the other, never a mix:
--
--   EFFECTIVE / POSTED (financial truth): only status='posted' credits
--   count. This is what A/R, A/P, aging, Financials Overview, P&L, Balance
--   Sheet, Trial Balance, Project Profitability, and every customer/vendor-
--   facing displayed Balance use. A draft credit has ZERO effect here --
--   "zero posted accounting/reporting effect."
--
--   AVAILABLE / RESERVED (write-safety ceiling): status IN ('draft',
--   'posted') credits both count. A draft credit -- even one whose GL
--   posting is still pending, or that failed and is sitting there waiting
--   for a retry -- reserves its dollar amount so a concurrent payment or a
--   second credit cannot also try to consume it before the first one
--   either finalizes or is administratively removed. This is intentional:
--   "zero posted accounting effect, but reserves settlement capacity."
--   Used by record_customer_credit_memo()/record_vendor_credit()'s own
--   ceilings (credit-vs-credit), record_invoice_payment()/record_vendor_
--   payment()'s ceilings (credit-vs-payment), Stripe checkout amount
--   calculation (invoice-create-payment.ts, portal-action.ts), and the
--   Collections Agent's dunning amount (run-agent.ts) -- collections
--   should never nag a customer for a balance a pending adjustment has
--   already reserved. It must NEVER be used for anything reported/
--   displayed as the customer's or vendor's actual financial balance.
--
-- A draft credit created because GL posting failed therefore still
-- reserves its amount (Part 7) -- the business cannot oversettle an
-- invoice/bill while a recoverable, GL-pending adjustment sits in draft,
-- even though that adjustment itself doesn't move any posted number yet.
--
-- Draft abandonment (Part 8): there is no automatic expiration and no
-- background cleanup in this phase. A draft that can never successfully
-- finalize (e.g. permanently missing accounting configuration) remains
-- reserved until either (a) the same idempotency key is retried and
-- succeeds, or (b) a future maintenance flow administratively removes it
-- (service-role deletion of a draft row remains technically possible under
-- the current schema/triggers -- only posted/reversed rows are delete-
-- protected). No such UI is built in this phase.
--
-- NOT applied automatically. Review and run manually in the Supabase SQL
-- Editor.

begin;

-- ============================================================================
-- 1. INVOICE_PAYMENTS -- append-only manual-payment reversal support
-- ============================================================================

alter table public.invoice_payments add column if not exists reverses_payment_id uuid null references public.invoice_payments(id) on delete restrict;
alter table public.invoice_payments add column if not exists reversal_reason text null;

-- Phase 13.10B, Part 15 -- manual-payment idempotency. A double-click/
-- retry on Record Payment must never create two payment rows; the client
-- generates one key per submit attempt (reused verbatim on retry, fresh on
-- a genuinely new logical payment -- see RecordPaymentDialog.tsx), and this
-- unique partial index is the real backstop, same shape as the credit
-- tables' own idempotency_key columns.
alter table public.invoice_payments add column if not exists idempotency_key text null;
create unique index if not exists uq_invoice_payments_org_idempotency
  on public.invoice_payments (org_id, idempotency_key) where idempotency_key is not null;

-- Phase 13.10A, Part 2 -- CRITICAL FIX. invoice_payments_source_check
-- (20260818, applied) only allows source in ('manual','legacy_import',
-- 'stripe_webhook') -- the reversal RPC below inserts source='reversal',
-- which would fail this CHECK outright the first time it ran. (vendor_
-- payments.source has no CHECK constraint at all, which is why the
-- equivalent vendor-side reversal never hit this.) Chosen fix: expand the
-- CHECK to include 'reversal' explicitly, rather than overloading an
-- existing value -- `source` describes how a ledger row entered the
-- system, and "created as an operator-initiated reversal correction" is a
-- genuinely distinct entry channel from "manually recorded original
-- payment," exactly as meaningful to audit as legacy_import/stripe_webhook
-- already are. No TypeScript type currently enumerates invoice_payments
-- source values (PaymentHistory.tsx reads it as a plain string), so no
-- client-side type update is required.
alter table public.invoice_payments drop constraint if exists invoice_payments_source_check;
alter table public.invoice_payments add constraint invoice_payments_source_check
  check (source in ('manual', 'legacy_import', 'stripe_webhook', 'reversal'));

-- At most one reversal row may reference a given original payment -- the
-- hard DB-level backstop against a double reversal, same pattern as
-- uq_vendor_payments_reverses_payment (Phase 13.8B/13.9A -- deliberately
-- ONE index here, not a redundant pair, per the cleanup lesson from
-- Phase 13.9A Part 12).
create unique index if not exists uq_invoice_payments_reverses_payment
  on public.invoice_payments (reverses_payment_id) where reverses_payment_id is not null;

-- Validates a reversal row's shape: must point at a real, succeeded,
-- MANUALLY-recorded (never Stripe), not-itself-a-reversal original payment
-- in the same org/invoice, reversing its exact amount (full reversal only
-- in this phase). Mirrors validate_vendor_payment_reversal_shape().
create or replace function public.validate_invoice_payment_reversal_shape()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_orig record;
begin
  -- Phase 13.10B, Part 20/21 -- CRITICAL FIX. source='reversal' IFF
  -- reverses_payment_id is set, enforced for every row (not just the
  -- reversal-shaped branch below) -- this closes the gap where a caller
  -- could have inserted an ordinary original payment with
  -- source='reversal' (no reverses_payment_id), or a reversal row that
  -- never actually points back at anything, and neither the CHECK
  -- constraint nor the rest of this function would have caught it.
  if new.reverses_payment_id is not null and new.source <> 'reversal' then
    raise exception 'A payment with reverses_payment_id set must have source=''reversal''';
  end if;
  if new.reverses_payment_id is null and new.source = 'reversal' then
    raise exception 'source=''reversal'' requires reverses_payment_id to be set';
  end if;

  if new.reverses_payment_id is null then
    return new;
  end if;

  select * into v_orig from public.invoice_payments where id = new.reverses_payment_id;
  if v_orig.id is null then
    raise exception 'reverses_payment_id does not reference an existing invoice payment';
  end if;
  if v_orig.org_id <> new.org_id then
    raise exception 'A payment reversal must belong to the same org as the original payment';
  end if;
  if v_orig.invoice_id <> new.invoice_id then
    raise exception 'A payment reversal must reference the same invoice as the original payment';
  end if;
  if v_orig.status <> 'succeeded' then
    raise exception 'Only a succeeded payment can be reversed';
  end if;
  -- Part 8 -- Stripe payments cannot be reversed as a manual accounting
  -- correction; they require an actual Stripe refund (Phase 13.11).
  if v_orig.provider <> 'manual' then
    raise exception 'Only manually recorded payments can be reversed here -- % payments require a refund, not a manual reversal', v_orig.provider;
  end if;
  if v_orig.reverses_payment_id is not null then
    raise exception 'Cannot reverse a payment that is itself a reversal';
  end if;
  if new.amount <> v_orig.amount then
    raise exception 'A payment reversal must reverse the original payment''s exact amount (%) -- partial reversal is not supported yet', v_orig.amount;
  end if;
  if new.status <> 'succeeded' then
    raise exception 'A payment reversal row must be recorded as succeeded';
  end if;
  if new.provider <> 'manual' then
    raise exception 'A payment reversal row must be recorded as manual';
  end if;
  if new.reversal_reason is null or btrim(new.reversal_reason) = '' then
    raise exception 'A reversal reason is required';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_invoice_payment_reversal_shape on public.invoice_payments;
create trigger trg_validate_invoice_payment_reversal_shape
  before insert or update on public.invoice_payments
  for each row execute function public.validate_invoice_payment_reversal_shape();

revoke all on function public.validate_invoice_payment_reversal_shape() from public, anon, authenticated;

-- invoice_payments had NO immutability protection before this migration.
-- Freeze every field once status='succeeded', mirroring vendor_payments'
-- succeeded-terminal model exactly (including the two new reversal
-- columns, so the reversal relationship itself can never be edited after
-- the fact). Confirmed safe: no existing code path ever UPDATEs a row
-- after insert.
create or replace function public.enforce_invoice_payment_immutability()
returns trigger language plpgsql as $$
begin
  if old.status = 'succeeded' then
    if new.org_id <> old.org_id
       or new.invoice_id <> old.invoice_id
       or new.project_id is distinct from old.project_id
       or new.contact_id is distinct from old.contact_id
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
       or new.idempotency_key is distinct from old.idempotency_key
       or new.created_by is distinct from old.created_by
    then
      raise exception 'Succeeded invoice payments are immutable -- reversal/correction is not a direct edit';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_invoice_payment_immutability on public.invoice_payments;
create trigger trg_enforce_invoice_payment_immutability
  before update on public.invoice_payments
  for each row execute function public.enforce_invoice_payment_immutability();

-- Part 3 -- effective amount_paid now nets successful ORIGINAL payments
-- against successful REVERSAL payments, exactly like vendor_payments.
-- The pre-existing 'refunded' subtraction is preserved as-is (dormant,
-- Phase 13.11 territory) rather than removed, so this stays backward
-- compatible with anything that assumed it existed.
--
-- Phase 13.10A, Part 3 -- audited for double-subtraction risk before this
-- formula was extended further. It is structurally safe: the two SUM(...)
-- terms are filtered on mutually exclusive `status` values (`succeeded`
-- vs. `refunded`), and validate_invoice_payment_reversal_shape() forces
-- every reversal row's own status to always be 'succeeded' (never
-- 'refunded') -- so a single row can never contribute to both terms at
-- once, and a reversal row can never ALSO be counted as a refund. This
-- guarantee depends on 'refunded' staying dormant (nothing in this phase,
-- or any phase before it, ever sets invoice_payments.status='refunded');
-- Phase 13.11's real Stripe refund design must re-verify this invariant
-- explicitly before it starts writing 'refunded' rows for real, since a
-- future refund-of-a-reversed-payment (or reversal-of-a-refunded-payment)
-- scenario is exactly the kind of case that could reintroduce double
-- counting if not designed carefully. Not addressed further here --
-- Stripe refunds are out of scope for Phase 13.10A by instruction.
create or replace function public.sync_invoice_amount_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_current_status text;
begin
  if tg_op = 'DELETE' then
    v_invoice_id := old.invoice_id;
  else
    v_invoice_id := new.invoice_id;
  end if;

  select
    coalesce(
      sum(case when reverses_payment_id is null then p.amount else -p.amount end)
        filter (where p.status = 'succeeded'),
      0
    )
    -
    coalesce(
      sum(p.amount) filter (where p.status = 'refunded'),
      0
    )
  into v_paid
  from public.invoice_payments p
  where p.invoice_id = v_invoice_id;

  if v_paid < 0 then
    v_paid := 0;
  end if;

  select i.total_amount, i.status into v_total, v_current_status
  from public.invoices i where i.id = v_invoice_id;

  if v_total is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  update public.invoices
  set
    amount_paid = v_paid,
    status = case
      when v_current_status in ('draft', 'void', 'cancelled') then v_current_status
      when v_total > 0 and v_paid >= v_total then 'paid'
      when v_paid > 0 and v_paid < v_total then 'partial'
      when v_paid = 0 and v_current_status in ('partial', 'paid') then 'sent'
      else v_current_status
    end,
    updated_at = now()
  where id = v_invoice_id;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ============================================================================
-- 2. record_invoice_payment_reversal() -- atomic, race-safe payment-reversal RPC
-- ============================================================================
--
-- Mirrors record_vendor_payment_reversal() (Phase 13.9A/B, hardened again in
-- 20260824) exactly, including its lock ordering fix: locks the INVOICE row
-- first (same order invoice-record-payment.ts's normal payment path
-- implicitly establishes by being the only writer that matters here), then
-- the original payment row, so a concurrent normal payment and a
-- concurrent reversal against the same invoice fully serialize instead of
-- racing on the cached amount_paid.
--
-- Phase 13.10A, Part 1 -- CRITICAL FIX. `invoice_id` is both an output
-- column name in RETURNS TABLE and a real column on invoice_payments/
-- invoices -- exactly the class of PL/pgSQL ambiguity bug 20260824 already
-- fixed for record_vendor_payment_reversal(). Every table reference is now
-- explicitly aliased (ip./i./vp-equivalent) so no bare column name can ever
-- resolve against the wrong thing.
create or replace function public.record_invoice_payment_reversal(
  p_org_id uuid,
  p_payment_id uuid,
  p_reason text,
  p_reversal_date date default current_date,
  p_created_by uuid default null
)
returns table (reversal_payment_id uuid, invoice_id uuid, invoice_status text, invoice_amount_paid numeric, already_reversed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id_lookup uuid;
  v_invoice record;
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
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reversal reason is required';
  end if;

  select ip.invoice_id into v_invoice_id_lookup
    from public.invoice_payments as ip
   where ip.id = p_payment_id and ip.org_id = p_org_id;
  if v_invoice_id_lookup is null then
    raise exception 'Invoice payment not found for this org';
  end if;

  select i.* into v_invoice
    from public.invoices as i
   where i.id = v_invoice_id_lookup and i.org_id = p_org_id
   for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found for this org';
  end if;

  select ip.* into v_orig
    from public.invoice_payments as ip
   where ip.id = p_payment_id and ip.org_id = p_org_id
   for update;
  if v_orig.id is null then
    raise exception 'Invoice payment not found for this org';
  end if;
  if v_orig.status <> 'succeeded' then
    raise exception 'Only a succeeded payment can be reversed (current status: %)', v_orig.status;
  end if;
  if v_orig.provider <> 'manual' then
    raise exception 'Only manually recorded payments can be reversed here -- % payments require a refund', v_orig.provider;
  end if;
  if v_orig.reverses_payment_id is not null then
    raise exception 'Cannot reverse a payment that is itself a reversal';
  end if;

  select ip.id into v_existing_reversal_id
    from public.invoice_payments as ip
   where ip.reverses_payment_id = p_payment_id;
  if v_existing_reversal_id is not null then
    select i.status, i.amount_paid into v_invoice.status, v_invoice.amount_paid
      from public.invoices as i where i.id = v_invoice_id_lookup;
    return query select v_existing_reversal_id, v_invoice_id_lookup, v_invoice.status, v_invoice.amount_paid, true;
    return;
  end if;

  insert into public.invoice_payments (
    org_id, invoice_id, project_id, contact_id, amount, currency, status,
    payment_method, provider, provider_payment_id, source, paid_at,
    reference, notes, reverses_payment_id, reversal_reason, created_by
  ) values (
    v_orig.org_id, v_orig.invoice_id, v_orig.project_id, v_orig.contact_id, v_orig.amount, v_orig.currency, 'succeeded',
    v_orig.payment_method, 'manual', null, 'reversal', coalesce(p_reversal_date, now()),
    null, null, p_payment_id, p_reason, p_created_by
  )
  returning id into v_new_id;

  select i.status, i.amount_paid into v_invoice.status, v_invoice.amount_paid
    from public.invoices as i where i.id = v_invoice_id_lookup;

  return query select v_new_id, v_invoice_id_lookup, v_invoice.status, v_invoice.amount_paid, false;
end;
$$;

revoke all on function public.record_invoice_payment_reversal(uuid, uuid, text, date, uuid) from public, anon, authenticated;
grant execute on function public.record_invoice_payment_reversal(uuid, uuid, text, date, uuid) to service_role;

-- ============================================================================
-- 3. FINANCIAL_DOCUMENT_COUNTERS -- shared race-safe numbering for credit documents
-- ============================================================================
--
-- Mirrors accounting_journal_entry_counters' row-locked, race-safe shape
-- (20260820) generalized across document types so customer credit memos
-- and vendor credits share one counter mechanism instead of two near-
-- identical ones. Purely internal -- never queried directly by the app.

create table if not exists public.financial_document_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  document_type text not null,
  year int not null,
  next_number int not null default 1,
  primary key (org_id, document_type, year)
);

alter table public.financial_document_counters enable row level security;
revoke all on public.financial_document_counters from anon, authenticated;

create or replace function public.next_financial_document_number(p_org_id uuid, p_document_type text, p_prefix text, p_date date)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_year int := extract(year from p_date);
  v_next int;
begin
  insert into public.financial_document_counters (org_id, document_type, year, next_number)
  values (p_org_id, p_document_type, v_year, 1)
  on conflict (org_id, document_type, year) do nothing;

  update public.financial_document_counters
     set next_number = next_number + 1
   where org_id = p_org_id and document_type = p_document_type and year = v_year
   returning next_number - 1 into v_next;

  return p_prefix || '-' || v_year || '-' || lpad(v_next::text, 6, '0');
end;
$$;

-- Internal helper only, called from within the SECURITY DEFINER credit-
-- posting RPCs below (which retain implicit execute rights on functions
-- owned by the same role) -- same pattern as next_journal_entry_number(),
-- not exposed to any client-facing role, not even service_role directly.
revoke all on function public.next_financial_document_number(uuid, text, text, date) from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. accounting_journal_entries -- add 'vendor_credit' source_type
-- ============================================================================
--
-- 'credit_memo' already exists (20260820, unused until now) -- customer
-- credit memos need no expansion. Vendor credits have no existing
-- equivalent value, so it's added here to both the CHECK constraint and
-- post_journal_entry()'s internal allowlist (below) -- the two must agree.

alter table public.accounting_journal_entries drop constraint if exists accounting_journal_entries_source_type_check;
alter table public.accounting_journal_entries add constraint accounting_journal_entries_source_type_check
  check (source_type in (
    'invoice', 'invoice_payment', 'expense', 'vendor_bill', 'vendor_payment',
    'change_order', 'manual', 'refund', 'credit_memo', 'vendor_credit', 'opening_balance'
  ));

-- Minimal-diff re-declaration of post_journal_entry() (20260820) -- only
-- v_valid_source_types changes (adds 'vendor_credit'); every other line is
-- unchanged from the applied version.
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
    'change_order', 'manual', 'refund', 'credit_memo', 'vendor_credit', 'opening_balance'
  ];
  v_line_account_id uuid;
  v_line_debit numeric(14,2);
  v_line_credit numeric(14,2);
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if not exists (select 1 from public.organizations where id = p_org_id) then
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
  if p_source_type not in ('manual', 'opening_balance') and p_source_id is null then
    raise exception 'source_id is required for source_type % -- only manual and opening_balance entries may omit it', p_source_type;
  end if;
  if p_posting_key is null or btrim(p_posting_key) = '' then
    raise exception 'posting_key is required';
  end if;
  p_posting_key := btrim(p_posting_key);

  if p_lines is null then
    raise exception 'lines is required';
  end if;
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

revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, text, jsonb, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, text, jsonb, uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 5. CUSTOMER_CREDIT_MEMOS + CUSTOMER_CREDIT_MEMO_LINES
-- ============================================================================
--
-- Phase 13.10A, Part 4/7 -- REVISED from Phase 13.10's original one-shot
-- "created already posted" design. record_customer_credit_memo() below now
-- creates the memo as 'draft', inserts its line(s), validates the line
-- total against the requested amount, and only THEN flips the row to
-- 'posted' -- all inside the same RPC/transaction, so the immutability
-- triggers below can safely block line mutation the instant status is no
-- longer 'draft', with no window where a "posted" memo could have had its
-- lines edited (the gap the original one-shot design left open, since
-- lines were inserted AFTER the parent was already created with
-- status='posted'). idempotency_key makes retries safe (Part 7) --
-- generated client-side once per create attempt and reused on retry, with
-- a DB-level unique constraint as the real backstop, not just "check then
-- insert." Revenue account is still always derived from the original
-- invoice's own posted journal entry -- never user-selectable -- and is
-- now ALSO verified at the DB layer (validate_customer_credit_memo_line_
-- dimensions, below), not just by the Netlify endpoint.

create table if not exists public.customer_credit_memos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  invoice_id uuid not null references public.invoices(id) on delete restrict,
  project_id uuid null references public.projects(id) on delete restrict,
  contact_id uuid null references public.contacts(id) on delete restrict,

  credit_number text null,
  credit_date date not null,
  reason text not null,
  -- Phase 13.10B, Part 6 -- stored separately from the line description
  -- (which defaults to `reason` when blank) so idempotency-fingerprint
  -- comparison on retry has the caller's own original normalized input to
  -- compare against, not a derived value.
  description text null,

  subtotal numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  currency text not null default 'usd',

  status text not null default 'draft',
  posted_at timestamptz null,
  -- Phase 13.10C, Part 18/47 -- NOT NULL. Every row in this table
  -- originates exclusively through record_customer_credit_memo() (there is
  -- no other insert path -- table grants are service_role-only, RLS is
  -- select-only for authenticated), and that RPC itself requires a
  -- non-blank key (defense in depth, not just a NOT NULL constraint doing
  -- the work alone). This is deliberately different from invoice_payments.
  -- idempotency_key, which stays nullable because THAT table has other
  -- legitimate insert paths (Stripe webhook, reversal, future legacy
  -- import) with their own identity models.
  idempotency_key text not null,

  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_credit_memos_status_check check (status in ('draft', 'posted', 'reversed')),
  constraint customer_credit_memos_amounts_nonneg check (subtotal >= 0 and tax_amount >= 0 and total_amount >= 0),
  constraint customer_credit_memos_total_positive_when_posted check (status = 'draft' or total_amount > 0),
  constraint customer_credit_memos_reason_not_blank check (btrim(reason) <> ''),
  constraint customer_credit_memos_idempotency_key_not_blank check (btrim(idempotency_key) <> ''),
  constraint customer_credit_memos_currency_usd_only check (currency = 'usd')
);

create unique index if not exists uq_customer_credit_memos_org_number
  on public.customer_credit_memos (org_id, credit_number) where credit_number is not null;
-- Part 7/20 -- idempotency backstop: the same (org, idempotency_key) can
-- never create two rows, regardless of how many times the RPC is invoked.
-- No longer a partial index (idempotency_key is NOT NULL now) -- plain
-- unique index on every row.
create unique index if not exists uq_customer_credit_memos_org_idempotency
  on public.customer_credit_memos (org_id, idempotency_key);
create index if not exists idx_customer_credit_memos_invoice on public.customer_credit_memos (invoice_id);
create index if not exists idx_customer_credit_memos_org_status on public.customer_credit_memos (org_id, status);

create or replace function public.set_customer_credit_memos_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_customer_credit_memos_updated_at on public.customer_credit_memos;
create trigger trg_customer_credit_memos_updated_at
  before update on public.customer_credit_memos
  for each row execute function public.set_customer_credit_memos_updated_at();

create or replace function public.validate_customer_credit_memo_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invoice_org uuid;
  v_invoice_project uuid;
  v_invoice_contact uuid;
  v_project_org uuid;
  v_contact_org uuid;
begin
  select org_id, project_id, client_id into v_invoice_org, v_invoice_project, v_invoice_contact
    from public.invoices where id = new.invoice_id;
  if v_invoice_org is null then
    raise exception 'invoice_id does not reference an existing invoice';
  end if;
  if v_invoice_org <> new.org_id then
    raise exception 'customer_credit_memos.org_id must match the invoice''s org_id';
  end if;
  if new.project_id is distinct from v_invoice_project then
    raise exception 'customer_credit_memos.project_id must match the invoice''s project_id';
  end if;
  if new.contact_id is distinct from v_invoice_contact then
    raise exception 'customer_credit_memos.contact_id must match the invoice''s client_id';
  end if;

  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'customer_credit_memos.project_id must belong to the same org';
    end if;
  end if;
  if new.contact_id is not null then
    select org_id into v_contact_org from public.contacts where id = new.contact_id;
    if v_contact_org is null or v_contact_org <> new.org_id then
      raise exception 'customer_credit_memos.contact_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_customer_credit_memo_dimensions on public.customer_credit_memos;
create trigger trg_validate_customer_credit_memo_dimensions
  before insert or update on public.customer_credit_memos
  for each row execute function public.validate_customer_credit_memo_dimensions();

revoke all on function public.validate_customer_credit_memo_dimensions() from public, anon, authenticated;

-- Posted credit memos are immutable and terminal (no reversal implemented
-- this phase -- Part 13: "do not expose UI action for it").
create or replace function public.enforce_customer_credit_memo_immutability()
returns trigger language plpgsql as $$
begin
  if old.status in ('posted', 'reversed') then
    raise exception 'Posted customer credit memos cannot be modified';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_customer_credit_memo_immutability on public.customer_credit_memos;
create trigger trg_enforce_customer_credit_memo_immutability
  before update on public.customer_credit_memos
  for each row execute function public.enforce_customer_credit_memo_immutability();

create or replace function public.prevent_posted_customer_credit_memo_delete()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'Only a draft credit memo can be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_customer_credit_memo_delete on public.customer_credit_memos;
create trigger trg_prevent_posted_customer_credit_memo_delete
  before delete on public.customer_credit_memos
  for each row execute function public.prevent_posted_customer_credit_memo_delete();

revoke all on function public.prevent_posted_customer_credit_memo_delete() from public, anon, authenticated;

alter table public.customer_credit_memos enable row level security;

drop policy if exists customer_credit_memos_select on public.customer_credit_memos;
create policy customer_credit_memos_select on public.customer_credit_memos
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.customer_credit_memos from anon, authenticated;
grant select on public.customer_credit_memos to authenticated;
grant select, insert, update, delete on public.customer_credit_memos to service_role;

create table if not exists public.customer_credit_memo_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  credit_memo_id uuid not null references public.customer_credit_memos(id) on delete cascade,

  description text not null,
  amount numeric(14,2) not null,
  revenue_account_id uuid not null references public.accounting_accounts(id),
  project_id uuid null references public.projects(id) on delete restrict,
  contact_id uuid null references public.contacts(id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint customer_credit_memo_lines_amount_positive check (amount > 0),
  constraint customer_credit_memo_lines_description_not_blank check (btrim(description) <> '')
);

create index if not exists idx_customer_credit_memo_lines_memo on public.customer_credit_memo_lines (credit_memo_id);

-- Phase 13.10B, Part 9/38 -- CRITICAL FIX. The Phase 13.10A version of this
-- trigger had a weak fallback: "if no issued JE exists, any same-org
-- revenue account passes." That fallback is removed. A customer credit
-- memo line now REQUIRES a posted original invoice 'issued' journal entry
-- to derive/verify its revenue account against, with no exception --
-- record_customer_credit_memo() already enforces this before it ever
-- reaches this insert (it derives the account from the same place), but
-- this trigger is the independent DB-level backstop, per accounting-
-- integrity's "prefer database enforcement" rule -- a service-role
-- insert/update still deserves its own invariant protection even though
-- the RPC that normally drives it already checked.
create or replace function public.validate_customer_credit_memo_line_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_memo_org uuid;
  v_memo_status text;
  v_memo_invoice_id uuid;
  v_account_org uuid;
  v_account_type text;
  v_issued_entry_id uuid;
  v_expected_revenue_account_id uuid;
  v_revenue_line_count int;
begin
  select org_id, status, invoice_id into v_memo_org, v_memo_status, v_memo_invoice_id
    from public.customer_credit_memos where id = new.credit_memo_id;
  if v_memo_org is null then
    raise exception 'credit_memo_id does not reference an existing credit memo';
  end if;
  if v_memo_org <> new.org_id then
    raise exception 'customer_credit_memo_lines.org_id must match its memo''s org_id';
  end if;
  if v_memo_status <> 'draft' then
    raise exception 'Cannot add/modify lines on a % credit memo -- only draft memos are editable', v_memo_status;
  end if;

  select org_id, account_type into v_account_org, v_account_type
    from public.accounting_accounts where id = new.revenue_account_id;
  if v_account_org is null then
    raise exception 'revenue_account_id does not reference an existing accounting account';
  end if;
  if v_account_org <> new.org_id then
    raise exception 'customer_credit_memo_lines.revenue_account_id must belong to the same org';
  end if;
  if v_account_type <> 'revenue' then
    raise exception 'customer_credit_memo_lines.revenue_account_id must be a revenue account, not a % account', v_account_type;
  end if;

  select je.id into v_issued_entry_id from public.accounting_journal_entries as je
    where je.org_id = new.org_id and je.source_type = 'invoice' and je.source_id = v_memo_invoice_id
      and je.posting_key = 'issued' and je.status = 'posted';
  if v_issued_entry_id is null then
    raise exception 'Cannot create a credit memo line -- invoice % has no posted issued journal entry to derive a revenue account from', v_memo_invoice_id;
  end if;

  select count(*), min(jel.account_id) into v_revenue_line_count, v_expected_revenue_account_id
    from public.accounting_journal_entry_lines as jel
    where jel.journal_entry_id = v_issued_entry_id and jel.credit > 0;
  if v_revenue_line_count <> 1 then
    raise exception 'Cannot verify a single revenue account for invoice % -- % revenue credit line(s) found on its issued entry (expected exactly 1)', v_memo_invoice_id, v_revenue_line_count;
  end if;
  if new.revenue_account_id <> v_expected_revenue_account_id then
    raise exception 'revenue_account_id must match the original invoice''s own posted revenue account';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_customer_credit_memo_line_dimensions on public.customer_credit_memo_lines;
create trigger trg_validate_customer_credit_memo_line_dimensions
  before insert or update on public.customer_credit_memo_lines
  for each row execute function public.validate_customer_credit_memo_line_dimensions();

revoke all on function public.validate_customer_credit_memo_line_dimensions() from public, anon, authenticated;

-- Part 4 -- once the parent memo leaves 'draft' (i.e. is posted), its
-- lines are fully frozen: no insert, no update, no delete. Combined with
-- the redesigned RPC (creates draft -> inserts lines -> flips to posted,
-- all in one transaction), this closes the exact gap Part 4 flagged: a
-- service-role write could previously still touch lines on an
-- already-posted memo.
create or replace function public.prevent_non_draft_customer_credit_memo_line_mutation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from public.customer_credit_memos where id = coalesce(new.credit_memo_id, old.credit_memo_id);
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Cannot modify lines on a % credit memo', v_status;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_non_draft_customer_credit_memo_line_delete on public.customer_credit_memo_lines;
create trigger trg_prevent_non_draft_customer_credit_memo_line_delete
  before delete on public.customer_credit_memo_lines
  for each row execute function public.prevent_non_draft_customer_credit_memo_line_mutation();

revoke all on function public.prevent_non_draft_customer_credit_memo_line_mutation() from public, anon, authenticated;

alter table public.customer_credit_memo_lines enable row level security;

drop policy if exists customer_credit_memo_lines_select on public.customer_credit_memo_lines;
create policy customer_credit_memo_lines_select on public.customer_credit_memo_lines
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.customer_credit_memo_lines from anon, authenticated;
grant select on public.customer_credit_memo_lines to authenticated;
grant select, insert, update, delete on public.customer_credit_memo_lines to service_role;

-- ============================================================================
-- 6. record_customer_credit_memo() + finalize_customer_credit_memo()
-- ============================================================================
--
-- Phase 13.10B rewrite (Part 1/2/3/4). CRITICAL FIX to Phase 13.10A's own
-- design: that version created the memo as 'draft', inserted its line,
-- validated the total, and flipped straight to 'posted' -- all before the
-- Netlify caller ever posted the journal entry. That meant the operational
-- credit could become financially effective (counted in A/R, payment
-- ceilings, aging, portal balances) BEFORE its GL entry existed at all --
-- if GL posting failed afterward, A/R had already moved with no ledger
-- backing it. This is now a two-RPC prepare/finalize split:
--
--   record_customer_credit_memo() -- locks invoice, enforces the ceiling,
--   derives the revenue account (fail-closed, Part 9), creates the memo +
--   line as 'draft' and returns it STILL DRAFT. A draft memo has ZERO
--   financial effect -- every effective-balance query in this codebase
--   (A/R, payment ceilings, aging, portal, reports) filters on
--   status = 'posted' already, so a draft memo is invisible to all of them
--   by construction, no separate "is this effective" flag needed.
--
--   finalize_customer_credit_memo() -- called by the Netlify layer only
--   AFTER post_journal_entry() has actually succeeded for this memo. Locks
--   the memo, verifies a posted journal entry with
--   (source_type='credit_memo', source_id=memo.id, posting_key='posted')
--   genuinely exists, re-verifies line totals still match the parent, and
--   ONLY THEN flips draft -> posted. If already posted, returns the
--   existing state idempotently (safe to call twice). If the JE is
--   missing, it raises rather than finalizing -- there is no way to mark a
--   memo "posted" without a real ledger entry backing it.
--
-- Recovery after a GL failure (Part 3): the draft memo + its allocated
-- number persist across the failed attempt. A retry with the SAME
-- idempotency key finds that exact draft again (never creates a second
-- one, never burns a second number), the caller retries GL posting against
-- the same memo id, and then calls finalize_customer_credit_memo() again --
-- fully self-healing, no manual cleanup, no "create another credit."
--
-- Idempotency fingerprint (Part 6): comparing only (invoice_id, amount) as
-- Phase 13.10A did was insufficient -- a caller could reuse a key with a
-- different reason/description/date and silently get back an unrelated
-- memo. The full normalized fingerprint compared here is (invoice_id,
-- amount, reason, description, credit_date). revenue_account_id is
-- deliberately NOT part of the fingerprint or the parameter list at all
-- (Part 10) -- it is derived entirely inside this RPC from the invoice's
-- own posted issued entry, which is immutable, so it can never legitimately
-- differ between two calls against the same invoice. A same-key request
-- whose normalized fingerprint doesn't match raises a clear conflict
-- exception rather than silently returning the wrong document.
--
-- Concurrent race (Part 7): two simultaneous calls with the same key can
-- both pass the initial fast-path lookup (neither sees the other's row
-- yet). Both then reach the number-allocation + insert, wrapped in its own
-- BEGIN/EXCEPTION block -- whichever commits second hits the unique index
-- on (org_id, idempotency_key), the handler catches specifically
-- unique_violation, fetches the row the winner just committed, verifies
-- the fingerprint matches (it does -- same key, same request), and returns
-- it instead of surfacing a raw 500. An unrelated unique_violation (not
-- from that index) is re-raised, never swallowed.
--
-- Numbering (Part 8): next_financial_document_number() is called INSIDE
-- that same BEGIN/EXCEPTION block, immediately before the insert. When the
-- block's exception handler fires, PL/pgSQL rolls back to the implicit
-- savepoint at BEGIN -- which undoes the number-counter UPDATE too, not
-- just the failed insert. So the losing side of a concurrent-retry race
-- burns no number at all; no gap is possible from this specific path. A
-- gap CAN still occur the ordinary way any Postgres sequence/counter can
-- gap -- if the entire enclosing transaction is rolled back for an
-- unrelated reason after the number was allocated but the function is
-- never called again with that same attempt -- but that is not a
-- distinguishable, retryable state from the caller's perspective (the
-- whole call failed), so it is not treated as a defect here.
--
-- Phase 13.10C, Part 1/2/9 -- CRITICAL FIX: RESERVED vs EFFECTIVE balance.
-- A draft memo has zero POSTED accounting/reporting effect (A/R, aging,
-- portal display, P&L, Balance Sheet, Project Profitability all still
-- filter status='posted' and never see it) -- but it DOES reserve
-- settlement capacity so a second concurrent credit or payment cannot
-- consume the same dollars while this one's GL/finalize is still pending.
-- The ceiling calculation below therefore sums
-- customer_credit_memos.total_amount WHERE status IN ('draft','posted'),
-- not just 'posted' -- this is a WRITE-SAFETY formula, deliberately
-- different from every DISPLAY/REPORT formula in this codebase (which stay
-- posted-only, untouched by this phase). The value returned here is named
-- invoice_available_balance (not invoice_effective_balance) precisely so
-- callers can't accidentally display it as the customer's real financial
-- balance -- see finalize_customer_credit_memo() for the posted-only
-- invoice_effective_balance a caller should actually show the customer.
--
-- Idempotent-retry double-count (Part 9/15/37): when the same idempotency
-- key finds its OWN existing draft, that row is already one of the rows
-- the draft+posted SUM naturally includes -- the returned available
-- balance is computed as (total - net_payments - SUM(draft+posted)) with
-- no separate "- p_amount" term, because the existing row's own
-- total_amount is already inside that SUM exactly once. Subtracting
-- p_amount again on top would double-count it. The same non-double-
-- counting principle applies to the concurrent-race exception handler
-- below (fetches the winner's row, which is likewise already included in
-- any subsequent SUM once).
create or replace function public.record_customer_credit_memo(
  p_org_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_reason text,
  p_description text,
  p_credit_date date,
  p_idempotency_key text,
  p_created_by uuid default null
)
returns table (credit_memo_id uuid, credit_number text, status text, revenue_account_id uuid, invoice_available_balance numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_net_payments numeric(14,2);
  v_reserved_credits numeric(14,2);
  v_available_balance numeric(14,2);
  v_credit_id uuid;
  v_credit_number text;
  v_existing record;
  v_existing_revenue_account_id uuid;
  v_lines_total numeric(14,2);
  v_issued_entry_id uuid;
  v_revenue_account_id uuid;
  v_revenue_line_count int;
  v_constraint_name text;
begin
  if p_org_id is null then raise exception 'org_id is required'; end if;
  if p_invoice_id is null then raise exception 'invoice_id is required'; end if;
  if p_amount is null then raise exception 'amount is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required'; end if;
  if p_credit_date is null then raise exception 'credit_date is required'; end if;

  p_idempotency_key := btrim(p_idempotency_key);
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'idempotency_key is required';
  end if;

  p_amount := round(p_amount, 2);
  p_reason := btrim(p_reason);
  p_description := nullif(btrim(p_description), '');
  if p_amount <= 0 then raise exception 'amount must be a positive number'; end if;

  -- Parent row is the serialization point for every invoice settlement write.
  select i.* into v_invoice
    from public.invoices as i
   where i.id = p_invoice_id and i.org_id = p_org_id
   for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found for this org';
  end if;

  -- Re-check idempotency AFTER acquiring the parent lock. This is required
  -- for the race where two same-key calls both miss an earlier lookup and
  -- the second waits for the first on the invoice lock.
  select ccm.id, ccm.credit_number, ccm.invoice_id, ccm.total_amount,
         ccm.reason, ccm.description, ccm.credit_date, ccm.status
    into v_existing
    from public.customer_credit_memos as ccm
   where ccm.org_id = p_org_id and ccm.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.total_amount <> p_amount
       or v_existing.reason <> p_reason
       or v_existing.description is distinct from p_description
       or v_existing.credit_date <> p_credit_date
    then
      raise exception 'This request key was already used for a different credit memo request';
    end if;

    select ccml.revenue_account_id into v_existing_revenue_account_id
      from public.customer_credit_memo_lines as ccml
     where ccml.credit_memo_id = v_existing.id;

    select coalesce(sum(
      case when ip.reverses_payment_id is null then ip.amount else -ip.amount end
    ) filter (where ip.status = 'succeeded'), 0)
      into v_net_payments
      from public.invoice_payments as ip
     where ip.invoice_id = p_invoice_id;

    select coalesce(sum(ccm2.total_amount), 0)
      into v_reserved_credits
      from public.customer_credit_memos as ccm2
     where ccm2.invoice_id = p_invoice_id
       and ccm2.status in ('draft', 'posted');

    return query
      select v_existing.id,
             v_existing.credit_number,
             v_existing.status,
             v_existing_revenue_account_id,
             round(greatest(0, v_invoice.total_amount - v_net_payments - v_reserved_credits), 2);
    return;
  end if;

  if v_invoice.status in ('draft', 'cancelled') then
    raise exception 'Cannot credit a % invoice', v_invoice.status;
  end if;

  select coalesce(sum(
    case when ip.reverses_payment_id is null then ip.amount else -ip.amount end
  ) filter (where ip.status = 'succeeded'), 0)
    into v_net_payments
    from public.invoice_payments as ip
   where ip.invoice_id = p_invoice_id;

  -- Draft + posted credits reserve settlement capacity. Only posted credits
  -- affect accounting/reporting outside write-safety paths.
  select coalesce(sum(ccm.total_amount), 0)
    into v_reserved_credits
    from public.customer_credit_memos as ccm
   where ccm.invoice_id = p_invoice_id
     and ccm.status in ('draft', 'posted');

  v_available_balance := round(v_invoice.total_amount - v_reserved_credits - v_net_payments, 2);
  if v_available_balance <= 0 then
    raise exception 'This invoice has no remaining available balance to credit';
  end if;
  if p_amount > v_available_balance + 0.005 then
    raise exception 'Credit of % exceeds the invoice''s current available balance of %', p_amount, v_available_balance;
  end if;

  -- Fail closed: a customer credit requires the invoice's posted issued JE
  -- and the current single-revenue-line architecture.
  select je.id into v_issued_entry_id
    from public.accounting_journal_entries as je
   where je.org_id = p_org_id
     and je.source_type = 'invoice'
     and je.source_id = p_invoice_id
     and je.posting_key = 'issued'
     and je.status = 'posted';
  if v_issued_entry_id is null then
    raise exception 'Cannot create a credit memo -- invoice % has no posted issued journal entry; accounting must be posted before this invoice can be credited', p_invoice_id;
  end if;

  select count(*), min(jel.account_id)
    into v_revenue_line_count, v_revenue_account_id
    from public.accounting_journal_entry_lines as jel
   where jel.journal_entry_id = v_issued_entry_id
     and jel.credit > 0;
  if v_revenue_line_count <> 1 then
    raise exception 'Cannot derive a single revenue account for invoice % -- % revenue credit line(s) found on its issued entry (expected exactly 1); unsupported account allocation for this phase', p_invoice_id, v_revenue_line_count;
  end if;

  begin
    v_credit_number := public.next_financial_document_number(
      p_org_id, 'customer_credit_memo', 'CM', p_credit_date
    );

    insert into public.customer_credit_memos (
      org_id, invoice_id, project_id, contact_id, credit_number, credit_date,
      reason, description, subtotal, tax_amount, total_amount, status,
      created_by, idempotency_key
    ) values (
      p_org_id, p_invoice_id, v_invoice.project_id, v_invoice.client_id,
      v_credit_number, p_credit_date, p_reason, p_description,
      p_amount, 0, p_amount, 'draft', p_created_by, p_idempotency_key
    )
    returning id into v_credit_id;

    insert into public.customer_credit_memo_lines (
      org_id, credit_memo_id, description, amount, revenue_account_id,
      project_id, contact_id
    ) values (
      p_org_id, v_credit_id, coalesce(p_description, p_reason), p_amount,
      v_revenue_account_id, v_invoice.project_id, v_invoice.client_id
    );

    select coalesce(sum(ccml.amount), 0)
      into v_lines_total
      from public.customer_credit_memo_lines as ccml
     where ccml.credit_memo_id = v_credit_id;
    if v_lines_total <> p_amount then
      raise exception 'Credit memo line total (%) does not match the requested amount (%)', v_lines_total, p_amount;
    end if;

    update public.customer_credit_memos as ccm
       set subtotal = v_lines_total,
           total_amount = v_lines_total
     where ccm.id = v_credit_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = CONSTRAINT_NAME;
    if v_constraint_name = 'uq_customer_credit_memos_org_idempotency' then
      select ccm.id, ccm.credit_number, ccm.invoice_id, ccm.total_amount,
             ccm.reason, ccm.description, ccm.credit_date, ccm.status
        into v_existing
        from public.customer_credit_memos as ccm
       where ccm.org_id = p_org_id
         and ccm.idempotency_key = p_idempotency_key;

      if v_existing.id is null
         or v_existing.invoice_id <> p_invoice_id
         or v_existing.total_amount <> p_amount
         or v_existing.reason <> p_reason
         or v_existing.description is distinct from p_description
         or v_existing.credit_date <> p_credit_date
      then
        raise exception 'This request key was already used for a different credit memo request';
      end if;

      select ccml.revenue_account_id into v_existing_revenue_account_id
        from public.customer_credit_memo_lines as ccml
       where ccml.credit_memo_id = v_existing.id;

      select coalesce(sum(
        case when ip.reverses_payment_id is null then ip.amount else -ip.amount end
      ) filter (where ip.status = 'succeeded'), 0)
        into v_net_payments
        from public.invoice_payments as ip
       where ip.invoice_id = p_invoice_id;

      select coalesce(sum(ccm2.total_amount), 0)
        into v_reserved_credits
        from public.customer_credit_memos as ccm2
       where ccm2.invoice_id = p_invoice_id
         and ccm2.status in ('draft', 'posted');

      return query
        select v_existing.id,
               v_existing.credit_number,
               v_existing.status,
               v_existing_revenue_account_id,
               round(greatest(0, v_invoice.total_amount - v_net_payments - v_reserved_credits), 2);
      return;
    end if;
    raise;
  end;

  return query
    select v_credit_id,
           v_credit_number,
           'draft'::text,
           v_revenue_account_id,
           round(greatest(0, v_available_balance - p_amount), 2);
end;
$$;

revoke all on function public.record_customer_credit_memo(uuid, uuid, numeric, text, text, date, text, uuid) from public, anon, authenticated;
grant execute on function public.record_customer_credit_memo(uuid, uuid, numeric, text, text, date, text, uuid) to service_role;

-- Part 4/21/22/25/26 -- the ONLY way a customer credit memo can transition
-- draft -> posted. Never called directly by anything but the Netlify
-- layer, and only ever after post_journal_entry() has actually succeeded
-- for this memo's (source_type='credit_memo', source_id,
-- posting_key='posted') identity. Phase 13.10C strengthens this from an
-- identity-only check (JE row exists) to a CONTENT check: the JE must have
-- exactly the expected two-line shape (Dr the memo's own revenue account
-- for the full total, Cr the canonical A/R account for the full total, no
-- other nonzero lines) -- this is the accounting-integrity boundary, so it
-- must prove the actual ledger effect, not just that some JE row with a
-- matching identity happened to get inserted. The A/R account is resolved
-- by its well-known Chart-of-Accounts code ('1100'), the exact same
-- canonical lookup netlify/lib/accounting.ts's resolveSystemAccounts()
-- uses -- never a hardcoded UUID.
--
-- Part 26 -- content verification runs UNCONDITIONALLY, even when the memo
-- is already 'posted' (idempotent repeat call) -- posted journal entries
-- are immutable, so re-checking is cheap, and it protects against the
-- pathological case of a posted memo whose backing JE was somehow deleted/
-- corrupted (should never happen given post_journal_entry()'s own
-- immutability guarantees, but this function is the integrity boundary and
-- must not blindly trust its own past success).
create or replace function public.finalize_customer_credit_memo(
  p_org_id uuid,
  p_credit_memo_id uuid,
  p_created_by uuid default null
)
returns table (credit_memo_id uuid, credit_number text, status text, invoice_effective_balance numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_memo record;
  v_credit_line_count int;
  v_lines_total numeric(14,2);
  v_je_id uuid;
  v_ar_account_id uuid;
  v_ar_account_count int;
  v_revenue_account_id uuid;
  v_line_count int;
  v_total_debit numeric(14,2);
  v_total_credit numeric(14,2);
  v_net_payments numeric(14,2);
  v_posted_credits numeric(14,2);
  v_invoice_total numeric(14,2);
begin
  if p_org_id is null then raise exception 'org_id is required'; end if;
  if p_credit_memo_id is null then raise exception 'credit_memo_id is required'; end if;

  select ccm.* into v_memo
    from public.customer_credit_memos as ccm
   where ccm.id = p_credit_memo_id and ccm.org_id = p_org_id
   for update;
  if v_memo.id is null then
    raise exception 'Credit memo not found for this org';
  end if;
  if v_memo.status not in ('draft', 'posted') then
    raise exception 'Cannot finalize a % credit memo', v_memo.status;
  end if;

  select count(*), coalesce(sum(ccml.amount), 0), min(ccml.revenue_account_id)
    into v_credit_line_count, v_lines_total, v_revenue_account_id
    from public.customer_credit_memo_lines as ccml
   where ccml.credit_memo_id = p_credit_memo_id;
  if v_credit_line_count <> 1 then
    raise exception 'Credit memo % must have exactly one line in this phase; found %', coalesce(v_memo.credit_number, p_credit_memo_id::text), v_credit_line_count;
  end if;
  if v_lines_total <> v_memo.total_amount or v_lines_total <= 0 then
    raise exception 'Credit memo line total (%) does not match parent total (%) -- cannot finalize', v_lines_total, v_memo.total_amount;
  end if;

  select count(*), min(aa.id)
    into v_ar_account_count, v_ar_account_id
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '1100'
     and aa.is_active = true;
  if v_ar_account_count <> 1 then
    raise exception 'Org % must have exactly one active Accounts Receivable account (code 1100); found %', p_org_id, v_ar_account_count;
  end if;

  select je.id into v_je_id
    from public.accounting_journal_entries as je
   where je.org_id = p_org_id
     and je.source_type = 'credit_memo'
     and je.source_id = p_credit_memo_id
     and je.posting_key = 'posted'
     and je.status = 'posted';
  if v_je_id is null then
    raise exception 'Cannot finalize credit memo % -- no posted journal entry found; post accounting first', coalesce(v_memo.credit_number, p_credit_memo_id::text);
  end if;

  select count(*), coalesce(sum(jel.debit), 0), coalesce(sum(jel.credit), 0)
    into v_line_count, v_total_debit, v_total_credit
    from public.accounting_journal_entry_lines as jel
   where jel.journal_entry_id = v_je_id
     and (jel.debit > 0 or jel.credit > 0);
  if v_line_count <> 2
     or v_total_debit <> v_memo.total_amount
     or v_total_credit <> v_memo.total_amount
  then
    raise exception 'Credit memo % journal entry does not match the expected two-line, %-total shape -- refusing to finalize', coalesce(v_memo.credit_number, p_credit_memo_id::text), v_memo.total_amount;
  end if;

  if not exists (
    select 1
      from public.accounting_journal_entry_lines as jel
     where jel.journal_entry_id = v_je_id
       and jel.account_id = v_revenue_account_id
       and jel.debit = v_memo.total_amount
       and jel.credit = 0
  ) then
    raise exception 'Credit memo % journal entry is missing the expected revenue debit line -- refusing to finalize', coalesce(v_memo.credit_number, p_credit_memo_id::text);
  end if;

  if not exists (
    select 1
      from public.accounting_journal_entry_lines as jel
     where jel.journal_entry_id = v_je_id
       and jel.account_id = v_ar_account_id
       and jel.credit = v_memo.total_amount
       and jel.debit = 0
  ) then
    raise exception 'Credit memo % journal entry is missing the expected Accounts Receivable credit line -- refusing to finalize', coalesce(v_memo.credit_number, p_credit_memo_id::text);
  end if;

  if v_memo.status = 'draft' then
    update public.customer_credit_memos as ccm
       set status = 'posted', posted_at = now()
     where ccm.id = p_credit_memo_id;
  end if;

  select coalesce(sum(
    case when ip.reverses_payment_id is null then ip.amount else -ip.amount end
  ) filter (where ip.status = 'succeeded'), 0)
    into v_net_payments
    from public.invoice_payments as ip
   where ip.invoice_id = v_memo.invoice_id;

  select coalesce(sum(ccm2.total_amount), 0)
    into v_posted_credits
    from public.customer_credit_memos as ccm2
   where ccm2.invoice_id = v_memo.invoice_id
     and ccm2.status = 'posted';

  select i.total_amount into v_invoice_total
    from public.invoices as i
   where i.id = v_memo.invoice_id and i.org_id = p_org_id;

  return query
    select v_memo.id,
           v_memo.credit_number,
           'posted'::text,
           round(greatest(0, coalesce(v_invoice_total, 0) - v_posted_credits - v_net_payments), 2);
end;
$$;

revoke all on function public.finalize_customer_credit_memo(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_customer_credit_memo(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 7. VENDOR_CREDITS + VENDOR_CREDIT_LINES
-- ============================================================================
--
-- Uses the existing canonical `vendors` table (company_id/contact_id) --
-- no duplicate vendor identity fields (Part 23). Account allocation is
-- always one of the original bill's OWN line accounts, validated server-
-- side (netlify function) against vendor_bill_lines -- never a free choice
-- from the whole chart of accounts.

create table if not exists public.vendor_credits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,

  vendor_id uuid not null references public.vendors(id) on delete restrict,
  vendor_bill_id uuid not null references public.vendor_bills(id) on delete restrict,
  project_id uuid null references public.projects(id) on delete restrict,

  credit_number text null,
  credit_date date not null,
  reason text not null,
  -- Phase 13.10B, Part 6 -- see the equivalent column on
  -- customer_credit_memos for why this is stored separately from the line
  -- description.
  description text null,

  subtotal numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  currency text not null default 'usd',

  status text not null default 'draft',
  posted_at timestamptz null,
  -- Phase 13.10C, Part 19/47 -- NOT NULL, same reasoning as
  -- customer_credit_memos.idempotency_key above.
  idempotency_key text not null,

  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vendor_credits_status_check check (status in ('draft', 'posted', 'reversed')),
  constraint vendor_credits_amounts_nonneg check (subtotal >= 0 and total_amount >= 0),
  constraint vendor_credits_total_positive_when_posted check (status = 'draft' or total_amount > 0),
  constraint vendor_credits_reason_not_blank check (btrim(reason) <> ''),
  constraint vendor_credits_idempotency_key_not_blank check (btrim(idempotency_key) <> ''),
  constraint vendor_credits_currency_usd_only check (currency = 'usd')
);

create unique index if not exists uq_vendor_credits_org_number
  on public.vendor_credits (org_id, credit_number) where credit_number is not null;
-- Phase 13.10A/C, Part 8/20 -- idempotency backstop, same shape as
-- uq_customer_credit_memos_org_idempotency above. Plain unique index (not
-- partial) now that idempotency_key is NOT NULL.
create unique index if not exists uq_vendor_credits_org_idempotency
  on public.vendor_credits (org_id, idempotency_key);
create index if not exists idx_vendor_credits_bill on public.vendor_credits (vendor_bill_id);
create index if not exists idx_vendor_credits_org_status on public.vendor_credits (org_id, status);

create or replace function public.set_vendor_credits_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_vendor_credits_updated_at on public.vendor_credits;
create trigger trg_vendor_credits_updated_at
  before update on public.vendor_credits
  for each row execute function public.set_vendor_credits_updated_at();

create or replace function public.validate_vendor_credit_dimensions()
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
    raise exception 'vendor_credits.org_id must match the bill''s org_id';
  end if;
  if new.vendor_id <> v_bill_vendor then
    raise exception 'vendor_credits.vendor_id must match the bill''s vendor_id';
  end if;
  if new.project_id is distinct from v_bill_project then
    raise exception 'vendor_credits.project_id must match the bill''s project_id';
  end if;
  -- Part 22 -- eligible bill statuses only.
  if v_bill_status not in ('open', 'partial', 'overdue') then
    raise exception 'Cannot credit a % vendor bill', v_bill_status;
  end if;

  select org_id into v_vendor_org from public.vendors where id = new.vendor_id;
  if v_vendor_org is null or v_vendor_org <> new.org_id then
    raise exception 'vendor_credits.vendor_id must belong to the same org';
  end if;
  if new.project_id is not null then
    select org_id into v_project_org from public.projects where id = new.project_id;
    if v_project_org is null or v_project_org <> new.org_id then
      raise exception 'vendor_credits.project_id must belong to the same org';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_credit_dimensions on public.vendor_credits;
create trigger trg_validate_vendor_credit_dimensions
  before insert or update on public.vendor_credits
  for each row execute function public.validate_vendor_credit_dimensions();

revoke all on function public.validate_vendor_credit_dimensions() from public, anon, authenticated;

create or replace function public.enforce_vendor_credit_immutability()
returns trigger language plpgsql as $$
begin
  if old.status in ('posted', 'reversed') then
    raise exception 'Posted vendor credits cannot be modified';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_vendor_credit_immutability on public.vendor_credits;
create trigger trg_enforce_vendor_credit_immutability
  before update on public.vendor_credits
  for each row execute function public.enforce_vendor_credit_immutability();

create or replace function public.prevent_posted_vendor_credit_delete()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'Only a draft vendor credit can be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_posted_vendor_credit_delete on public.vendor_credits;
create trigger trg_prevent_posted_vendor_credit_delete
  before delete on public.vendor_credits
  for each row execute function public.prevent_posted_vendor_credit_delete();

revoke all on function public.prevent_posted_vendor_credit_delete() from public, anon, authenticated;

alter table public.vendor_credits enable row level security;

drop policy if exists vendor_credits_select on public.vendor_credits;
create policy vendor_credits_select on public.vendor_credits
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.vendor_credits from anon, authenticated;
grant select on public.vendor_credits to authenticated;
grant select, insert, update, delete on public.vendor_credits to service_role;

create table if not exists public.vendor_credit_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  vendor_credit_id uuid not null references public.vendor_credits(id) on delete cascade,

  description text not null,
  amount numeric(14,2) not null,
  account_id uuid not null references public.accounting_accounts(id),
  project_id uuid null references public.projects(id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint vendor_credit_lines_amount_positive check (amount > 0),
  constraint vendor_credit_lines_description_not_blank check (btrim(description) <> '')
);

create index if not exists idx_vendor_credit_lines_credit on public.vendor_credit_lines (vendor_credit_id);

-- Phase 13.10A, Part 21 -- account_id must be one of the ORIGINAL bill's
-- own line accounts, verified at the DB layer (not just the Netlify
-- endpoint's pre-check) -- a service-role RPC still deserves its own
-- invariant protection. Also now draft-gated (Part 5), same shape as the
-- customer credit memo line trigger above.
create or replace function public.validate_vendor_credit_line_dimensions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_credit_org uuid;
  v_credit_status text;
  v_credit_bill_id uuid;
  v_account_org uuid;
  v_account_type text;
  v_account_on_bill boolean;
begin
  select org_id, status, vendor_bill_id into v_credit_org, v_credit_status, v_credit_bill_id
    from public.vendor_credits where id = new.vendor_credit_id;
  if v_credit_org is null then
    raise exception 'vendor_credit_id does not reference an existing vendor credit';
  end if;
  if v_credit_org <> new.org_id then
    raise exception 'vendor_credit_lines.org_id must match its credit''s org_id';
  end if;
  if v_credit_status <> 'draft' then
    raise exception 'Cannot add/modify lines on a % vendor credit -- only draft credits are editable', v_credit_status;
  end if;

  select org_id, account_type into v_account_org, v_account_type
    from public.accounting_accounts where id = new.account_id;
  if v_account_org is null then
    raise exception 'account_id does not reference an existing accounting account';
  end if;
  if v_account_org <> new.org_id then
    raise exception 'vendor_credit_lines.account_id must belong to the same org';
  end if;
  if v_account_type <> 'expense' then
    raise exception 'vendor_credit_lines.account_id must be an expense/COGS account, not a % account', v_account_type;
  end if;

  select exists(
    select 1 from public.vendor_bill_lines as vbl
    where vbl.vendor_bill_id = v_credit_bill_id and vbl.account_id = new.account_id
  ) into v_account_on_bill;
  if not v_account_on_bill then
    raise exception 'vendor_credit_lines.account_id must be one of the original bill''s own line accounts';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_vendor_credit_line_dimensions on public.vendor_credit_lines;
create trigger trg_validate_vendor_credit_line_dimensions
  before insert or update on public.vendor_credit_lines
  for each row execute function public.validate_vendor_credit_line_dimensions();

revoke all on function public.validate_vendor_credit_line_dimensions() from public, anon, authenticated;

-- Part 5 -- once the parent credit leaves 'draft', its lines are fully
-- frozen (delete path -- insert/update are already blocked above by the
-- draft-status check in validate_vendor_credit_line_dimensions()).
create or replace function public.prevent_non_draft_vendor_credit_line_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from public.vendor_credits where id = old.vendor_credit_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Cannot delete a line from a % vendor credit', v_status;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_non_draft_vendor_credit_line_delete on public.vendor_credit_lines;
create trigger trg_prevent_non_draft_vendor_credit_line_delete
  before delete on public.vendor_credit_lines
  for each row execute function public.prevent_non_draft_vendor_credit_line_delete();

revoke all on function public.prevent_non_draft_vendor_credit_line_delete() from public, anon, authenticated;

alter table public.vendor_credit_lines enable row level security;

drop policy if exists vendor_credit_lines_select on public.vendor_credit_lines;
create policy vendor_credit_lines_select on public.vendor_credit_lines
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.vendor_credit_lines from anon, authenticated;
grant select on public.vendor_credit_lines to authenticated;
grant select, insert, update, delete on public.vendor_credit_lines to service_role;

-- ============================================================================
-- 8. record_vendor_credit() + finalize_vendor_credit()
-- ============================================================================
--
-- Phase 13.10B rewrite (Part 1/2/3/4) -- same prepare/finalize split as
-- record_customer_credit_memo()/finalize_customer_credit_memo() above, for
-- the exact same reason (a vendor credit must never become financially
-- effective in A/P before its journal entry exists). Locks the vendor_bill
-- FIRST (matching record_vendor_payment()'s and record_vendor_payment_
-- reversal()'s own lock ordering -- Part 40: never a reverse lock order
-- relative to existing functions). p_account_id IS kept as a caller
-- parameter here (unlike the customer credit memo's revenue account) --
-- Part 12 explicitly allows the UI to choose among the original bill's own
-- multiple line accounts when more than one exists, so it cannot be
-- uniquely derived the way a single-revenue-account invoice can; DB-level
-- enforcement (validate_vendor_credit_line_dimensions) still requires it
-- to be one of the bill's own accounts, never an arbitrary COA choice.
-- Phase 13.10C, Part 3/9/10/18/20 -- same reserved-vs-effective distinction
-- as record_customer_credit_memo() above: the ceiling here sums
-- vendor_credits.total_amount WHERE status IN ('draft','posted') (write-
-- safety reservation), not just 'posted' (financial/reporting effect,
-- unchanged everywhere else). Returns bill_available_balance, not
-- bill_effective_balance -- see finalize_vendor_credit() for the
-- posted-only value. Idempotency key is now mandatory (Part 19/20,
-- normalized via btrim before use). Same no-double-count principle on a
-- same-key retry/race as the customer version -- see that function's
-- header comment for the full reasoning, not repeated here.
create or replace function public.record_vendor_credit(
  p_org_id uuid,
  p_vendor_bill_id uuid,
  p_amount numeric,
  p_reason text,
  p_description text,
  p_account_id uuid,
  p_credit_date date,
  p_idempotency_key text,
  p_created_by uuid default null
)
returns table (vendor_credit_id uuid, credit_number text, status text, bill_available_balance numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bill record;
  v_net_payments numeric(14,2);
  v_reserved_credits numeric(14,2);
  v_available_balance numeric(14,2);
  v_credit_id uuid;
  v_credit_number text;
  v_existing record;
  v_lines_total numeric(14,2);
  v_constraint_name text;
begin
  if p_org_id is null then raise exception 'org_id is required'; end if;
  if p_vendor_bill_id is null then raise exception 'vendor_bill_id is required'; end if;
  if p_amount is null then raise exception 'amount is required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required'; end if;
  if p_account_id is null then raise exception 'account_id is required'; end if;
  if p_credit_date is null then raise exception 'credit_date is required'; end if;

  p_idempotency_key := btrim(p_idempotency_key);
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'idempotency_key is required';
  end if;

  p_amount := round(p_amount, 2);
  p_reason := btrim(p_reason);
  p_description := nullif(btrim(p_description), '');
  if p_amount <= 0 then raise exception 'amount must be a positive number'; end if;

  -- Parent row serializes every settlement write against this bill.
  select vb.* into v_bill
    from public.vendor_bills as vb
   where vb.id = p_vendor_bill_id and vb.org_id = p_org_id
   for update;
  if v_bill.id is null then
    raise exception 'Bill not found for this org';
  end if;

  -- Post-lock idempotency re-check closes the same-key retry race.
  select vc.id, vc.credit_number, vc.vendor_bill_id, vc.total_amount,
         vc.reason, vc.description, vc.credit_date, vc.status
    into v_existing
    from public.vendor_credits as vc
   where vc.org_id = p_org_id and vc.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.vendor_bill_id <> p_vendor_bill_id
       or v_existing.total_amount <> p_amount
       or v_existing.reason <> p_reason
       or v_existing.description is distinct from p_description
       or v_existing.credit_date <> p_credit_date
       or not exists (
         select 1
           from public.vendor_credit_lines as vcl
          where vcl.vendor_credit_id = v_existing.id
            and vcl.account_id = p_account_id
       )
    then
      raise exception 'This request key was already used for a different vendor credit request';
    end if;

    select coalesce(sum(
      case when vp.reverses_payment_id is null then vp.amount else -vp.amount end
    ) filter (where vp.status = 'succeeded'), 0)
      into v_net_payments
      from public.vendor_payments as vp
     where vp.vendor_bill_id = p_vendor_bill_id;

    select coalesce(sum(vc2.total_amount), 0)
      into v_reserved_credits
      from public.vendor_credits as vc2
     where vc2.vendor_bill_id = p_vendor_bill_id
       and vc2.status in ('draft', 'posted');

    return query
      select v_existing.id,
             v_existing.credit_number,
             v_existing.status,
             round(greatest(0, v_bill.total_amount - v_net_payments - v_reserved_credits), 2);
    return;
  end if;

  if v_bill.status not in ('open', 'partial', 'overdue') then
    raise exception 'Cannot credit a % vendor bill', v_bill.status;
  end if;

  if not exists (
    select 1
      from public.vendor_bill_lines as vbl
     where vbl.vendor_bill_id = p_vendor_bill_id
       and vbl.account_id = p_account_id
  ) then
    raise exception 'account_id must be one of this bill''s own line accounts';
  end if;

  select coalesce(sum(
    case when vp.reverses_payment_id is null then vp.amount else -vp.amount end
  ) filter (where vp.status = 'succeeded'), 0)
    into v_net_payments
    from public.vendor_payments as vp
   where vp.vendor_bill_id = p_vendor_bill_id;

  select coalesce(sum(vc.total_amount), 0)
    into v_reserved_credits
    from public.vendor_credits as vc
   where vc.vendor_bill_id = p_vendor_bill_id
     and vc.status in ('draft', 'posted');

  v_available_balance := round(v_bill.total_amount - v_reserved_credits - v_net_payments, 2);
  if v_available_balance <= 0 then
    raise exception 'This bill has no remaining available balance to credit';
  end if;
  if p_amount > v_available_balance + 0.005 then
    raise exception 'Credit of % exceeds the bill''s current available balance of %', p_amount, v_available_balance;
  end if;

  begin
    v_credit_number := public.next_financial_document_number(
      p_org_id, 'vendor_credit', 'VC', p_credit_date
    );

    insert into public.vendor_credits (
      org_id, vendor_id, vendor_bill_id, project_id, credit_number,
      credit_date, reason, description, subtotal, total_amount, status,
      created_by, idempotency_key
    ) values (
      p_org_id, v_bill.vendor_id, p_vendor_bill_id, v_bill.project_id,
      v_credit_number, p_credit_date, p_reason, p_description,
      p_amount, p_amount, 'draft', p_created_by, p_idempotency_key
    )
    returning id into v_credit_id;

    insert into public.vendor_credit_lines (
      org_id, vendor_credit_id, description, amount, account_id, project_id
    ) values (
      p_org_id, v_credit_id, coalesce(p_description, p_reason), p_amount,
      p_account_id, v_bill.project_id
    );

    select coalesce(sum(vcl.amount), 0)
      into v_lines_total
      from public.vendor_credit_lines as vcl
     where vcl.vendor_credit_id = v_credit_id;
    if v_lines_total <> p_amount then
      raise exception 'Vendor credit line total (%) does not match the requested amount (%)', v_lines_total, p_amount;
    end if;

    update public.vendor_credits as vc
       set subtotal = v_lines_total,
           total_amount = v_lines_total
     where vc.id = v_credit_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = CONSTRAINT_NAME;
    if v_constraint_name = 'uq_vendor_credits_org_idempotency' then
      select vc.id, vc.credit_number, vc.vendor_bill_id, vc.total_amount,
             vc.reason, vc.description, vc.credit_date, vc.status
        into v_existing
        from public.vendor_credits as vc
       where vc.org_id = p_org_id
         and vc.idempotency_key = p_idempotency_key;

      if v_existing.id is null
         or v_existing.vendor_bill_id <> p_vendor_bill_id
         or v_existing.total_amount <> p_amount
         or v_existing.reason <> p_reason
         or v_existing.description is distinct from p_description
         or v_existing.credit_date <> p_credit_date
         or not exists (
           select 1
             from public.vendor_credit_lines as vcl
            where vcl.vendor_credit_id = v_existing.id
              and vcl.account_id = p_account_id
         )
      then
        raise exception 'This request key was already used for a different vendor credit request';
      end if;

      select coalesce(sum(
        case when vp.reverses_payment_id is null then vp.amount else -vp.amount end
      ) filter (where vp.status = 'succeeded'), 0)
        into v_net_payments
        from public.vendor_payments as vp
       where vp.vendor_bill_id = p_vendor_bill_id;

      select coalesce(sum(vc2.total_amount), 0)
        into v_reserved_credits
        from public.vendor_credits as vc2
       where vc2.vendor_bill_id = p_vendor_bill_id
         and vc2.status in ('draft', 'posted');

      return query
        select v_existing.id,
               v_existing.credit_number,
               v_existing.status,
               round(greatest(0, v_bill.total_amount - v_net_payments - v_reserved_credits), 2);
      return;
    end if;
    raise;
  end;

  return query
    select v_credit_id,
           v_credit_number,
           'draft'::text,
           round(greatest(0, v_available_balance - p_amount), 2);
end;
$$;

revoke all on function public.record_vendor_credit(uuid, uuid, numeric, text, text, uuid, date, text, uuid) from public, anon, authenticated;
grant execute on function public.record_vendor_credit(uuid, uuid, numeric, text, text, uuid, date, text, uuid) to service_role;

-- Part 4/23/24/25/26 -- the ONLY way a vendor credit can transition draft
-- -> posted. Mirrors finalize_customer_credit_memo() exactly, including
-- exact two-line JE content verification (Dr canonical A/P for the full
-- total, Cr the credit's own selected bill-line account for the full
-- total) instead of only checking JE identity/existence. The A/P account
-- is resolved by its well-known code ('2000'), the same canonical lookup
-- resolveSystemAccounts() uses -- never hardcoded. Content is re-verified
-- even on an idempotent already-posted repeat call (Part 26).
create or replace function public.finalize_vendor_credit(
  p_org_id uuid,
  p_vendor_credit_id uuid,
  p_created_by uuid default null
)
returns table (vendor_credit_id uuid, credit_number text, status text, bill_effective_balance numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_credit record;
  v_credit_line_count int;
  v_lines_total numeric(14,2);
  v_credit_account_id uuid;
  v_je_id uuid;
  v_ap_account_id uuid;
  v_ap_account_count int;
  v_line_count int;
  v_total_debit numeric(14,2);
  v_total_credit numeric(14,2);
  v_net_payments numeric(14,2);
  v_posted_credits numeric(14,2);
  v_bill_total numeric(14,2);
begin
  if p_org_id is null then raise exception 'org_id is required'; end if;
  if p_vendor_credit_id is null then raise exception 'vendor_credit_id is required'; end if;

  select vc.* into v_credit
    from public.vendor_credits as vc
   where vc.id = p_vendor_credit_id and vc.org_id = p_org_id
   for update;
  if v_credit.id is null then
    raise exception 'Vendor credit not found for this org';
  end if;
  if v_credit.status not in ('draft', 'posted') then
    raise exception 'Cannot finalize a % vendor credit', v_credit.status;
  end if;

  select count(*), coalesce(sum(vcl.amount), 0), min(vcl.account_id)
    into v_credit_line_count, v_lines_total, v_credit_account_id
    from public.vendor_credit_lines as vcl
   where vcl.vendor_credit_id = p_vendor_credit_id;
  if v_credit_line_count <> 1 then
    raise exception 'Vendor credit % must have exactly one line in this phase; found %', coalesce(v_credit.credit_number, p_vendor_credit_id::text), v_credit_line_count;
  end if;
  if v_lines_total <> v_credit.total_amount or v_lines_total <= 0 then
    raise exception 'Vendor credit line total (%) does not match parent total (%) -- cannot finalize', v_lines_total, v_credit.total_amount;
  end if;

  select count(*), min(aa.id)
    into v_ap_account_count, v_ap_account_id
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '2000'
     and aa.is_active = true;
  if v_ap_account_count <> 1 then
    raise exception 'Org % must have exactly one active Accounts Payable account (code 2000); found %', p_org_id, v_ap_account_count;
  end if;

  select je.id into v_je_id
    from public.accounting_journal_entries as je
   where je.org_id = p_org_id
     and je.source_type = 'vendor_credit'
     and je.source_id = p_vendor_credit_id
     and je.posting_key = 'posted'
     and je.status = 'posted';
  if v_je_id is null then
    raise exception 'Cannot finalize vendor credit % -- no posted journal entry found; post accounting first', coalesce(v_credit.credit_number, p_vendor_credit_id::text);
  end if;

  select count(*), coalesce(sum(jel.debit), 0), coalesce(sum(jel.credit), 0)
    into v_line_count, v_total_debit, v_total_credit
    from public.accounting_journal_entry_lines as jel
   where jel.journal_entry_id = v_je_id
     and (jel.debit > 0 or jel.credit > 0);
  if v_line_count <> 2
     or v_total_debit <> v_credit.total_amount
     or v_total_credit <> v_credit.total_amount
  then
    raise exception 'Vendor credit % journal entry does not match the expected two-line, %-total shape -- refusing to finalize', coalesce(v_credit.credit_number, p_vendor_credit_id::text), v_credit.total_amount;
  end if;

  if not exists (
    select 1
      from public.accounting_journal_entry_lines as jel
     where jel.journal_entry_id = v_je_id
       and jel.account_id = v_ap_account_id
       and jel.debit = v_credit.total_amount
       and jel.credit = 0
  ) then
    raise exception 'Vendor credit % journal entry is missing the expected Accounts Payable debit line -- refusing to finalize', coalesce(v_credit.credit_number, p_vendor_credit_id::text);
  end if;

  if not exists (
    select 1
      from public.accounting_journal_entry_lines as jel
     where jel.journal_entry_id = v_je_id
       and jel.account_id = v_credit_account_id
       and jel.credit = v_credit.total_amount
       and jel.debit = 0
  ) then
    raise exception 'Vendor credit % journal entry is missing the expected expense/COGS credit line -- refusing to finalize', coalesce(v_credit.credit_number, p_vendor_credit_id::text);
  end if;

  if v_credit.status = 'draft' then
    update public.vendor_credits as vc
       set status = 'posted', posted_at = now()
     where vc.id = p_vendor_credit_id;
  end if;

  select coalesce(sum(
    case when vp.reverses_payment_id is null then vp.amount else -vp.amount end
  ) filter (where vp.status = 'succeeded'), 0)
    into v_net_payments
    from public.vendor_payments as vp
   where vp.vendor_bill_id = v_credit.vendor_bill_id;

  select coalesce(sum(vc2.total_amount), 0)
    into v_posted_credits
    from public.vendor_credits as vc2
   where vc2.vendor_bill_id = v_credit.vendor_bill_id
     and vc2.status = 'posted';

  select vb.total_amount into v_bill_total
    from public.vendor_bills as vb
   where vb.id = v_credit.vendor_bill_id and vb.org_id = p_org_id;

  return query
    select v_credit.id,
           v_credit.credit_number,
           'posted'::text,
           round(greatest(0, coalesce(v_bill_total, 0) - v_posted_credits - v_net_payments), 2);
end;
$$;

revoke all on function public.finalize_vendor_credit(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_vendor_credit(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 9. record_vendor_payment() -- extended to be credit-aware (Part 10)
-- ============================================================================
--
-- Phase 13.10A, Part 10 -- CRITICAL FIX. Once vendor_credits exist, the
-- overpayment guard's remaining-balance calculation must also subtract
-- credits, or a bill with a $50 credit against a $200 total would still
-- accept a full $200 payment. Minimal-diff re-declaration of
-- record_vendor_payment() (20260822, hardened again in 20260823/20260824,
-- all already applied) -- every line is unchanged except v_remaining now
-- also subtracts vendor_credits, computed under the SAME bill lock this
-- function already takes (so a concurrent record_vendor_credit() call
-- against the same bill -- which also locks the bill first -- can never
-- race with this calculation; Part 40's lock ordering is preserved
-- unchanged).
--
-- Phase 13.10C, Part 3/5/12 -- CRITICAL FIX. v_credits now sums
-- vendor_credits.total_amount WHERE status IN ('draft','posted'), not just
-- 'posted' -- a draft vendor credit (GL posting pending, or simply not yet
-- finalized) must still reserve its amount so this payment can't oversettle
-- the bill out from under it. This is a WRITE-SAFETY ceiling only -- the
-- bill's DISPLAYED balance/A-P aging/reports remain posted-credits-only,
-- unchanged, computed elsewhere (src/lib/vendors.ts).
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
  v_credits numeric(14,2);
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

  select vb.* into v_bill from public.vendor_bills as vb
    where vb.id = p_vendor_bill_id and vb.org_id = p_org_id
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
  if v_bill.status = 'reversed' then
    raise exception 'This bill has been reversed and can no longer be paid';
  end if;
  if v_bill.status = 'paid' then
    raise exception 'This bill is already fully paid';
  end if;

  select coalesce(sum(case when vp.reverses_payment_id is null then vp.amount else -vp.amount end) filter (where vp.status = 'succeeded'), 0)
    into v_paid
    from public.vendor_payments as vp where vp.vendor_bill_id = p_vendor_bill_id;

  select coalesce(sum(vc.total_amount), 0) into v_credits
    from public.vendor_credits as vc where vc.vendor_bill_id = p_vendor_bill_id and vc.status in ('draft', 'posted');

  v_remaining := round(v_bill.total_amount - v_paid - v_credits, 2);
  if v_remaining <= 0 then
    raise exception 'This bill has no remaining available balance';
  end if;
  if p_amount > v_remaining + 0.005 then
    raise exception 'Payment of % exceeds the available balance of %', p_amount, v_remaining;
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

  select vb.status, vb.amount_paid into v_bill.status, v_bill.amount_paid
    from public.vendor_bills as vb where vb.id = p_vendor_bill_id;

  return query select v_payment_id, v_bill.status, v_bill.amount_paid;
end;
$$;

-- Signature is unchanged from 20260822/20260823 -- grants already exist and
-- remain valid; no revoke/grant re-statement needed.

-- ============================================================================
-- 10. record_invoice_payment() -- race-safe manual customer payment RPC
-- ============================================================================
--
-- Phase 13.10B, Part 14/15/16/17 -- CRITICAL FIX. invoice-record-payment.ts
-- previously performed its remaining-balance check in application code with
-- no invoice-row lock at all -- two concurrent requests could both read the
-- same pre-payment balance and both be accepted, overpaying the invoice.
-- This RPC is the new canonical authority, mirroring record_vendor_
-- payment()'s own shape exactly: locks the invoice FIRST (Part 16 -- same
-- lock order as record_invoice_payment_reversal() and record_customer_
-- credit_memo(), so no two functions touching invoices ever lock in a
-- different order relative to each other), recomputes credits and net
-- effective payments UNDER that lock, and only then computes/enforces the
-- ceiling. The Netlify endpoint's own pre-check becomes advisory only (a
-- nicer error message before the round trip) -- this RPC is final.
--
-- Phase 13.10C, Part 14/16/17 -- CRITICAL FIX to the now() idempotency bug.
-- p_paid_at previously defaulted to `now()` and every internal comparison
-- used `coalesce(p_paid_at, now())` -- if the endpoint omitted it, the
-- FIRST call stored T1, and a RETRY (same idempotency key, no p_paid_at)
-- computed a brand new `now()` = T2 at call time, so the fingerprint
-- comparison `existing.paid_at <> coalesce(p_paid_at, now())` falsely
-- failed even though nothing about the actual request had changed. Fixed
-- by the "Preferred strict design": p_paid_at now has NO default and is
-- explicitly rejected if null -- the canonical endpoint (invoice-record-
-- payment.ts) computes a stable timestamp ONCE per logical submission (in
-- RecordPaymentDialog.tsx, alongside the idempotency key) and passes it on
-- every retry unchanged. This removes the ambiguity completely -- there is
-- no `now()`/`coalesce` call left anywhere in this function's idempotency
-- path.
--
-- Idempotency (Part 15/17/20) -- p_idempotency_key is now REQUIRED
-- (normalized via btrim, rejected if blank) -- a user-created manual
-- payment can never bypass idempotency protection, same rule as the credit
-- RPCs. A same-key request whose normalized (invoice_id, amount, method,
-- paid_at, reference, notes) doesn't match raises a conflict --
-- deliberately NOT reusing `reference` alone as the key, since two
-- genuinely different payments can legitimately share the same free-text
-- reference. invoice_payments.idempotency_key stays NULLABLE at the table
-- level (Stripe webhook rows use provider_payment_id identity, reversal
-- rows use reverses_payment_id identity, legacy import may use a different
-- model) -- only THIS canonical RPC enforces the requirement.
--
-- Part 11/27 -- returns BOTH invoice_effective_balance (posted-credits-
-- only -- the number a caller should actually display to the customer)
-- and invoice_available_balance (draft+posted credits -- the write-safety
-- ceiling this function itself just enforced). Never conflate the two.
create or replace function public.record_invoice_payment(
  p_org_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_paid_at timestamptz,
  p_idempotency_key text,
  p_payment_method text default 'other',
  p_reference text default null,
  p_notes text default null,
  p_created_by uuid default null
)
returns table (
  payment_id uuid,
  invoice_status text,
  invoice_amount_paid numeric,
  invoice_effective_balance numeric,
  invoice_available_balance numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_net_payments numeric(14,2);
  v_reserved_credits numeric(14,2);
  v_posted_credits numeric(14,2);
  v_available numeric(14,2);
  v_payment_id uuid;
  v_existing record;
  v_normalized_reference text;
  v_normalized_notes text;
  v_constraint_name text;
begin
  if p_org_id is null then raise exception 'org_id is required'; end if;
  if p_invoice_id is null then raise exception 'invoice_id is required'; end if;
  if p_amount is null then raise exception 'amount is required'; end if;
  if p_paid_at is null then raise exception 'paid_at is required'; end if;

  p_idempotency_key := btrim(p_idempotency_key);
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'idempotency_key is required';
  end if;

  p_amount := round(p_amount, 2);
  if p_amount <= 0 then raise exception 'amount must be a positive number'; end if;
  p_payment_method := coalesce(nullif(btrim(p_payment_method), ''), 'other');
  v_normalized_reference := nullif(btrim(p_reference), '');
  v_normalized_notes := nullif(btrim(p_notes), '');

  -- Parent lock is the authoritative concurrency boundary for manual
  -- payments, reversals, and customer credits.
  select i.* into v_invoice
    from public.invoices as i
   where i.id = p_invoice_id and i.org_id = p_org_id
   for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found for this org';
  end if;

  -- Re-check idempotency AFTER acquiring the invoice lock so a same-key
  -- request that waited for the winner returns that row instead of failing
  -- a now-smaller balance ceiling.
  select ip.id, ip.invoice_id, ip.amount, ip.payment_method,
         ip.paid_at, ip.reference, ip.notes
    into v_existing
    from public.invoice_payments as ip
   where ip.org_id = p_org_id
     and ip.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.invoice_id <> p_invoice_id
       or v_existing.amount <> p_amount
       or v_existing.payment_method <> p_payment_method
       or v_existing.paid_at <> p_paid_at
       or v_existing.reference is distinct from v_normalized_reference
       or v_existing.notes is distinct from v_normalized_notes
    then
      raise exception 'This request key was already used for a different payment request';
    end if;

    select i.status, i.amount_paid, i.total_amount
      into v_invoice.status, v_invoice.amount_paid, v_invoice.total_amount
      from public.invoices as i
     where i.id = p_invoice_id and i.org_id = p_org_id;

    select coalesce(sum(
      case when ip2.reverses_payment_id is null then ip2.amount else -ip2.amount end
    ) filter (where ip2.status = 'succeeded'), 0)
      into v_net_payments
      from public.invoice_payments as ip2
     where ip2.invoice_id = p_invoice_id;

    select coalesce(sum(ccm.total_amount), 0)
      into v_posted_credits
      from public.customer_credit_memos as ccm
     where ccm.invoice_id = p_invoice_id
       and ccm.status = 'posted';

    select coalesce(sum(ccm.total_amount), 0)
      into v_reserved_credits
      from public.customer_credit_memos as ccm
     where ccm.invoice_id = p_invoice_id
       and ccm.status in ('draft', 'posted');

    return query
      select v_existing.id,
             v_invoice.status,
             v_invoice.amount_paid,
             round(greatest(0, v_invoice.total_amount - v_net_payments - v_posted_credits), 2),
             round(greatest(0, v_invoice.total_amount - v_net_payments - v_reserved_credits), 2);
    return;
  end if;

  if v_invoice.status in ('draft', 'cancelled') then
    raise exception 'A % invoice cannot receive a payment', v_invoice.status;
  end if;

  select coalesce(sum(
    case when ip.reverses_payment_id is null then ip.amount else -ip.amount end
  ) filter (where ip.status = 'succeeded'), 0)
    into v_net_payments
    from public.invoice_payments as ip
   where ip.invoice_id = p_invoice_id;

  select coalesce(sum(ccm.total_amount), 0)
    into v_reserved_credits
    from public.customer_credit_memos as ccm
   where ccm.invoice_id = p_invoice_id
     and ccm.status in ('draft', 'posted');

  v_available := round(v_invoice.total_amount - v_net_payments - v_reserved_credits, 2);
  if v_available <= 0 then
    raise exception 'This invoice has no remaining available balance';
  end if;
  if p_amount > v_available + 0.005 then
    raise exception 'Payment of % exceeds the available balance of %', p_amount, v_available;
  end if;

  begin
    insert into public.invoice_payments (
      org_id, invoice_id, project_id, contact_id, amount, currency, status,
      payment_method, provider, provider_payment_id, source, paid_at,
      reference, notes, created_by, idempotency_key
    ) values (
      p_org_id, p_invoice_id, v_invoice.project_id, v_invoice.client_id,
      p_amount, 'usd', 'succeeded', p_payment_method, 'manual', null,
      'manual', p_paid_at, v_normalized_reference, v_normalized_notes,
      p_created_by, p_idempotency_key
    )
    returning id into v_payment_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = CONSTRAINT_NAME;
    if v_constraint_name = 'uq_invoice_payments_org_idempotency' then
      select ip.id, ip.invoice_id, ip.amount, ip.payment_method,
             ip.paid_at, ip.reference, ip.notes
        into v_existing
        from public.invoice_payments as ip
       where ip.org_id = p_org_id
         and ip.idempotency_key = p_idempotency_key;

      if v_existing.id is null
         or v_existing.invoice_id <> p_invoice_id
         or v_existing.amount <> p_amount
         or v_existing.payment_method <> p_payment_method
         or v_existing.paid_at <> p_paid_at
         or v_existing.reference is distinct from v_normalized_reference
         or v_existing.notes is distinct from v_normalized_notes
      then
        raise exception 'This request key was already used for a different payment request';
      end if;

      select i.status, i.amount_paid, i.total_amount
        into v_invoice.status, v_invoice.amount_paid, v_invoice.total_amount
        from public.invoices as i
       where i.id = p_invoice_id and i.org_id = p_org_id;

      select coalesce(sum(
        case when ip2.reverses_payment_id is null then ip2.amount else -ip2.amount end
      ) filter (where ip2.status = 'succeeded'), 0)
        into v_net_payments
        from public.invoice_payments as ip2
       where ip2.invoice_id = p_invoice_id;

      select coalesce(sum(ccm.total_amount), 0)
        into v_posted_credits
        from public.customer_credit_memos as ccm
       where ccm.invoice_id = p_invoice_id
         and ccm.status = 'posted';

      select coalesce(sum(ccm.total_amount), 0)
        into v_reserved_credits
        from public.customer_credit_memos as ccm
       where ccm.invoice_id = p_invoice_id
         and ccm.status in ('draft', 'posted');

      return query
        select v_existing.id,
               v_invoice.status,
               v_invoice.amount_paid,
               round(greatest(0, v_invoice.total_amount - v_net_payments - v_posted_credits), 2),
               round(greatest(0, v_invoice.total_amount - v_net_payments - v_reserved_credits), 2);
      return;
    end if;
    raise;
  end;

  -- The insert trigger has synchronized invoices.amount_paid/status.
  select i.status, i.amount_paid, i.total_amount
    into v_invoice.status, v_invoice.amount_paid, v_invoice.total_amount
    from public.invoices as i
   where i.id = p_invoice_id and i.org_id = p_org_id;

  select coalesce(sum(
    case when ip2.reverses_payment_id is null then ip2.amount else -ip2.amount end
  ) filter (where ip2.status = 'succeeded'), 0)
    into v_net_payments
    from public.invoice_payments as ip2
   where ip2.invoice_id = p_invoice_id;

  select coalesce(sum(ccm.total_amount), 0)
    into v_posted_credits
    from public.customer_credit_memos as ccm
   where ccm.invoice_id = p_invoice_id
     and ccm.status = 'posted';

  select coalesce(sum(ccm.total_amount), 0)
    into v_reserved_credits
    from public.customer_credit_memos as ccm
   where ccm.invoice_id = p_invoice_id
     and ccm.status in ('draft', 'posted');

  return query
    select v_payment_id,
           v_invoice.status,
           v_invoice.amount_paid,
           round(greatest(0, v_invoice.total_amount - v_net_payments - v_posted_credits), 2),
           round(greatest(0, v_invoice.total_amount - v_net_payments - v_reserved_credits), 2);
end;
$$;

revoke all on function public.record_invoice_payment(uuid, uuid, numeric, timestamptz, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid, uuid, numeric, timestamptz, text, text, text, text, uuid) to service_role;

commit;

-- ============================================================================
-- Manual verification queries (run after applying, before use)
-- ============================================================================
-- Phase 13.10A, Part 34 -- expanded to cover every new/changed object in
-- this hardening pass, not just the original Phase 13.10 shape.

-- 1. invoice_payments append-only/reversal columns + the new CHECK.
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoice_payments' and column_name in ('reverses_payment_id','reversal_reason');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.invoice_payments'::regclass and conname = 'invoice_payments_source_check';
--   -- expect: source in ('manual','legacy_import','stripe_webhook','reversal')

-- 2. All five new tables + financial_document_counters exist.
-- select table_name from information_schema.tables where table_schema = 'public'
--   and table_name in ('customer_credit_memos','customer_credit_memo_lines','vendor_credits','vendor_credit_lines','financial_document_counters');

-- 3. idempotency_key columns + their unique partial indexes (Part 7/8).
-- select table_name, column_name from information_schema.columns
--   where table_schema = 'public' and column_name = 'idempotency_key'
--   and table_name in ('customer_credit_memos','vendor_credits');
-- select indexname, indexdef from pg_indexes where schemaname = 'public'
--   and indexname in ('uq_customer_credit_memos_org_idempotency','uq_vendor_credits_org_idempotency');

-- 4. draft-then-post default + line-immutability triggers (Part 4/5/6).
-- select column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'customer_credit_memos' and column_name = 'status'; -- expect 'draft'::text
-- select column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'vendor_credits' and column_name = 'status'; -- expect 'draft'::text
-- select tgname from pg_trigger where tgrelid = 'public.customer_credit_memo_lines'::regclass and not tgisinternal order by tgname;
--   -- expect validate_customer_credit_memo_line_dimensions + prevent_non_draft_customer_credit_memo_line_mutation
-- select tgname from pg_trigger where tgrelid = 'public.vendor_credit_lines'::regclass and not tgisinternal order by tgname;
--   -- expect validate_vendor_credit_line_dimensions + prevent_non_draft_vendor_credit_line_delete
-- select tgname from pg_trigger where tgrelid = 'public.invoice_payments'::regclass and not tgisinternal order by tgname;
--   -- expect validate_invoice_payment_reversal_shape + enforce_invoice_payment_immutability

-- 5. Every RPC this migration creates/replaces actually exists.
-- select proname from pg_proc where proname in (
--   'record_invoice_payment_reversal','record_customer_credit_memo','record_vendor_credit',
--   'record_vendor_payment','next_financial_document_number','post_journal_entry'
-- );
-- select pg_get_functiondef(oid) like '%p_idempotency_key%' as has_idempotency_param
--   from pg_proc where proname in ('record_customer_credit_memo','record_vendor_credit'); -- expect true, true
-- select pg_get_functiondef(oid) like '%v_credits%' as is_credit_aware
--   from pg_proc where proname = 'record_vendor_payment'; -- expect true (Part 10)

-- 6. source_type CHECK + post_journal_entry's own valid-types array include 'vendor_credit'.
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.accounting_journal_entries'::regclass and conname = 'accounting_journal_entries_source_type_check';
-- select pg_get_functiondef(oid) like '%vendor_credit%' as allows_vendor_credit
--   from pg_proc where proname = 'post_journal_entry';

-- 7. RLS + grants on all five new/touched tables plus financial_document_counters (Part 22).
-- select relname, relrowsecurity, relforcerowsecurity from pg_class
--   where relname in ('customer_credit_memos','customer_credit_memo_lines','vendor_credits','vendor_credit_lines','financial_document_counters')
--   and relnamespace = 'public'::regnamespace;
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in ('customer_credit_memos','customer_credit_memo_lines','vendor_credits','vendor_credit_lines','financial_document_counters')
--   order by table_name, grantee;
-- select grantee, routine_name, privilege_type from information_schema.role_routine_grants
--   where routine_name in ('record_invoice_payment_reversal','record_customer_credit_memo','record_vendor_credit','record_vendor_payment');

-- ============================================================================
-- Phase 13.10B additions (Part 43) -- verify every new/changed object below.
-- ============================================================================

-- 8. invoice_payments reversal-source invariant + idempotency column.
-- select pg_get_functiondef(oid) like '%reverses_payment_id is not null and new.source <> ''reversal''%' as enforces_reversal_source_invariant
--   from pg_proc where proname = 'validate_invoice_payment_reversal_shape'; -- expect true
-- select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoice_payments' and column_name = 'idempotency_key';
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'uq_invoice_payments_org_idempotency';

-- 9. customer_credit_memos / vendor_credits new `description` column (idempotency fingerprint field).
-- select table_name, column_name from information_schema.columns
--   where table_schema = 'public' and column_name = 'description'
--   and table_name in ('customer_credit_memos','vendor_credits');

-- 10. prepare (record_*) + finalize RPCs all exist with the expected signatures.
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where proname in ('record_customer_credit_memo','finalize_customer_credit_memo','record_vendor_credit','finalize_vendor_credit','record_invoice_payment')
--   order by proname;
-- select pg_get_functiondef(oid) not like '%p_revenue_account_id%' as revenue_account_removed_from_params
--   from pg_proc where proname = 'record_customer_credit_memo'; -- expect true (Part 10 -- derived internally now)
-- select pg_get_functiondef(oid) like '%no posted issued journal entry%' as fails_closed_on_missing_je
--   from pg_proc where proname = 'record_customer_credit_memo'; -- expect true (Part 9)
-- select pg_get_functiondef(oid) like '%exception when unique_violation%' as has_race_handler
--   from pg_proc where proname in ('record_customer_credit_memo','record_vendor_credit','record_invoice_payment'); -- expect true for all three rows

-- 11. finalize RPCs require a posted JE before flipping draft -> posted.
-- select pg_get_functiondef(oid) like '%posting_key = ''posted'' and je.status = ''posted''%' as requires_posted_je
--   from pg_proc where proname in ('finalize_customer_credit_memo','finalize_vendor_credit'); -- expect true for both rows

-- 12. record_invoice_payment() locks the invoice first and is credit-aware.
-- select pg_get_functiondef(oid) like '%for update%' as locks_invoice
--   from pg_proc where proname = 'record_invoice_payment'; -- expect true
-- select pg_get_functiondef(oid) like '%customer_credit_memos%' as is_credit_aware
--   from pg_proc where proname = 'record_invoice_payment'; -- expect true

-- 13. Every new/changed RPC is service_role-only (no public/anon/authenticated execute).
-- select grantee, routine_name, privilege_type from information_schema.role_routine_grants
--   where routine_name in ('record_customer_credit_memo','finalize_customer_credit_memo','record_vendor_credit','finalize_vendor_credit','record_invoice_payment')
--   order by routine_name, grantee;
-- Expect ONLY service_role rows -- no public/anon/authenticated rows for any of these five.

-- 14. validate_customer_credit_memo_line_dimensions() no longer has the old permissive fallback.
-- select pg_get_functiondef(oid) like '%if v_issued_entry_id is not null then%' as still_has_old_weak_fallback
--   from pg_proc where proname = 'validate_customer_credit_memo_line_dimensions'; -- expect false/no rows
-- select pg_get_functiondef(oid) like '%has no posted issued journal entry to derive%' as fails_closed
--   from pg_proc where proname = 'validate_customer_credit_memo_line_dimensions'; -- expect true

-- 15. Trial balance sanity after applying (run against a real org once you begin the E2E phase, not before):
-- select source_type, sum(debit) as total_debit, sum(credit) as total_credit
--   from public.accounting_journal_entry_lines jel
--   join public.accounting_journal_entries je on je.id = jel.journal_entry_id
--   where je.status <> 'draft'
--   group by source_type;
-- select sum(debit) - sum(credit) as should_be_zero from public.accounting_journal_entry_lines jel
--   join public.accounting_journal_entries je on je.id = jel.journal_entry_id where je.status <> 'draft';

-- ============================================================================
-- Phase 13.10C additions -- verify reserved-vs-effective, idempotency
-- mandate, and JE-content-verified finalize below.
-- ============================================================================

-- 16. idempotency_key is NOT NULL at the table level for both credit tables.
-- select table_name, column_name, is_nullable from information_schema.columns
--   where table_schema = 'public' and column_name = 'idempotency_key'
--   and table_name in ('customer_credit_memos','vendor_credits');
--   -- expect is_nullable = 'NO' for both rows
-- select table_name, column_name, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'invoice_payments' and column_name = 'idempotency_key';
--   -- expect is_nullable = 'YES' (Stripe/legacy/reversal rows have other identity models)

-- 17. Ceiling formulas use draft+posted (reserved), not posted-only.
-- select pg_get_functiondef(oid) like '%status in (''draft'', ''posted'')%' as uses_reserved_ceiling
--   from pg_proc where proname in ('record_customer_credit_memo','record_vendor_credit','record_invoice_payment','record_vendor_payment');
--   -- expect true for all four rows
-- select pg_get_functiondef(oid) like '%idempotency_key is required%' as requires_key
--   from pg_proc where proname in ('record_customer_credit_memo','record_vendor_credit','record_invoice_payment');
--   -- expect true for all three rows

-- 18. record_invoice_payment() no longer has any now()/coalesce(p_paid_at,...) ambiguity.
-- select pg_get_functiondef(oid) not like '%coalesce(p_paid_at%' and pg_get_functiondef(oid) not like '%now())%' as no_now_ambiguity
--   from pg_proc where proname = 'record_invoice_payment'; -- expect true
-- select pg_get_functiondef(oid) like '%paid_at is required%' as requires_paid_at
--   from pg_proc where proname = 'record_invoice_payment'; -- expect true
-- select proname, pg_get_function_arguments(oid) from pg_proc where proname = 'record_invoice_payment';
--   -- expect p_paid_at and p_idempotency_key with NO "DEFAULT" in their argument text

-- 19. finalize RPCs verify exact JE content (account + debit/credit + amount), not just identity.
-- select pg_get_functiondef(oid) like '%v_line_count <> 2%' as verifies_line_count
--   from pg_proc where proname in ('finalize_customer_credit_memo','finalize_vendor_credit'); -- expect true for both
-- select pg_get_functiondef(oid) like '%code = ''1100''%' as resolves_ar_by_code
--   from pg_proc where proname = 'finalize_customer_credit_memo'; -- expect true
-- select pg_get_functiondef(oid) like '%code = ''2000''%' as resolves_ap_by_code
--   from pg_proc where proname = 'finalize_vendor_credit'; -- expect true
-- select pg_get_functiondef(oid) like '%if v_credit.status = ''posted'' then%' as reverifies_je_on_idempotent_repeat
--   from pg_proc where proname = 'finalize_vendor_credit'; -- expect true (content check runs BEFORE this branch, unconditionally)

-- 20. Return-value semantics renamed correctly (available vs effective never conflated).
-- select proname, pg_get_function_result(oid) from pg_proc
--   where proname in ('record_customer_credit_memo','finalize_customer_credit_memo','record_vendor_credit','finalize_vendor_credit','record_invoice_payment')
--   order by proname;
--   -- expect record_customer_credit_memo/record_vendor_credit to return *_available_balance;
--   -- expect finalize_customer_credit_memo/finalize_vendor_credit to return *_effective_balance;
--   -- expect record_invoice_payment to return BOTH invoice_effective_balance and invoice_available_balance

-- 20A. Retry-race hardening: same-key lookup is performed after the parent FOR UPDATE lock.
-- select pg_get_functiondef(oid) like '%Re-check idempotency AFTER acquiring the parent lock%' as customer_post_lock_idempotency
--   from pg_proc where proname = 'record_customer_credit_memo'; -- expect true
-- select pg_get_functiondef(oid) like '%Post-lock idempotency re-check%' as vendor_post_lock_idempotency
--   from pg_proc where proname = 'record_vendor_credit'; -- expect true
-- select pg_get_functiondef(oid) like '%Re-check idempotency AFTER acquiring the invoice lock%' as payment_post_lock_idempotency
--   from pg_proc where proname = 'record_invoice_payment'; -- expect true

-- 20B. credit_date is required (no DEFAULT current_date) so the idempotency fingerprint is stable across midnight.
-- select proname, pg_get_function_arguments(oid) from pg_proc
--   where proname in ('record_customer_credit_memo','record_vendor_credit');
--   -- expect p_credit_date with NO DEFAULT in both signatures

-- 21. Full function signature list post-apply (confirm no stale overload remains).
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where proname in ('record_customer_credit_memo','finalize_customer_credit_memo','record_vendor_credit','finalize_vendor_credit','record_invoice_payment','record_invoice_payment_reversal','record_vendor_payment','post_journal_entry')
--   order by proname;