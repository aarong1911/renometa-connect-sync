-- Phase 13.9 hotfix
-- Fix ambiguous vendor_bill_id reference inside
-- record_vendor_payment_reversal().
--
-- 20260823 is already applied, so this correction is additive and
-- intentionally replaces only the affected function definition.

begin;

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

  /*
   * IMPORTANT:
   * vendor_bill_id is also the name of one of this function's
   * RETURNS TABLE output variables.
   *
   * Therefore all table-column references with that name must be
   * explicitly qualified with a table alias to avoid PL/pgSQL
   * ambiguity.
   */
  select vp.vendor_bill_id
    into v_bill_id_lookup
  from public.vendor_payments as vp
  where vp.id = p_payment_id
    and vp.org_id = p_org_id;

  if v_bill_id_lookup is null then
    raise exception
      'Vendor payment not found for this org';
  end if;

  /*
   * Lock the bill FIRST.
   * This preserves the same lock order used by record_vendor_payment()
   * and serializes payment/payment-reversal writes for the same bill.
   */
  select vb.*
    into v_bill
  from public.vendor_bills as vb
  where vb.id = v_bill_id_lookup
    and vb.org_id = p_org_id
  for update;

  if v_bill.id is null then
    raise exception
      'Bill not found for this org';
  end if;

  /*
   * Then lock the original vendor payment.
   */
  select vp.*
    into v_orig
  from public.vendor_payments as vp
  where vp.id = p_payment_id
    and vp.org_id = p_org_id
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

  /*
   * Idempotent retry:
   * if this payment already has a reversal row, return it.
   */
  select vp.id
    into v_existing_reversal_id
  from public.vendor_payments as vp
  where vp.reverses_payment_id = p_payment_id;

  if v_existing_reversal_id is not null then
    select
      vb.status,
      vb.amount_paid
    into
      v_bill.status,
      v_bill.amount_paid
    from public.vendor_bills as vb
    where vb.id = v_orig.vendor_bill_id;

    return query
    select
      v_existing_reversal_id,
      v_orig.vendor_bill_id,
      v_bill.status,
      v_bill.amount_paid,
      true;

    return;
  end if;

  /*
   * Append-only reversal transaction.
   * The original successful payment remains untouched.
   */
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

  /*
   * trg_sync_vendor_bill_amount_paid has already recalculated the
   * canonical amount_paid/status as part of the INSERT above.
   */
  select
    vb.status,
    vb.amount_paid
  into
    v_bill.status,
    v_bill.amount_paid
  from public.vendor_bills as vb
  where vb.id = v_orig.vendor_bill_id;

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


-- Verification
select
  p.proname,
  p.prosecdef,
  pg_get_functiondef(p.oid)
from pg_proc as p
join pg_namespace as n
  on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'record_vendor_payment_reversal';