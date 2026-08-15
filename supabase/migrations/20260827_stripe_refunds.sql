-- 20260827_stripe_refunds.sql
--
-- Phase 13.11 -- Stripe refunds.
--
-- Revision note (this file is still UNAPPLIED -- rewritten in place per
-- this repo's own rule that an unapplied migration is edited directly
-- rather than superseded by a new dated file): the first draft of this
-- migration had a critical regression in recompute_invoice_amount_paid()
-- -- it dropped Phase 13.10's reverses_payment_id handling, which would
-- have made a manual payment reversal silently stop reducing
-- invoices.amount_paid the moment this migration was applied. Fixed below
-- by carrying the FULL Phase 13.10 formula forward exactly and only
-- ADDING the Stripe-refund subtraction on top of it. Several other
-- invariants (payment status check, exact NULL-safe project/contact
-- matching, write-once stripe_refund_id/stripe_idempotency_key, dimension
-- immutability, convergence-RPC conflict handling) were hardened in this
-- same pass -- see the inline comments at each site.
--
-- Architecture audited before writing this file (repo evidence only, no
-- live information_schema access from this session):
--   - invoice_payments (20260818, applied) is the canonical customer
--     payment ledger. Phase 13.10A/13.10B (20260825, applied) added
--     reverses_payment_id/reversal_reason/idempotency_key and, critically,
--     enforce_invoice_payment_immutability(): once a row's status is
--     'succeeded', EVERY column is frozen, including `status` itself. That
--     means the pre-existing 'refunded' status value on invoice_payments
--     (present in the original CHECK constraint since 20260818) has been
--     UNREACHABLE since 20260825 -- nothing can ever flip a succeeded row's
--     status to 'refunded' anymore; the trigger rejects that UPDATE
--     outright. The formula below still subtracts it for backward
--     compatibility (matching sync_invoice_amount_paid()'s own existing
--     dormant term, unchanged since 20260818/20260825) even though it is
--     confirmed dead code -- removing a defensive term that costs nothing
--     and matches the applied formula exactly is out of scope for this
--     phase and not requested.
--   - Phase 13.10's actual LIVE effective-paid formula (20260825,
--     sync_invoice_amount_paid()) nets succeeded ORIGINAL payments against
--     succeeded REVERSAL payments via reverses_payment_id -- NOT a flat
--     sum of every succeeded row. This migration's recompute_invoice_
--     amount_paid() now reproduces that exact CASE expression, then
--     subtracts the dormant 'refunded'-status term (unchanged), then
--     subtracts succeeded invoice_payment_refunds. This is the only
--     change from the first draft that affects invoice_payments-side
--     behavior at all -- everything else in this section is unchanged.
--   - This settles the data-model choice: a Stripe refund CANNOT be
--     modeled as mutating the original invoice_payments row (blocked at
--     the DB level by design -- see accounting-integrity's "Canonical
--     payment ledgers" append-only rule) and must not reuse the dormant
--     'refunded' status path. It also cannot be modeled as another row
--     appended directly to invoice_payments (that table's rows are "money
--     moved on the invoice's ledger"; a refund is a distinct
--     external-provider lifecycle -- pending/requires_action/succeeded/
--     failed/canceled -- that does not belong in a table whose own status
--     enum and immutability trigger were designed around a payment's much
--     simpler lifecycle).
--   - Chosen model (unchanged from the first draft, approved): a
--     dedicated, append-only `invoice_payment_refunds` table. One
--     invoice_payments row (provider='stripe', status='succeeded') can
--     have MANY refund rows (multiple partial refunds). Each row tracks
--     its own Stripe-native lifecycle independently, carries its own
--     Stripe refund id (unique), and is immutable once terminal
--     (succeeded/failed/canceled) -- mirroring every other financial-
--     ledger table in this codebase.
--   - 'refund' is already a valid accounting_journal_entries.source_type
--     (added in 20260820_accounting_foundation.sql's original CHECK
--     constraint, applied, never used until now) -- no accounting-side
--     migration needed for that part.
--
-- Does NOT touch or redefine any table/column added by:
--   20260818_invoice_payments_ledger.sql
--   20260819_expand_invoice_status_check.sql
--   20260820_accounting_foundation.sql (only ADDS usage of its existing
--     'refund' source_type and post_journal_entry()/resolveSystemAccounts
--     conventions -- no schema change there)
--   20260821_public_invoice_payments.sql
--   20260822_expenses_vendors_ap.sql
--   20260823_accounting_reversals_credits.sql
--   20260824_fix_vendor_payment_reversal_ambiguity.sql
--   20260825_customer_credits_vendor_credits.sql
--   20260826_fix_credit_uuid_aggregates.sql
-- It only ADDS a new table, new functions/triggers scoped to that new
-- table, and redefines (CREATE OR REPLACE) two existing functions
-- (sync_invoice_amount_paid, and a brand-new recompute_invoice_amount_paid)
-- so both invoice_payments and invoice_payment_refunds writes stay
-- reconciled through one shared formula that reproduces 20260825's
-- reversal-aware arithmetic exactly.
--
-- NOT applied automatically. Apply manually in the Supabase SQL Editor.
-- Do not run via `supabase db push`.

begin;

-- ============================================================================
-- 1. INVOICE_PAYMENT_REFUNDS -- canonical Stripe refund ledger
-- ============================================================================

create table if not exists public.invoice_payment_refunds (
  id uuid primary key default gen_random_uuid(),

  org_id uuid not null
    references public.organizations(id)
    on delete cascade,

  invoice_payment_id uuid not null
    references public.invoice_payments(id)
    on delete restrict,

  invoice_id uuid not null
    references public.invoices(id)
    on delete cascade,

  project_id uuid null
    references public.projects(id)
    on delete set null,

  contact_id uuid null
    references public.contacts(id)
    on delete set null,

  amount numeric(12,2) not null,
  currency text not null default 'usd',

  -- Mirrors Stripe's own Refund.status vocabulary (Stripe docs: pending,
  -- requires_action, succeeded, failed, canceled) rather than reusing
  -- invoice_payments' payment-shaped status enum -- a refund's lifecycle is
  -- a genuinely different shape (it can sit in requires_action, which a
  -- payment row's vocabulary has no equivalent for).
  --
  -- Terminal states: succeeded, failed, canceled -- frozen forever once
  -- reached (enforce_invoice_payment_refund_immutability). Non-terminal:
  -- pending, requires_action -- may still transition among themselves or
  -- into a terminal state.
  status text not null default 'pending',

  reason text null,

  -- Stripe's refund id (re_xxx). NULL until the synchronous Stripe API call
  -- (or, in the failure-window case, until the webhook converges it via
  -- metadata.local_refund_id) actually returns one. Write-once: null ->
  -- value is allowed exactly once while the refund is still pending/
  -- requires_action, never changed after that write; once the refund
  -- reaches a terminal status (succeeded/failed/canceled) this field is
  -- frozen outright -- even a still-null value can no longer be set (see
  -- enforce_invoice_payment_refund_immutability()). Never trusted from the
  -- client -- always written server-side from Stripe's own response or a
  -- signature-verified webhook payload.
  stripe_refund_id text null,
  stripe_failure_reason text null,

  -- Local request-level idempotency (client/API-level "same logical refund
  -- request"). Required, unique per org -- same shape as invoice_payments.
  -- idempotency_key (20260825).
  idempotency_key text not null,

  -- The deterministic key actually sent to Stripe's Idempotency-Key header
  -- for this refund's stripe.refunds.create call. Same write-once-then-
  -- frozen-at-terminal rule as stripe_refund_id -- see
  -- record_invoice_payment_refund_stripe_key() below, the only RPC allowed
  -- to set it.
  stripe_idempotency_key text null,

  requested_by uuid null
    references public.profiles(id)
    on delete set null,

  requested_at timestamptz not null default now(),
  succeeded_at timestamptz null,
  failed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invoice_payment_refunds_amount_positive
    check (amount > 0),

  constraint invoice_payment_refunds_status_check
    check (
      status in (
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled'
      )
    )
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================

create index if not exists idx_invoice_payment_refunds_payment
  on public.invoice_payment_refunds (invoice_payment_id, created_at desc);

create index if not exists idx_invoice_payment_refunds_invoice
  on public.invoice_payment_refunds (invoice_id, created_at desc);

create index if not exists idx_invoice_payment_refunds_org
  on public.invoice_payment_refunds (org_id, created_at desc);

-- Request-level idempotency -- the real backstop, not just the RPC's
-- own pre-check-then-insert.
create unique index if not exists uq_invoice_payment_refunds_org_idempotency
  on public.invoice_payment_refunds (org_id, idempotency_key);

-- A Stripe refund id must never be attached to two local rows -- this is
-- the webhook-replay / duplicate-processing backstop at the DB level. The
-- convergence RPC below also checks this explicitly BEFORE relying on this
-- index, so a conflict surfaces as a clear application-level error rather
-- than an opaque unique-violation.
create unique index if not exists uq_invoice_payment_refunds_stripe_refund_id
  on public.invoice_payment_refunds (stripe_refund_id)
  where stripe_refund_id is not null;

-- ============================================================================
-- 3. CROSS-ORG / RELATIONSHIP VALIDATION
-- ============================================================================
--
-- CRITICAL FIX (this rewrite): the first draft selected the original
-- payment's status into v_payment.payment_status but never actually
-- checked it -- a refund row could be inserted against a payment that was
-- never 'succeeded' (e.g. still 'pending', or 'failed'). This is now a
-- hard, enforced invariant, defended at the table-trigger level so a
-- service-role application bug (not just a malicious client -- there is no
-- client path here at all, since this table has no client INSERT grant)
-- can never create a refund against a non-canonical original payment.
--
-- CRITICAL FIX (this rewrite): project_id/contact_id matching was
-- previously only checked when the NEW value was non-null, silently
-- allowing a refund row with project_id=NULL/contact_id=NULL against a
-- payment that actually has non-null dimensions -- which would corrupt
-- project profitability and accounting dimension reporting for that
-- refund. Now uses NULL-safe exact equality (`is distinct from`) in both
-- directions. The request RPC below always copies these dimensions
-- straight from the payment row, so no legitimate caller is affected.
create or replace function public.validate_invoice_payment_refund_org()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment record;
begin
  select
    ip.org_id,
    ip.invoice_id,
    ip.project_id,
    ip.contact_id,
    ip.provider,
    ip.status as payment_status,
    ip.reverses_payment_id,
    ip.provider_payment_id
  into v_payment
  from public.invoice_payments ip
  where ip.id = new.invoice_payment_id;

  if v_payment.org_id is null then
    raise exception
      'invoice_payment_refunds.invoice_payment_id does not reference an existing payment';
  end if;

  if v_payment.org_id <> new.org_id then
    raise exception
      'invoice_payment_refunds.org_id must match the payment''s own org_id';
  end if;

  if v_payment.invoice_id <> new.invoice_id then
    raise exception
      'invoice_payment_refunds.invoice_id must match the payment''s own invoice_id';
  end if;

  -- Only a genuine Stripe-confirmed original payment can ever be refunded.
  -- Manual payments use the separate reversal path (record_invoice_payment_
  -- reversal, 20260825); a reversal row itself can never be refunded.
  if v_payment.provider <> 'stripe' then
    raise exception
      'Only Stripe payments can be refunded -- % payments use the manual reversal path', v_payment.provider;
  end if;

  -- CRITICAL FIX -- previously selected but never enforced.
  if v_payment.payment_status <> 'succeeded' then
    raise exception
      'Only a succeeded payment can be refunded (current payment status: %)', v_payment.payment_status;
  end if;

  if v_payment.reverses_payment_id is not null then
    raise exception
      'Cannot refund a payment-reversal row';
  end if;

  if v_payment.provider_payment_id is null then
    raise exception
      'Payment has no Stripe provider id and cannot be refunded';
  end if;

  -- CRITICAL FIX -- exact NULL-safe equality in both directions, not just
  -- "reject if new value is non-null and different."
  if new.project_id is distinct from v_payment.project_id then
    raise exception
      'invoice_payment_refunds.project_id must exactly match the payment''s project_id';
  end if;

  if new.contact_id is distinct from v_payment.contact_id then
    raise exception
      'invoice_payment_refunds.contact_id must exactly match the payment''s contact_id';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_invoice_payment_refund_org
  on public.invoice_payment_refunds;

create trigger trg_validate_invoice_payment_refund_org
  before insert
  on public.invoice_payment_refunds
  for each row
  execute function public.validate_invoice_payment_refund_org();

revoke all on function public.validate_invoice_payment_refund_org()
  from public, anon, authenticated;

-- ============================================================================
-- 4. IMMUTABILITY -- dimensional linkage frozen from insert; terminal once
--    succeeded/failed/canceled
-- ============================================================================
--
-- CRITICAL FIX (this rewrite): the first draft only froze org_id/
-- invoice_payment_id/invoice_id/amount/currency/idempotency_key -- project_id
-- and contact_id (and requested_by/requested_at/reason) were NOT in the
-- always-frozen linkage check, meaning a later UPDATE could silently
-- retarget a refund's project/contact dimensions even while still pending.
-- Every dimensional/audit field is now frozen unconditionally from the
-- moment the row is created -- there is no legitimate reason for any of
-- them to ever change after insert.
--
-- CRITICAL FIX (this rewrite, pass 2 -- final hardening before manual
-- apply): stripe_idempotency_key was write-once (null -> value, never
-- changed after) UNCONDITIONALLY -- independent of terminal/non-terminal
-- status. That was still wrong: for a TERMINAL row, it silently allowed
-- old.stripe_idempotency_key IS NULL -> new.stripe_idempotency_key = some
-- value, i.e. a terminal row could still receive its very first
-- stripe_idempotency_key write after reaching succeeded/failed/canceled.
-- That contradicts "terminal refund records are frozen." stripe_refund_id
-- had the identical latent gap.
--
-- Corrected model, now branched explicitly on old.status:
--   TERMINAL (succeeded/failed/canceled): stripe_refund_id and
--     stripe_idempotency_key must be EXACTLY unchanged -- `is distinct
--     from` in both directions, so null->value is rejected here too, not
--     just value->different-value.
--   NON-TERMINAL (pending/requires_action): the original write-once rule
--     stands -- null -> a value is allowed exactly once; the same value
--     again is a no-op; an existing non-null value -> a different value is
--     rejected.
create or replace function public.enforce_invoice_payment_refund_immutability()
returns trigger
language plpgsql
as $$
begin
  -- Dimensional/financial/audit linkage: frozen unconditionally, from
  -- INSERT onward, regardless of status.
  if new.org_id <> old.org_id
     or new.invoice_payment_id <> old.invoice_payment_id
     or new.invoice_id <> old.invoice_id
     or new.project_id is distinct from old.project_id
     or new.contact_id is distinct from old.contact_id
     or new.amount <> old.amount
     or new.currency <> old.currency
     or new.idempotency_key <> old.idempotency_key
     or new.requested_by is distinct from old.requested_by
     or new.requested_at <> old.requested_at
     or new.reason is distinct from old.reason
     or new.created_at <> old.created_at
  then
    raise exception
      'A refund''s dimensional/financial linkage cannot be modified';
  end if;

  if old.status in ('succeeded', 'failed', 'canceled') then
    -- Terminal: EVERYTHING below is frozen exactly, including
    -- stripe_refund_id/stripe_idempotency_key going from null to a value
    -- -- a terminal row can never receive its first write of either field
    -- after the fact, not just a differing one.
    if new.status <> old.status then
      raise exception
        'Refund % is % and terminal -- status cannot change', old.id, old.status;
    end if;
    if new.stripe_refund_id is distinct from old.stripe_refund_id then
      raise exception
        'Refund % is % and terminal -- stripe_refund_id cannot be modified', old.id, old.status;
    end if;
    if new.stripe_idempotency_key is distinct from old.stripe_idempotency_key then
      raise exception
        'Refund % is % and terminal -- stripe_idempotency_key cannot be modified', old.id, old.status;
    end if;
    if new.stripe_failure_reason is distinct from old.stripe_failure_reason
       or new.succeeded_at is distinct from old.succeeded_at
       or new.failed_at is distinct from old.failed_at
    then
      raise exception
        'Refund % is % and its business record cannot be modified', old.id, old.status;
    end if;
  else
    -- Non-terminal (pending/requires_action): ordinary write-once
    -- semantics -- null -> a value is allowed exactly once; a differing
    -- non-null -> non-null change is rejected. (Same value again never
    -- reaches this branch as a change at all -- `is distinct from` is
    -- false for it -- so it's implicitly the allowed idempotent case.)
    if old.stripe_refund_id is not null
       and new.stripe_refund_id is distinct from old.stripe_refund_id
    then
      raise exception
        'stripe_refund_id can only be set once, never changed';
    end if;

    if old.stripe_idempotency_key is not null
       and new.stripe_idempotency_key is distinct from old.stripe_idempotency_key
    then
      raise exception
        'stripe_idempotency_key can only be set once, never changed';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_invoice_payment_refund_immutability
  on public.invoice_payment_refunds;

create trigger trg_enforce_invoice_payment_refund_immutability
  before update
  on public.invoice_payment_refunds
  for each row
  execute function public.enforce_invoice_payment_refund_immutability();

-- ============================================================================
-- 5. UPDATED_AT TRIGGER
-- ============================================================================

create or replace function public.set_invoice_payment_refunds_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_invoice_payment_refunds_updated_at
  on public.invoice_payment_refunds;

create trigger trg_invoice_payment_refunds_updated_at
  before update
  on public.invoice_payment_refunds
  for each row
  execute function public.set_invoice_payment_refunds_updated_at();

-- ============================================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================================

alter table public.invoice_payment_refunds
  enable row level security;

drop policy if exists invoice_payment_refunds_select
  on public.invoice_payment_refunds;

create policy invoice_payment_refunds_select
  on public.invoice_payment_refunds
  for select
  to authenticated
  using (
    org_id in (
      select p.organization_id
      from public.profiles p
      where p.id = auth.uid()
    )
    or
    org_id in (
      select om.org_id
      from public.org_memberships om
      where om.member_id = auth.uid()
    )
  );

-- No insert/update/delete policy for authenticated users -- every mutation
-- goes through the SECURITY DEFINER RPCs below (service_role only),
-- exactly like invoice_payments.
revoke insert, update, delete
  on public.invoice_payment_refunds
  from anon, authenticated;

grant select
  on public.invoice_payment_refunds
  to authenticated;

grant select, insert, update, delete
  on public.invoice_payment_refunds
  to service_role;

-- ============================================================================
-- 7. SHARED amount_paid RECOMPUTATION (invoice_payments + refunds together)
-- ============================================================================
--
-- CRITICAL FIX (this rewrite): the first draft's formula here was simply
--   sum(amount) where status='succeeded' - sum(amount) where status='refunded'
-- which DROPPED Phase 13.10's reverses_payment_id handling entirely -- an
-- append-only manual reversal row (status='succeeded', reverses_payment_id
-- -> original) would have been counted as a POSITIVE contribution instead
-- of negative, silently breaking every existing manual payment reversal
-- the moment this migration was applied. This is now byte-for-byte the
-- same CASE expression 20260825's sync_invoice_amount_paid() uses, with
-- the Stripe-refund subtraction added as a THIRD, separate term on top --
-- never folded into or replacing the reversal-aware term.
--
-- Only a SUCCEEDED Stripe refund reduces effective collected amount
-- (Part 2 of the Phase 13.11 brief) -- pending/requires_action/failed/
-- canceled refunds never touch amount_paid.
create or replace function public.recompute_invoice_amount_paid(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_current_status text;
  v_refunded_manual numeric(12,2);
  v_refunded_stripe numeric(12,2);
begin
  -- Phase 13.10's exact reversal-aware formula (20260825's
  -- sync_invoice_amount_paid()) -- reproduced verbatim, never
  -- reconstructed differently.
  select
    coalesce(
      sum(
        case
          when p.reverses_payment_id is null then p.amount
          else -p.amount
        end
      ) filter (where p.status = 'succeeded'),
      0
    )
  into v_paid
  from public.invoice_payments p
  where p.invoice_id = p_invoice_id;

  -- Dormant 'refunded'-status term, preserved unchanged from 20260818/
  -- 20260825 for backward compatibility (see this file's header comment --
  -- confirmed unreachable today by enforce_invoice_payment_immutability,
  -- but not relied upon and not removed).
  select coalesce(sum(p.amount) filter (where p.status = 'refunded'), 0)
  into v_refunded_manual
  from public.invoice_payments p
  where p.invoice_id = p_invoice_id;

  -- Phase 13.11 addition -- the ONLY new term. Separate from, not merged
  -- into, the two terms above.
  select coalesce(sum(r.amount), 0)
  into v_refunded_stripe
  from public.invoice_payment_refunds r
  where r.invoice_id = p_invoice_id
    and r.status = 'succeeded';

  v_paid := v_paid - v_refunded_manual - v_refunded_stripe;

  if v_paid < 0 then
    v_paid := 0;
  end if;

  select i.total_amount, i.status
  into v_total, v_current_status
  from public.invoices i
  where i.id = p_invoice_id;

  if v_total is null then
    return;
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
  where id = p_invoice_id;
end;
$$;

revoke all on function public.recompute_invoice_amount_paid(uuid)
  from public, anon, authenticated;

-- Redefine the existing (20260818/20260825) trigger function to call the
-- shared recomputation instead of duplicating its arithmetic. Same trigger
-- binding (trg_sync_invoice_amount_paid on invoice_payments) -- no DROP/
-- CREATE TRIGGER needed here, only CREATE OR REPLACE FUNCTION.
create or replace function public.sync_invoice_amount_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
begin
  if tg_op = 'DELETE' then
    v_invoice_id := old.invoice_id;
  else
    v_invoice_id := new.invoice_id;
  end if;

  perform public.recompute_invoice_amount_paid(v_invoice_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- New trigger: a change to invoice_payment_refunds (status moving into or
-- out of -- in practice only ever INTO, given the immutability trigger --
-- 'succeeded') must recompute the same invoice's amount_paid the same way.
create or replace function public.sync_invoice_amount_paid_from_refund()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  perform public.recompute_invoice_amount_paid(v_invoice_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_invoice_amount_paid_from_refund
  on public.invoice_payment_refunds;

create trigger trg_sync_invoice_amount_paid_from_refund
  after insert or update or delete
  on public.invoice_payment_refunds
  for each row
  execute function public.sync_invoice_amount_paid_from_refund();

-- ============================================================================
-- 8. create_invoice_payment_refund_request() -- locked, ceiling-enforced,
--    idempotent refund-request RPC
-- ============================================================================
--
-- Called BEFORE the Stripe API call. Locks the invoice, then the original
-- payment (same lock order as record_invoice_payment/record_invoice_
-- payment_reversal -- accounting-integrity: "use the same lock order
-- everywhere"), computes the refundable ceiling from EXISTING pending +
-- requires_action + succeeded refunds against this payment (reserving for
-- an in-flight refund the same way customer_credit_memos reserves
-- draft+posted -- two concurrent different-key refunds must not jointly
-- exceed the refundable amount), and inserts a new 'pending' row.
-- failed/canceled refunds never reserve balance. Idempotent on (org_id,
-- idempotency_key): a retried request with the SAME key and SAME
-- (payment, amount) returns the existing row; a changed amount/payment
-- under the same key is rejected.
create or replace function public.create_invoice_payment_refund_request(
  p_org_id uuid,
  p_payment_id uuid,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text,
  p_created_by uuid default null
)
returns table (
  refund_id uuid,
  invoice_id uuid,
  invoice_payment_id uuid,
  status text,
  amount numeric,
  stripe_refund_id text,
  provider_payment_id text,
  already_exists boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id_lookup uuid;
  v_invoice record;
  v_payment record;
  v_existing record;
  v_reserved numeric(12,2);
  v_available numeric(12,2);
  v_new_id uuid;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if p_payment_id is null then
    raise exception 'payment_id is required';
  end if;

  p_amount := round(p_amount, 2);
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be a positive number';
  end if;

  p_idempotency_key := btrim(p_idempotency_key);
  if p_idempotency_key is null or p_idempotency_key = '' then
    raise exception 'idempotency_key is required';
  end if;

  select ip.invoice_id into v_invoice_id_lookup
    from public.invoice_payments ip
   where ip.id = p_payment_id and ip.org_id = p_org_id;
  if v_invoice_id_lookup is null then
    raise exception 'Payment not found for this org';
  end if;

  -- Lock the invoice FIRST -- same order every other invoice-mutating RPC
  -- uses (record_invoice_payment, record_invoice_payment_reversal,
  -- record_customer_credit_memo).
  select i.* into v_invoice
    from public.invoices i
   where i.id = v_invoice_id_lookup and i.org_id = p_org_id
   for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found for this org';
  end if;

  -- Then lock the original payment.
  select ip.* into v_payment
    from public.invoice_payments ip
   where ip.id = p_payment_id and ip.org_id = p_org_id
   for update;
  if v_payment.id is null then
    raise exception 'Payment not found for this org';
  end if;

  if v_payment.provider <> 'stripe' then
    raise exception 'Only Stripe payments can be refunded -- % payments use the manual reversal path', v_payment.provider;
  end if;
  if v_payment.status <> 'succeeded' then
    raise exception 'Only a succeeded payment can be refunded (current status: %)', v_payment.status;
  end if;
  if v_payment.reverses_payment_id is not null then
    raise exception 'Cannot refund a payment-reversal row';
  end if;
  if v_payment.provider_payment_id is null then
    raise exception 'This payment has no Stripe provider id and cannot be refunded';
  end if;

  -- Idempotent retry -- re-checked AFTER acquiring both locks so a
  -- same-key request that waited behind a concurrent winner returns that
  -- winner's row instead of racing its own ceiling check.
  select r.* into v_existing
    from public.invoice_payment_refunds r
   where r.org_id = p_org_id and r.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.invoice_payment_id <> p_payment_id
       or v_existing.amount <> p_amount
    then
      raise exception 'This request key was already used for a different refund request';
    end if;
    return query
      select v_existing.id, v_invoice.id, p_payment_id, v_existing.status,
             v_existing.amount, v_existing.stripe_refund_id, v_payment.provider_payment_id, true;
    return;
  end if;

  -- Refundable ceiling: original payment amount minus every pending/
  -- requires_action/succeeded refund already recorded against it (reserves
  -- for in-flight refunds). failed/canceled refunds release their
  -- reservation automatically -- they are simply excluded from this SUM.
  select coalesce(sum(amount), 0) into v_reserved
    from public.invoice_payment_refunds
   where invoice_payment_id = p_payment_id
     and status in ('pending', 'requires_action', 'succeeded');

  v_available := round(v_payment.amount - v_reserved, 2);
  if v_available <= 0 then
    raise exception 'This payment has no remaining refundable balance';
  end if;
  if p_amount > v_available + 0.005 then
    raise exception 'Refund of % exceeds the refundable balance of %', p_amount, v_available;
  end if;

  begin
    insert into public.invoice_payment_refunds (
      org_id, invoice_payment_id, invoice_id, project_id, contact_id,
      amount, currency, status, reason, idempotency_key, requested_by
    ) values (
      p_org_id, p_payment_id, v_invoice.id, v_payment.project_id, v_payment.contact_id,
      p_amount, v_payment.currency, 'pending', nullif(btrim(p_reason), ''),
      p_idempotency_key, p_created_by
    )
    returning id into v_new_id;
  exception when unique_violation then
    -- A concurrent request with the SAME idempotency key won the race
    -- between our pre-check and this insert -- converge on its row rather
    -- than erroring.
    select r.* into v_existing
      from public.invoice_payment_refunds r
     where r.org_id = p_org_id and r.idempotency_key = p_idempotency_key;
    if v_existing.id is null
       or v_existing.invoice_payment_id <> p_payment_id
       or v_existing.amount <> p_amount
    then
      raise exception 'This request key was already used for a different refund request';
    end if;
    return query
      select v_existing.id, v_invoice.id, p_payment_id, v_existing.status,
             v_existing.amount, v_existing.stripe_refund_id, v_payment.provider_payment_id, true;
    return;
  end;

  return query
    select v_new_id, v_invoice.id, p_payment_id, 'pending'::text, p_amount,
           null::text, v_payment.provider_payment_id, false;
end;
$$;

revoke all on function public.create_invoice_payment_refund_request(uuid, uuid, numeric, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_invoice_payment_refund_request(uuid, uuid, numeric, text, text, uuid)
  to service_role;

-- ============================================================================
-- 9. apply_invoice_payment_refund_result() -- convergence RPC
-- ============================================================================
--
-- The single write path for "Stripe told us something about this refund" --
-- called both by the synchronous handler right after stripe.refunds.create
-- returns, AND by the webhook handler for refund.created/refund.updated/
-- refund.failed. Both callers funnel through the exact same function so
-- there is only one place status convergence happens.
--
-- Re-audited in this rewrite for the exact scenarios called out in review:
--   - succeeded followed by a stale/replayed pending event -> succeeded
--     remains, changed=false (terminal short-circuit below).
--   - failed followed by a stale pending event -> failed remains,
--     changed=false.
--   - canceled followed by a stale requires_action event -> canceled
--     remains, changed=false.
--   - a duplicate succeeded event -> changed=false.
--   - p_local_refund_id and p_stripe_refund_id BOTH supplied but they
--     identify DIFFERENT local rows, or the local row already has a
--     DIFFERENT stripe_refund_id than supplied -> explicit exception
--     (never silently attaches to the wrong row, never depends on the
--     unique index alone to catch it).
create or replace function public.apply_invoice_payment_refund_result(
  p_org_id uuid,
  p_local_refund_id uuid,
  p_stripe_refund_id text,
  p_status text,
  p_failure_reason text default null
)
returns table (
  refund_id uuid,
  invoice_payment_id uuid,
  invoice_id uuid,
  status text,
  amount numeric,
  project_id uuid,
  contact_id uuid,
  changed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id_lookup uuid;
  v_by_local record;
  v_by_stripe record;
  v_refund record;
  v_prior_status text;
  v_stripe_id text;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if p_status is null or btrim(p_status) = '' then
    raise exception 'status is required';
  end if;
  if not (p_status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')) then
    raise exception 'Invalid status %', p_status;
  end if;

  v_stripe_id := nullif(btrim(p_stripe_refund_id), '');
  if p_local_refund_id is null and v_stripe_id is null then
    raise exception 'Either local_refund_id or stripe_refund_id is required';
  end if;

  -- Resolve identity BEFORE locking anything, so a bad/conflicting
  -- payload fails loudly instead of silently attaching to the wrong row.
  if p_local_refund_id is not null then
    select id, invoice_id, stripe_refund_id
      into v_by_local
      from public.invoice_payment_refunds
     where id = p_local_refund_id and org_id = p_org_id;
    if v_by_local.id is null then
      raise exception 'Refund not found for this org (local_refund_id=%)', p_local_refund_id;
    end if;
  end if;

  if v_stripe_id is not null then
    select id, invoice_id, stripe_refund_id
      into v_by_stripe
      from public.invoice_payment_refunds
     where stripe_refund_id = v_stripe_id and org_id = p_org_id;
  end if;

  if p_local_refund_id is not null and v_stripe_id is not null then
    if v_by_stripe.id is not null and v_by_stripe.id <> v_by_local.id then
      raise exception
        'stripe_refund_id % already belongs to a different local refund (%) than local_refund_id %',
        v_stripe_id, v_by_stripe.id, p_local_refund_id;
    end if;
    if v_by_local.stripe_refund_id is not null and v_by_local.stripe_refund_id <> v_stripe_id then
      raise exception
        'Refund % already has a different stripe_refund_id (%) than supplied (%)',
        p_local_refund_id, v_by_local.stripe_refund_id, v_stripe_id;
    end if;
    v_invoice_id_lookup := v_by_local.invoice_id;
  elsif p_local_refund_id is not null then
    v_invoice_id_lookup := v_by_local.invoice_id;
  else
    if v_by_stripe.id is null then
      raise exception 'Refund not found for this org (stripe_refund_id=%)', v_stripe_id;
    end if;
    v_invoice_id_lookup := v_by_stripe.invoice_id;
  end if;

  -- Lock the invoice first (same order as every other invoice-touching
  -- RPC), then the refund row itself.
  perform 1 from public.invoices where id = v_invoice_id_lookup and org_id = p_org_id for update;

  if p_local_refund_id is not null then
    select * into v_refund
      from public.invoice_payment_refunds
     where id = p_local_refund_id and org_id = p_org_id
     for update;
  else
    select * into v_refund
      from public.invoice_payment_refunds
     where stripe_refund_id = v_stripe_id and org_id = p_org_id
     for update;
  end if;

  if v_refund.id is null then
    raise exception 'Refund not found for this org';
  end if;

  -- Re-verify the stripe-id conflict under lock (closes the race between
  -- the pre-check above and acquiring this lock).
  if v_stripe_id is not null
     and v_refund.stripe_refund_id is not null
     and v_refund.stripe_refund_id <> v_stripe_id
  then
    raise exception
      'Refund % already has a different stripe_refund_id (%) than supplied (%)',
      v_refund.id, v_refund.stripe_refund_id, v_stripe_id;
  end if;

  v_prior_status := v_refund.status;

  -- Terminal rows are frozen -- a replay or an out-of-order stale event
  -- (in any direction: terminal->terminal, or a stale non-terminal event
  -- arriving after a terminal one already landed) must never move a
  -- terminal row. This mirrors, and is backed by, the DB-level immutability
  -- trigger -- this short-circuit exists so a legitimate replay reports a
  -- clean no-op instead of surfacing an error to the caller.
  if v_prior_status in ('succeeded', 'failed', 'canceled') then
    return query
      select v_refund.id, v_refund.invoice_payment_id, v_refund.invoice_id,
             v_refund.status, v_refund.amount, v_refund.project_id, v_refund.contact_id, false;
    return;
  end if;

  update public.invoice_payment_refunds
  set
    status = p_status,
    stripe_refund_id = coalesce(stripe_refund_id, v_stripe_id),
    stripe_failure_reason = case when p_status = 'failed' then coalesce(p_failure_reason, stripe_failure_reason) else stripe_failure_reason end,
    succeeded_at = case when p_status = 'succeeded' and succeeded_at is null then now() else succeeded_at end,
    failed_at = case when p_status = 'failed' and failed_at is null then now() else failed_at end
  where id = v_refund.id
  returning * into v_refund;

  return query
    select v_refund.id, v_refund.invoice_payment_id, v_refund.invoice_id,
           v_refund.status, v_refund.amount, v_refund.project_id, v_refund.contact_id,
           (v_prior_status <> v_refund.status);
end;
$$;

revoke all on function public.apply_invoice_payment_refund_result(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_invoice_payment_refund_result(uuid, uuid, text, text, text)
  to service_role;

-- ============================================================================
-- 10. record_invoice_payment_refund_stripe_key() -- persist the outbound
--     Stripe idempotency key used, for audit/support only
-- ============================================================================
--
-- CRITICAL FIX (this rewrite, pass 2 -- final hardening before manual
-- apply): the previous version's write-once check was status-agnostic --
-- it allowed a TERMINAL row with stripe_idempotency_key still NULL to
-- receive its first write, which is exactly the gap just closed in
-- enforce_invoice_payment_refund_immutability() above. This RPC must agree
-- with that trigger's now-terminal-aware model, and fail with the SAME
-- named application error the trigger would eventually raise anyway --
-- never rely on the trigger alone to catch what this RPC could reject
-- first with a clearer message.
--
-- Corrected model, now branched explicitly on the row's current status:
--   TERMINAL (succeeded/failed/canceled):
--     existing key == supplied key -> idempotent no-op (a legitimate
--       replay of the same recording call after the refund already
--       resolved).
--     existing key IS NULL -> rejected. A terminal row must never receive
--       its first stripe_idempotency_key write after the fact.
--     existing key <> supplied key -> rejected.
--   NON-TERMINAL (pending/requires_action): unchanged write-once
--     semantics -- NULL -> a key is written; same key again is an
--     idempotent no-op; a different key is rejected.
create or replace function public.record_invoice_payment_refund_stripe_key(
  p_org_id uuid,
  p_refund_id uuid,
  p_stripe_idempotency_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing text;
  v_status text;
begin
  if p_org_id is null then
    raise exception 'org_id is required';
  end if;
  if p_refund_id is null then
    raise exception 'refund_id is required';
  end if;

  p_stripe_idempotency_key := btrim(p_stripe_idempotency_key);
  if p_stripe_idempotency_key is null or p_stripe_idempotency_key = '' then
    raise exception 'stripe_idempotency_key is required';
  end if;

  select stripe_idempotency_key, status
    into v_existing, v_status
    from public.invoice_payment_refunds
   where id = p_refund_id and org_id = p_org_id
   for update;

  if not found then
    raise exception 'Refund not found for this org';
  end if;

  if v_status in ('succeeded', 'failed', 'canceled') then
    -- Terminal: idempotent only for an exact replay of the same key;
    -- never a first write, never a differing one.
    if v_existing is not null and v_existing = p_stripe_idempotency_key then
      return;
    end if;
    raise exception
      'Refund % is % and terminal -- stripe_idempotency_key cannot be set or changed', p_refund_id, v_status;
  end if;

  if v_existing is not null then
    if v_existing = p_stripe_idempotency_key then
      -- Idempotent no-op: the same key was already recorded.
      return;
    end if;
    raise exception
      'stripe_idempotency_key was already set to a different value for this refund';
  end if;

  update public.invoice_payment_refunds
  set stripe_idempotency_key = p_stripe_idempotency_key
  where id = p_refund_id
    and org_id = p_org_id;
end;
$$;

revoke all on function public.record_invoice_payment_refund_stripe_key(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_invoice_payment_refund_stripe_key(uuid, uuid, text)
  to service_role;

commit;

-- ============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- Run these manually AFTER applying the migration. All read-only -- none
-- of these mutate data.
-- ============================================================================

-- 1. Table exists.
-- select to_regclass('public.invoice_payment_refunds');

-- 2. Triggers attached.
-- select tgname from pg_trigger
--  where tgrelid = 'public.invoice_payment_refunds'::regclass and not tgisinternal
--  order by tgname;
-- Expected: trg_enforce_invoice_payment_refund_immutability,
--           trg_invoice_payment_refunds_updated_at,
--           trg_sync_invoice_amount_paid_from_refund,
--           trg_validate_invoice_payment_refund_org

-- 3. RLS policy.
-- select policyname, roles, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'invoice_payment_refunds';
-- Expected: invoice_payment_refunds_select / SELECT / {authenticated}

-- 4. Ordinary users cannot mutate the refund ledger.
-- select
--   has_table_privilege('authenticated', 'public.invoice_payment_refunds', 'INSERT') as authenticated_insert,
--   has_table_privilege('authenticated', 'public.invoice_payment_refunds', 'UPDATE') as authenticated_update,
--   has_table_privilege('authenticated', 'public.invoice_payment_refunds', 'DELETE') as authenticated_delete,
--   has_table_privilege('service_role', 'public.invoice_payment_refunds', 'INSERT') as service_role_insert;
-- Expected: false, false, false, true

-- 5. New RPCs exist EXACTLY ONCE, are SECURITY DEFINER, and are granted to
--    service_role only (never anon/authenticated).
-- select p.proname, count(*) as overload_count, bool_and(p.prosecdef) as all_security_definer
--  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in (
--    'create_invoice_payment_refund_request',
--    'apply_invoice_payment_refund_result',
--    'record_invoice_payment_refund_stripe_key',
--    'recompute_invoice_amount_paid'
--  )
--  group by p.proname order by p.proname;
-- Expected: overload_count = 1 for each, all_security_definer = true for each.

-- select grantee, routine_name, privilege_type from information_schema.role_routine_grants
--  where routine_schema = 'public' and routine_name in (
--    'create_invoice_payment_refund_request',
--    'apply_invoice_payment_refund_result',
--    'record_invoice_payment_refund_stripe_key'
--  ) order by routine_name, grantee;
-- Expected: only service_role, EXECUTE, for each -- no row for anon, authenticated, or public.

-- 6. Unique indexes present.
-- select indexname from pg_indexes where schemaname = 'public'
--  and tablename = 'invoice_payment_refunds'
--  and indexname in ('uq_invoice_payment_refunds_org_idempotency', 'uq_invoice_payment_refunds_stripe_refund_id');

-- 7. CRITICAL -- prove the LIVE recompute_invoice_amount_paid() actually
--    contains the Phase 13.10 reversal-aware CASE expression, not the
--    regressed flat-sum formula from the first draft.
-- select
--   pg_get_functiondef(oid) like '%reverses_payment_id%' as has_reversal_handling,
--   pg_get_functiondef(oid) like '%invoice_payment_refunds%' as subtracts_stripe_refunds
-- from pg_proc where proname = 'recompute_invoice_amount_paid';
-- Expected: true, true for BOTH columns. If has_reversal_handling is
-- false, DO NOT proceed to use this migration in production -- it means
-- the regression is still present.

-- select pg_get_functiondef(oid) like '%recompute_invoice_amount_paid%' as delegates_to_shared_fn
--  from pg_proc where proname = 'sync_invoice_amount_paid';
-- Expected: true

-- 8. Payment-status validation invariant is actually present in the live
--    trigger function (not just selected-but-unused).
-- select pg_get_functiondef(oid) like '%payment_status <> ''succeeded''%' as enforces_succeeded_status
--  from pg_proc where proname = 'validate_invoice_payment_refund_org';
-- Expected: true

-- 9. Exact NULL-safe project/contact matching is present (not the
--    "only reject when NEW is non-null" bug from the first draft).
-- select
--   pg_get_functiondef(oid) like '%new.project_id is distinct from v_payment.project_id%' as exact_project_match,
--   pg_get_functiondef(oid) like '%new.contact_id is distinct from v_payment.contact_id%' as exact_contact_match
-- from pg_proc where proname = 'validate_invoice_payment_refund_org';
-- Expected: true, true

-- 10. Sanity: no existing invoice_payments row has status='refunded' (confirms
--     the dormant path was indeed never used, matching this migration's
--     stated assumption).
-- select count(*) from public.invoice_payments where status = 'refunded';
-- Expected: 0

-- 11. OPERATIONAL SANITY -- READ-ONLY. Run this BEFORE and immediately
--     AFTER applying the migration and diff the results by hand. Lists
--     every existing manual reversal pair and each pair's net contribution
--     under the reversal-aware formula. If invoices.amount_paid jumps for
--     any of these invoices after applying this migration, the reversal
--     formula regressed -- STOP and investigate before doing anything else.
--     This query does not mutate any data.
-- select
--   i.id as invoice_id,
--   i.invoice_number,
--   i.amount_paid as current_amount_paid,
--   orig.id as original_payment_id,
--   orig.amount as original_amount,
--   rev.id as reversal_payment_id,
--   rev.amount as reversal_amount,
--   (orig.amount - rev.amount) as net_contribution_expected_zero
-- from public.invoice_payments rev
-- join public.invoice_payments orig on orig.id = rev.reverses_payment_id
-- join public.invoices i on i.id = rev.invoice_id
-- where rev.reverses_payment_id is not null
--   and rev.status = 'succeeded'
--   and orig.status = 'succeeded'
-- order by i.invoice_number;
-- Expected: net_contribution_expected_zero = 0.00 for every row, both
-- before and after applying this migration.
