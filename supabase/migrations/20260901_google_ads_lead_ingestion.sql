-- 20260901_google_ads_lead_ingestion.sql
--
-- Phase 3, Step 6, Part B: storage for Google Ads lead-form submission
-- ingestion + attribution. Does NOT touch 20260830_google_ads_oauth_foundation.sql
-- (historical/applied) — this is purely additive.
--
-- Two changes:
--   1. google_ads_lead_submissions — a brand-new, dedicated table for raw
--      Google Ads lead-form submission + attribution data (verified: no
--      CREATE TABLE for this name anywhere in supabase/migrations/, and no
--      existing store/function references it — CREATE TABLE IF NOT EXISTS
--      is safe here per the database-migrations skill's "confirmed new" bar).
--   2. google_ads_connections gains three lead-ingestion sync-state columns
--      (lead_last_synced_at/lead_last_error_code/lead_last_error_at),
--      additive via ALTER TABLE ADD COLUMN IF NOT EXISTS — deliberately
--      SEPARATE from that table's existing last_synced_at/last_error_code,
--      which track OAuth/account sync, not lead ingestion. Verified against
--      the live column list in 20260830_google_ads_oauth_foundation.sql
--      (read, not modified) before writing this ALTER.
--
-- Why a dedicated table instead of writing straight into `leads`/`contacts`:
-- Google's lead-form resource carries far more provider-specific detail
-- (submission ID, resource name, campaign/asset/ad-group attribution,
-- gclid, raw + custom field payloads) than either CRM table has columns
-- for, and overloading leads.custom_fields with all of it would make every
-- other leads.custom_fields consumer (see leads-store.ts's mapRow) have to
-- learn to ignore Google-specific keys. Mirrors the same "dedicated
-- per-provider table" precedent already used for google_ads_connections
-- and meta_connections rather than overloading a generic column.
--
-- Naming/FK conventions verified against the live repo before writing this
-- (not assumed): public.leads(id) and public.contacts(id) are referenced
-- elsewhere as `lead_id`/`contact_id` with `on delete set null`
-- (20260808_project_creation_enhancements.sql, 20260815_project_change_orders.sql)
-- — NOT a `crm_`-prefixed name — so this table follows that existing
-- convention rather than the crm_lead_id/crm_contact_id names floated in
-- the task description.

-- ── google_ads_lead_submissions ─────────────────────────────────────────
create table if not exists google_ads_lead_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  -- Provider identity — google_submission_id is Google's own immutable ID
  -- for this exact submission (lead_form_submission_data.id), the sole
  -- basis for dedupe/idempotency. Timestamps are NEVER used for dedupe
  -- (Part B4) — only this unique constraint below.
  google_ads_customer_id text not null,
  google_submission_id text not null,
  google_resource_name text,

  -- Attribution — digit-only Google Ads numeric IDs stored as text,
  -- matching google_ads_connections' own selected_customer_id/
  -- login_customer_id convention. ad_group_id/ad_group_ad_id are
  -- deliberately nullable — not every lead-form asset is associated with
  -- an ad group (Part B3: "do not assume ad_group/ad_group_ad always exist").
  campaign_id text,
  campaign_name text,
  asset_id text,
  ad_group_id text,
  ad_group_ad_id text,
  gclid text,
  submission_date_time timestamptz,

  -- Raw payloads — every field Google returned is preserved here even if
  -- not individually mapped below (Part B7: "do not discard unknown
  -- fields"), so a future normalization improvement can re-derive more
  -- from history without re-fetching from Google.
  raw_fields jsonb not null default '[]'::jsonb,
  raw_custom_fields jsonb not null default '[]'::jsonb,

  -- Normalized standard fields (best-effort extraction from raw_fields —
  -- see lib/google-ads-lead-fields.ts normalizeGoogleAdsLeadFields()).
  -- Used for CRM dedupe matching and contact/lead creation; NOT every
  -- lead form asks for every field, so all are nullable.
  normalized_email text,
  normalized_phone text,
  normalized_first_name text,
  normalized_last_name text,
  normalized_full_name text,

  -- CRM linkage — set once ingestion resolves a matching or newly-created
  -- CRM record. Nullable + ON DELETE SET NULL: if the linked lead/contact
  -- is later deleted, the submission itself (the provider-side event
  -- record) is still historically true and must not disappear with it.
  lead_id uuid references public.leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,

  ingestion_status text not null default 'pending'
    check (ingestion_status in ('pending', 'matched', 'created', 'failed')),
  ingestion_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The atomic idempotency guarantee (Part B4/B5): a repeated ingestion
  -- run over the same submission (overlap window, retry, etc.) hits this
  -- constraint on upsert and is treated as "already ingested" rather than
  -- creating a duplicate CRM record — a database-enforced decision, not an
  -- application-level read-then-write check.
  unique (organization_id, google_ads_customer_id, google_submission_id)
);

comment on table google_ads_lead_submissions is
  'Raw Google Ads lead-form submission + attribution data, one row per Google lead_form_submission_data.id (idempotent via the org/customer/submission unique constraint). Links to leads/contacts once CRM dedupe/creation resolves. Server-only — no client access; a future dedicated status/summary endpoint fronts any UI needs, the same way google-ads-connection-status.ts fronts google_ads_connections.';

create index if not exists idx_google_ads_lead_submissions_organization_id on google_ads_lead_submissions(organization_id);
create index if not exists idx_google_ads_lead_submissions_lead_id on google_ads_lead_submissions(lead_id) where lead_id is not null;
create index if not exists idx_google_ads_lead_submissions_contact_id on google_ads_lead_submissions(contact_id) where contact_id is not null;
create index if not exists idx_google_ads_lead_submissions_submission_date on google_ads_lead_submissions(organization_id, submission_date_time);

create or replace function public.set_google_ads_lead_submissions_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists google_ads_lead_submissions_set_updated_at on public.google_ads_lead_submissions;
create trigger google_ads_lead_submissions_set_updated_at
  before update on public.google_ads_lead_submissions
  for each row execute function public.set_google_ads_lead_submissions_updated_at();

alter table google_ads_lead_submissions enable row level security;
-- Intentionally zero policies — same precedent as google_ads_connections /
-- google_ads_oauth_nonces / agent_action_idempotency: default-deny for
-- anon/authenticated, service-role client (the only thing that will ever
-- write or read this table — the ingestion function) bypasses RLS as
-- usual. This table can carry lead PII (raw_fields/normalized_email/
-- normalized_phone) even when no CRM match exists yet, so it gets the
-- same no-client-access posture as the encrypted-token-holding
-- google_ads_connections table, not the lighter posture CRM-facing tables
-- like leads/contacts have.

-- ── google_ads_connections: lead-ingestion sync state (Part B6) ─────────
-- Additive columns on the EXISTING (applied) table — never a new
-- CREATE TABLE, never a modification of the historical migration that
-- created it. Separate from that table's own last_synced_at/
-- last_error_code (OAuth/account discovery sync) so a lead-sync failure
-- can never be confused with an account-discovery failure or vice versa.
alter table google_ads_connections add column if not exists lead_last_synced_at timestamptz;
alter table google_ads_connections add column if not exists lead_last_error_code text;
alter table google_ads_connections add column if not exists lead_last_error_at timestamptz;

comment on column google_ads_connections.lead_last_synced_at is 'Last successful google-ads-lead-sync.ts run for this connection. Distinct from last_synced_at (account/OAuth discovery sync).';
comment on column google_ads_connections.lead_last_error_code is 'Safe internal error code from the most recent lead-sync attempt, if any (see GOOGLE_ADS_SAFE_ERROR_CODES). Cleared to null on the next successful lead sync.';
comment on column google_ads_connections.lead_last_error_at is 'Timestamp of lead_last_error_code, if set.';

-- ── Verification (run after applying) ──────────────────────────────────
-- select table_name from information_schema.tables where table_name = 'google_ads_lead_submissions';
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'google_ads_lead_submissions' order by ordinal_position;
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.google_ads_lead_submissions'::regclass and contype = 'u';
--   -- expect the (organization_id, google_ads_customer_id, google_submission_id) unique constraint
--
-- select c.relname, c.relrowsecurity from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relname = 'google_ads_lead_submissions';
--   -- expect relrowsecurity = true
-- select policyname from pg_policies where schemaname = 'public' and tablename = 'google_ads_lead_submissions';
--   -- expect 0 rows
--
-- select column_name from information_schema.columns
--   where table_name = 'google_ads_connections'
--   and column_name in ('lead_last_synced_at', 'lead_last_error_code', 'lead_last_error_at');
--   -- expect all 3 rows present
