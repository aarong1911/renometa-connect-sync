-- 20260902_google_ads_conversion_attribution.sql
--
-- Phase 3, Step 7A: local foundation for Google Ads offline conversion
-- attribution — represents/queues CRM outcomes (qualified lead,
-- appointment booked, deal won) that could later be uploaded to Google
-- Ads as conversions, while preserving exact per-submission attribution
-- (gclid, campaign, provider submission). Does NOT touch either historical
-- migration:
--   20260830_google_ads_oauth_foundation.sql (applied)
--   20260901_google_ads_lead_ingestion.sql (applied)
-- This is purely additive — two brand-new tables (verified: no CREATE
-- TABLE for either name anywhere in supabase/migrations/, no existing
-- store/function references them).
--
-- NO Google conversion upload happens anywhere in this migration or the
-- application code that uses it — see netlify/functions/lib/
-- google-ads-conversion-events.ts and google-ads-conversion-event-create.ts
-- for the read/write logic. Step 7B will add the actual upload call.
--
-- ── CRM outcome audit (recorded here for context — see the Phase 3 Step
-- 7A report for the full writeup) ──────────────────────────────────────
-- qualified_lead   -> leads.status = 'qualified' (see src/lib/lead-status.ts,
--                     the canonical 5-value LEAD_STATUSES list)
-- appointment_booked -> the existence of an appointments row (creation is
--                     the "booked" event; appointments has its own status
--                     lifecycle — scheduled/confirmed/.../cancelled — but
--                     "booked" itself is the row's existence, not a
--                     specific status value)
-- deal_won         -> deals.status = 'won' (see src/lib/sales/types.ts's
--                     DealStatus = "open" | "won" | "lost")
-- deal value       -> deals.value (numeric) — the canonical revenue field;
--                     NOT estimates.value, which is a pre-close estimate,
--                     not confirmed won revenue
--
-- Two tables:
--   1. google_ads_conversion_events   — one row per (org, provider
--      submission, event_type) CRM outcome, queued for a future export.
--   2. google_ads_conversion_mappings — org+customer-scoped mapping from
--      RenoMeta event_type -> a Google Ads conversion_action_id, entered
--      by the org later (Step 7B UI) rather than hardcoded in source code.
--
-- Both follow the exact RLS-enabled/zero-policies/service-role-only
-- precedent already used for google_ads_connections and
-- google_ads_lead_submissions (see 20260830_google_ads_oauth_foundation.sql
-- and 20260901_google_ads_lead_ingestion.sql) — no client-facing policy,
-- ever. All reads/writes go through trusted Netlify functions.

-- ── google_ads_conversion_events ────────────────────────────────────────
create table if not exists google_ads_conversion_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  google_ads_customer_id text not null,

  -- The ENTIRE point of this column: attribution is resolved from the
  -- EXACT provider submission linked to the CRM lead that generated this
  -- event — never "the contact's most recent Google submission" (Part 3).
  -- One contact can have multiple google_ads_lead_submissions rows, each
  -- with its own gclid/campaign; this FK is what keeps a deal_won event
  -- pinned to the correct one.
  google_ads_lead_submission_id uuid not null references public.google_ads_lead_submissions(id) on delete cascade,

  -- CRM-side references — nullable because not every event type touches
  -- every entity (a qualified_lead event has no deal yet; an
  -- appointment_booked event may have no deal yet either).
  lead_id uuid references public.leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,

  event_type text not null
    check (event_type in ('qualified_lead', 'appointment_booked', 'deal_won')),
  event_at timestamptz not null,

  -- Copied from the provider submission at event-creation time (never
  -- re-derived later) — a synthetic dev-fixture row's gclid is a fake
  -- value and this table makes no attempt to distinguish that here; see
  -- export_status below, which is what actually blocks a synthetic
  -- event from ever being considered for upload.
  gclid text,

  conversion_value numeric,
  -- No canonical currency model exists anywhere in this app today (no
  -- currency column on deals/organizations/leads — confirmed by repo
  -- audit) — left nullable and caller-supplied rather than defaulted to
  -- any hardcoded currency (never assume USD or ILS).
  currency_code text,

  -- Populated once an org configures google_ads_conversion_mappings for
  -- this (customer_id, event_type) — null until then.
  conversion_action_id text,

  export_status text not null default 'pending'
    check (export_status in ('pending', 'ready', 'exported', 'failed', 'ineligible')),
  export_attempt_count integer not null default 0,
  exported_at timestamptz,
  last_export_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  -- Reserved for Step 7B (the actual upload call) — never populated by
  -- anything in this migration's accompanying application code.
  google_upload_resource_name text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Part 5: one event per CRM milestone per attributed provider
  -- submission. A duplicate recordGoogleAdsConversionEvent() call for the
  -- same (org, submission, event_type) is treated as idempotent, not a
  -- new row (see Part 17 — the duplicate-event test). This intentionally
  -- allows exactly one qualified_lead, one appointment_booked, and one
  -- deal_won per submission; if a future product need requires MULTIPLE
  -- appointment_booked events per lead (e.g. a rescheduled/second
  -- appointment), that will need a different uniqueness key at that time
  -- — not assumed here.
  unique (organization_id, google_ads_lead_submission_id, event_type)
);

comment on table google_ads_conversion_events is
  'Local queue of CRM outcomes (qualified_lead/appointment_booked/deal_won) attributable to a specific Google Ads lead-form submission, pending a future offline-conversion export. No Google upload happens from this table in Step 7A. Server-only — no client access.';

create index if not exists idx_google_ads_conversion_events_organization_id on google_ads_conversion_events(organization_id);
create index if not exists idx_google_ads_conversion_events_submission_id on google_ads_conversion_events(google_ads_lead_submission_id);
create index if not exists idx_google_ads_conversion_events_export_status on google_ads_conversion_events(organization_id, export_status);

create or replace function public.set_google_ads_conversion_events_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists google_ads_conversion_events_set_updated_at on public.google_ads_conversion_events;
create trigger google_ads_conversion_events_set_updated_at
  before update on public.google_ads_conversion_events
  for each row execute function public.set_google_ads_conversion_events_updated_at();

alter table google_ads_conversion_events enable row level security;
-- Intentionally zero policies — same precedent as google_ads_connections /
-- google_ads_lead_submissions: default-deny for anon/authenticated,
-- service-role client (the only thing that will ever write or read this
-- table — trusted Netlify functions) bypasses RLS as usual. No user can
-- spoof gclid/google_ads_customer_id/google_ads_lead_submission_id/
-- export_status from the browser because the browser never has a policy
-- that lets it touch this table at all.

-- ── google_ads_conversion_mappings ──────────────────────────────────────
-- Org+customer-scoped mapping from a RenoMeta event_type to a Google Ads
-- conversion_action_id — entered later via an org-facing settings UI
-- (Step 7B), never hardcoded in source code (Part 9).
create table if not exists google_ads_conversion_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  google_ads_customer_id text not null,
  event_type text not null
    check (event_type in ('qualified_lead', 'appointment_booked', 'deal_won')),
  conversion_action_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, google_ads_customer_id, event_type)
);

comment on table google_ads_conversion_mappings is
  'Org+customer-scoped RenoMeta event_type -> Google Ads conversion_action_id mapping. No remote Google conversion actions are created from this table — it only records an ID the org enters after creating the conversion action in Google Ads themselves. Server-only — no client access; a future trusted settings endpoint fronts writes.';

create index if not exists idx_google_ads_conversion_mappings_org_customer on google_ads_conversion_mappings(organization_id, google_ads_customer_id);

create or replace function public.set_google_ads_conversion_mappings_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists google_ads_conversion_mappings_set_updated_at on public.google_ads_conversion_mappings;
create trigger google_ads_conversion_mappings_set_updated_at
  before update on public.google_ads_conversion_mappings
  for each row execute function public.set_google_ads_conversion_mappings_updated_at();

alter table google_ads_conversion_mappings enable row level security;
-- Intentionally zero policies — see comment above.

-- ── Verification (run after applying) ──────────────────────────────────
-- select table_name from information_schema.tables
--   where table_name in ('google_ads_conversion_events', 'google_ads_conversion_mappings');
--
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'google_ads_conversion_events' order by ordinal_position;
--
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.google_ads_conversion_events'::regclass and contype in ('u', 'c');
--   -- expect the (organization_id, google_ads_lead_submission_id, event_type)
--   -- unique constraint and the event_type/export_status CHECK constraints
--
-- select c.relname, c.relrowsecurity from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname in ('google_ads_conversion_events', 'google_ads_conversion_mappings');
--   -- expect relrowsecurity = true for both
--
-- select policyname from pg_policies where schemaname = 'public'
--   and tablename in ('google_ads_conversion_events', 'google_ads_conversion_mappings');
--   -- expect 0 rows
