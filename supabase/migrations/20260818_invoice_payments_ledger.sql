-- Phase 13.4 follow-up -- Invoice Payment Ledger.
--
-- invoices.amount_paid has historically been the only record of cash
-- received. That means the system had no reliable payment dates, payment
-- methods, partial-payment history, provider transaction ids, refunds, or
-- auditable payment rows.
--
-- This migration adds an additive, org-scoped invoice_payments table as the
-- canonical payment ledger and keeps invoices.amount_paid / invoices.status
-- synchronized as a maintained compatibility cache.
--
-- Existing read paths that already trust invoices.amount_paid continue to
-- work, while new Financials logic can read invoice_payments directly for
-- real payment dates, methods, providers, and partial payments.
--
-- Trust boundary:
-- - authenticated users may SELECT payment rows for their own org
-- - authenticated users receive NO direct INSERT/UPDATE/DELETE policy
-- - all payment writes must go through trusted server-side code using the
--   service-role client after independently verifying org/invoice ownership
--
-- Historical compatibility:
-- - existing invoices.amount_paid > 0 are backfilled into one synthetic
--   source='legacy_import' payment row per invoice
-- - exact historical payment timing is not recoverable, so invoices.updated_at
--   is used only as the best available legacy timestamp and the source is
--   explicitly marked as imported
--
-- Additive only.
-- Does not modify any prior migration.
-- Safe to re-run: objects are created/replaced deterministically and the
-- historical backfill skips invoices that already have payment rows.
--
-- Do not run via supabase db push.
-- Apply manually in the Supabase SQL Editor.

begin;

-- ============================================================================
-- 1. INVOICE_PAYMENTS TABLE
-- ============================================================================

create table if not exists public.invoice_payments (
  id uuid primary key default gen_random_uuid(),

  org_id uuid not null
    references public.organizations(id)
    on delete cascade,

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

  status text not null default 'succeeded',

  payment_method text not null default 'other',

  provider text not null default 'manual',

  provider_payment_id text null,

  -- source describes how this ledger row entered the system:
  --
  -- manual
  --   staff-recorded payment through RenoMeta Connect
  --
  -- legacy_import
  --   one-time migration of pre-existing invoices.amount_paid
  --
  -- stripe_webhook
  --   reserved for Stripe-confirmed payments created from webhook events
  source text not null default 'manual',

  paid_at timestamptz not null default now(),

  reference text null,

  notes text null,

  created_by uuid null
    references public.profiles(id)
    on delete set null,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint invoice_payments_amount_positive
    check (amount > 0),

  constraint invoice_payments_status_check
    check (
      status in (
        'pending',
        'succeeded',
        'failed',
        'refunded',
        'voided'
      )
    ),

  constraint invoice_payments_method_check
    check (
      payment_method in (
        'cash',
        'check',
        'card',
        'ach',
        'bank_transfer',
        'other'
      )
    ),

  constraint invoice_payments_provider_check
    check (
      provider in (
        'manual',
        'stripe',
        'square',
        'other'
      )
    ),

  constraint invoice_payments_source_check
    check (
      source in (
        'manual',
        'legacy_import',
        'stripe_webhook'
      )
    )
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================

create index if not exists idx_invoice_payments_invoice
  on public.invoice_payments (
    invoice_id,
    paid_at desc
  );

create index if not exists idx_invoice_payments_org
  on public.invoice_payments (
    org_id,
    paid_at desc
  );

create index if not exists idx_invoice_payments_project
  on public.invoice_payments (project_id)
  where project_id is not null;

-- A provider transaction must not be recorded twice.
--
-- This is especially important for Stripe webhook retries.
-- Manual payments normally have provider_payment_id = null, so they are
-- unaffected by this unique index.
create unique index if not exists uq_invoice_payments_provider_txn
  on public.invoice_payments (
    provider,
    provider_payment_id
  )
  where provider_payment_id is not null;

-- ============================================================================
-- 3. CROSS-ORG / RELATIONSHIP VALIDATION
-- ============================================================================

create or replace function public.validate_invoice_payment_org()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_org_id uuid;
  v_invoice_project_id uuid;
  v_invoice_contact_id uuid;
begin
  select
    i.org_id,
    i.project_id,
    i.client_id
  into
    v_invoice_org_id,
    v_invoice_project_id,
    v_invoice_contact_id
  from public.invoices i
  where i.id = new.invoice_id;

  if v_invoice_org_id is null then
    raise exception
      'invoice_payments.invoice_id does not reference an existing invoice';
  end if;

  if v_invoice_org_id <> new.org_id then
    raise exception
      'invoice_payments.org_id must match the invoice''s own org_id';
  end if;

  -- If a project_id is supplied on the payment row, it must match the
  -- invoice's own linked Project.
  if new.project_id is not null
     and new.project_id is distinct from v_invoice_project_id then
    raise exception
      'invoice_payments.project_id must match the invoice''s project_id';
  end if;

  -- If a contact_id is supplied on the payment row, it must match the
  -- invoice's own client/contact.
  if new.contact_id is not null
     and new.contact_id is distinct from v_invoice_contact_id then
    raise exception
      'invoice_payments.contact_id must match the invoice''s client_id';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_invoice_payment_org
  on public.invoice_payments;

create trigger trg_validate_invoice_payment_org
  before insert or update
  on public.invoice_payments
  for each row
  execute function public.validate_invoice_payment_org();

-- ============================================================================
-- 4. UPDATED_AT TRIGGER
-- ============================================================================

create or replace function public.set_invoice_payments_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_invoice_payments_updated_at
  on public.invoice_payments;

create trigger trg_invoice_payments_updated_at
  before update
  on public.invoice_payments
  for each row
  execute function public.set_invoice_payments_updated_at();

-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================

alter table public.invoice_payments
  enable row level security;

drop policy if exists invoice_payments_select
  on public.invoice_payments;

create policy invoice_payments_select
  on public.invoice_payments
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

-- Intentionally NO insert/update/delete policy for authenticated users.
--
-- All payment mutations must go through trusted server-side functions using
-- the service-role key after re-verifying the authenticated user's org and
-- invoice ownership.
--
-- Explicitly remove ordinary browser privileges in case table defaults or
-- earlier grants make them available.

revoke insert, update, delete
  on public.invoice_payments
  from anon, authenticated;

grant select
  on public.invoice_payments
  to authenticated;

grant select, insert, update, delete
  on public.invoice_payments
  to service_role;

-- ============================================================================
-- 6. PAYMENT LEDGER -> INVOICE CACHE SYNCHRONIZATION
-- ============================================================================
--
-- invoice_payments is canonical.
--
-- invoices.amount_paid is maintained as a compatibility/cache field:
--
-- succeeded payments
-- MINUS
-- refunded payments
--
-- Invoice lifecycle rules:
--
-- draft / void / cancelled
--   never changed by payment-ledger synchronization
--
-- amount_paid = 0
--   partial/paid may fall back to sent after refund/void removes all cash
--
-- 0 < amount_paid < total_amount
--   partial
--
-- amount_paid >= total_amount
--   paid
--
-- Overdue remains derived at read time and is not persisted here.

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
  -- NEW is not populated for DELETE triggers, so handle DELETE explicitly.
  if tg_op = 'DELETE' then
    v_invoice_id := old.invoice_id;
  else
    v_invoice_id := new.invoice_id;
  end if;

  select
    coalesce(
      sum(p.amount)
      filter (where p.status = 'succeeded'),
      0
    )
    -
    coalesce(
      sum(p.amount)
      filter (where p.status = 'refunded'),
      0
    )
  into v_paid
  from public.invoice_payments p
  where p.invoice_id = v_invoice_id;

  if v_paid < 0 then
    v_paid := 0;
  end if;

  select
    i.total_amount,
    i.status
  into
    v_total,
    v_current_status
  from public.invoices i
  where i.id = v_invoice_id;

  -- The invoice may already have been deleted by ON DELETE CASCADE.
  if v_total is null then
    if tg_op = 'DELETE' then
      return old;
    end if;

    return new;
  end if;

  update public.invoices
  set
    amount_paid = v_paid,

    status = case
      -- Payments must never alter non-payable lifecycle states.
      when v_current_status in (
        'draft',
        'void',
        'cancelled'
      )
      then v_current_status

      -- Fully paid.
      when v_total > 0
           and v_paid >= v_total
      then 'paid'

      -- Partially paid.
      when v_paid > 0
           and v_paid < v_total
      then 'partial'

      -- A refund/void can reduce a previously partial/paid invoice back to
      -- zero collected. Restore it to issued/sent rather than leaving a
      -- financially impossible paid/partial state.
      when v_paid = 0
           and v_current_status in (
             'partial',
             'paid'
           )
      then 'sent'

      -- sent/viewed/etc. remain unchanged when payment state does not
      -- require a lifecycle transition.
      else v_current_status
    end,

    updated_at = now()

  where id = v_invoice_id;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_invoice_amount_paid
  on public.invoice_payments;

create trigger trg_sync_invoice_amount_paid
  after insert or update or delete
  on public.invoice_payments
  for each row
  execute function public.sync_invoice_amount_paid();

-- ============================================================================
-- 7. HISTORICAL BACKFILL
-- ============================================================================
--
-- Existing invoices may already have amount_paid > 0 from the pre-ledger
-- architecture.
--
-- Exact historical payment timing is not recoverable because invoices does
-- not have a dedicated paid_at field.
--
-- We therefore create ONE clearly-labelled synthetic payment per existing
-- invoice that:
--
-- - currently has amount_paid > 0
-- - does not already have invoice_payments rows
--
-- paid_at uses:
--   updated_at
--   then created_at
--   then now()
--
-- This is intentionally marked source='legacy_import' so future reporting
-- can distinguish approximate historical timing from actual payment dates.

insert into public.invoice_payments (
  org_id,
  invoice_id,
  project_id,
  contact_id,
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
select
  i.org_id,
  i.id,
  i.project_id,
  i.client_id,
  i.amount_paid,
  'usd',
  'succeeded',
  'other',
  'manual',
  null,
  'legacy_import',
  coalesce(
    i.updated_at,
    i.created_at,
    now()
  ),
  null,
  'Backfilled from invoices.amount_paid during Phase 13.4 invoice payment ledger migration. Exact original payment date and payment method are unknown.',
  null
from public.invoices i
where coalesce(i.amount_paid, 0) > 0
  and not exists (
    select 1
    from public.invoice_payments p
    where p.invoice_id = i.id
  );

commit;

-- ============================================================================
-- POST-DEPLOYMENT VERIFICATION
-- Run these manually AFTER the migration.
-- ============================================================================

-- 1. Confirm table exists.
--
-- select to_regclass('public.invoice_payments');

-- 2. Confirm triggers.
--
-- select
--   tgname
-- from pg_trigger
-- where tgrelid = 'public.invoice_payments'::regclass
--   and not tgisinternal
-- order by tgname;

-- Expected:
-- trg_invoice_payments_updated_at
-- trg_sync_invoice_amount_paid
-- trg_validate_invoice_payment_org

-- 3. Confirm RLS policies.
--
-- select
--   policyname,
--   roles,
--   cmd
-- from pg_policies
-- where schemaname = 'public'
--   and tablename = 'invoice_payments'
-- order by policyname;

-- Expected authenticated policy:
-- invoice_payments_select / SELECT

-- 4. Confirm ordinary users cannot mutate payment ledger.
--
-- select
--   has_table_privilege(
--     'anon',
--     'public.invoice_payments',
--     'INSERT'
--   ) as anon_insert,
--
--   has_table_privilege(
--     'authenticated',
--     'public.invoice_payments',
--     'INSERT'
--   ) as authenticated_insert,
--
--   has_table_privilege(
--     'authenticated',
--     'public.invoice_payments',
--     'UPDATE'
--   ) as authenticated_update,
--
--   has_table_privilege(
--     'authenticated',
--     'public.invoice_payments',
--     'DELETE'
--   ) as authenticated_delete,
--
--   has_table_privilege(
--     'service_role',
--     'public.invoice_payments',
--     'INSERT'
--   ) as service_role_insert;

-- Expected:
-- false
-- false
-- false
-- false
-- true

-- 5. Inspect any historical backfill.
--
-- select
--   p.id,
--   p.invoice_id,
--   p.amount,
--   p.status,
--   p.payment_method,
--   p.provider,
--   p.source,
--   p.paid_at
-- from public.invoice_payments p
-- where p.source = 'legacy_import'
-- order by p.paid_at desc;

-- 6. Confirm cache reconciliation.
--
-- select
--   i.id,
--   i.number,
--   i.total_amount,
--   i.amount_paid,
--   i.status,
--   coalesce(
--     sum(p.amount)
--       filter (where p.status = 'succeeded'),
--     0
--   )
--   -
--   coalesce(
--     sum(p.amount)
--       filter (where p.status = 'refunded'),
--     0
--   ) as ledger_net_paid
-- from public.invoices i
-- left join public.invoice_payments p
--   on p.invoice_id = i.id
-- group by
--   i.id,
--   i.number,
--   i.total_amount,
--   i.amount_paid,
--   i.status
-- order by i.created_at desc;

-- invoices.amount_paid should equal ledger_net_paid for every invoice that
-- has payment rows.