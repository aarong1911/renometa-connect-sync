-- Phase 13.10E -- CRITICAL FIX. PostgreSQL has no built-in MIN/MAX aggregate
-- for the `uuid` type (unlike most comparable types, uuid has no default
-- aggregate registered even though it has btree comparison operators via
-- its default opclass). 20260825_customer_credits_vendor_credits.sql (now
-- APPLIED and historical -- NOT edited here) used `min(<uuid column>)`
-- alongside `count(*)` in four functions purely to "pick the one account_id
-- when exactly one row exists" -- a real, live bug that breaks every
-- customer/vendor credit memo creation and finalization with:
--   "function min(uuid) does not exist"
--
-- Root cause confirmed by direct grep of the applied migration: exactly six
-- `min(<uuid>)` call sites, all inside Phase 13.10 credit functions, none
-- elsewhere in the schema.
--
-- Fix: `create or replace function` for the four affected functions,
-- splitting each `select count(*), min(x) into v_count, v_id ...` into two
-- separate statements -- `select count(*) into v_count ...` (unchanged
-- exactly-one enforcement, still raises before any account is trusted) then
-- `select x into v_id ... limit 1` (safe once the exactly-one check has
-- already passed; a `limit 1` is not aggregation, so it never touches the
-- missing uuid-aggregate code path). No `::text` cast trick used -- this
-- preserves normal PL/pgSQL scalar-select semantics rather than routing
-- through NEVER an aggregate at all.
--
-- Every other line of these four functions -- locking, idempotency
-- fingerprinting, race handling, JE content verification, reserved-vs-
-- effective balance formulas, lock ordering -- is reproduced byte-for-byte
-- unchanged; this migration touches ONLY the six uuid-aggregate call
-- sites and nothing else. No table/column/constraint/index/RLS/grant
-- changes; no other function touched.
--
-- Signatures are IDENTICAL to the applied versions (same names, same
-- parameter names/types/order, same return shape), so `create or replace
-- function` cleanly replaces each in place -- no stale overload, no new
-- revoke/grant strictly required, though the existing grants are re-stated
-- below anyway for self-documentation/consistency with this codebase's
-- established pattern.
--
-- NOT applied automatically. Review and run manually in the Supabase SQL
-- Editor. Does NOT touch 20260825 or any earlier migration file.

begin;

-- ============================================================================
-- 1. validate_customer_credit_memo_line_dimensions() -- trigger on
--    customer_credit_memo_lines. Fixes the min(jel.account_id) call used to
--    derive the invoice's single expected revenue account for comparison.
-- ============================================================================
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

  -- Phase 13.10E fix -- count(*) alone first (exactly-one enforcement
  -- unchanged); the account_id itself is fetched via a separate plain
  -- SELECT ... LIMIT 1 only after that check passes, never via min(uuid).
  select count(*) into v_revenue_line_count
    from public.accounting_journal_entry_lines as jel
    where jel.journal_entry_id = v_issued_entry_id and jel.credit > 0;
  if v_revenue_line_count <> 1 then
    raise exception 'Cannot verify a single revenue account for invoice % -- % revenue credit line(s) found on its issued entry (expected exactly 1)', v_memo_invoice_id, v_revenue_line_count;
  end if;

  select jel.account_id into v_expected_revenue_account_id
    from public.accounting_journal_entry_lines as jel
    where jel.journal_entry_id = v_issued_entry_id and jel.credit > 0
    limit 1;

  if new.revenue_account_id <> v_expected_revenue_account_id then
    raise exception 'revenue_account_id must match the original invoice''s own posted revenue account';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_customer_credit_memo_line_dimensions() from public, anon, authenticated;

-- ============================================================================
-- 2. record_customer_credit_memo() -- fixes the min(jel.account_id) call
--    used to derive the invoice's single revenue account when preparing a
--    new draft credit memo. Every other line (idempotency fingerprint,
--    invoice lock, reserved-balance ceiling, race handling, numbering) is
--    reproduced unchanged from the applied version.
-- ============================================================================
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

  -- Phase 13.10E fix -- count(*) alone first (exactly-one enforcement
  -- unchanged); the account_id is fetched via a separate plain
  -- SELECT ... LIMIT 1 only after that check passes, never via min(uuid).
  select count(*)
    into v_revenue_line_count
    from public.accounting_journal_entry_lines as jel
   where jel.journal_entry_id = v_issued_entry_id
     and jel.credit > 0;
  if v_revenue_line_count <> 1 then
    raise exception 'Cannot derive a single revenue account for invoice % -- % revenue credit line(s) found on its issued entry (expected exactly 1); unsupported account allocation for this phase', p_invoice_id, v_revenue_line_count;
  end if;

  select jel.account_id
    into v_revenue_account_id
    from public.accounting_journal_entry_lines as jel
   where jel.journal_entry_id = v_issued_entry_id
     and jel.credit > 0
   limit 1;

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

-- ============================================================================
-- 3. finalize_customer_credit_memo() -- fixes TWO min(uuid) calls:
--    min(ccml.revenue_account_id) (the memo's own line account) and
--    min(aa.id) (the org's canonical Accounts Receivable account, code
--    1100). Both exactly-one checks (line count, account count) are
--    preserved unchanged; only the follow-up id fetch changes shape.
-- ============================================================================
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

  -- Phase 13.10E fix -- count(*)/sum(amount) alone first (exactly-one line
  -- enforcement unchanged); the line's own revenue_account_id is fetched
  -- via a separate plain SELECT ... LIMIT 1 only after that check passes,
  -- never via min(uuid).
  select count(*), coalesce(sum(ccml.amount), 0)
    into v_credit_line_count, v_lines_total
    from public.customer_credit_memo_lines as ccml
   where ccml.credit_memo_id = p_credit_memo_id;
  if v_credit_line_count <> 1 then
    raise exception 'Credit memo % must have exactly one line in this phase; found %', coalesce(v_memo.credit_number, p_credit_memo_id::text), v_credit_line_count;
  end if;
  if v_lines_total <> v_memo.total_amount or v_lines_total <= 0 then
    raise exception 'Credit memo line total (%) does not match parent total (%) -- cannot finalize', v_lines_total, v_memo.total_amount;
  end if;

  select ccml.revenue_account_id
    into v_revenue_account_id
    from public.customer_credit_memo_lines as ccml
   where ccml.credit_memo_id = p_credit_memo_id
   limit 1;

  -- Phase 13.10E fix -- same principle for the canonical A/R account
  -- lookup (code 1100): count(*) alone first, exactly-one enforcement
  -- unchanged, then a separate plain SELECT ... LIMIT 1, never min(uuid).
  select count(*)
    into v_ar_account_count
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '1100'
     and aa.is_active = true;
  if v_ar_account_count <> 1 then
    raise exception 'Org % must have exactly one active Accounts Receivable account (code 1100); found %', p_org_id, v_ar_account_count;
  end if;

  select aa.id
    into v_ar_account_id
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '1100'
     and aa.is_active = true
   limit 1;

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
-- 4. finalize_vendor_credit() -- fixes TWO min(uuid) calls, mirroring
--    finalize_customer_credit_memo() exactly: min(vcl.account_id) (the
--    credit's own line account) and min(aa.id) (the org's canonical
--    Accounts Payable account, code 2000).
-- ============================================================================
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

  -- Phase 13.10E fix -- count(*)/sum(amount) alone first (exactly-one line
  -- enforcement unchanged); the line's own account_id is fetched via a
  -- separate plain SELECT ... LIMIT 1 only after that check passes, never
  -- via min(uuid).
  select count(*), coalesce(sum(vcl.amount), 0)
    into v_credit_line_count, v_lines_total
    from public.vendor_credit_lines as vcl
   where vcl.vendor_credit_id = p_vendor_credit_id;
  if v_credit_line_count <> 1 then
    raise exception 'Vendor credit % must have exactly one line in this phase; found %', coalesce(v_credit.credit_number, p_vendor_credit_id::text), v_credit_line_count;
  end if;
  if v_lines_total <> v_credit.total_amount or v_lines_total <= 0 then
    raise exception 'Vendor credit line total (%) does not match parent total (%) -- cannot finalize', v_lines_total, v_credit.total_amount;
  end if;

  select vcl.account_id
    into v_credit_account_id
    from public.vendor_credit_lines as vcl
   where vcl.vendor_credit_id = p_vendor_credit_id
   limit 1;

  -- Phase 13.10E fix -- same principle for the canonical A/P account
  -- lookup (code 2000): count(*) alone first, exactly-one enforcement
  -- unchanged, then a separate plain SELECT ... LIMIT 1, never min(uuid).
  select count(*)
    into v_ap_account_count
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '2000'
     and aa.is_active = true;
  if v_ap_account_count <> 1 then
    raise exception 'Org % must have exactly one active Accounts Payable account (code 2000); found %', p_org_id, v_ap_account_count;
  end if;

  select aa.id
    into v_ap_account_id
    from public.accounting_accounts as aa
   where aa.org_id = p_org_id
     and aa.code = '2000'
     and aa.is_active = true
   limit 1;

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

commit;

-- ============================================================================
-- Manual verification queries (run after applying, before use)
-- ============================================================================
-- 1. Confirm no min(uuid)/max(uuid) call sites remain in any of the four
--    fixed functions (this returns 0 rows for all four if clean):
-- select proname from pg_proc
--   where proname in ('validate_customer_credit_memo_line_dimensions','record_customer_credit_memo','finalize_customer_credit_memo','finalize_vendor_credit')
--     and (pg_get_functiondef(oid) ~* 'min\(\s*(jel\.account_id|ccml\.revenue_account_id|vcl\.account_id|aa\.id)\s*\)'
--       or pg_get_functiondef(oid) ~* 'max\(\s*(jel\.account_id|ccml\.revenue_account_id|vcl\.account_id|aa\.id)\s*\)');

-- 2. Confirm all four functions still exist with the exact same signatures.
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where proname in ('validate_customer_credit_memo_line_dimensions','record_customer_credit_memo','finalize_customer_credit_memo','finalize_vendor_credit')
--   order by proname;

-- 3. Confirm grants are still service_role-only for the two RPCs.
-- select grantee, routine_name, privilege_type from information_schema.role_routine_grants
--   where routine_name in ('record_customer_credit_memo','finalize_customer_credit_memo','finalize_vendor_credit')
--   order by routine_name, grantee;
-- Expect ONLY service_role rows.
