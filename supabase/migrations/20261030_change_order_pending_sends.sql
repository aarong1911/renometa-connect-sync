-- 20261030_change_order_pending_sends.sql
--
-- Change Order email delivery: prepare the approval link BEFORE Gmail is
-- called, make it live only once the email has been delivered.
--
-- Why: change-order-send.ts now emails from the contractor's Gmail BEFORE
-- the Change Order is marked sent (a Gmail rejection must never leave a
-- false "sent" state). The approval link inside that email is only valid
-- once send_project_change_order() has written the version snapshot and
-- the access-token row — and validate_project_change_order_access_token()
-- (20260815) deliberately refuses a token before its snapshot exists, so a
-- link cannot be pre-issued in project_change_order_access_tokens. Without
-- this migration, a database failure after Gmail accepted the email left
-- the customer holding a link that did not work until the contractor
-- clicked Send again.
--
-- Design:
--   project_change_order_pending_sends  one row per emailed link, written
--     BEFORE the Gmail call (prepare_project_change_order_send). Holds only
--     the SHA-256 of the token, never the plaintext, plus a fingerprint of
--     the approval-relevant terms at the moment the email was built. It
--     grants nothing on its own: approve/reject/view still require a row in
--     project_change_order_access_tokens, exactly as before.
--   activate_project_change_order_send(token_hash)  runs the UNCHANGED
--     send_project_change_order() with that hash (snapshot, status
--     transition, token issue, prior-token revocation, "resent" audit row,
--     revision supersession — all in one transaction) and marks the pending
--     row activated — but only if the terms fingerprint still matches, so
--     the immutable snapshot the customer approves against is exactly what
--     was emailed. Idempotent and row-locked. Called (service role only) by
--     change-order-send.ts right after Gmail accepts, and by
--     change-order-data.ts / change-order-action.ts when the customer first
--     uses a link that is still pending. Only the delivered email contains
--     the plaintext token, so presenting it is proof of delivery — which is
--     exactly the condition for marking the Change Order sent.
--   change_order_terms_fingerprint(change_order_id)  SHA-256 of a canonical
--     jsonb of every approval-relevant field (see the function).
--
-- Unchanged: send_project_change_order(), enforce_change_order_lifecycle(),
-- validate_project_change_order_access_token(), calculate_change_order_totals(),
-- the access-token, versions and approvals tables, approve/reject RPCs, RLS
-- on every existing table, and every existing approval link (existing tokens
-- never have a pending row, so activation returns 'not_pending' and nothing
-- else differs). No status can move backwards: nothing here un-sends.
--
-- Rollback (if needed after apply, BEFORE any Netlify code depending on it
-- is live — or after reverting that code):
--   drop function if exists public.activate_project_change_order_send(text);
--   drop function if exists public.prepare_project_change_order_send(uuid, uuid, uuid, text, timestamptz);
--   drop function if exists public.change_order_terms_fingerprint(uuid);
--   drop table if exists public.project_change_order_pending_sends;
-- Dropping the table discards any links that were emailed but never
-- activated; activated links live in project_change_order_access_tokens
-- and are unaffected.
--
-- Status: written for review. NOT applied. Apply manually in the Supabase
-- SQL editor BEFORE deploying the matching Netlify functions (the new
-- change-order-send.ts calls prepare_project_change_order_send and fails
-- closed — nothing emailed — if it does not exist).

-- ============================================================================
-- 1. TERMS FINGERPRINT
-- ============================================================================
-- Everything a customer approves: identity/version, customer-facing text,
-- pricing configuration, the authoritative totals, every line item (in
-- display order) and the schedule/deadline terms, plus the project and the
-- project's client. Internal-only fields (internal_notes, reason,
-- internal_cost, internal_markup, phase/task links) are deliberately
-- excluded: editing them does not change what the customer agreed to.
-- jsonb's text output is canonical (keys sorted, whitespace normalized) and
-- numeric(p,s) columns have a fixed scale, so equal terms always hash equal.
-- sha256() is built in (PostgreSQL 11+); no pgcrypto dependency.
create or replace function public.change_order_terms_fingerprint(p_change_order_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'id', co.id,
    'orgId', co.org_id,
    'projectId', co.project_id,
    'clientId', p.client_id,
    'parentChangeOrderId', co.parent_change_order_id,
    'changeOrderNumber', co.change_order_number,
    'version', co.version,
    'title', co.title,
    'description', co.description,
    'customerMessage', co.customer_message,
    'currency', co.currency,
    'discountType', co.discount_type,
    'discountValue', co.discount_value,
    'markupType', co.markup_type,
    'markupValue', co.markup_value,
    'taxRate', co.tax_rate,
    'subtotal', t.subtotal,
    'discountAmount', t.discount_amount,
    'markupAmount', t.markup_amount,
    'taxAmount', t.tax_amount,
    'totalAmount', t.total_amount,
    'scheduleImpactDays', co.schedule_impact_days,
    'proposedStartDate', co.proposed_start_date,
    'proposedCompletionDate', co.proposed_completion_date,
    'approvalDueAt', co.approval_due_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', i."position",
        'itemType', i.item_type,
        'name', i.name,
        'description', i.description,
        'quantity', i.quantity,
        'unit', i.unit,
        'unitPrice', i.unit_price,
        'taxable', i.taxable
      ) order by i."position", i.id)
      from public.project_change_order_items i
      where i.change_order_id = co.id
    ), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  from public.project_change_orders co
  cross join lateral public.calculate_change_order_totals(co.id) t
  left join public.projects p on p.id = co.project_id
  where co.id = p_change_order_id
$$;

comment on function public.change_order_terms_fingerprint(uuid) is
  '20261030 -- SHA-256 of every approval-relevant Change Order term (text, pricing config, totals, line items, schedule/deadline, project/client). Used to refuse activating an emailed link whose terms changed after the email was built.';

revoke all on function public.change_order_terms_fingerprint(uuid) from public, anon, authenticated;
grant execute on function public.change_order_terms_fingerprint(uuid) to service_role;

-- ============================================================================
-- 2. TABLE (new — fails loudly if a table of this name already exists)
-- ============================================================================

create table public.project_change_order_pending_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid not null references public.project_change_orders(id) on delete cascade,
  version integer not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  -- change_order_terms_fingerprint() when the email was built. Activation
  -- refuses to make the link live if the terms no longer match.
  terms_fingerprint text not null,
  -- For the email body only (diagnostics); the fingerprint is what's enforced.
  expected_total_amount numeric not null,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz null,
  discarded_at timestamptz null,
  constraint project_change_order_pending_sends_token_hash_len check (length(token_hash) >= 32),
  constraint project_change_order_pending_sends_fingerprint_len check (length(terms_fingerprint) = 64),
  constraint project_change_order_pending_sends_single_outcome check (activated_at is null or discarded_at is null)
);

comment on table public.project_change_order_pending_sends is
  '20261030 -- one row per Change Order approval link that has been emailed (or is being emailed) but not yet made live. Stores only the SHA-256 token hash. Rows grant no access by themselves; activate_project_change_order_send() turns one into a real project_change_order_access_tokens row via send_project_change_order(). Service-role only: RLS enabled with no policies and no anon/authenticated table privileges.';

create index idx_project_change_order_pending_sends_co on public.project_change_order_pending_sends (change_order_id, created_at);

alter table public.project_change_order_pending_sends enable row level security;
-- No policies (default-deny), and — defense in depth beyond RLS, since
-- Supabase's default privileges grant new public tables to anon/authenticated —
-- no table privileges for those roles either.
revoke all on table public.project_change_order_pending_sends from public, anon, authenticated;
grant select, insert, update, delete on table public.project_change_order_pending_sends to service_role;

-- ============================================================================
-- 3. PREPARE (service_role only)
-- ============================================================================
-- Same caller validation as send_project_change_order(): org/actor supplied
-- by the Netlify function after it authenticated the user and checked the
-- change_orders "send" permission. Writes ONLY the pending row — no status
-- change, no snapshot, no live token, no revocation of existing links.
-- Returns the DB-authoritative title/number/total the email is built from,
-- read under the same row lock as the fingerprint.
create or replace function public.prepare_project_change_order_send(
  p_change_order_id uuid,
  p_org_id uuid,
  p_actor_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co public.project_change_orders%rowtype;
  v_totals record;
begin
  if p_org_id is null or p_actor_user_id is null then
    raise exception 'org_id and actor_user_id are required';
  end if;
  if not exists (
    select 1 from public.org_memberships where member_id = p_actor_user_id and org_id = p_org_id
    union
    select 1 from public.profiles where id = p_actor_user_id and organization_id = p_org_id
  ) then
    raise exception 'actor_user_id is not a member of the specified organization';
  end if;
  if p_token_hash is null or length(p_token_hash) < 32 then
    raise exception 'A valid token hash is required';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'Token expiry must be in the future';
  end if;

  -- Same lock order as send_project_change_order(): the Change Order row first.
  select * into v_co from public.project_change_orders where id = p_change_order_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Change Order not found in the specified organization';
  end if;
  if v_co.status not in ('ready_to_send', 'sent', 'viewed') then
    raise exception 'Cannot send a Change Order in "%" status', v_co.status;
  end if;

  select * into v_totals from public.calculate_change_order_totals(v_co.id);

  insert into public.project_change_order_pending_sends
    (org_id, project_id, change_order_id, version, token_hash, expires_at, terms_fingerprint, expected_total_amount, created_by)
  values
    (p_org_id, v_co.project_id, v_co.id, v_co.version, p_token_hash, p_expires_at,
     public.change_order_terms_fingerprint(v_co.id), v_totals.total_amount, p_actor_user_id);

  return jsonb_build_object(
    'version', v_co.version,
    'changeOrderNumber', v_co.change_order_number,
    'title', v_co.title,
    'totalAmount', v_totals.total_amount,
    'isFirstSend', v_co.status = 'ready_to_send'
  );
end;
$$;

comment on function public.prepare_project_change_order_send(uuid, uuid, uuid, text, timestamptz) is
  '20261030 -- service_role-only. Records a pending (not yet live) approval link, with a fingerprint of the approval-relevant terms, for a Change Order about to be emailed. Never changes status, never issues or revokes access tokens.';

revoke all on function public.prepare_project_change_order_send(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.prepare_project_change_order_send(uuid, uuid, uuid, text, timestamptz) to service_role;

-- ============================================================================
-- 4. ACTIVATE (service_role only)
-- ============================================================================
-- Lock order: Change Order row FIRST, then pending rows — the same order as
-- prepare (CO, then insert) and send_project_change_order (CO), so two
-- concurrent activations of different links for the same Change Order
-- cannot deadlock. A concurrent second activation of the SAME link waits on
-- the Change Order lock, then sees activated_at and returns already_active.
--
-- Returns {status}:
--   not_pending     no pending row for this hash (every pre-existing link)
--   already_active  activated earlier — idempotent no-op
--   activated       send_project_change_order() ran; {result} is its result
--   discarded       never delivered (Gmail rejected) or superseded by a newer
--                   activated link for the same Change Order
--   expired         the link's expiry passed before it was ever used
--   changed         the approval-relevant terms (or version) no longer match
--                   what was emailed — discarded, never made live
--   not_sendable    the Change Order left ready_to_send/sent/viewed
--                   (cancelled, approved via another link, ...) — discarded
-- Any exception from send_project_change_order() rolls the whole call back,
-- leaving the pending row pending.
create or replace function public.activate_project_change_order_send(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_change_order_id uuid;
  v_pending public.project_change_order_pending_sends%rowtype;
  v_co public.project_change_orders%rowtype;
  v_result jsonb;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    return jsonb_build_object('status', 'not_pending');
  end if;

  select change_order_id into v_change_order_id
    from public.project_change_order_pending_sends where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'not_pending');
  end if;

  select * into v_co from public.project_change_orders where id = v_change_order_id for update;
  select * into v_pending from public.project_change_order_pending_sends where token_hash = p_token_hash for update;
  if v_pending.id is null or v_co.id is null then
    -- Removed (cascade) between the unlocked read and the locks.
    return jsonb_build_object('status', 'not_pending');
  end if;

  if v_pending.activated_at is not null then
    return jsonb_build_object('status', 'already_active');
  end if;
  if v_pending.discarded_at is not null then
    return jsonb_build_object('status', 'discarded');
  end if;
  if v_pending.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  -- Tenant guard (the FKs and prepare() already guarantee it; never trust it implicitly).
  if v_co.org_id <> v_pending.org_id or v_co.project_id <> v_pending.project_id then
    update public.project_change_order_pending_sends set discarded_at = now() where id = v_pending.id;
    return jsonb_build_object('status', 'changed');
  end if;
  if v_co.status not in ('ready_to_send', 'sent', 'viewed') then
    update public.project_change_order_pending_sends set discarded_at = now() where id = v_pending.id;
    return jsonb_build_object('status', 'not_sendable');
  end if;
  if v_co.version <> v_pending.version
    or public.change_order_terms_fingerprint(v_co.id) is distinct from v_pending.terms_fingerprint
  then
    update public.project_change_order_pending_sends set discarded_at = now() where id = v_pending.id;
    return jsonb_build_object('status', 'changed');
  end if;

  if v_pending.created_by is null then
    raise exception 'The user who sent this Change Order no longer exists -- send it again';
  end if;

  -- The existing, unchanged transactional send: snapshot, status, token,
  -- revocation of earlier links, "resent" audit row, supersession. Its own
  -- membership/status/expiry checks still apply. The Change Order row is
  -- locked above, so the snapshot it builds has the fingerprinted terms.
  v_result := public.send_project_change_order(
    v_co.id, v_pending.org_id, v_pending.created_by, v_pending.token_hash, v_pending.expires_at
  );

  update public.project_change_order_pending_sends set activated_at = now() where id = v_pending.id;

  -- Older links for this Change Order that never went live are superseded
  -- (the newest activated link wins, matching resend semantics) — so a
  -- stale email from an earlier, unconfirmed attempt can never later revoke
  -- the link the customer is actually using.
  update public.project_change_order_pending_sends
    set discarded_at = now()
    where change_order_id = v_co.id and id <> v_pending.id
      and activated_at is null and discarded_at is null
      and created_at <= v_pending.created_at;

  return jsonb_build_object('status', 'activated', 'result', v_result);
end;
$$;

comment on function public.activate_project_change_order_send(text) is
  '20261030 -- service_role-only. Makes an emailed (pending) Change Order approval link live by running send_project_change_order() with its token hash, only if the approval-relevant terms still match what was emailed. Idempotent. Called after Gmail accepts the email, and on the customer''s first use of a still-pending link.';

revoke all on function public.activate_project_change_order_send(text) from public, anon, authenticated;
grant execute on function public.activate_project_change_order_send(text) to service_role;

-- ============================================================================
-- VERIFICATION (run AFTER applying, before deploying the Netlify functions)
-- ============================================================================
-- Full behavioral checks: supabase/verification/change_order_pending_sends_verification.sql
-- (local / non-production only). Quick read-only checks:
-- 1) Table + RLS with no policies, no anon/authenticated privileges:
--   select relname, relrowsecurity from pg_class where relname = 'project_change_order_pending_sends';
--   -- expect relrowsecurity = true
--   select count(*) from pg_policies where tablename = 'project_change_order_pending_sends';   -- expect 0
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'project_change_order_pending_sends' order by 1, 2;
--   -- expect only service_role (and the owner)
-- 2) Functions: SECURITY DEFINER (prepare/activate) with a pinned search_path:
--   select proname, prosecdef, proconfig from pg_proc
--    where proname in ('prepare_project_change_order_send','activate_project_change_order_send','change_order_terms_fingerprint');
--   -- expect prepare/activate prosecdef = true; all proconfig = {"search_path=public, pg_temp"}
-- 3) Grants — service_role only (no anon/authenticated/public):
--   select routine_name, grantee from information_schema.role_routine_grants
--    where routine_schema = 'public'
--      and routine_name in ('prepare_project_change_order_send','activate_project_change_order_send','change_order_terms_fingerprint')
--    order by 1, 2;
-- 4) Existing objects untouched (compare to the same query run BEFORE applying):
--   select md5(pg_get_functiondef('public.send_project_change_order(uuid,uuid,uuid,text,timestamptz)'::regprocedure));
--   select trigger_name from information_schema.triggers
--    where event_object_table in ('project_change_orders','project_change_order_access_tokens') order by 1;
-- 5) An unknown hash is a no-op:
--   select public.activate_project_change_order_send(repeat('0', 64));   -- {"status": "not_pending"}
--
-- Housekeeping (optional, any time): pending rows hold only hashes and are
-- removed with their Change Order. Old dead rows can be purged with:
--   delete from public.project_change_order_pending_sends
--    where (discarded_at is not null or expires_at < now()) and activated_at is null
--      and created_at < now() - interval '90 days';
