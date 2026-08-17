-- ============================================================================
-- Phase 14.1 — Campaigns & Messaging Foundation
--
-- Adds/evolves the canonical schema for one-time Email/SMS Campaigns sent
-- to existing CRM contacts (leads, customers, past customers). Replaces
-- the prior fully-mocked "Broadcasts" UI (localStorage-only, no backend
-- table, no real send pipeline — see src/lib/broadcasts-store.ts) with a
-- real, org-scoped, RLS-protected schema.
--
-- ============================================================================
-- LIVE SCHEMA RECONCILIATION (2026-08-15) — READ BEFORE TOUCHING THIS FILE
-- ============================================================================
-- An earlier draft of this migration wrote `create table if not exists
-- marketing_campaigns` / `marketing_campaign_recipients` / (a differently-
-- shaped) `marketing_templates`. Those `CREATE TABLE IF NOT EXISTS`
-- statements would have silently no-op'd on apply: `public.campaigns`,
-- `public.campaign_recipients`, and `public.marketing_templates` ALREADY
-- EXIST in the live database (provisioned outside this repo's migration
-- history — exactly the trap the database-migrations skill warns about).
-- That draft never applied (its own transaction rolled back on an
-- unrelated failure), so no live damage was done, but this file has been
-- rewritten from scratch to use the real live tables instead of
-- duplicating them.
--
-- Confirmed (grepped supabase/migrations + src/ + netlify/functions)
-- before writing this version: zero application code anywhere in this
-- repo referenced `campaigns`/`campaign_recipients`/`marketing_templates`
-- before this rewrite — the only references were this migration's own
-- abandoned draft and the Phase 14.1 store/functions built against it,
-- which are being updated in the same pass as this file. `content jsonb`
-- on the live `marketing_templates` also has zero other consumers
-- (confirmed by grep — a same-named `.content` field on
-- proposal-templates-store.ts belongs to a completely different,
-- unrelated table) and the table has 0 rows, so it is safe to evolve.
--
-- Canonical Phase 14.1 tables as of this version:
--   1. public.campaigns                    (EXISTING — ALTERed, not created)
--   2. public.campaign_recipients          (EXISTING — ALTERed, not created)
--   3. public.marketing_templates          (EXISTING — ALTERed, not created)
--   4. public.marketing_segments           (NEW)
--   5. public.marketing_contact_preferences(NEW)
--   6. public.marketing_unsubscribe_tokens (NEW)
--
-- `public.voice_campaigns` (a separate AI Voice feature — tenant_id,
-- agent_id, contact_list, call scheduling) is NOT touched anywhere in
-- this file. Not renamed, not merged, not referenced.
--
-- `marketing_campaigns` / `marketing_campaign_recipients` (the abandoned
-- draft's table names) are NOT created anywhere in this file and must not
-- reappear in application code — see the Phase 14.1 store/functions,
-- updated in this same pass to query `campaigns`/`campaign_recipients`.
--
-- Other audit notes carried over from the original draft (still true):
--   - contacts / leads / companies have NO CREATE TABLE in this repo's
--     migration history (base tables provisioned outside local migrations).
--   - contacts has NO consent/opt-out/suppression columns — kept that way;
--     see marketing_contact_preferences below (a dedicated table, not
--     columns on contacts — Postgres RLS is row-level, not column-level,
--     so ordinary authenticated contact edits could otherwise clear
--     compliance state silently).
--   - workflow_trigger_queue is documented dead/unsafe infrastructure
--     (20260731_agentic_foundation.sql) — NOT reused. The claimed_by/
--     claimed_at/attempt_count shape mirrored on campaign_recipients below
--     instead follows agent_executions' precedent.
--   - The "trusted caller" role-check pattern (current_user not in
--     ('authenticated', 'anon')) used throughout this migration's guard
--     triggers is copied verbatim from the established, applied pattern in
--     20260815_project_change_orders.sql — not a new invention.
--
-- Does NOT touch any already-applied migration. Does NOT touch Financials/
-- accounting tables. Does NOT touch voice_campaigns. This file is
-- UNAPPLIED — the user applies it manually via the Supabase SQL Editor.
-- ============================================================================

begin;

-- ============================================================================
-- 1. marketing_contact_preferences (NEW) — dedicated service-role-owned
--    table. Email and SMS opt-out are tracked independently: an SMS STOP
--    must never imply email unsubscribe and vice versa.
--
-- Why not columns on contacts: contacts already supports ordinary
-- authenticated CRUD (org-scoped insert policy confirmed in
-- 20260606_deals_rls_and_wtq.sql; contacts-store.ts's updateContact()
-- performs full-row updates from the browser today and that already works
-- in production). Postgres RLS is row-level, not column-level — a policy
-- that lets an org member update a contact's name/phone/email cannot
-- selectively protect a handful of other columns on that same row.
-- Putting the state in its own table sidesteps that entirely: authenticated
-- gets SELECT only, every write goes through service_role.
--
-- Email vs SMS use different default postures, deliberately:
--   - Email defaults to eligible/subscribed (no row = not unsubscribed,
--     not suppressed) — an opt-OUT model.
--   - SMS defaults to 'unknown', NOT eligible (no row = unknown) — an
--     opt-IN-style eligibility model. A CRM phone number was very likely
--     collected for calls/appointments, not necessarily marketing SMS
--     consent, so it must never be treated as implicitly eligible. Only
--     'eligible' is ever included in an SMS campaign's recipient set.
-- ============================================================================

create table if not exists public.marketing_contact_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  email_unsubscribed boolean not null default false,
  email_unsubscribed_at timestamptz,
  email_suppressed boolean not null default false,
  email_suppressed_reason text,
  -- unknown:    no eligibility established yet (the safe default for every
  --             existing/new contact — never implicitly eligible).
  -- eligible:   a trusted path (marketing-contact-preferences-set.ts) has
  --             recorded that this contact may receive marketing SMS.
  -- opted_out:  an inbound Twilio STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT
  --             reply was received (marketing-sms-inbound.ts).
  -- suppressed: reserved for future carrier-level invalid/undeliverable
  --             number handling once that signal exists. Never auto-set.
  sms_status text not null default 'unknown'
    check (sms_status in ('unknown', 'eligible', 'opted_out', 'suppressed')),
  sms_status_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_marketing_contact_preferences_contact unique (contact_id)
);

create index if not exists idx_marketing_contact_preferences_org
  on public.marketing_contact_preferences (org_id);
create index if not exists idx_marketing_contact_preferences_sms_status
  on public.marketing_contact_preferences (org_id, sms_status);

create or replace function public.set_marketing_contact_preferences_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_marketing_contact_preferences_updated_at on public.marketing_contact_preferences;
create trigger trg_marketing_contact_preferences_updated_at
  before update on public.marketing_contact_preferences
  for each row execute function public.set_marketing_contact_preferences_updated_at();

create or replace function public.validate_marketing_contact_preferences_refs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.contacts ct
    where ct.id = new.contact_id and ct.org_id = new.org_id
  ) then
    raise exception 'contact_id % does not belong to org %', new.contact_id, new.org_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_validate_marketing_contact_preferences_refs on public.marketing_contact_preferences;
create trigger trg_validate_marketing_contact_preferences_refs
  before insert or update on public.marketing_contact_preferences
  for each row execute function public.validate_marketing_contact_preferences_refs();

alter table public.marketing_contact_preferences enable row level security;

drop policy if exists marketing_contact_preferences_select on public.marketing_contact_preferences;
create policy marketing_contact_preferences_select on public.marketing_contact_preferences
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- No insert/update/delete policy for authenticated at all — every mutation
-- (unsubscribe link, SMS STOP, the trusted "mark SMS eligible" action)
-- goes through a service_role Netlify function.
revoke insert, update, delete on public.marketing_contact_preferences from anon, authenticated;
revoke all on public.marketing_contact_preferences from anon;
grant select on public.marketing_contact_preferences to authenticated;
grant select, insert, update, delete on public.marketing_contact_preferences to service_role;

-- ============================================================================
-- 2. marketing_templates (EXISTING TABLE — reconciled, not created).
--
-- Live shape before this migration: id, org_id, created_by uuid NOT NULL,
-- name varchar NOT NULL, description text, template_type varchar NOT NULL,
-- category varchar, content jsonb NOT NULL, is_shared boolean default
-- false, usage_count integer default 0, created_at, updated_at. 0 rows.
--
-- Rationalization chosen (table is empty, so this is a one-time schema
-- decision, not a data migration):
--   - `template_type` is kept as the canonical channel field (avoids
--     maintaining both `template_type` and a second `channel` column) —
--     restricted here to 'email'/'sms'.
--   - `content jsonb` is DROPPED and replaced with explicit
--     `email_subject text` + `body text` columns. It was over-general for
--     a simple Campaign template and had zero other consumers anywhere in
--     this repo (grepped before making this change — see the header
--     note), so this is a clean evolution, not a breaking change to any
--     real feature.
--   - `is_archived boolean` is added (was implicit nowhere before).
--   - `description`, `category`, `is_shared`, `usage_count` are KEPT as
--     dormant/future-use columns — not surfaced in the Phase 14.1
--     Templates UI yet, but not dropped either (may be genuinely useful
--     later and dropping them is not required to reach a clean model).
-- ============================================================================

alter table public.marketing_templates
  add column if not exists email_subject text,
  add column if not exists body text,
  add column if not exists is_archived boolean not null default false;

-- content had no default and was NOT NULL; safe to drop outright since the
-- table has 0 rows and, per the header note, no other code reads it.
alter table public.marketing_templates drop column if exists content;

-- body becomes the canonical message field going forward (mirrors
-- campaigns.content below) — NOT NULL with a safe default now that the
-- table is otherwise empty.
update public.marketing_templates set body = '' where body is null;
alter table public.marketing_templates alter column body set default '';
alter table public.marketing_templates alter column body set not null;

alter table public.marketing_templates drop constraint if exists marketing_templates_template_type_check;
alter table public.marketing_templates
  add constraint marketing_templates_template_type_check
  check (template_type in ('email', 'sms'));

-- Templates are complete, reusable resources (no wizard/draft concept,
-- unlike campaigns) — requires genuinely non-blank subject content, not
-- just non-null.
alter table public.marketing_templates drop constraint if exists marketing_templates_email_subject_required;
alter table public.marketing_templates
  add constraint marketing_templates_email_subject_required
  check (template_type <> 'email' or (email_subject is not null and btrim(email_subject) <> ''));

create index if not exists idx_marketing_templates_org
  on public.marketing_templates (org_id, is_archived);

-- Ownership integrity — covers BOTH insert and update. INSERT (untrusted
-- caller): created_by must resolve to auth.uid() — null is filled in, an
-- arbitrary/other value is rejected (created_by is NOT NULL live, so an
-- untrusted insert with no created_by at all would otherwise fail the
-- NOT NULL constraint rather than being filled — this trigger fires
-- BEFORE that check, so the fill-in still applies). UPDATE (untrusted
-- caller): created_by and org_id are BOTH pinned back to their prior
-- values — no exceptions, no "editor becomes new owner" behavior. Any
-- other org member with row access may still edit real content without
-- becoming the record's attributed creator or moving it to another org.
-- Reused identically for marketing_segments below — one function, not two
-- copies of the same logic.
create or replace function public.enforce_marketing_owned_content_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_trusted_caller boolean := current_user not in ('authenticated', 'anon');
  v_uid uuid := auth.uid();
begin
  if not v_is_trusted_caller then
    if TG_OP = 'INSERT' then
      if new.created_by is null then
        new.created_by := v_uid;
      elsif new.created_by is distinct from v_uid then
        raise exception 'created_by must match the authenticated user';
      end if;
    elsif TG_OP = 'UPDATE' then
      new.created_by := old.created_by;
      new.org_id := old.org_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_marketing_templates_owner_guard on public.marketing_templates;
create trigger trg_marketing_templates_owner_guard
  before insert or update on public.marketing_templates
  for each row execute function public.enforce_marketing_owned_content_guard();

create or replace function public.set_marketing_templates_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_marketing_templates_updated_at on public.marketing_templates;
create trigger trg_marketing_templates_updated_at
  before update on public.marketing_templates
  for each row execute function public.set_marketing_templates_updated_at();

alter table public.marketing_templates enable row level security;

-- Exact prior policy names/definitions on this live table are unknown
-- (only "an existing INSERT policy" and "an existing SELECT policy" were
-- confirmed to exist, not their exact source) — dropping by assumed name
-- would risk leaving an unknown-shaped permissive policy active alongside
-- ours (RLS permissive policies OR together, so a stale broad policy
-- would silently widen access even after this migration runs). Drop
-- EVERY existing policy on this table by querying pg_policies directly,
-- name-agnostic, then install exactly the four policies Phase 14.1 needs.
do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'marketing_templates' loop
    execute format('drop policy if exists %I on public.marketing_templates', pol.policyname);
  end loop;
end $$;

create policy marketing_templates_select on public.marketing_templates
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

create policy marketing_templates_insert on public.marketing_templates
  for insert to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

create policy marketing_templates_update on public.marketing_templates
  for update to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  )
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

create policy marketing_templates_delete on public.marketing_templates
  for delete to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.marketing_templates from anon, authenticated;
grant select, insert, update, delete on public.marketing_templates to authenticated;
grant select, insert, update, delete on public.marketing_templates to service_role;

-- ============================================================================
-- 3. marketing_segments (NEW) — user-facing "Audiences". Filters are
--    stored as a validated, whitelisted JSON shape (validated server-side
--    by the Netlify audience-preview/send functions — never raw SQL/
--    client query fragments — see src/lib/marketing-audience.ts).
-- ============================================================================

create table if not exists public.marketing_segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_marketing_segments_org
  on public.marketing_segments (org_id);

-- Reuses enforce_marketing_owned_content_guard() defined above (Part 2) —
-- same insert+update ownership rule, not a second copy of the logic.
drop trigger if exists trg_marketing_segments_owner_guard on public.marketing_segments;
create trigger trg_marketing_segments_owner_guard
  before insert or update on public.marketing_segments
  for each row execute function public.enforce_marketing_owned_content_guard();

create or replace function public.set_marketing_segments_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_marketing_segments_updated_at on public.marketing_segments;
create trigger trg_marketing_segments_updated_at
  before update on public.marketing_segments
  for each row execute function public.set_marketing_segments_updated_at();

alter table public.marketing_segments enable row level security;

drop policy if exists marketing_segments_select on public.marketing_segments;
create policy marketing_segments_select on public.marketing_segments
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists marketing_segments_insert on public.marketing_segments;
create policy marketing_segments_insert on public.marketing_segments
  for insert to authenticated
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists marketing_segments_update on public.marketing_segments;
create policy marketing_segments_update on public.marketing_segments
  for update to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  )
  with check (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

drop policy if exists marketing_segments_delete on public.marketing_segments;
create policy marketing_segments_delete on public.marketing_segments
  for delete to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

revoke all on public.marketing_segments from anon;
grant select, insert, update, delete on public.marketing_segments to authenticated;
grant select, insert, update, delete on public.marketing_segments to service_role;

-- ============================================================================
-- 4. campaigns (EXISTING TABLE — reconciled, not created).
--
-- Live shape before this migration: id, org_id, name, campaign_type,
-- status default 'draft', subject, content NOT NULL, plain_text_content,
-- from_name, from_email, reply_to, scheduled_at, started_at, completed_at,
-- target_audience jsonb default {}, stats jsonb default {}, settings
-- jsonb default {}, created_by, created_at, updated_at, description,
-- budget, actual_cost default 0, total_recipients default 0,
-- successful_deliveries default 0, opens default 0, clicks default 0,
-- conversions default 0. RLS enabled with a broad
-- "Users can manage campaigns in their org" FOR ALL policy and a
-- "Users can view campaigns in their org" SELECT policy. 2 existing rows.
--
-- Column mapping decisions (documented once, not left ambiguous):
--   - campaign_type is the canonical channel field (email/sms) — kept
--     as-is rather than renamed, to avoid unnecessary migration churn.
--   - subject / content / plain_text_content / from_name / from_email /
--     reply_to / description / target_audience are kept as the canonical
--     user-editable fields (target_audience is the audience-filter
--     snapshot — same role the draft design called "audience_filters").
--   - total_recipients is reused as the canonical "eligible recipients
--     queued" counter — no separate recipients_total column added.
--   - successful_deliveries, opens, clicks, conversions, actual_cost,
--     stats are LEGACY: kept in the table for compatibility (never
--     dropped — nothing here proves nothing else could read them), never
--     written by Phase 14.1 code, never surfaced in the Phase 14.1 UI,
--     and — like every other backend-owned field — protected from client
--     tampering by the write-guard trigger below. NEW, clearly-named
--     counters (recipients_sent/delivered/failed/excluded) are added
--     instead of overloading the legacy ones, so there is exactly one
--     counter set the Phase 14.1 UI actually reads.
--   - budget and settings are left as freely user-editable/unmanaged —
--     they carry no lifecycle or delivery-integrity meaning, so there is
--     no compliance reason to lock them the way counters/timestamps are
--     locked.
--   - segment_id / template_id are new FKs into marketing_segments /
--     marketing_templates (both did not exist as concepts before this
--     migration's other new/altered tables).
-- ============================================================================

alter table public.campaigns
  add column if not exists segment_id uuid references public.marketing_segments(id) on delete set null,
  add column if not exists template_id uuid references public.marketing_templates(id) on delete set null,
  add column if not exists recipients_sent integer not null default 0,
  add column if not exists recipients_delivered integer not null default 0,
  add column if not exists recipients_failed integer not null default 0,
  add column if not exists recipients_excluded integer not null default 0;

-- ── Controlled reconciliation of pre-existing invalid data (Phase 14.1
-- hardening review) — BEFORE installing the strict lifecycle constraint
-- below. One of the two preserved rows has status = 'scheduled' with
-- scheduled_at = null, which the new "scheduled requires scheduled_at"
-- invariant would reject. It has zero recipients and is clearly
-- legacy/demo data (never actually processed by any real send pipeline —
-- none existed before this feature). Rather than fabricate a timestamp
-- (which would misrepresent when/whether it was ever really scheduled),
-- it is moved back to 'draft' — the honest representation of "not
-- actually scheduled." No row is deleted or truncated; both original
-- campaigns are preserved.
update public.campaigns
  set status = 'draft'
  where status = 'scheduled' and scheduled_at is null;

-- Live database reconciliation: the pre-existing campaign-type constraint
-- is named campaigns_type_check and allows ('email','sms','both'). Drop
-- that exact live constraint first, then defensively drop the abandoned
-- pre-apply name too before installing the canonical Phase 14.1 check.
alter table public.campaigns
  drop constraint if exists campaigns_type_check;

alter table public.campaigns
  drop constraint if exists campaigns_campaign_type_check;

alter table public.campaigns
  add constraint campaigns_campaign_type_check
  check (campaign_type in ('email', 'sms'));

alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('draft', 'scheduled', 'queued', 'sending', 'completed', 'canceled', 'failed'));

alter table public.campaigns drop constraint if exists campaigns_scheduled_requires_scheduled_at;
alter table public.campaigns
  add constraint campaigns_scheduled_requires_scheduled_at
  check (status <> 'scheduled' or scheduled_at is not null);

alter table public.campaigns drop constraint if exists campaigns_draft_has_no_lifecycle_timestamps;
alter table public.campaigns
  add constraint campaigns_draft_has_no_lifecycle_timestamps
  check (status <> 'draft' or (started_at is null and completed_at is null));

alter table public.campaigns drop constraint if exists campaigns_completed_requires_completed_at;
alter table public.campaigns
  add constraint campaigns_completed_requires_completed_at
  check (status <> 'completed' or completed_at is not null);

alter table public.campaigns drop constraint if exists campaigns_counts_non_negative;
alter table public.campaigns
  add constraint campaigns_counts_non_negative
  check (
    total_recipients >= 0 and recipients_sent >= 0 and recipients_delivered >= 0
    and recipients_failed >= 0 and recipients_excluded >= 0 and successful_deliveries >= 0
  );

-- Provider semantics: delivered can't exceed sent, and sent/failed can't
-- exceed the eligible total this campaign was queued for. Deliberately
-- NOT a strict sent+failed=total partition — legitimate retries can still
-- be in flight (neither sent nor failed yet) without violating this.
alter table public.campaigns drop constraint if exists campaigns_delivered_le_sent;
alter table public.campaigns
  add constraint campaigns_delivered_le_sent
  check (recipients_delivered <= recipients_sent);

alter table public.campaigns drop constraint if exists campaigns_sent_le_total;
alter table public.campaigns
  add constraint campaigns_sent_le_total
  check (recipients_sent <= total_recipients);

alter table public.campaigns drop constraint if exists campaigns_failed_le_total;
alter table public.campaigns
  add constraint campaigns_failed_le_total
  check (recipients_failed <= total_recipients);

create index if not exists idx_campaigns_org_status
  on public.campaigns (org_id, status);
create index if not exists idx_campaigns_scheduled
  on public.campaigns (status, scheduled_at)
  where status = 'scheduled';

create or replace function public.set_campaigns_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The live database already has a legacy BEFORE UPDATE trigger named
-- update_campaigns_updated_at that calls update_updated_at_column().
-- Remove only that trigger from campaigns so this table has exactly one
-- canonical updated_at trigger after Phase 14.1. Do NOT drop the shared
-- update_updated_at_column() function because other tables may use it.
drop trigger if exists update_campaigns_updated_at on public.campaigns;

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.set_campaigns_updated_at();

-- Same-org validation: template_id / segment_id must belong to the same
-- org as the campaign — a bare FK doesn't guarantee that.
create or replace function public.validate_campaigns_refs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.template_id is not null and not exists (
    select 1 from public.marketing_templates t
    where t.id = new.template_id and t.org_id = new.org_id
  ) then
    raise exception 'template_id % does not belong to org %', new.template_id, new.org_id;
  end if;

  if new.segment_id is not null and not exists (
    select 1 from public.marketing_segments s
    where s.id = new.segment_id and s.org_id = new.org_id
  ) then
    raise exception 'segment_id % does not belong to org %', new.segment_id, new.org_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_campaigns_refs on public.campaigns;
create trigger trg_validate_campaigns_refs
  before insert or update on public.campaigns
  for each row execute function public.validate_campaigns_refs();

-- ── Write guard: the real trust boundary for lifecycle + backend-owned
-- fields + created_by. Fires before every insert/update; "trusted caller"
-- means current_user is not the literal 'authenticated'/'anon' role every
-- ordinary PostgREST-routed request executes as (pattern from
-- 20260815_project_change_orders.sql).
--
-- PINNED / backend-owned for untrusted callers: status (beyond draft),
-- scheduled_at, started_at, completed_at, total_recipients,
-- recipients_sent, recipients_delivered, recipients_failed,
-- recipients_excluded, successful_deliveries, opens, clicks, conversions,
-- actual_cost, stats, created_by, org_id.
--
-- EDITABLE for untrusted callers (real campaign content, not lifecycle
-- state): name, campaign_type, subject, content, plain_text_content,
-- description, target_audience, segment_id, template_id, from_name,
-- from_email, reply_to, budget, settings. budget/settings carry no
-- delivery-integrity meaning, so there is no compliance reason to lock
-- them the way counters/timestamps are locked.
create or replace function public.enforce_campaigns_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_trusted_caller boolean := current_user not in ('authenticated', 'anon');
  v_uid uuid := auth.uid();
begin
  if TG_OP = 'INSERT' then
    if not v_is_trusted_caller then
      new.status := 'draft';
      new.scheduled_at := null;
      new.started_at := null;
      new.completed_at := null;
      new.total_recipients := 0;
      new.recipients_sent := 0;
      new.recipients_delivered := 0;
      new.recipients_failed := 0;
      new.recipients_excluded := 0;
      new.successful_deliveries := 0;
      new.opens := 0;
      new.clicks := 0;
      new.conversions := 0;
      new.actual_cost := 0;

      if new.created_by is null then
        new.created_by := v_uid;
      elsif new.created_by is distinct from v_uid then
        raise exception 'created_by must match the authenticated user';
      end if;
    end if;
  elsif TG_OP = 'UPDATE' then
    if not v_is_trusted_caller then
      if old.status <> 'draft' then
        raise exception 'Only draft campaigns can be edited directly — use the schedule/send/cancel action for %', old.status;
      end if;
      if new.status <> 'draft' then
        raise exception 'Campaign status can only be changed by the trusted schedule/send/cancel backend';
      end if;

      new.scheduled_at := old.scheduled_at;
      new.started_at := old.started_at;
      new.completed_at := old.completed_at;
      new.total_recipients := old.total_recipients;
      new.recipients_sent := old.recipients_sent;
      new.recipients_delivered := old.recipients_delivered;
      new.recipients_failed := old.recipients_failed;
      new.recipients_excluded := old.recipients_excluded;
      new.successful_deliveries := old.successful_deliveries;
      new.opens := old.opens;
      new.clicks := old.clicks;
      new.conversions := old.conversions;
      new.actual_cost := old.actual_cost;
      new.created_by := old.created_by;
      new.org_id := old.org_id;
    end if;
  end if;

  -- Readiness check applies to EVERY caller, trusted or not — defense in
  -- depth so a future trusted RPC/worker that accidentally skips a step
  -- still cannot leave an incomplete campaign sitting in an active/
  -- successful processing status. Covers scheduled/queued/sending/
  -- completed; deliberately EXCLUDES draft (still being written) and
  -- canceled/failed (an interrupted lifecycle must remain representable
  -- even if it never got a subject/body).
  --
  -- Deliberately NOT gated on "only when status is actually changing" —
  -- OLD is unassigned in a BEFORE INSERT trigger, so a condition
  -- referencing old.status in a branch also reachable from INSERT would
  -- raise "record old is not assigned yet". Re-running this cheap check on
  -- every update where the row is already in one of these statuses is
  -- harmless.
  if new.status in ('scheduled', 'queued', 'sending', 'completed') then
    if new.campaign_type = 'email' and (new.subject is null or btrim(new.subject) = '') then
      raise exception 'Email campaigns require a non-blank subject before scheduling/sending';
    end if;
    if new.content is null or btrim(new.content) = '' then
      raise exception 'Campaign message content cannot be empty before scheduling/sending';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_campaigns_write_guard on public.campaigns;
create trigger trg_enforce_campaigns_write_guard
  before insert or update on public.campaigns
  for each row execute function public.enforce_campaigns_write_guard();

alter table public.campaigns enable row level security;

-- The pre-existing "Users can manage campaigns in their org" FOR ALL
-- policy is too broad for the hardened lifecycle above (it would let an
-- authenticated client update/delete a row regardless of status,
-- bypassing the whole point of the write guard's status checks — a
-- permissive FOR ALL policy is evaluated independently of the trigger and
-- would still let the UPDATE reach the trigger, but would also allow
-- deletes/other verbs on non-draft rows that should be blocked at the RLS
-- layer too). Exact names ARE known for this table, so they are dropped
-- by name rather than the dynamic pg_policies loop used for
-- marketing_templates above.
drop policy if exists "Users can manage campaigns in their org" on public.campaigns;
drop policy if exists "Users can view campaigns in their org" on public.campaigns;

create policy campaigns_select on public.campaigns
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

create policy campaigns_insert on public.campaigns
  for insert to authenticated
  with check (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    -- Redundant with the write-guard trigger (which forces status to
    -- 'draft' regardless) — kept as a layered, independent check.
    and status = 'draft'
  );

create policy campaigns_update on public.campaigns
  for update to authenticated
  using (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    -- Only a still-draft row may be touched by a client-authored UPDATE at
    -- all — scheduled/queued/sending/completed/canceled/failed campaigns
    -- are 100% backend-owned from here on (schedule, send now, and cancel
    -- are all trusted Netlify functions).
    and status = 'draft'
  )
  with check (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and status = 'draft'
  );

create policy campaigns_delete on public.campaigns
  for delete to authenticated
  using (
    (
      org_id in (select organization_id from public.profiles where id = auth.uid())
      or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
    )
    and status = 'draft'
  );

revoke all on public.campaigns from anon, authenticated;
grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.campaigns to service_role;

-- ============================================================================
-- 5. campaign_recipients (EXISTING TABLE — reconciled, not created).
--
-- Live shape before this migration: id, campaign_id, contact_id
-- (nullable, no FK), contact_email varchar NOT NULL, contact_name,
-- contact_phone, status varchar default 'pending', sent_at, opened_at,
-- clicked_at, converted_at, metadata jsonb default {}, created_at.
-- 0 rows — RLS enabled with a SELECT policy keyed off campaigns.org_id.
--
-- Evolved (table is empty, so this is a one-time schema decision, not a
-- data migration) into the hardened queue/send-state model:
--   - org_id added and made NOT NULL — safe with 0 rows, no backfill
--     needed, but still done as a two-step ADD-then-SET-NOT-NULL (not a
--     single "ADD COLUMN ... NOT NULL") so this migration stays safe to
--     reason about even if it were ever re-run against a table that
--     somehow already had rows.
--   - contact_id made NOT NULL + FK to contacts(id) — Phase 14.1
--     Campaigns only ever sends to existing CRM contacts, never arbitrary
--     email/phone lists (explicit product requirement).
--   - `destination` added as the ONE canonical snapshotted send target
--     (email address or E.164 phone, captured at enqueue time). The
--     legacy `contact_email`/`contact_phone` columns are KEPT for
--     compatibility/display but the send worker reads ONLY `destination`
--     — no ambiguity about which field is authoritative. contact_email's
--     NOT NULL is relaxed since an SMS-channel recipient legitimately has
--     no email at all.
--   - status widened to the full pending/queued/sending/sent/delivered/
--     failed/excluded set (see the 'sending' column comment below for
--     why that state exists).
--   - queued_at/delivered_at/failed_at/failure_reason/provider_message_id/
--     excluded_reason/claimed_by/claimed_at/attempt_count/updated_at
--     added for the durable queue/idempotency model.
--   - opened_at/clicked_at/converted_at are KEPT (legacy/future-use) but
--     the new queue/send architecture does NOT read or write them — no
--     real open/click tracking pipeline exists.
-- ============================================================================

alter table public.campaign_recipients
  add column if not exists org_id uuid;
update public.campaign_recipients cr
  set org_id = c.org_id
  from public.campaigns c
  where cr.campaign_id = c.id and cr.org_id is null;
alter table public.campaign_recipients
  alter column org_id set not null;
alter table public.campaign_recipients drop constraint if exists campaign_recipients_org_id_fkey;
alter table public.campaign_recipients
  add constraint campaign_recipients_org_id_fkey foreign key (org_id) references public.organizations(id) on delete cascade;

alter table public.campaign_recipients
  alter column contact_id set not null;
alter table public.campaign_recipients drop constraint if exists campaign_recipients_contact_id_fkey;
alter table public.campaign_recipients
  add constraint campaign_recipients_contact_id_fkey foreign key (contact_id) references public.contacts(id) on delete cascade;

-- contact_email is no longer the canonical destination (see `destination`
-- below) — an SMS-only recipient legitimately has no email value.
alter table public.campaign_recipients alter column contact_email drop not null;

alter table public.campaign_recipients
  add column if not exists destination text;
update public.campaign_recipients set destination = contact_email where destination is null and contact_email is not null;
update public.campaign_recipients set destination = contact_phone where destination is null and contact_phone is not null;
alter table public.campaign_recipients alter column destination set not null;

alter table public.campaign_recipients
  add column if not exists queued_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists provider_message_id text,
  add column if not exists excluded_reason text,
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

alter table public.campaign_recipients alter column status set default 'pending';
alter table public.campaign_recipients drop constraint if exists campaign_recipients_status_check;
-- 'sending' is a durable, persisted "attempt in flight" marker written
-- BEFORE the provider is called (not just an in-memory step) — see the
-- ambiguous-provider-window analysis in
-- marketing-campaign-process-queue.ts. A row stuck in 'sending' past the
-- staleness window is never silently reclaimed as 'queued' again; it is
-- swept to 'failed' with an explicit ambiguous-outcome reason instead,
-- because neither Twilio nor Gmail SMTP gives this worker a safe way to
-- confirm after the fact whether an ambiguous attempt actually sent.
alter table public.campaign_recipients
  add constraint campaign_recipients_status_check
  check (status in ('pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'excluded'));

alter table public.campaign_recipients drop constraint if exists uq_campaign_recipients_campaign_contact;
alter table public.campaign_recipients
  add constraint uq_campaign_recipients_campaign_contact unique (campaign_id, contact_id);

create index if not exists idx_campaign_recipients_campaign
  on public.campaign_recipients (campaign_id, status);
create index if not exists idx_campaign_recipients_org
  on public.campaign_recipients (org_id);
create index if not exists idx_campaign_recipients_queued
  on public.campaign_recipients (status, claimed_at)
  where status = 'queued';
create index if not exists idx_campaign_recipients_sending
  on public.campaign_recipients (status, claimed_at)
  where status = 'sending';

create or replace function public.set_campaign_recipients_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_campaign_recipients_updated_at on public.campaign_recipients;
create trigger trg_campaign_recipients_updated_at
  before update on public.campaign_recipients
  for each row execute function public.set_campaign_recipients_updated_at();

-- Same-org validation: campaign_id and contact_id must both belong to the
-- recipient row's own org_id — a bare FK doesn't guarantee that.
create or replace function public.validate_campaign_recipient_refs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.campaigns c
    where c.id = new.campaign_id and c.org_id = new.org_id
  ) then
    raise exception 'campaign_id % does not belong to org %', new.campaign_id, new.org_id;
  end if;

  if not exists (
    select 1 from public.contacts ct
    where ct.id = new.contact_id and ct.org_id = new.org_id
  ) then
    raise exception 'contact_id % does not belong to org %', new.contact_id, new.org_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_campaign_recipient_refs on public.campaign_recipients;
create trigger trg_validate_campaign_recipient_refs
  before insert or update on public.campaign_recipients
  for each row execute function public.validate_campaign_recipient_refs();

alter table public.campaign_recipients enable row level security;

-- Exact prior policy name/definition on this table is unknown (only "a
-- SELECT policy based on campaigns.org_id" was confirmed) — drop
-- name-agnostically via pg_policies, same reasoning as marketing_templates
-- above, then install exactly the one policy Phase 14.1 needs.
do $$
declare
  pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'campaign_recipients' loop
    execute format('drop policy if exists %I on public.campaign_recipients', pol.policyname);
  end loop;
end $$;

create policy campaign_recipients_select on public.campaign_recipients
  for select to authenticated
  using (
    org_id in (select organization_id from public.profiles where id = auth.uid())
    or org_id in (select org_id from public.org_memberships where member_id = auth.uid())
  );

-- No insert/update/delete policy for authenticated — every mutation goes
-- through the service_role-only backend, exactly like invoice_payments /
-- invoice_payment_refunds.
revoke all on public.campaign_recipients from anon, authenticated;
grant select on public.campaign_recipients to authenticated;
grant select, insert, update, delete on public.campaign_recipients to service_role;

-- ============================================================================
-- 6. marketing_unsubscribe_tokens (NEW) — opaque, unpredictable tokens
--    backing the public (no-login) email unsubscribe link. Never expose
--    contact_id or org_id directly in a URL — the token is the only thing
--    a recipient's browser ever sees. campaign_id now points at the real
--    live `campaigns` table, not the abandoned `marketing_campaigns`.
--
--    No client access at all (not even read) — used exclusively by the
--    marketing-unsubscribe Netlify function via service_role, which
--    bypasses RLS. RLS is still enabled with zero permissive policies as
--    a defense-in-depth default-deny.
-- ============================================================================

create table if not exists public.marketing_unsubscribe_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  token text not null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  expires_at timestamptz not null default (now() + interval '2 years'),
  constraint uq_marketing_unsubscribe_tokens_token unique (token)
);

create index if not exists idx_marketing_unsubscribe_tokens_contact
  on public.marketing_unsubscribe_tokens (contact_id, channel);

-- Cross-org validation: a bare set of independent FKs does not prove
-- contact_id/campaign_id/org_id form a consistent same-org relationship.
create or replace function public.validate_marketing_unsubscribe_token_refs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.contacts ct
    where ct.id = new.contact_id and ct.org_id = new.org_id
  ) then
    raise exception 'contact_id % does not belong to org %', new.contact_id, new.org_id;
  end if;

  if new.campaign_id is not null and not exists (
    select 1 from public.campaigns c
    where c.id = new.campaign_id and c.org_id = new.org_id
  ) then
    raise exception 'campaign_id % does not belong to org %', new.campaign_id, new.org_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_marketing_unsubscribe_token_refs on public.marketing_unsubscribe_tokens;
create trigger trg_validate_marketing_unsubscribe_token_refs
  before insert or update on public.marketing_unsubscribe_tokens
  for each row execute function public.validate_marketing_unsubscribe_token_refs();

alter table public.marketing_unsubscribe_tokens enable row level security;
-- Deliberately no select/insert/update/delete policy for anon/authenticated
-- — default-deny. service_role bypasses RLS.

revoke all on public.marketing_unsubscribe_tokens from anon, authenticated;
grant select, insert, update, delete on public.marketing_unsubscribe_tokens to service_role;

commit;

-- ============================================================================
-- VERIFICATION — run after applying, before trusting this migration:
-- ============================================================================
--
-- -- 1. Final six canonical tables exist (3 pre-existing/ALTERed, 3 new):
-- select table_name from information_schema.tables
-- where table_schema = 'public' and table_name in (
--   'campaigns','campaign_recipients','marketing_templates',
--   'marketing_segments','marketing_contact_preferences','marketing_unsubscribe_tokens'
-- );
--
-- -- 2. voice_campaigns is untouched — same column count/shape as before
-- --    this migration ran (compare manually against a pre-apply snapshot;
-- --    this migration contains zero statements referencing voice_campaigns):
-- select count(*) from information_schema.columns
-- where table_schema = 'public' and table_name = 'voice_campaigns';
--
-- -- 3. campaigns still has its 2 preserved rows:
-- select id, name, status, scheduled_at from public.campaigns order by created_at;
-- -- expect 2 rows, "Spring Renovation Special" / "Follow-up with Cold Leads".
--
-- -- 4. The invalid legacy scheduled/no-date row is now draft:
-- select count(*) from public.campaigns where status = 'scheduled' and scheduled_at is null;
-- -- expect 0.
--
-- -- 5. campaign_recipients still has 0 rows (nothing fabricated):
-- select count(*) from public.campaign_recipients;
-- -- expect 0.
--
-- -- 6. marketing_templates still has 0 rows:
-- select count(*) from public.marketing_templates;
-- -- expect 0.
--
-- -- 7. RLS enabled on all six:
-- select relname, relrowsecurity from pg_class
-- where relname in (
--   'campaigns','campaign_recipients','marketing_templates',
--   'marketing_segments','marketing_contact_preferences','marketing_unsubscribe_tokens'
-- );
--
-- -- 8. Exact policy names/commands:
-- select tablename, policyname, cmd from pg_policies
-- where tablename in (
--   'campaigns','campaign_recipients','marketing_templates',
--   'marketing_segments','marketing_contact_preferences','marketing_unsubscribe_tokens'
-- ) order by tablename, cmd;
-- -- expect: campaigns (select/insert/update/delete, our 4 new names — the
-- -- old "Users can manage campaigns in their org" FOR ALL and "Users can
-- -- view campaigns in their org" must NOT appear); campaign_recipients
-- -- (1, select-only, ours); marketing_templates (4, our 4 new names — no
-- -- unrecognized leftover policy names); marketing_segments (4);
-- -- marketing_contact_preferences (1, select-only); marketing_unsubscribe_tokens (0).
--
-- -- 9. Grants:
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
-- where table_schema = 'public' and table_name in (
--   'campaigns','campaign_recipients','marketing_templates',
--   'marketing_segments','marketing_contact_preferences','marketing_unsubscribe_tokens'
-- ) and grantee in ('anon','authenticated','service_role')
-- order by table_name, grantee, privilege_type;
--
-- -- 10. Triggers:
-- select event_object_table, trigger_name from information_schema.triggers
-- where event_object_table in (
--   'campaigns','campaign_recipients','marketing_templates',
--   'marketing_segments','marketing_contact_preferences','marketing_unsubscribe_tokens'
-- ) order by event_object_table;
--
-- -- 11. Constraints on campaigns/campaign_recipients/marketing_templates:
-- select conrelid::regclass as table_name, conname, contype from pg_constraint
-- where conrelid in (
--   'public.campaigns'::regclass, 'public.campaign_recipients'::regclass,
--   'public.marketing_templates'::regclass
-- ) order by table_name, conname;
--
-- -- 12. campaign_recipients status constraint includes 'sending':
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conname = 'campaign_recipients_status_check';
--
-- -- 13. SMS preference default/absence resolves to 'unknown':
-- select coalesce(
--   (select sms_status from marketing_contact_preferences where contact_id = '<some contact id>'),
--   'unknown'
-- );
--
-- -- 14. No marketing_campaigns table exists:
-- select count(*) from information_schema.tables
-- where table_schema = 'public' and table_name = 'marketing_campaigns';
-- -- expect 0.
--
-- -- 15. No marketing_campaign_recipients table exists:
-- select count(*) from information_schema.tables
-- where table_schema = 'public' and table_name = 'marketing_campaign_recipients';
-- -- expect 0.
-- ============================================================================