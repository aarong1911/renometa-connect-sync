-- Phase 13.3B -- Change Orders and Customer Approval Workflow.
--
-- Adds a full Change Order subsystem scoped to public.projects: draft
-- authoring, line items (positive/negative), pricing (discount/markup/tax),
-- schedule impact, immutable customer-facing snapshots, an append-only
-- approval/rejection audit trail, secure single-use-per-action approval
-- tokens, an idempotent financial-adjustment ledger so approved totals are
-- applied to Project Financials exactly once, and an additive
-- project_files.change_order_id linkage for attachments.
--
-- Mirrors the patterns already established for estimates (20260809):
-- guarded DDL, org-scoped RLS via the canonical
-- profiles.organization_id / org_memberships.org_id predicate,
-- same-org/same-project validation triggers, advisory-lock-guarded
-- server-side numbering (never client-side count+1), a real
-- trigger-owned + app-owned activity/approval log, and SECURITY DEFINER
-- RPCs for the two operations a public, unauthenticated customer must be
-- able to perform (approve / reject) without ever granting that customer
-- direct table access.
--
-- Additive only. Does not modify any prior migration (including
-- 20260813_project_execution_daily_logs_photos.sql or
-- 20260814_secure_project_media.sql). Every statement is guarded so
-- re-running this file is a no-op. Not applied automatically -- run
-- manually in the Supabase SQL Editor.
--
-- Revised for a pre-deployment security audit (this file has never been
-- applied, so this is an in-place revision, not a follow-up migration):
-- database-level immutability + explicit lifecycle-transition enforcement
-- (enforce_change_order_lifecycle()), relationship-validation triggers on
-- every child table, a transactional send/resend/supersession RPC
-- (send_project_change_order -- replaces direct multi-statement writes
-- from the Netlify function), a server-side exactly-once schedule-impact
-- RPC (apply_project_change_order_schedule_impact), and hardened
-- approve/reject RPCs that price off the immutable version snapshot
-- instead of the mutable row, drop the client-controllable p_source
-- parameter, and revoke every active token (not just the one used) on
-- a final decision.
--
-- Round 3 (final pre-deployment correction, same still-unapplied file):
-- send_project_change_order/cancel_project_change_order/apply_project_
-- change_order_schedule_impact are now service_role-only (not grantable
-- to authenticated) -- an authenticated browser client cannot invoke them
-- directly under any circumstances, closing the gap where a user-JWT-
-- scoped RPC could otherwise have been fed a caller-chosen financial
-- total or an arbitrary snapshot. Totals are now computed inside the
-- database by calculate_change_order_totals() from persisted line items,
-- and the customer-facing snapshot is built inside send_project_change_
-- order() from persisted rows -- neither is ever accepted as a parameter
-- from any caller. project_change_orders_update RLS now requires status
-- to be draft/internal_review/ready_to_send on BOTH sides (not just
-- USING), so ready_to_send->sent and any sent/viewed->* transition are
-- structurally impossible through ordinary UPDATE. The authenticated
-- INSERT policy on project_change_order_versions has been removed
-- entirely. cancelled/expired can no longer transition back to draft/sent
-- -- terminal states stay terminal; Create Revision is the only path
-- forward. See the "8. TRUST ARCHITECTURE" section below for the full
-- rationale.
--
-- Round 4 (final pre-deployment correction, same still-unapplied file):
-- an INSERT-time guard (enforce_change_order_insert_state()) now requires
-- every ordinary-client-created Change Order to start as a clean draft
-- with no lifecycle/approval state pre-set, and independently validates
-- revision lineage (version = parent.version + 1, same change_order_
-- number) for every caller. enforce_change_order_lifecycle() now locks
-- system-owned fields (change_order_number, version, every approval/
-- rejection/lifecycle timestamp and actor, schedule-impact application,
-- created_at/created_by) from ordinary callers at ALL times, including
-- while still draft -- previously an editable draft could smuggle
-- changes to these through. Change Order numbering is now (project_id,
-- change_order_number, version)-unique, matching the "CO-003 · Version 2"
-- customer-facing model; a new create_project_change_order_revision()
-- RPC (service_role-only) derives the new version/number from the real,
-- advisory-lock-guarded parent row rather than trusting a browser-
-- supplied value. Finally, approve_project_change_order() now reverses
-- any still-active financial adjustment elsewhere in the same lineage in
-- the same transaction it applies the newly-approved version's
-- adjustment, so a superseded-then-approved revision chain contributes
-- its latest approved amount exactly once to Revised Contract Value, not
-- the sum of every version ever approved.


-- Round 5 (final trust-boundary correction, same still-unapplied file):
-- ordinary authenticated INSERTs can no longer create revisions directly,
-- spoof created_by/updated_by, or choose their own initial CO number. Initial
-- Change Order numbering is always database-owned: for every non-revision
-- row, set_project_change_order_number() overwrites any caller-supplied number
-- under the Project-scoped advisory lock. Ordinary inserts are forced to be
-- version 1, parentless clean drafts, and enforce_change_order_insert_state()
-- stamps/validates created_by + updated_by against auth.uid(). Revision
-- creation remains service_role-only through create_project_change_order_
-- revision(), which now verifies the requested parent is the latest row in
-- the lineage after taking the lineage advisory lock and derives the next
-- version from max(version) + 1. Trigger behavior is intentionally order-
-- independent: the insert-state guard does not rely on the number being blank,
-- and the numbering trigger only rewrites non-revision numbers.

begin;

-- digest() (used by approve/reject RPCs below to hash the plaintext token)
-- is part of pgcrypto. Supabase installs this into the `extensions` schema
-- by default; this statement is a guarded no-op if it's already installed
-- anywhere (including a legacy `public` install some environments have).
-- Every function that calls digest() sets search_path to `public,
-- extensions, pg_temp` and calls it unqualified, so resolution works
-- correctly regardless of which schema it actually lives in here.
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1. PROJECT_CHANGE_ORDERS
-- ============================================================================

create table if not exists public.project_change_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_number text not null,
  title text not null,
  description text null,
  reason text null,
  internal_notes text null,
  customer_message text null,
  status text not null default 'draft',
  currency text not null default 'USD',
  subtotal numeric(14,2) not null default 0,
  discount_type text null,
  discount_value numeric(14,2) null,
  discount_amount numeric(14,2) not null default 0,
  tax_rate numeric(8,4) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  markup_type text null,
  markup_value numeric(14,2) null,
  markup_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  schedule_impact_days integer not null default 0,
  proposed_start_date date null,
  proposed_completion_date date null,
  approval_due_at timestamptz null,
  sent_at timestamptz null,
  first_viewed_at timestamptz null,
  approved_at timestamptz null,
  rejected_at timestamptz null,
  cancelled_at timestamptz null,
  expired_at timestamptz null,
  superseded_at timestamptz null,
  approved_by_name text null,
  approved_by_email text null,
  rejected_by_name text null,
  rejected_by_email text null,
  approval_source text null,
  rejection_reason text null,
  is_customer_visible boolean not null default false,
  is_field_visible boolean not null default false,
  source text not null default 'connect',
  version integer not null default 1,
  parent_change_order_id uuid null references public.project_change_orders(id) on delete set null,
  schedule_impact_applied_at timestamptz null,
  schedule_impact_applied_by uuid null references public.profiles(id) on delete set null,
  schedule_impact_application jsonb null,
  created_by uuid null references public.profiles(id) on delete set null,
  updated_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_change_orders is
  'Phase 13.3B -- a Project scope/price/schedule amendment. May be positive, zero, or negative (credit). Sent/approved content is snapshotted immutably in project_change_order_versions -- draft edits after sending require a new version/revision, never a silent overwrite.';
comment on column public.project_change_orders.total_amount is
  'Authoritative total, always recalculated server-side (never trusted from the browser) before persistence and before approval. May be negative.';
comment on column public.project_change_orders.schedule_impact_days is
  'Signed day delta. Recording this does not by itself shift any Task/phase/milestone -- see schedule_impact_applied_at for the explicit, user-confirmed application step.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_status_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_status_check
      check (status in (
        'draft', 'internal_review', 'ready_to_send', 'sent', 'viewed',
        'approved', 'rejected', 'cancelled', 'expired', 'superseded'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_source_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_source_check
      check (source in ('connect', 'portal', 'field'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_currency_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_currency_check
      check (currency ~ '^[A-Z]{3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_discount_type_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_discount_type_check
      check (discount_type is null or discount_type in ('percentage', 'fixed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_markup_type_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_markup_type_check
      check (markup_type is null or markup_type in ('percentage', 'fixed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_tax_rate_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_tax_rate_check
      check (tax_rate >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_version_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_version_check
      check (version >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_approved_consistency_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_approved_consistency_check
      check (status <> 'approved' or approved_at is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_rejected_consistency_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_rejected_consistency_check
      check (status <> 'rejected' or rejected_at is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_not_both_approved_rejected_check' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_not_both_approved_rejected_check
      check (approved_at is null or rejected_at is null);
  end if;
end $$;

-- Security audit (round 4): a Change Order lineage is a business-facing
-- number (CO-003) shared by every revision, distinguished by version
-- (CO-003 v1, CO-003 v2, ...) -- (project_id, change_order_number) alone
-- is no longer unique now that revisions exist, so a revision would
-- collide against its own parent. (project_id, change_order_number,
-- version) is the real uniqueness boundary, and is also what
-- create_project_change_order_revision()'s advisory lock protects against
-- concurrent duplication of.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'project_change_orders_number_unique' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders drop constraint project_change_orders_number_unique;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_orders_number_version_unique' and conrelid = 'public.project_change_orders'::regclass) then
    alter table public.project_change_orders
      add constraint project_change_orders_number_version_unique unique (project_id, change_order_number, version);
  end if;
end $$;

-- ── same-project/same-org validation (mirror validate_estimate_relationships) ──
create or replace function public.validate_project_change_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.org_id is null then
    raise exception 'project_change_orders.org_id is required';
  end if;

  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'Change Order project does not belong to this organization';
  end if;

  if new.created_by is not null and not exists (
    select 1 from public.org_memberships where member_id = new.created_by and org_id = new.org_id
    union
    select 1 from public.profiles where id = new.created_by and organization_id = new.org_id
  ) then
    raise exception 'Change Order creator is not a member of this organization';
  end if;

  if new.updated_by is not null and not exists (
    select 1 from public.org_memberships where member_id = new.updated_by and org_id = new.org_id
    union
    select 1 from public.profiles where id = new.updated_by and organization_id = new.org_id
  ) then
    raise exception 'Change Order updater is not a member of this organization';
  end if;

  if new.parent_change_order_id is not null and not exists (
    select 1 from public.project_change_orders co
    where co.id = new.parent_change_order_id and co.project_id = new.project_id and co.org_id = new.org_id
  ) then
    raise exception 'Parent Change Order does not belong to this Project';
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_orders_validate on public.project_change_orders;
create trigger project_change_orders_validate
  before insert or update of org_id, project_id, created_by, updated_by, parent_change_order_id on public.project_change_orders
  for each row
  execute function public.validate_project_change_order();

-- ── INSERT-time state guard (security audit, round 4) ────────────────────
-- An ordinary authenticated client must never be able to INSERT a Change
-- Order that is already sent/viewed/approved/rejected/cancelled/expired/
-- superseded, or that already carries approval/lifecycle state. current_
-- user reliably distinguishes an ordinary PostgREST-routed request
-- (which always executes AS the literal 'authenticated' or 'anon' role)
-- from a trusted SECURITY DEFINER function's execution (which, per
-- Postgres's own SECURITY DEFINER semantics, runs as the FUNCTION OWNER
-- for its entire duration, including any triggers it fires) -- this is
-- not a caller-settable bypass flag; a client cannot make itself appear
-- to be the function owner except by legitimately being granted EXECUTE
-- on that function in the first place, which is the real trust boundary.
--
-- Lineage/version consistency (new.version / new.change_order_number vs.
-- parent_change_order_id) is validated for EVERY caller, trusted or not
-- -- even create_project_change_order_revision() must not be able to
-- fabricate an inconsistent lineage; it and this trigger independently
-- agree on "version = parent.version + 1, same change_order_number".
create or replace function public.enforce_change_order_insert_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_trusted_caller boolean := current_user not in ('authenticated', 'anon');
  v_uid uuid := auth.uid();
  v_parent public.project_change_orders%rowtype;
begin
  if not v_is_trusted_caller then
    if v_uid is null then
      raise exception 'Authentication required to create a Change Order';
    end if;

    -- Ordinary application clients can create only brand-new lineage roots.
    -- Revisions must go through create_project_change_order_revision(), which
    -- is service_role-only and is fronted by the authenticated/permission-
    -- checked Netlify function.
    if new.parent_change_order_id is not null then
      raise exception 'Revisions must be created through the trusted revision workflow';
    end if;
    if new.version <> 1 then
      raise exception 'A new Change Order must start at version 1';
    end if;

    if new.status is distinct from 'draft' then
      raise exception 'New Change Orders must be created as draft';
    end if;
    if new.is_customer_visible is distinct from false then
      raise exception 'New Change Orders must not be created customer-visible';
    end if;
    if new.sent_at is not null or new.first_viewed_at is not null or new.approved_at is not null
      or new.rejected_at is not null or new.cancelled_at is not null or new.expired_at is not null
      or new.superseded_at is not null or new.approved_by_name is not null or new.approved_by_email is not null
      or new.rejected_by_name is not null or new.rejected_by_email is not null or new.approval_source is not null
      or new.rejection_reason is not null or new.schedule_impact_applied_at is not null
      or new.schedule_impact_applied_by is not null or new.schedule_impact_application is not null
    then
      raise exception 'New Change Orders cannot be created with lifecycle/approval state already set';
    end if;

    -- Audit ownership is never caller-attributable. Null is filled from the
    -- authenticated JWT; an attempt to name another org member is rejected.
    if new.created_by is null then
      new.created_by := v_uid;
    elsif new.created_by <> v_uid then
      raise exception 'created_by must match the authenticated user';
    end if;

    if new.updated_by is null then
      new.updated_by := v_uid;
    elsif new.updated_by <> v_uid then
      raise exception 'updated_by must match the authenticated user';
    end if;

    -- These timestamps are system-owned on ordinary creation. Assigning them
    -- here makes their provenance independent of browser-supplied values.
    new.created_at := now();
    new.updated_at := now();

    -- Ordinary Connect creation cannot impersonate Portal/Field provenance.
    new.source := 'connect';
  end if;

  -- Trusted callers may create revisions, but lineage integrity is still
  -- enforced independently of the trusted RPC as defense-in-depth.
  if new.parent_change_order_id is null then
    if new.version <> 1 then
      raise exception 'A new (non-revision) Change Order must start at version 1';
    end if;
  else
    select * into v_parent
      from public.project_change_orders
      where id = new.parent_change_order_id;
    if not found then
      raise exception 'Parent Change Order not found';
    end if;
    if new.org_id <> v_parent.org_id or new.project_id <> v_parent.project_id then
      raise exception 'A revision must stay in the parent Change Order organization and Project';
    end if;
    if new.version <> v_parent.version + 1 then
      raise exception 'A revision must be exactly one version ahead of its parent';
    end if;
    if new.change_order_number is distinct from v_parent.change_order_number then
      raise exception 'A revision must retain its parent''s Change Order number';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_orders_enforce_insert_state on public.project_change_orders;
create trigger project_change_orders_enforce_insert_state
  before insert on public.project_change_orders
  for each row
  execute function public.enforce_change_order_insert_state();

-- ── database-level immutability + lifecycle enforcement (security audit) ──
-- Three things happen here, deliberately in one trigger since all three
-- gate the same UPDATE:
--   1. Status transitions are checked against an explicit allow-list --
--      an ordinary UPDATE can never move a Change Order through an
--      unlisted transition (e.g. draft -> approved), regardless of RLS.
--   2. System-owned fields (change_order_number, version, every
--      approval/rejection/lifecycle timestamp and actor field, schedule-
--      impact application record, created_at/created_by) can NEVER be
--      changed by an ordinary authenticated/anon caller -- not even while
--      the Change Order is still draft/internal_review/ready_to_send
--      (security audit, round 4: the previous version of this trigger
--      returned immediately for editable drafts, which meant a draft's
--      own client-writable UPDATE could also smuggle in changes to these
--      fields). Only a trusted SECURITY DEFINER function may set them.
--   3. Once a Change Order has left draft/internal_review/ready_to_send,
--      customer-facing content/pricing/Project/org linkage also becomes
--      immutable.
--
-- "Trusted" here means current_user is not the literal 'authenticated' or
-- 'anon' role that every ordinary PostgREST-routed request executes as --
-- per Postgres's own SECURITY DEFINER semantics, a SECURITY DEFINER
-- function (and every trigger it fires) runs as the FUNCTION OWNER for
-- its entire execution, regardless of who called it. This is not a
-- caller-settable bypass flag: a client cannot make itself "the owner"
-- except by being granted EXECUTE on a specific trusted function, which
-- is the actual, unbypassable trust boundary (send/cancel/apply-schedule-
-- impact are service_role-only; approve/reject are token-gated and never
-- accept these fields as parameters).
create or replace function public.enforce_change_order_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_trusted_caller boolean := current_user not in ('authenticated', 'anon');
  v_editable_statuses text[] := array['draft', 'internal_review', 'ready_to_send'];
  -- Final-state hardening (security audit, round 3): cancelled/expired/
  -- rejected/approved/superseded are historical/auditable records, not
  -- reachable back into an editable state through this map -- there is no
  -- "restore to draft" transition anymore. A superseded/cancelled/expired/
  -- rejected/approved Change Order that needs new terms goes through
  -- Create Revision (a NEW row with parent_change_order_id set), never a
  -- resurrected old one.
  v_transitions jsonb := '{
    "draft": ["internal_review", "ready_to_send", "cancelled"],
    "internal_review": ["draft", "ready_to_send", "cancelled"],
    "ready_to_send": ["draft", "sent", "cancelled"],
    "sent": ["viewed", "approved", "rejected", "cancelled", "expired", "superseded"],
    "viewed": ["approved", "rejected", "cancelled", "expired", "superseded"],
    "approved": ["superseded"],
    "rejected": ["superseded"],
    "cancelled": [],
    "expired": [],
    "superseded": []
  }'::jsonb;
begin
  if new.status is distinct from old.status then
    if not (coalesce(v_transitions -> old.status, '[]'::jsonb) ? new.status) then
      raise exception 'Invalid Change Order status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- System-owned fields (round 4): locked from ordinary callers at ALL
  -- times, including while still draft/internal_review/ready_to_send.
  if not v_is_trusted_caller then
    if new.change_order_number is distinct from old.change_order_number
      or new.version is distinct from old.version
      or new.sent_at is distinct from old.sent_at
      or new.first_viewed_at is distinct from old.first_viewed_at
      or new.approved_at is distinct from old.approved_at
      or new.rejected_at is distinct from old.rejected_at
      or new.cancelled_at is distinct from old.cancelled_at
      or new.expired_at is distinct from old.expired_at
      or new.superseded_at is distinct from old.superseded_at
      or new.approved_by_name is distinct from old.approved_by_name
      or new.approved_by_email is distinct from old.approved_by_email
      or new.rejected_by_name is distinct from old.rejected_by_name
      or new.rejected_by_email is distinct from old.rejected_by_email
      or new.approval_source is distinct from old.approval_source
      or new.rejection_reason is distinct from old.rejection_reason
      or new.schedule_impact_applied_at is distinct from old.schedule_impact_applied_at
      or new.schedule_impact_applied_by is distinct from old.schedule_impact_applied_by
      or new.schedule_impact_application is distinct from old.schedule_impact_application
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by
    then
      raise exception 'This field is system-owned and cannot be modified directly';
    end if;
  end if;

  if old.status = any (v_editable_statuses) then
    return new;
  end if;

  if new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.reason is distinct from old.reason
    or new.internal_notes is distinct from old.internal_notes
    or new.customer_message is distinct from old.customer_message
    or new.currency is distinct from old.currency
    or new.subtotal is distinct from old.subtotal
    or new.discount_type is distinct from old.discount_type
    or new.discount_value is distinct from old.discount_value
    or new.discount_amount is distinct from old.discount_amount
    or new.tax_rate is distinct from old.tax_rate
    or new.tax_amount is distinct from old.tax_amount
    or new.markup_type is distinct from old.markup_type
    or new.markup_value is distinct from old.markup_value
    or new.markup_amount is distinct from old.markup_amount
    or new.total_amount is distinct from old.total_amount
    or new.schedule_impact_days is distinct from old.schedule_impact_days
    or new.proposed_start_date is distinct from old.proposed_start_date
    or new.proposed_completion_date is distinct from old.proposed_completion_date
    or new.approval_due_at is distinct from old.approval_due_at
    or new.is_field_visible is distinct from old.is_field_visible
    or new.org_id is distinct from old.org_id
    or new.project_id is distinct from old.project_id
    or new.parent_change_order_id is distinct from old.parent_change_order_id
    or new.source is distinct from old.source
  then
    raise exception 'This Change Order is no longer editable in status "%"', old.status;
  end if;

  return new;
end;
$$;

comment on function public.enforce_change_order_lifecycle() is
  'Security audit (post-13.3B) -- database-level immutability: once a Change Order leaves draft/internal_review/ready_to_send, only lifecycle/system columns may change, and only through an explicitly allowed status transition. Applies to every UPDATE regardless of caller (RLS-scoped authenticated user or SECURITY DEFINER RPC).';

drop trigger if exists project_change_orders_enforce_lifecycle on public.project_change_orders;
create trigger project_change_orders_enforce_lifecycle
  before update on public.project_change_orders
  for each row
  execute function public.enforce_change_order_lifecycle();

-- ── Project-scoped numbering (CO-001), advisory-lock guarded ────────────────
create or replace function public.set_project_change_order_number()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_next bigint;
begin
  -- Revisions inherit the parent business-facing number. The trusted
  -- create_project_change_order_revision() RPC derives that value and the
  -- insert-state trigger independently validates it. Never consume a new CO
  -- number for a revision.
  if new.parent_change_order_id is not null then
    return new;
  end if;

  -- Initial Change Order numbers are ALWAYS database-owned. Deliberately
  -- overwrite any caller-supplied value rather than trusting CO-999/etc.
  perform pg_advisory_xact_lock(hashtext('change_order_number:' || new.project_id::text));

  select coalesce(max(substring(change_order_number from 'CO-(\d+)')::bigint), 0) + 1
    into v_next
    from public.project_change_orders
    where project_id = new.project_id
      and version = 1
      and change_order_number ~ '^CO-\d+$';

  new.change_order_number := 'CO-' || lpad(v_next::text, 3, '0');
  return new;
end;
$$;

comment on function public.set_project_change_order_number() is
  'Phase 13.3B -- database-owned Project-scoped CO numbering. Every non-revision INSERT gets the next CO-### value under an advisory lock, overwriting any caller-supplied number. Revisions retain their parent number and do not consume a new sequence value.';

drop trigger if exists project_change_orders_set_number on public.project_change_orders;
create trigger project_change_orders_set_number
  before insert on public.project_change_orders
  for each row
  execute function public.set_project_change_order_number();

-- ── updated_at ───────────────────────────────────────────────────────────
create or replace function public.set_project_change_orders_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_change_orders_set_updated_at on public.project_change_orders;
create trigger project_change_orders_set_updated_at
  before update on public.project_change_orders
  for each row
  execute function public.set_project_change_orders_updated_at();

alter table public.project_change_orders enable row level security;

drop policy if exists project_change_orders_select on public.project_change_orders;
create policy project_change_orders_select on public.project_change_orders
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Security audit (round 4): RLS defense-in-depth alongside
-- enforce_change_order_insert_state() -- an ordinary authenticated INSERT
-- must produce a clean draft with no lifecycle/approval state already
-- set. The trigger is the precise authority (it also validates
-- version/change_order_number lineage against the real parent row, which
-- RLS cannot express); this policy is a coarser second layer that fails
-- the same class of attempt even earlier, before the trigger runs.
drop policy if exists project_change_orders_insert on public.project_change_orders;
create policy project_change_orders_insert on public.project_change_orders
  for insert to authenticated
  with check (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and parent_change_order_id is null
    and version = 1
    and created_by = auth.uid()
    and updated_by = auth.uid()
    and status = 'draft'
    and is_customer_visible = false
    and sent_at is null
    and first_viewed_at is null
    and approved_at is null
    and rejected_at is null
    and cancelled_at is null
    and expired_at is null
    and superseded_at is null
    and approved_by_name is null
    and approved_by_email is null
    and rejected_by_name is null
    and rejected_by_email is null
    and approval_source is null
    and rejection_reason is null
    and schedule_impact_applied_at is null
    and schedule_impact_applied_by is null
    and schedule_impact_application is null
  );

-- Security audit (round 3): ordinary authenticated UPDATE is now
-- restricted to the three genuinely-internal statuses on BOTH sides --
-- the row must already be draft/internal_review/ready_to_send (USING)
-- AND must still be one of those three after the write (WITH CHECK). This
-- is what actually prevents an authenticated client from ever performing
-- ready_to_send -> sent, sent/viewed -> approved/rejected/expired/
-- superseded, or a same-status "edit" of a sent/viewed/approved/rejected/
-- cancelled/expired/superseded row via plain UPDATE -- those are only
-- reachable through send_project_change_order() / cancel_project_change_
-- order() / apply_project_change_order_schedule_impact() /
-- approve_project_change_order() / reject_project_change_order(), all
-- SECURITY DEFINER and owned by the migration-running role, which bypass
-- RLS entirely and so are never blocked by this policy. Cancelling a
-- sent/viewed Change Order is therefore no longer a plain UPDATE at all
-- -- see cancel_project_change_order() below, which has its own
-- authorization/permission check and audit trail rather than relying on
-- a broadly-writable row.
drop policy if exists project_change_orders_update on public.project_change_orders;
create policy project_change_orders_update on public.project_change_orders
  for update to authenticated
  using (
    status in ('draft', 'internal_review', 'ready_to_send')
    and (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
  )
  with check (
    status in ('draft', 'internal_review', 'ready_to_send')
    and (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
  );

-- Only draft Change Orders may be deleted through ordinary UI/RLS; every
-- other lifecycle state is preserved for audit (cancel/status-change instead).
drop policy if exists project_change_orders_delete on public.project_change_orders;
create policy project_change_orders_delete on public.project_change_orders
  for delete to authenticated
  using (
    status = 'draft'
    and (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
  );

create index if not exists idx_project_change_orders_project_updated on public.project_change_orders (project_id, updated_at desc);
create index if not exists idx_project_change_orders_org on public.project_change_orders (org_id);
create index if not exists idx_project_change_orders_status on public.project_change_orders (status);
create index if not exists idx_project_change_orders_approval_due on public.project_change_orders (approval_due_at) where approval_due_at is not null;
create index if not exists idx_project_change_orders_created_by on public.project_change_orders (created_by) where created_by is not null;
create index if not exists idx_project_change_orders_parent on public.project_change_orders (parent_change_order_id) where parent_change_order_id is not null;
create index if not exists idx_project_change_orders_customer_visible on public.project_change_orders (project_id) where is_customer_visible;

-- ============================================================================
-- 2. PROJECT_CHANGE_ORDER_ITEMS
-- ============================================================================

create table if not exists public.project_change_order_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid not null references public.project_change_orders(id) on delete cascade,
  "position" integer not null default 0,
  item_type text not null default 'service',
  name text not null,
  description text null,
  quantity numeric(12,3) not null default 1,
  unit text null,
  unit_price numeric(14,2) not null default 0,
  line_subtotal numeric(14,2) not null default 0,
  taxable boolean not null default true,
  internal_cost numeric(14,2) null,
  internal_markup numeric(14,2) null,
  phase_id uuid null references public.project_phases(id) on delete set null,
  task_id uuid null references public.tasks(id) on delete set null,
  source_estimate_item_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_change_order_items is
  'Phase 13.3B -- Change Order line items. Negative unit_price/line_subtotal is intentional (credits/removed-scope). internal_cost/internal_markup are Connect-only and must never appear in a Portal/Field projection.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_change_order_items_type_check' and conrelid = 'public.project_change_order_items'::regclass) then
    alter table public.project_change_order_items
      add constraint project_change_order_items_type_check
      check (item_type in ('service', 'labor', 'material', 'equipment', 'allowance', 'credit', 'fee', 'other'));
  end if;
end $$;

create or replace function public.validate_project_change_order_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.project_change_orders co
    where co.id = new.change_order_id and co.project_id = new.project_id and co.org_id = new.org_id
  ) then
    raise exception 'Change Order item does not belong to the referenced Change Order/Project/organization';
  end if;

  if new.phase_id is not null and not exists (
    select 1 from public.project_phases ph where ph.id = new.phase_id and ph.project_id = new.project_id
  ) then
    raise exception 'Linked phase does not belong to this Project';
  end if;

  if new.task_id is not null and not exists (
    select 1 from public.tasks t where t.id = new.task_id and t.project_id = new.project_id
  ) then
    raise exception 'Linked task does not belong to this Project';
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_order_items_validate on public.project_change_order_items;
create trigger project_change_order_items_validate
  before insert or update of change_order_id, project_id, org_id, phase_id, task_id on public.project_change_order_items
  for each row
  execute function public.validate_project_change_order_item();

create or replace function public.set_project_change_order_items_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists project_change_order_items_set_updated_at on public.project_change_order_items;
create trigger project_change_order_items_set_updated_at
  before update on public.project_change_order_items
  for each row
  execute function public.set_project_change_order_items_updated_at();

alter table public.project_change_order_items enable row level security;

drop policy if exists project_change_order_items_select on public.project_change_order_items;
create policy project_change_order_items_select on public.project_change_order_items
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Line items may only be inserted/updated/deleted while their parent
-- Change Order is still internal -- once sent, items are frozen (the
-- snapshot in project_change_order_versions is the only record of what
-- the customer saw, and project_change_orders.total_amount can no longer
-- legally change per enforce_change_order_lifecycle(), so mutating items
-- underneath a sent+ Change Order would silently desync the two).
drop policy if exists project_change_order_items_insert on public.project_change_order_items;
create policy project_change_order_items_insert on public.project_change_order_items
  for insert to authenticated
  with check (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and exists (
      select 1 from public.project_change_orders co
      where co.id = change_order_id and co.status in ('draft', 'internal_review', 'ready_to_send')
    )
  );

drop policy if exists project_change_order_items_update on public.project_change_order_items;
create policy project_change_order_items_update on public.project_change_order_items
  for update to authenticated
  using (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and exists (
      select 1 from public.project_change_orders co
      where co.id = change_order_id and co.status in ('draft', 'internal_review', 'ready_to_send')
    )
  )
  with check (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and exists (
      select 1 from public.project_change_orders co
      where co.id = change_order_id and co.status in ('draft', 'internal_review', 'ready_to_send')
    )
  );

drop policy if exists project_change_order_items_delete on public.project_change_order_items;
create policy project_change_order_items_delete on public.project_change_order_items
  for delete to authenticated
  using (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and exists (
      select 1 from public.project_change_orders co
      where co.id = change_order_id and co.status in ('draft', 'internal_review', 'ready_to_send')
    )
  );

create index if not exists idx_project_change_order_items_co_position on public.project_change_order_items (change_order_id, "position");
create index if not exists idx_project_change_order_items_project on public.project_change_order_items (project_id);
create index if not exists idx_project_change_order_items_phase on public.project_change_order_items (phase_id) where phase_id is not null;
create index if not exists idx_project_change_order_items_task on public.project_change_order_items (task_id) where task_id is not null;

-- ============================================================================
-- 3. PROJECT_CHANGE_ORDER_VERSIONS (immutable customer-facing snapshots)
-- ============================================================================

create table if not exists public.project_change_order_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid not null references public.project_change_orders(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  pdf_bucket text null,
  pdf_path text null,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.project_change_order_versions is
  'Phase 13.3B -- immutable point-in-time JSONB copy of a Change Order''s customer-facing content, written once each time it is sent. Must never be joined against current project_change_order_items -- draft edits after this point require a new version, not a silent rewrite.';

create unique index if not exists uq_project_change_order_versions_co_version on public.project_change_order_versions (change_order_id, version);
create index if not exists idx_project_change_order_versions_project on public.project_change_order_versions (project_id);

-- ── relationship validation (security audit) ─────────────────────────────
create or replace function public.validate_project_change_order_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.project_change_orders co
    where co.id = new.change_order_id and co.org_id = new.org_id and co.project_id = new.project_id
      and co.version = new.version
  ) then
    raise exception 'Change Order version snapshot does not match its Change Order/Project/organization/version';
  end if;

  if new.created_by is not null and not exists (
    select 1 from public.org_memberships where member_id = new.created_by and org_id = new.org_id
    union
    select 1 from public.profiles where id = new.created_by and organization_id = new.org_id
  ) then
    raise exception 'Change Order version creator is not a member of this organization';
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_order_versions_validate on public.project_change_order_versions;
create trigger project_change_order_versions_validate
  before insert on public.project_change_order_versions
  for each row
  execute function public.validate_project_change_order_version();

alter table public.project_change_order_versions enable row level security;

drop policy if exists project_change_order_versions_select on public.project_change_order_versions;
create policy project_change_order_versions_select on public.project_change_order_versions
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- Security audit (round 3): the authenticated INSERT policy that used to
-- live here has been removed entirely. send_project_change_order() uses
-- ON CONFLICT (change_order_id, version) DO NOTHING when it writes the
-- immutable snapshot -- if ordinary authenticated clients could INSERT
-- into this table, a malicious/buggy client could pre-seed a row for a
-- not-yet-sent version, and the trusted send function would then silently
-- treat that attacker-controlled row as "the" snapshot on first send
-- (never reaching its own insert). With no authenticated INSERT policy at
-- all, this table can only ever be written by send_project_change_order()
-- itself (SECURITY DEFINER, owned by the migration-running role, bypasses
-- RLS) -- there is no other path to a row here, trusted or not.
drop policy if exists project_change_order_versions_insert on public.project_change_order_versions;

-- No INSERT/UPDATE/DELETE policy -- immutable and write-only-by-trusted-
-- function by omission.

-- ============================================================================
-- 4. PROJECT_CHANGE_ORDER_APPROVALS (append-only audit trail)
-- ============================================================================

create table if not exists public.project_change_order_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid not null references public.project_change_orders(id) on delete cascade,
  version integer not null,
  action text not null,
  actor_type text not null,
  actor_user_id uuid null references public.profiles(id) on delete set null,
  actor_contact_id uuid null references public.contacts(id) on delete set null,
  actor_name text null,
  actor_email text null,
  actor_ip inet null,
  user_agent text null,
  source text not null,
  rejection_reason text null,
  acknowledgment_text text null,
  signature_name text null,
  signature_data jsonb null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_change_order_approvals is
  'Phase 13.3B -- append-only Change Order audit trail (viewed/approved/rejected/cancelled/expired/superseded/resent). This, not the status timestamps alone, is the authoritative history. Rows are written only by SECURITY DEFINER RPCs / service-role Netlify functions -- no ordinary authenticated INSERT/UPDATE/DELETE policy exists.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_change_order_approvals_action_check' and conrelid = 'public.project_change_order_approvals'::regclass) then
    alter table public.project_change_order_approvals
      add constraint project_change_order_approvals_action_check
      check (action in ('viewed', 'approved', 'rejected', 'cancelled', 'expired', 'superseded', 'resent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_change_order_approvals_actor_type_check' and conrelid = 'public.project_change_order_approvals'::regclass) then
    alter table public.project_change_order_approvals
      add constraint project_change_order_approvals_actor_type_check
      check (actor_type in ('organization_user', 'customer', 'system'));
  end if;
end $$;

create index if not exists idx_project_change_order_approvals_co_created on public.project_change_order_approvals (change_order_id, created_at desc);
create index if not exists idx_project_change_order_approvals_project on public.project_change_order_approvals (project_id);
create index if not exists idx_project_change_order_approvals_action on public.project_change_order_approvals (action);
create index if not exists idx_project_change_order_approvals_actor_contact on public.project_change_order_approvals (actor_contact_id) where actor_contact_id is not null;
create index if not exists idx_project_change_order_approvals_actor_user on public.project_change_order_approvals (actor_user_id) where actor_user_id is not null;

-- ── relationship validation (security audit) ─────────────────────────────
create or replace function public.validate_project_change_order_approval()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.project_change_orders co
    where co.id = new.change_order_id and co.org_id = new.org_id and co.project_id = new.project_id
      and co.version = new.version
  ) then
    raise exception 'Change Order approval does not match its Change Order/Project/organization/version';
  end if;

  if new.actor_type = 'organization_user' and new.actor_user_id is not null and not exists (
    select 1 from public.org_memberships where member_id = new.actor_user_id and org_id = new.org_id
    union
    select 1 from public.profiles where id = new.actor_user_id and organization_id = new.org_id
  ) then
    raise exception 'Approval actor is not a member of this organization';
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_order_approvals_validate on public.project_change_order_approvals;
create trigger project_change_order_approvals_validate
  before insert on public.project_change_order_approvals
  for each row
  execute function public.validate_project_change_order_approval();

alter table public.project_change_order_approvals enable row level security;

drop policy if exists project_change_order_approvals_select on public.project_change_order_approvals;
create policy project_change_order_approvals_select on public.project_change_order_approvals
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- No authenticated INSERT/UPDATE/DELETE policy -- see table comment.

-- ============================================================================
-- 5. PROJECT_CHANGE_ORDER_ACCESS_TOKENS (never exposed to authenticated/anon clients)
-- ============================================================================

create table if not exists public.project_change_order_access_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_order_id uuid not null references public.project_change_orders(id) on delete cascade,
  version integer not null,
  token_hash text not null unique,
  recipient_contact_id uuid null references public.contacts(id) on delete set null,
  recipient_email text null,
  expires_at timestamptz not null,
  first_used_at timestamptz null,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  use_count integer not null default 0,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_change_order_access_tokens is
  'Phase 13.3B -- stores only a SHA-256 hash of the customer approval token, never the plaintext (plaintext is returned once, at creation, to the service-role caller only). RLS is enabled with zero authenticated/anon policies -- only the service role (Netlify functions / SECURITY DEFINER RPCs, which bypass RLS) can read or write this table. Do not add a SELECT policy here.';

create index if not exists idx_project_change_order_access_tokens_co on public.project_change_order_access_tokens (change_order_id);
create index if not exists idx_project_change_order_access_tokens_expires on public.project_change_order_access_tokens (expires_at);
create index if not exists idx_project_change_order_access_tokens_revoked on public.project_change_order_access_tokens (revoked_at) where revoked_at is not null;

-- ── relationship validation (security audit) ─────────────────────────────
create or replace function public.validate_project_change_order_access_token()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.project_change_orders co
    where co.id = new.change_order_id and co.org_id = new.org_id and co.project_id = new.project_id
      and co.version = new.version
  ) then
    raise exception 'Access token does not match its Change Order/Project/organization/version';
  end if;

  if not exists (
    select 1 from public.project_change_order_versions v
    where v.change_order_id = new.change_order_id and v.version = new.version
  ) then
    raise exception 'Cannot issue an approval token before the corresponding version snapshot exists';
  end if;

  if new.created_by is not null and not exists (
    select 1 from public.org_memberships where member_id = new.created_by and org_id = new.org_id
    union
    select 1 from public.profiles where id = new.created_by and organization_id = new.org_id
  ) then
    raise exception 'Access token creator is not a member of this organization';
  end if;

  return new;
end;
$$;

drop trigger if exists project_change_order_access_tokens_validate on public.project_change_order_access_tokens;
create trigger project_change_order_access_tokens_validate
  before insert on public.project_change_order_access_tokens
  for each row
  execute function public.validate_project_change_order_access_token();

alter table public.project_change_order_access_tokens enable row level security;
-- Intentionally no policies: default-deny for both authenticated and anon.

-- ============================================================================
-- 6. PROJECT_FINANCIAL_ADJUSTMENTS (idempotent ledger, exactly-once application)
-- ============================================================================

create table if not exists public.project_financial_adjustments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  amount numeric(14,2) not null default 0,
  status text not null default 'applied',
  applied_at timestamptz not null default now(),
  reversed_at timestamptz null,
  created_by uuid null references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.project_financial_adjustments is
  'Phase 13.3B -- a general Project financial adjustment ledger. Approved Change Orders write exactly one row here (source_type=''change_order'', source_id=change_order.id), enforced by the unique(source_type, source_id) constraint, which is what makes approval idempotent even under retry/replay. Revised Contract Value = projects.budget_total + sum(amount) where status=''applied'' and reversed_at is null.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_financial_adjustments_status_check' and conrelid = 'public.project_financial_adjustments'::regclass) then
    alter table public.project_financial_adjustments
      add constraint project_financial_adjustments_status_check
      check (status in ('applied', 'reversed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_financial_adjustments_source_unique' and conrelid = 'public.project_financial_adjustments'::regclass) then
    alter table public.project_financial_adjustments
      add constraint project_financial_adjustments_source_unique unique (source_type, source_id);
  end if;
end $$;

create index if not exists idx_project_financial_adjustments_project on public.project_financial_adjustments (project_id);

-- ── relationship validation (security audit) ─────────────────────────────
create or replace function public.validate_project_financial_adjustment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_co public.project_change_orders%rowtype;
  v_snapshot jsonb;
  v_snapshot_amount numeric;
begin
  if new.source_type = 'change_order' then
    select * into v_co from public.project_change_orders where id = new.source_id;
    if not found then
      raise exception 'Financial adjustment references a non-existent Change Order';
    end if;
    if v_co.org_id <> new.org_id or v_co.project_id <> new.project_id then
      raise exception 'Financial adjustment organization/Project does not match its Change Order';
    end if;
    if v_co.status <> 'approved' then
      raise exception 'Financial adjustment can only be recorded for an approved Change Order';
    end if;

    -- Security audit (round 3): project_change_orders.total_amount is no
    -- longer the sole authority here -- it is cross-checked against the
    -- immutable snapshot for the approved version, the same authority
    -- approve_project_change_order() itself uses to decide the amount in
    -- the first place. Defense-in-depth: even if some future code path
    -- managed to insert a financial adjustment outside that RPC, it still
    -- cannot assert an amount the customer never actually saw and approved.
    select v.snapshot into v_snapshot
      from public.project_change_order_versions v
      where v.change_order_id = v_co.id and v.version = v_co.version;

    if v_snapshot is null then
      raise exception 'No approved snapshot exists for this Change Order version -- cannot record financial adjustment';
    end if;

    v_snapshot_amount := nullif(v_snapshot ->> 'totalAmount', '')::numeric;
    if v_snapshot_amount is null then
      raise exception 'The Change Order snapshot is missing a valid total amount';
    end if;

    if new.amount <> v_snapshot_amount then
      raise exception 'Financial adjustment amount does not match the Change Order''s immutable approved snapshot total';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists project_financial_adjustments_validate on public.project_financial_adjustments;
create trigger project_financial_adjustments_validate
  before insert on public.project_financial_adjustments
  for each row
  execute function public.validate_project_financial_adjustment();

alter table public.project_financial_adjustments enable row level security;

drop policy if exists project_financial_adjustments_select on public.project_financial_adjustments;
create policy project_financial_adjustments_select on public.project_financial_adjustments
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- No authenticated INSERT/UPDATE/DELETE policy -- written only by the
-- approve_project_change_order() RPC below (SECURITY DEFINER).

-- ============================================================================
-- 7. PROJECT_FILES: ADDITIVE CHANGE ORDER LINKAGE
-- ============================================================================

alter table public.project_files
  add column if not exists change_order_id uuid null references public.project_change_orders(id) on delete set null;

create index if not exists idx_project_files_change_order on public.project_files (change_order_id) where change_order_id is not null;

-- Extend the existing linkage-validation trigger's coverage: change_order_id
-- must belong to the same project as the file. project_files already has a
-- validate_project_files_linkage() trigger from 20260813 covering
-- phase/milestone/daily_log/task; we add change_order_id validation as its
-- own lightweight trigger rather than touching that already-applied function.
create or replace function public.validate_project_file_change_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.change_order_id is not null and not exists (
    select 1 from public.project_change_orders co
    where co.id = new.change_order_id and co.project_id = new.project_id
  ) then
    raise exception 'Linked Change Order does not belong to this Project';
  end if;
  return new;
end;
$$;

drop trigger if exists project_files_validate_change_order on public.project_files;
create trigger project_files_validate_change_order
  before insert or update of change_order_id, project_id on public.project_files
  for each row
  execute function public.validate_project_file_change_order();

-- ============================================================================
-- 8. TRUST ARCHITECTURE (security audit, round 3 -- read this first)
-- ============================================================================
-- Every privileged Change Order write below (send, cancel, apply schedule
-- impact) follows ONE trust model, chosen deliberately over the
-- alternative of letting authenticated browser clients call a
-- user-JWT-scoped RPC with caller-supplied financial/snapshot data:
--
--   1. The Netlify function authenticates the caller's bearer token
--      (supabase.auth.getUser), resolves their real org_id and role
--      server-side (never from the request body), and checks the exact
--      change_orders permission via the shared resolveChangeOrderPermission
--      helper (src/lib/change-order-permissions.ts) -- the SAME table the
--      Permissions settings UI reads, not a hardcoded role check.
--   2. Only after that succeeds does the Netlify function call the
--      SECURITY DEFINER RPC below, using the SERVICE ROLE key (never the
--      anon key, never exposed to the browser) and passing the
--      already-verified org_id/actor_user_id as plain parameters.
--   3. These RPCs are granted EXECUTE to `service_role` ONLY -- not
--      `authenticated`, not `anon`. An authenticated browser client
--      cannot invoke send_project_change_order/cancel_project_change_
--      order/apply_project_change_order_schedule_impact directly through
--      PostgREST no matter what it passes, because it has no grant to do
--      so at all. This closes the exact gap a user-JWT-scoped RPC design
--      would leave open: a caller supplying its own p_total_amount/
--      p_snapshot/p_subtotal etc.
--   4. Financial totals and the customer-facing snapshot are NEVER
--      accepted as RPC parameters from any caller (Netlify function
--      included) -- see calculate_change_order_totals() and the inline
--      jsonb_build_object() snapshot construction inside
--      send_project_change_order() below, both built exclusively from
--      persisted project_change_order_items / project_change_orders /
--      projects / organizations / contacts rows. The database itself is
--      the sole financial authority, not any application-layer caller.
--
-- approve_project_change_order()/reject_project_change_order() are the
-- one deliberate exception: they remain grantable to `anon`/`authenticated`
-- because an anonymous customer, by definition, has no Netlify-authenticated
-- session to front them with -- the plaintext token itself IS the
-- credential, verified inside the function via a hash lookup, and neither
-- function accepts org_id, a snapshot, or a financial amount as a
-- parameter (the amount is read from the immutable snapshot, never
-- supplied by the caller).

-- ── authoritative totals, computed server-side from persisted rows ──────
-- Mirrors src/lib/change-order-calculations.ts's calculateChangeOrderTotals
-- exactly: sum line subtotals -> discount -> markup -> taxable base
-- (discount/markup allocated proportionally onto the taxable share) ->
-- tax -> total. Every step uses round(x, 2) the same way round2() does.
-- Negative quantities/unit prices (credits) are never floored -- subtotal,
-- discount_amount, markup_amount, and total_amount may all be negative.
create or replace function public.calculate_change_order_totals(p_change_order_id uuid)
returns table(subtotal numeric, discount_amount numeric, markup_amount numeric, tax_amount numeric, total_amount numeric)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_co public.project_change_orders%rowtype;
  v_subtotal numeric := 0;
  v_taxable numeric := 0;
  v_discount numeric := 0;
  v_after_discount numeric := 0;
  v_markup numeric := 0;
  v_after_markup numeric := 0;
  v_ratio numeric := 0;
  v_taxable_subtotal numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
begin
  select * into v_co from public.project_change_orders where id = p_change_order_id;
  if not found then
    raise exception 'Change Order not found';
  end if;

  select
    coalesce(round(sum(round(i.quantity * i.unit_price, 2)), 2), 0),
    coalesce(round(sum(case when i.taxable then round(i.quantity * i.unit_price, 2) else 0 end), 2), 0)
    into v_subtotal, v_taxable
    from public.project_change_order_items i
    where i.change_order_id = p_change_order_id;

  if v_co.discount_type = 'percentage' and v_co.discount_value is not null then
    v_discount := round(v_subtotal * (v_co.discount_value / 100.0), 2);
  elsif v_co.discount_type = 'fixed' and v_co.discount_value is not null then
    v_discount := round(v_co.discount_value, 2);
  end if;

  v_after_discount := round(v_subtotal - v_discount, 2);

  if v_co.markup_type = 'percentage' and v_co.markup_value is not null then
    v_markup := round(v_after_discount * (v_co.markup_value / 100.0), 2);
  elsif v_co.markup_type = 'fixed' and v_co.markup_value is not null then
    v_markup := round(v_co.markup_value, 2);
  end if;

  v_after_markup := round(v_after_discount + v_markup, 2);

  if v_subtotal <> 0 then
    v_ratio := (v_after_markup - v_subtotal) / v_subtotal;
  else
    v_ratio := 0;
  end if;

  v_taxable_subtotal := round(v_taxable + v_taxable * v_ratio, 2);
  v_tax := round(v_taxable_subtotal * (coalesce(v_co.tax_rate, 0) / 100.0), 2);
  v_total := round(v_after_markup + v_tax, 2);

  return query select v_subtotal, v_discount, v_markup, v_tax, v_total;
end;
$$;

comment on function public.calculate_change_order_totals(uuid) is
  'Security audit (round 3) -- the single authoritative Change Order totals calculation, computed entirely from persisted project_change_order_items and the Change Order''s own stored pricing config. Mirrors src/lib/change-order-calculations.ts exactly. Never accepts a caller-supplied total. Not SECURITY DEFINER -- it only reads, via the caller''s own RLS-scoped visibility, and is called from inside the SECURITY DEFINER functions below where org scoping has already been established.';

-- Ordinary org members may call this directly too (e.g. for a live
-- preview) -- it is read-only and RLS on the underlying tables already
-- restricts what it can see.
revoke all on function public.calculate_change_order_totals(uuid) from public;
grant execute on function public.calculate_change_order_totals(uuid) to authenticated, service_role;

-- ============================================================================
-- 9. TRANSACTIONAL SEND (service_role only -- see Part 8 trust architecture)
-- ============================================================================
-- Everything a "send" does -- recalculating totals from persisted items,
-- building the customer-safe snapshot from persisted data, writing the
-- immutable version snapshot, revoking prior tokens, issuing the new
-- token, transitioning status, and (on a revision's first send)
-- superseding its parent -- happens in one transaction, and trusts
-- nothing from the caller except which Change Order to send and the
-- pre-generated token hash/expiry (token generation is a Node-only
-- capability, so that part legitimately comes from the Netlify function --
-- see the header comment on change-order-send.ts).
create or replace function public.send_project_change_order(
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
  v_parent public.project_change_orders%rowtype;
  v_is_first_send boolean;
  v_totals record;
  v_existing_snapshot jsonb;
  v_snapshot jsonb;
  v_project record;
  v_org record;
  v_customer record;
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

  select * into v_co from public.project_change_orders where id = p_change_order_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Change Order not found in the specified organization';
  end if;
  if v_co.status not in ('ready_to_send', 'sent', 'viewed') then
    raise exception 'Cannot send a Change Order in "%" status', v_co.status;
  end if;

  v_is_first_send := v_co.status = 'ready_to_send';

  -- Authoritative totals, computed here, never accepted as a parameter.
  select * into v_totals from public.calculate_change_order_totals(v_co.id);

  if v_is_first_send then
    update public.project_change_orders
      set subtotal = v_totals.subtotal, discount_amount = v_totals.discount_amount, markup_amount = v_totals.markup_amount,
          tax_amount = v_totals.tax_amount, total_amount = v_totals.total_amount,
          status = 'sent', is_customer_visible = true, sent_at = coalesce(sent_at, now()),
          updated_at = now(), updated_by = p_actor_user_id
      where id = v_co.id;
    select * into v_co from public.project_change_orders where id = v_co.id;
  else
    update public.project_change_orders set updated_at = now(), updated_by = p_actor_user_id where id = v_co.id;
  end if;

  -- Authoritative snapshot, built here from persisted rows, never
  -- accepted as a parameter.
  select p.id, p.name into v_project from public.projects p where p.id = v_co.project_id;
  select o.name, o.public_name into v_org from public.organizations o where o.id = v_co.org_id;
  select c.full_name, c.email into v_customer
    from public.contacts c
    join public.projects p on p.client_id = c.id
    where p.id = v_co.project_id;

  select jsonb_build_object(
    'changeOrderNumber', v_co.change_order_number,
    'version', v_co.version,
    'title', v_co.title,
    'scope', v_co.description,
    'customerMessage', v_co.customer_message,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.name, 'description', i.description, 'quantity', i.quantity,
        'unit', i.unit, 'unitPrice', i.unit_price, 'lineTotal', round(i.quantity * i.unit_price, 2)
      ) order by i.position)
      from public.project_change_order_items i where i.change_order_id = v_co.id
    ), '[]'::jsonb),
    'subtotal', v_totals.subtotal, 'discountAmount', v_totals.discount_amount, 'markupAmount', v_totals.markup_amount,
    'taxAmount', v_totals.tax_amount, 'totalAmount', v_totals.total_amount,
    'scheduleImpactDays', v_co.schedule_impact_days, 'proposedStartDate', v_co.proposed_start_date,
    'proposedCompletionDate', v_co.proposed_completion_date, 'approvalDueAt', v_co.approval_due_at,
    'organization', jsonb_build_object('name', coalesce(nullif(v_org.public_name, ''), v_org.name, 'Your contractor')),
    'customer', jsonb_build_object('name', v_customer.full_name, 'email', v_customer.email),
    'project', jsonb_build_object('id', v_project.id, 'name', v_project.name),
    'sentAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS."000Z"')
  ) into v_snapshot;

  select v.snapshot into v_existing_snapshot
    from public.project_change_order_versions v
    where v.change_order_id = v_co.id and v.version = v_co.version;

  if v_is_first_send then
    -- A version snapshot must never already exist the first time a
    -- version is sent -- if one does, something wrote to
    -- project_change_order_versions outside this function (which should
    -- be structurally impossible now that the authenticated INSERT policy
    -- has been removed), and silently accepting it (the previous ON
    -- CONFLICT DO NOTHING behavior) would let that row's content --
    -- possibly attacker-controlled -- become "the" snapshot a customer
    -- approves against. Fail loudly instead.
    if v_existing_snapshot is not null then
      raise exception 'A version snapshot unexpectedly already exists for this Change Order version -- refusing to send';
    end if;

    insert into public.project_change_order_versions (org_id, project_id, change_order_id, version, snapshot, created_by)
    values (p_org_id, v_co.project_id, v_co.id, v_co.version, v_snapshot, p_actor_user_id);
  else
    -- Resend of the exact same immutable version: reuse the existing
    -- snapshot verbatim. Never replace it, never accept the freshly
    -- rebuilt one even though it should be equivalent -- the persisted
    -- snapshot is definitionally what was already sent.
    if v_existing_snapshot is null then
      raise exception 'No existing snapshot found for this Change Order version -- cannot resend';
    end if;
  end if;

  -- A resend supersedes rather than coexists with any still-active token.
  update public.project_change_order_access_tokens
    set revoked_at = now()
    where change_order_id = v_co.id and revoked_at is null;

  insert into public.project_change_order_access_tokens
    (org_id, project_id, change_order_id, version, token_hash, expires_at, created_by)
  values (p_org_id, v_co.project_id, v_co.id, v_co.version, p_token_hash, p_expires_at, p_actor_user_id);

  if not v_is_first_send then
    insert into public.project_change_order_approvals
      (org_id, project_id, change_order_id, version, action, actor_type, actor_user_id, source)
    values (p_org_id, v_co.project_id, v_co.id, v_co.version, 'resent', 'organization_user', p_actor_user_id, 'connect');
  end if;

  -- Revision supersession (security audit, round 4, Part 6 -- document
  -- lifecycle vs. financial effectiveness are DELIBERATELY separate
  -- here): only on the FIRST successful send of a revision, and only in
  -- the same transaction as that send, the parent's STATUS moves to
  -- 'superseded' and its approval tokens are revoked -- this stops the
  -- parent from being document-approvable and pulls its public link, but
  -- it does NOT touch project_financial_adjustments. If the parent was
  -- previously approved, its financial adjustment stays 'applied' (fully
  -- effective, still counted in Revised Contract Value) right up until
  -- THIS child revision is itself approved -- see the lineage-reversal
  -- block inside approve_project_change_order() above, which is the only
  -- place a parent's adjustment is ever reversed. A merely-drafted
  -- revision never reaches this branch at all (only send does), and if
  -- this child is later rejected/cancelled/expired instead of approved,
  -- the parent's adjustment is never touched and remains fully effective.
  if v_is_first_send and v_co.parent_change_order_id is not null then
    select * into v_parent from public.project_change_orders where id = v_co.parent_change_order_id for update;
    if found and v_parent.status in ('sent', 'viewed', 'approved', 'rejected') then
      update public.project_change_orders
        set status = 'superseded', superseded_at = now(), updated_at = now(), updated_by = p_actor_user_id
        where id = v_parent.id;

      insert into public.project_change_order_approvals
        (org_id, project_id, change_order_id, version, action, actor_type, actor_user_id, source)
      values (v_parent.org_id, v_parent.project_id, v_parent.id, v_parent.version, 'superseded', 'organization_user', p_actor_user_id, 'connect');

      update public.project_change_order_access_tokens
        set revoked_at = now()
        where change_order_id = v_parent.id and revoked_at is null;
    end if;
  end if;

  return jsonb_build_object(
    'status', 'sent', 'isFirstSend', v_is_first_send, 'version', v_co.version,
    'changeOrderNumber', v_co.change_order_number, 'title', v_co.title, 'totalAmount', v_totals.total_amount
  );
end;
$$;

comment on function public.send_project_change_order(uuid, uuid, uuid, text, timestamptz) is
  'Security audit (round 3) -- service_role-only transactional send/resend/supersession. org_id/actor_user_id are supplied by the Netlify function only after it has independently authenticated the caller and verified organization membership + the change_orders "send" permission -- never trusted as-is from anything a browser could submit, because a browser cannot call this function at all (no grant to authenticated/anon). Totals and the customer-facing snapshot are computed/built entirely inside this function from persisted rows.';

revoke all on function public.send_project_change_order(uuid, uuid, uuid, text, timestamptz) from public;
grant execute on function public.send_project_change_order(uuid, uuid, uuid, text, timestamptz) to service_role;

-- ============================================================================
-- 10. CANCEL (service_role only -- see Part 8 trust architecture)
-- ============================================================================
-- Cancellation of a sent/viewed Change Order is no longer possible through
-- an ordinary authenticated UPDATE (project_change_orders_update now
-- requires status to already be draft/internal_review/ready_to_send on
-- both sides). This is the dedicated, audited replacement: its own
-- authorization check (via the Netlify function, same pattern as send),
-- its own row lock, its own audit row, and its own token revocation.
create or replace function public.cancel_project_change_order(
  p_change_order_id uuid,
  p_org_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co public.project_change_orders%rowtype;
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

  select * into v_co from public.project_change_orders where id = p_change_order_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Change Order not found in the specified organization';
  end if;
  if v_co.status not in ('draft', 'internal_review', 'ready_to_send', 'sent', 'viewed') then
    raise exception 'Cannot cancel a Change Order in "%" status', v_co.status;
  end if;

  update public.project_change_orders
    set status = 'cancelled', cancelled_at = now(), updated_at = now(), updated_by = p_actor_user_id
    where id = v_co.id;

  insert into public.project_change_order_approvals
    (org_id, project_id, change_order_id, version, action, actor_type, actor_user_id, source)
  values (v_co.org_id, v_co.project_id, v_co.id, v_co.version, 'cancelled', 'organization_user', p_actor_user_id, 'connect');

  update public.project_change_order_access_tokens
    set revoked_at = now()
    where change_order_id = v_co.id and revoked_at is null;

  return jsonb_build_object('status', 'cancelled', 'changeOrderId', v_co.id);
end;
$$;

comment on function public.cancel_project_change_order(uuid, uuid, uuid) is
  'Security audit (round 3) -- service_role-only, dedicated cancel path (Part 1 of the audit). org_id/actor_user_id are supplied by the Netlify function only after independently verifying organization membership + the change_orders "cancel" permission.';

revoke all on function public.cancel_project_change_order(uuid, uuid, uuid) from public;
grant execute on function public.cancel_project_change_order(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 11. CREATE REVISION (service_role only -- see Part 8 trust architecture)
-- ============================================================================
-- Security audit (round 4), Part 8/4 -- createChangeOrderRevision() used
-- to run as an ordinary client-side INSERT (browser-supplied
-- change_order_number/version/parent_change_order_id), trusted only by
-- the INSERT-time guard trigger. That trigger still re-validates lineage
-- independently (defense-in-depth against a hypothetical bug here), but
-- the authoritative path is now this function: it derives the new
-- version/number from the REAL parent row under an advisory lock (so two
-- concurrent "Create Revision" calls for the same lineage can never both
-- produce Version 2), copies only customer-safe editable fields (never
-- tokens, never approval records, never financial adjustments -- those
-- tables aren't even referenced here), and copies line items as fresh
-- rows scoped to the new Change Order id.
create or replace function public.create_project_change_order_revision(
  p_parent_change_order_id uuid,
  p_org_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent public.project_change_orders%rowtype;
  v_new_id uuid;
  v_new_version integer;
  v_latest_version integer;
  v_latest_id uuid;
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

  select * into v_parent
    from public.project_change_orders
    where id = p_parent_change_order_id and org_id = p_org_id;
  if not found then
    raise exception 'Change Order not found in the specified organization';
  end if;

  -- Serialize the entire lineage, not just this parent row.
  perform pg_advisory_xact_lock(
    hashtext('change_order_revision:' || v_parent.project_id::text || ':' || v_parent.change_order_number)
  );

  -- Re-fetch the requested parent under a row lock after obtaining the lineage
  -- lock, then determine the true current tip of the lineage.
  select * into v_parent
    from public.project_change_orders
    where id = p_parent_change_order_id and org_id = p_org_id
    for update;

  select co.id, co.version
    into v_latest_id, v_latest_version
    from public.project_change_orders co
    where co.project_id = v_parent.project_id
      and co.change_order_number = v_parent.change_order_number
    order by co.version desc
    limit 1;

  if v_latest_id is distinct from v_parent.id then
    raise exception 'A newer revision already exists for this Change Order';
  end if;

  v_new_version := v_latest_version + 1;

  insert into public.project_change_orders (
    org_id, project_id, change_order_number, title, description, reason, customer_message,
    status, currency, discount_type, discount_value, markup_type, markup_value, tax_rate,
    schedule_impact_days, proposed_start_date, proposed_completion_date,
    version, parent_change_order_id, created_by, updated_by
  )
  values (
    v_parent.org_id, v_parent.project_id, v_parent.change_order_number,
    v_parent.title, v_parent.description, v_parent.reason, v_parent.customer_message,
    'draft', v_parent.currency, v_parent.discount_type, v_parent.discount_value,
    v_parent.markup_type, v_parent.markup_value, v_parent.tax_rate,
    v_parent.schedule_impact_days, v_parent.proposed_start_date, v_parent.proposed_completion_date,
    v_new_version, v_parent.id, p_actor_user_id, p_actor_user_id
  )
  returning id into v_new_id;

  insert into public.project_change_order_items (
    org_id, project_id, change_order_id, "position", item_type, name, description,
    quantity, unit, unit_price, line_subtotal, taxable, internal_cost, internal_markup, phase_id, task_id
  )
  select
    i.org_id, i.project_id, v_new_id, i."position", i.item_type, i.name, i.description,
    i.quantity, i.unit, i.unit_price, i.line_subtotal, i.taxable, i.internal_cost,
    i.internal_markup, i.phase_id, i.task_id
  from public.project_change_order_items i
  where i.change_order_id = v_parent.id
  order by i."position";

  return jsonb_build_object(
    'id', v_new_id,
    'changeOrderNumber', v_parent.change_order_number,
    'version', v_new_version
  );
end;
$$;

comment on function public.create_project_change_order_revision(uuid, uuid, uuid) is
  'Security audit (round 5) -- service_role-only trusted revision creation. Serializes the lineage, requires the requested parent to be the current latest revision, derives max(version)+1 and the inherited CO number from persisted rows, and copies line items only. Never copies tokens, approval records, or financial adjustments.';

revoke all on function public.create_project_change_order_revision(uuid, uuid, uuid) from public;
grant execute on function public.create_project_change_order_revision(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- 12. APPLY SCHEDULE IMPACT (service_role only -- see Part 8 trust architecture)
-- ============================================================================
create or replace function public.apply_project_change_order_schedule_impact(
  p_change_order_id uuid,
  p_org_id uuid,
  p_actor_user_id uuid,
  p_new_completion_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co public.project_change_orders%rowtype;
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
  if p_new_completion_date is null then
    raise exception 'A new completion date is required';
  end if;

  select * into v_co from public.project_change_orders where id = p_change_order_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Change Order not found in the specified organization';
  end if;
  if v_co.status <> 'approved' then
    raise exception 'Schedule impact can only be applied to an approved Change Order';
  end if;
  if v_co.schedule_impact_applied_at is not null then
    raise exception 'Schedule impact has already been applied for this Change Order';
  end if;

  perform 1 from public.projects where id = v_co.project_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Project not found in the specified organization';
  end if;

  update public.projects set end_date = p_new_completion_date where id = v_co.project_id;

  update public.project_change_orders
    set schedule_impact_applied_at = now(),
        schedule_impact_applied_by = p_actor_user_id,
        schedule_impact_application = jsonb_build_object('newCompletionDate', p_new_completion_date, 'scheduleImpactDays', v_co.schedule_impact_days),
        updated_at = now(), updated_by = p_actor_user_id
    where id = v_co.id;

  return jsonb_build_object('ok', true, 'newCompletionDate', p_new_completion_date);
end;
$$;

comment on function public.apply_project_change_order_schedule_impact(uuid, uuid, uuid, date) is
  'Security audit (round 3) -- service_role-only, org-scoped, exactly-once application of an approved Change Order''s schedule impact. org_id/actor_user_id are supplied by the Netlify function only after independently verifying organization membership + the change_orders "apply schedule impact" permission. Locks both the Change Order and Project rows; schedule_impact_applied_at is the guard against repeated application (positive, zero, and negative day counts are all handled the same way -- only the resulting date matters here, the sign only affects how it is displayed).';

revoke all on function public.apply_project_change_order_schedule_impact(uuid, uuid, uuid, date) from public;
grant execute on function public.apply_project_change_order_schedule_impact(uuid, uuid, uuid, date) to service_role;

-- ============================================================================
-- 13. SECURE CUSTOMER APPROVAL / REJECTION RPCS (anon + authenticated --
-- deliberate exception to Part 8's service_role-only rule; see the
-- rationale in the Part 8 header comment)
-- ============================================================================
-- token is the PLAINTEXT token from the public link; hashed here before
-- lookup so the stored token_hash column is never compared against
-- anything but an equally-hashed value. Both functions are SECURITY
-- DEFINER so an anonymous/public caller (no table grants at all) can
-- still execute them via PostgREST RPC while every other access path to
-- these tables stays fully locked down. search_path includes `extensions`
-- (where Supabase installs pgcrypto by default) alongside `public` (where
-- some environments install it instead) so the unqualified digest() call
-- below resolves in either layout without hardcoding a schema that might
-- be wrong.
--
-- p_source is intentionally NOT a parameter -- a public caller invoking
-- this RPC directly (bypassing the Netlify function) must never be able
-- to assert an arbitrary source; every customer action recorded here is
-- hardcoded to source = 'portal'. p_ip/p_user_agent are accepted as
-- best-effort, server-captured context (populated by the Netlify function
-- from Netlify's own forwarded-IP header, never trusted as verified
-- identity) and are stored as-is for audit purposes only.

create or replace function public.approve_project_change_order(
  p_token text,
  p_name text,
  p_email text,
  p_acknowledgment text default null,
  p_signature jsonb default null,
  p_ip inet default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_token public.project_change_order_access_tokens%rowtype;
  v_co public.project_change_orders%rowtype;
  v_snapshot jsonb;
  v_amount numeric;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'Invalid approval token';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Approver name is required';
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select * into v_token from public.project_change_order_access_tokens where token_hash = v_hash for update;
  if not found then
    raise exception 'Approval link is invalid';
  end if;
  if v_token.revoked_at is not null then
    raise exception 'Approval link has been revoked';
  end if;
  if v_token.expires_at < now() then
    raise exception 'Approval link has expired';
  end if;

  -- Lock the Change Order row for the remainder of this transaction so a
  -- concurrent approve/reject on the same row cannot race past this point.
  select * into v_co from public.project_change_orders where id = v_token.change_order_id for update;
  if not found then
    raise exception 'Change Order not found';
  end if;
  if v_co.version <> v_token.version then
    raise exception 'This approval link refers to an outdated version of this Change Order';
  end if;
  if v_co.status not in ('sent', 'viewed') then
    raise exception 'This Change Order is no longer awaiting approval';
  end if;
  if v_co.approval_due_at is not null and v_co.approval_due_at < now() then
    raise exception 'The approval deadline for this Change Order has passed';
  end if;

  -- Authoritative amount comes from the immutable snapshot for this exact
  -- version, never from the (still-live, if theoretically drifted)
  -- project_change_orders row -- an approval must never be able to apply
  -- a different figure than what the customer actually saw and approved.
  select v.snapshot into v_snapshot
    from public.project_change_order_versions v
    where v.change_order_id = v_co.id and v.version = v_co.version;

  if v_snapshot is null then
    raise exception 'No sent snapshot exists for this Change Order version -- cannot approve';
  end if;

  v_amount := nullif(v_snapshot ->> 'totalAmount', '')::numeric;
  if v_amount is null then
    raise exception 'The Change Order snapshot is missing a valid total amount';
  end if;

  update public.project_change_orders
    set status = 'approved',
        approved_at = now(),
        approved_by_name = p_name,
        approved_by_email = p_email,
        approval_source = 'portal',
        updated_at = now()
    where id = v_co.id;

  insert into public.project_change_order_approvals
    (org_id, project_id, change_order_id, version, action, actor_type, actor_contact_id,
     actor_name, actor_email, actor_ip, user_agent, source, acknowledgment_text, signature_name, signature_data)
  values
    (v_co.org_id, v_co.project_id, v_co.id, v_co.version, 'approved', 'customer', v_token.recipient_contact_id,
     p_name, p_email, p_ip, p_user_agent, 'portal', p_acknowledgment,
     case when p_signature is not null then p_signature ->> 'name' else null end, p_signature);

  -- Lineage reversal (security audit, round 4, Parts 5-6): if an EARLIER
  -- version in this same lineage (same project_id + change_order_number,
  -- any other row) still has an active (applied, non-reversed) financial
  -- adjustment, reverse it now, atomically with applying this version's
  -- adjustment. This is what keeps Revised Contract Value from
  -- double-counting a lineage when a later revision is approved -- e.g.
  -- CO-003 v1 approved for +$5,000, v2 sent (v1 marked superseded for
  -- document/approval-link purposes only -- its adjustment stays active),
  -- v2 approved for +$6,000: this UPDATE reverses v1's +$5,000 row in the
  -- same transaction that inserts v2's +$6,000 row, so the lineage
  -- contributes exactly +$6,000, never +$11,000. If v2 had instead been
  -- rejected/cancelled/expired, this function is never reached for v2, so
  -- v1's adjustment is never touched and remains fully effective -- the
  -- prior approved amount stays financially effective until a REPLACEMENT
  -- is actually approved, never merely because it was sent.
  update public.project_financial_adjustments fa
    set status = 'reversed', reversed_at = now()
    from public.project_change_orders lineage_co
    where fa.source_type = 'change_order'
      and fa.source_id = lineage_co.id
      and fa.status = 'applied'
      and fa.reversed_at is null
      and lineage_co.project_id = v_co.project_id
      and lineage_co.change_order_number = v_co.change_order_number
      and lineage_co.id <> v_co.id;

  -- Exactly-once financial application: unique(source_type, source_id) makes
  -- a retried/duplicate call a harmless no-op rather than double-applying.
  -- The amount inserted is the snapshot-derived v_amount, not any mutable
  -- column, and validate_project_financial_adjustment() independently
  -- re-derives and re-checks it against the same immutable snapshot.
  insert into public.project_financial_adjustments (org_id, project_id, source_type, source_id, amount, status)
  values (v_co.org_id, v_co.project_id, 'change_order', v_co.id, v_amount, 'applied')
  on conflict (source_type, source_id) do nothing;

  -- Revoke every active token for this Change Order (not only the one
  -- used) so no second, still-valid link can act on it after a final
  -- decision has been recorded.
  update public.project_change_order_access_tokens
    set use_count = use_count + 1,
        first_used_at = coalesce(first_used_at, now()),
        last_used_at = now(),
        revoked_at = now()
    where change_order_id = v_co.id and revoked_at is null;

  return jsonb_build_object('status', 'approved', 'changeOrderId', v_co.id, 'totalAmount', v_amount);
end;
$$;

revoke all on function public.approve_project_change_order(text, text, text, text, jsonb, inet, text) from public;
grant execute on function public.approve_project_change_order(text, text, text, text, jsonb, inet, text) to anon, authenticated;

create or replace function public.reject_project_change_order(
  p_token text,
  p_name text,
  p_email text,
  p_reason text default null,
  p_ip inet default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_token public.project_change_order_access_tokens%rowtype;
  v_co public.project_change_orders%rowtype;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'Invalid approval token';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Name is required';
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select * into v_token from public.project_change_order_access_tokens where token_hash = v_hash for update;
  if not found then
    raise exception 'Approval link is invalid';
  end if;
  if v_token.revoked_at is not null then
    raise exception 'Approval link has been revoked';
  end if;
  if v_token.expires_at < now() then
    raise exception 'Approval link has expired';
  end if;

  select * into v_co from public.project_change_orders where id = v_token.change_order_id for update;
  if not found then
    raise exception 'Change Order not found';
  end if;
  if v_co.version <> v_token.version then
    raise exception 'This approval link refers to an outdated version of this Change Order';
  end if;
  if v_co.status not in ('sent', 'viewed') then
    raise exception 'This Change Order is no longer awaiting approval';
  end if;
  if v_co.approval_due_at is not null and v_co.approval_due_at < now() then
    raise exception 'The approval deadline for this Change Order has passed';
  end if;

  update public.project_change_orders
    set status = 'rejected',
        rejected_at = now(),
        rejected_by_name = p_name,
        rejected_by_email = p_email,
        rejection_reason = p_reason,
        updated_at = now()
    where id = v_co.id;

  insert into public.project_change_order_approvals
    (org_id, project_id, change_order_id, version, action, actor_type, actor_contact_id,
     actor_name, actor_email, actor_ip, user_agent, source, rejection_reason)
  values
    (v_co.org_id, v_co.project_id, v_co.id, v_co.version, 'rejected', 'customer', v_token.recipient_contact_id,
     p_name, p_email, p_ip, p_user_agent, 'portal', p_reason);

  update public.project_change_order_access_tokens
    set use_count = use_count + 1,
        first_used_at = coalesce(first_used_at, now()),
        last_used_at = now(),
        revoked_at = now()
    where change_order_id = v_co.id and revoked_at is null;

  return jsonb_build_object('status', 'rejected', 'changeOrderId', v_co.id);
end;
$$;

revoke all on function public.reject_project_change_order(text, text, text, text, inet, text) from public;
grant execute on function public.reject_project_change_order(text, text, text, text, inet, text) to anon, authenticated;

commit;

-- ============================================================================
-- POST-DEPLOYMENT VERIFICATION (run manually, not part of this migration)
-- ============================================================================
-- select table_name from information_schema.tables
--   where table_schema = 'public' and table_name like 'project_change_order%'
--   order by table_name;
--
-- select conname from pg_constraint
--   where conrelid = 'public.project_change_orders'::regclass;
--
-- select policyname, cmd from pg_policies
--   where tablename in ('project_change_orders','project_change_order_items',
--     'project_change_order_versions','project_change_order_approvals',
--     'project_change_order_access_tokens','project_financial_adjustments')
--   order by tablename, cmd;
--
-- select proname from pg_proc
--   where proname in ('approve_project_change_order','reject_project_change_order',
--     'send_project_change_order','cancel_project_change_order',
--     'create_project_change_order_revision',
--     'apply_project_change_order_schedule_impact','calculate_change_order_totals',
--     'enforce_change_order_lifecycle','enforce_change_order_insert_state');
--
-- -- Confirm digest()/pgcrypto resolves inside the SECURITY DEFINER function
-- -- (32+ char token clears the length check and reaches the digest() call;
-- -- expect "Approval link is invalid", NOT "function digest(...) does not exist"):
-- select public.approve_project_change_order(repeat('x', 32), 'Test', 'test@example.com');
--
-- -- Confirm the privileged RPCs are NOT callable by authenticated/anon
-- -- (expect "permission denied for function ..."):
-- -- (run as an authenticated, non-service-role session)
-- -- select public.send_project_change_order('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, repeat('x', 32), now() + interval '1 day');
--
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--   where routine_name in ('send_project_change_order','cancel_project_change_order',
--     'create_project_change_order_revision','apply_project_change_order_schedule_impact')
--   order by routine_name, grantee;
--
-- -- Confirm the lineage uniqueness/reversal model:
-- -- select project_id, change_order_number, version, status from public.project_change_orders order by change_order_number, version;
-- -- select source_id, amount, status, reversed_at from public.project_financial_adjustments where source_type = 'change_order' order by applied_at;
--
-- -- Round 5 verification ideas:
-- -- 1) As authenticated, INSERT a clean draft while supplying CO-999; verify
-- --    the stored number is the next database-assigned CO-###, not CO-999.
-- -- 2) As authenticated, attempt INSERT with parent_change_order_id set;
-- --    expect rejection / RLS denial.
-- -- 3) As authenticated, attempt created_by <> auth.uid(); expect rejection.
-- -- 4) Create a trusted revision from the latest row; expect same CO number and
-- --    version + 1. Attempt another revision from an older parent; expect
-- --    "A newer revision already exists for this Change Order".
