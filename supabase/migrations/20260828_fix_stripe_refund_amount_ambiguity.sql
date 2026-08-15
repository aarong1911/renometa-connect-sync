-- 20260828_fix_stripe_refund_amount_ambiguity.sql
--
-- Phase 13.11A -- fix PL/pgSQL "column reference is ambiguous" errors in
-- the Stripe refund RPCs introduced by 20260827_stripe_refunds.sql.
--
-- 20260827 is APPLIED and HISTORICAL. This is a NEW migration, per this
-- repo's own rule that an applied migration is never edited again -- any
-- bug found after apply gets a new dated file. Does not touch, redefine,
-- or reference anything from 20260818 through 20260827 except by
-- CREATE OR REPLACE FUNCTION on two of 20260827's own functions, using the
-- exact same signatures.
--
-- ============================================================================
-- ROOT CAUSE
-- ============================================================================
--
-- create_invoice_payment_refund_request() declares:
--   returns table (
--     refund_id uuid, invoice_id uuid, invoice_payment_id uuid, status text,
--     amount numeric, stripe_refund_id text, provider_payment_id text,
--     already_exists boolean
--   )
--
-- Every one of those OUT column names becomes an implicitly-declared
-- PL/pgSQL variable inside the function body. The refundable-ceiling query:
--
--   select coalesce(sum(amount), 0) into v_reserved
--   from public.invoice_payment_refunds
--   where invoice_payment_id = p_payment_id
--     and status in ('pending', 'requires_action', 'succeeded');
--
-- bare-references THREE identifiers -- amount, invoice_payment_id, status --
-- that are simultaneously real columns on invoice_payment_refunds AND OUT
-- parameter names on this function. Postgres's default
-- plpgsql.variable_conflict=error setting refuses to guess which one is
-- meant and raises "column reference \"amount\" is ambiguous" (the first
-- one it hits) -- exactly the error surfaced by the live E2E attempt
-- against payment 61765453-e38e-488b-9c6d-d1d802adc562. This function was
-- never actually able to complete a ceiling check for ANY refund request,
-- live or otherwise -- the bug is 100% reproducible, not a rare race.
--
-- AUDIT OF OTHER PHASE 13.11 RPCs FOR THE SAME CLASS OF BUG
--
--   apply_invoice_payment_refund_result() -- ALSO AFFECTED. Its
--     RETURNS TABLE includes `invoice_id` as an OUT name. Two identity-
--     resolution queries bare-select `invoice_id` from
--     invoice_payment_refunds (once for p_local_refund_id, once for
--     p_stripe_refund_id):
--       select id, invoice_id, stripe_refund_id into v_by_local ...
--       select id, invoice_id, stripe_refund_id into v_by_stripe ...
--     `invoice_id` there is exactly the same ambiguity class as the bug
--     above. This is a LIVE latent bug, not theoretical -- it fires on
--     every normal call to this function (both the synchronous handler's
--     post-Stripe-call convergence and every webhook delivery), since
--     p_local_refund_id is always supplied by both callers. It has not
--     yet been observed only because the first bug in
--     create_invoice_payment_refund_request() prevented any refund from
--     ever reaching the point where apply_invoice_payment_refund_result()
--     is called. Fixed below in the same migration, same class of fix
--     (qualify every invoice_payment_refunds column reference with an
--     explicit table alias).
--
--   record_invoice_payment_refund_stripe_key() -- AUDITED, NOT AFFECTED.
--     `returns void` (no RETURNS TABLE / OUT parameters at all), and its
--     only bare column references (stripe_idempotency_key, status, id,
--     org_id) do not collide with any declared variable name (v_existing,
--     v_status) or parameter name (p_org_id, p_refund_id,
--     p_stripe_idempotency_key). Left unchanged -- CREATE OR REPLACE is
--     not repeated here for a function that needs no change.
--
--   recompute_invoice_amount_paid() -- AUDITED, NOT AFFECTED. `returns
--     void`, and every table reference already uses an explicit alias
--     (p./r./i.) for every column read, with no bare unqualified column
--     reference anywhere in the body. Left unchanged.
--
-- ============================================================================
-- FIX
-- ============================================================================
--
-- Both affected functions are replaced below with their EXACT existing
-- signatures and EXACT existing business behavior -- only bare
-- invoice_payment_refunds column references are qualified with an
-- explicit `r.` table alias (and `public.invoices` gets an explicit `i.`
-- alias in apply_invoice_payment_refund_result's lock statement, for the
-- same defensive consistency, though it was not itself ambiguous).
-- Preserved exactly, byte-for-byte in intent:
--   - invoice -> payment lock ordering
--   - same-key idempotency recheck AFTER locks
--   - pending/requires_action/succeeded reservation ceiling
--   - failed/canceled refund reservation release (by exclusion from the SUM)
--   - Stripe-only provider requirement
--   - original payment status='succeeded' requirement
--   - reverses_payment_id IS NULL requirement
--   - provider_payment_id required
--   - same key + changed payment/amount rejection
--   - unique-violation convergence behavior
--   - terminal-state short-circuit / freeze semantics in the convergence RPC
--   - stripe_refund_id dual-identity conflict detection
--   - RPC signatures (unchanged)
--   - SECURITY DEFINER (unchanged)
--   - search_path = public, pg_temp (unchanged)
--   - service_role-only EXECUTE grant (unchanged)
--
-- NOT applied automatically. Apply manually in the Supabase SQL Editor.
-- Do not run via `supabase db push`.

begin;

-- ============================================================================
-- 1. create_invoice_payment_refund_request() -- qualified
-- ============================================================================

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
  --
  -- FIX (Phase 13.11A): every column here is now qualified with the `r`
  -- alias. amount/invoice_payment_id/status were previously bare and
  -- collided with this function's own RETURNS TABLE OUT parameters of the
  -- exact same names -- the root cause of the live "column reference
  -- \"amount\" is ambiguous" error.
  select coalesce(sum(r.amount), 0) into v_reserved
    from public.invoice_payment_refunds as r
   where r.invoice_payment_id = p_payment_id
     and r.status in ('pending', 'requires_action', 'succeeded');

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
-- 2. apply_invoice_payment_refund_result() -- qualified
-- ============================================================================

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
  --
  -- FIX (Phase 13.11A): `invoice_id` was previously bare-selected here and
  -- collided with this function's own RETURNS TABLE OUT parameter of the
  -- same name -- the same ambiguity class as
  -- create_invoice_payment_refund_request()'s bug, latent in this
  -- function since it was never reached in the live E2E (the request-
  -- stage bug fired first). Every column is now qualified with the `r`
  -- alias.
  if p_local_refund_id is not null then
    select r.id, r.invoice_id, r.stripe_refund_id
      into v_by_local
      from public.invoice_payment_refunds as r
     where r.id = p_local_refund_id and r.org_id = p_org_id;
    if v_by_local.id is null then
      raise exception 'Refund not found for this org (local_refund_id=%)', p_local_refund_id;
    end if;
  end if;

  if v_stripe_id is not null then
    select r.id, r.invoice_id, r.stripe_refund_id
      into v_by_stripe
      from public.invoice_payment_refunds as r
     where r.stripe_refund_id = v_stripe_id and r.org_id = p_org_id;
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
  -- RPC), then the refund row itself. `i` alias added for defensive
  -- consistency -- id/org_id here were never actually ambiguous (neither
  -- name matches an OUT parameter of this function), left unqualified
  -- would have been fine, but qualifying costs nothing and matches every
  -- other query in this function now being explicit.
  perform 1 from public.invoices as i where i.id = v_invoice_id_lookup and i.org_id = p_org_id for update;

  if p_local_refund_id is not null then
    select * into v_refund
      from public.invoice_payment_refunds as r
     where r.id = p_local_refund_id and r.org_id = p_org_id
     for update;
  else
    select * into v_refund
      from public.invoice_payment_refunds as r
     where r.stripe_refund_id = v_stripe_id and r.org_id = p_org_id
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

  -- FIX (Phase 13.11A): explicit `r` alias added on the UPDATE target so
  -- every value expression that reads the row's own current column
  -- values (stripe_refund_id/stripe_failure_reason/succeeded_at/
  -- failed_at) is qualified too. None of those four were actually
  -- ambiguous against this function's OUT names, but qualifying them
  -- removes any doubt and matches the same defensive standard applied to
  -- every other query in this function in this pass.
  update public.invoice_payment_refunds as r
  set
    status = p_status,
    stripe_refund_id = coalesce(r.stripe_refund_id, v_stripe_id),
    stripe_failure_reason = case when p_status = 'failed' then coalesce(p_failure_reason, r.stripe_failure_reason) else r.stripe_failure_reason end,
    succeeded_at = case when p_status = 'succeeded' and r.succeeded_at is null then now() else r.succeeded_at end,
    failed_at = case when p_status = 'failed' and r.failed_at is null then now() else r.failed_at end
  where r.id = v_refund.id
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

commit;

-- ============================================================================
-- PRE-RETRY, READ-ONLY VERIFICATION -- run these BEFORE retrying the
-- refund, to prove the failed attempt left no trace. NONE of these mutate
-- data. Uses the payment/invoice from the failed live E2E attempt:
--   payment_id       61765453-e38e-488b-9c6d-d1d802adc562
--   invoice           INV-2026-0808-735
--   payment amount    $25.00
--   intended refund   $5.00
-- ============================================================================

-- A. Any refund row(s) created against this payment by the failed attempt.
-- Expected: 0 rows. create_invoice_payment_refund_request() raised its
-- ambiguous-column exception INSIDE the function body, before its INSERT
-- ever ran -- the whole call rolled back, so no partial row should exist.
-- select
--   id,
--   amount,
--   status,
--   idempotency_key,
--   stripe_refund_id,
--   stripe_idempotency_key,
--   created_at
-- from public.invoice_payment_refunds
-- where invoice_payment_id = '61765453-e38e-488b-9c6d-d1d802adc562'
-- order by created_at desc;

-- B. Invoice amount_paid/status untouched -- still exactly what it was
-- before the failed attempt (a failed create_invoice_payment_refund_request
-- call never reaches recompute_invoice_amount_paid() at all).
-- select
--   i.id,
--   i.invoice_number,
--   i.amount_paid,
--   i.status
-- from public.invoices i
-- where i.invoice_number = 'INV-2026-0808-735';
-- Expected: amount_paid = 25.00, status = 'paid'.

-- C. No refund journal entry exists for this payment/invoice.
-- select
--   je.id,
--   je.entry_number,
--   je.source_type,
--   je.source_id,
--   je.posting_key,
--   je.status,
--   je.entry_date
-- from public.accounting_journal_entries je
-- where je.source_type = 'refund'
--   and je.source_id in (
--     select id from public.invoice_payment_refunds
--     where invoice_payment_id = '61765453-e38e-488b-9c6d-d1d802adc562'
--   );
-- Expected: 0 rows.

-- ============================================================================
-- POST-APPLY VERIFICATION -- run these AFTER applying this migration.
-- All read-only.
-- ============================================================================

-- 1. Both functions exist exactly once each, still SECURITY DEFINER.
-- select p.proname, count(*) as overload_count, bool_and(p.prosecdef) as all_security_definer
--  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in (
--    'create_invoice_payment_refund_request',
--    'apply_invoice_payment_refund_result'
--  )
--  group by p.proname order by p.proname;
-- Expected: overload_count = 1, all_security_definer = true, for both.

-- 2. Grants unchanged -- service_role only, no anon/authenticated EXECUTE.
-- select grantee, routine_name, privilege_type
-- from information_schema.role_routine_grants
-- where routine_schema = 'public'
--   and routine_name in ('create_invoice_payment_refund_request', 'apply_invoice_payment_refund_result')
-- order by routine_name, grantee;
-- Expected: only service_role / EXECUTE, for each.

-- 3. The live function definition now contains the qualified reference and
--    no longer contains the bare, ambiguous one.
-- select
--   pg_get_functiondef(oid) like '%sum(r.amount)%' as has_qualified_sum,
--   pg_get_functiondef(oid) like '%sum(amount)%' as still_has_unqualified_sum
-- from pg_proc where proname = 'create_invoice_payment_refund_request';
-- Expected: has_qualified_sum = true, still_has_unqualified_sum = false.

-- 4. Same check for the convergence RPC's previously-ambiguous invoice_id
--    references.
-- select
--   pg_get_functiondef(oid) like '%r.id, r.invoice_id, r.stripe_refund_id%' as has_qualified_identity_selects
-- from pg_proc where proname = 'apply_invoice_payment_refund_result';
-- Expected: true.

-- 5. RPC signatures unchanged (argument type lists match the original
--    20260827 signatures exactly).
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname in (
--   'create_invoice_payment_refund_request',
--   'apply_invoice_payment_refund_result'
-- )
-- order by p.proname;
-- Expected create_invoice_payment_refund_request:
--   uuid, uuid, numeric, text, text, uuid
-- Expected apply_invoice_payment_refund_result:
--   uuid, uuid, text, text, text
